# 2026-08-19 — Identity Fail-Closed & Row-Level Security (R1 Readiness, Phase 3a/3b)

**Branch:** `mg-genie-r1-readiness-fixes`
**Deployments:** `01f19c110f8713d183b0a171dcbea361` (Phase 2), `01f19c1209021e94bfeb3e5f2a3c1cb3` (Phase 3a), `01f19c1ae56618ef9b20db12d7d87f16` (Phase 3b + SPN permission fix)
**Follows:** `2026-08-19_runtime-fixes-and-infra-integration.md`; responds to Polly's `hi_genie/001_release-1-readiness.md`

## Summary

Responded to Polly's Release 1 readiness review. Completed Phase 1 (deprecate scaffold
todo-routes), Phase 2 (real test gate + unit tests), Phase 3a (fail-closed identity
middleware replacing the `'system'` fallback), and a first validation pass of Phase 3b
(Postgres row-level security on `dispatch.plans` / `dispatch.plan_snapshots`). Along the
way: resolved the AppKit Lakebase OBO question (no verifiable API — used a Postgres
session-variable pattern instead), and found/fixed two real platform permission gotchas
that would have silently broken M2M traffic.

## Problems Fixed / Decisions

### 1. `getUserIdentity` no longer falls back to `'system'` (Phase 3a)

New `server/api/middleware/identity.ts` — `requireVerifiedIdentity` mounted on all of
`/api/v1`. Fails closed with 401 `UNAUTHENTICATED` if no identity header is present,
rather than silently attributing the write to a shared `'system'` account.
`getUserIdentity(req)` in `plans.ts` now throws `UNVERIFIED_IDENTITY` if called on a
request that somehow bypassed the middleware.

### 2. AppKit Lakebase OBO — investigated, not adopted

No verifiable API surface for AppKit's "Lakebase OBO pool manager" (referenced only in
startup logs): no `node_modules` to inspect, no public docs for the internal `@databricks/appkit`
package, and no usage precedent in lakeLoom / dbxWearables-ZeroBus / scAuditor (all use
the shared SP pool + a custom JWT/route-guard layer instead). Adopting true per-identity
Postgres roles would also require dynamically provisioning a role per calling identity
(via `databricks_create_role`), which doesn't fit this orchestrator's shared-pool,
many-callers pattern (human users, multiple SPNs, and eventually MCP-tool callers).

**Resolution:** Postgres session-variable RLS instead — `set_config('app.user_identity', $1, true)`
right after `BEGIN` on the same transaction as the write, with RLS policies checking
`current_setting('app.user_identity', true)`. Independently corroborated by Lakebase's own
Genie assistant as a first-class, recommended RLS pattern for pooled-connection apps.

### 3. Row-Level Security — first validation pass (Phase 3b, `plans.ts` scope only)

New `server/migrations/005_row_level_security_plans.ts`:
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` on
  `dispatch.plans` and `dispatch.plan_snapshots`.
- Permissive `SELECT` policy (`USING (true)`) — no project-membership/ACL model exists
  yet, so there's no correct predicate for row-visibility restriction.
- `INSERT` policy: `WITH CHECK (created_by = current_setting('app.user_identity', true))`
  — write-integrity only (can't forge someone else's identity on a new row).
- Permissive `UPDATE` policy on `plans` (neither endpoint mutates `created_by` on update).
- **`FORCE ROW LEVEL SECURITY` is required**: the app's own SPN role owns these tables
  (it created them via migrations), and table owners bypass RLS by default.

`plans.ts`: wrapped the previously single-statement `POST /` handler in an explicit
transaction (`BEGIN` → `set_config` → `INSERT` → `COMMIT`), and added the same
`set_config` call to the existing `publish` transaction.

Scope intentionally narrow (validate the pattern before rolling out further) — does NOT
cover `workstreams.ts` / `reviews.ts` writes, nor the `state` schema tables written by the
22 MCP tools (those use a `developer_id` passed as an explicit tool argument over `/mcp`,
a separate identity path Phase 3a never touched).

### 4. Platform gotcha: `CAN_USE` is required even for the app's own auto-provisioned SPN

The Databricks Apps auth sidecar enforces `CAN_USE` on every caller — including the app's
own system-managed service principal (`84b36586-1ca7-4756-b39e-551a79058c55`,
`dbrx-apps-84b36586-...` as a Postgres role) calling the app's own HTTP ingress over the
`client_credentials` M2M flow. `CAN_MANAGE` does **not** imply `CAN_USE` for this
authorization check. This was granted manually via the UI first (lost on the next
`bundle deploy`, which overwrites the dev target's permissions block), then persisted in
`resources/hi_genie_app.app.yml` under `targets.dev.resources.apps.app.permissions`.

### 5. Platform gotcha: `wc.config.authenticate()` is not valid for a Databricks App's own HTTP ingress

Tried authenticating a human-identity request to the app with `wc.config.authenticate()`
headers (per the existing "must use notebook" convention) — got 401 `{}` regardless of
permissions. Root cause: that call returns a token scoped for platform REST APIs
(`/api/2.0/...`), not one valid for a Databricks App's own ingress under a human/U2M
identity (which normally goes through the browser SSO session). The SPN
`client_credentials` flow (`POST /oidc/v1/token`) *does* produce a token the App ingress
accepts — used that instead to validate the create-plan RLS flow.

### 6. Deploy gotcha: `lakebase_database_id` must be supplied manually outside `deploy.sh`

`bundle deploy --target dev` run directly (not via `deploy.sh`) fails with
`Failed to get postgres database projects/hi-genie-orchestrator/branches/development/databases/`
— the variable defaults to `""` and is normally resolved by `deploy.sh`. Fix:
`--var="lakebase_database_id=databricks-postgres"`.

### 7. Deploy gotcha: `bundle deploy` (source-linked dev) doesn't always restart the app process

After a successful `bundle deploy`, the migration hadn't actually run — the most recent
app deployment predated the source change. Had to force a fresh deployment explicitly via
the SDK: `w.apps.deploy(app_name=..., app_deployment=AppDeployment(source_code_path=...))`
and wait on the result. `w.apps.deploy()` needs a `datetime.timedelta` for `timeout`, not
a bare `int`.

### 8. Zod `.uuid()` strictness

A placeholder UUID like `00000000-0000-0000-0000-0000000000aa` fails Zod's `.uuid()`
validator — it enforces RFC 4122 version/variant nibbles (version digit must be `1`-`5`).
Use `uuid.uuid4()` for test payloads, not hand-rolled near-zero UUIDs.

## Validation Results (dev)

| Test | Result |
| --- | --- |
| `GET /api/v1/plans/<bogus-uuid>` as SPN, before `CAN_USE` grant | 401 (platform sidecar, not our middleware) |
| `GET /api/v1/plans/<bogus-uuid>` as SPN, after `CAN_USE` grant | 404 `NOT_FOUND` — reached the route handler |
| `dispatch.plans` / `dispatch.plan_snapshots`: `relrowsecurity`, `relforcerowsecurity` | both `true` |
| `pg_policies` on `dispatch` schema | 5 policies, exactly as designed |
| App SPN role (`84b36586-...`) `rolbypassrls` | `false` (not exempt — `FORCE` actually takes effect) |
| Table owner of `dispatch.plans` / `plan_snapshots` | `84b36586-...` (the app's own SPN) |
| `POST /api/v1/plans` as SPN, after `CAN_USE` persisted in YAML + redeploy | **201**, `created_by="77145947608610@7474657291520070"` |

The final 201 is conclusive: if `set_config` hadn't run on the same transaction as the
`INSERT`, the RLS `WITH CHECK` policy would have rejected the write outright rather than
succeeding.

## Files Modified

- `server/api/middleware/identity.ts` (new, Phase 3a)
- `server/api/routes/plans.ts` — fail-closed `getUserIdentity`, transaction + `set_config` wiring
- `server/migrations/005_row_level_security_plans.ts` (new)
- `server/migrations/index.ts` — registered migration 005
- `resources/hi_genie_app.app.yml` — persisted SPN `CAN_USE` grant for dev target
- `hey_polly/001_release-1-readiness.md` — response updates
- `M2M Identity Middleware Test.ipynb` (new, diagnostic notebook — SPN OAuth flow + RLS validation, kept for future re-verification)
- Phase 1/2 (same branch, prior commits): `server/routes/lakebase/todo-routes.ts` (deprecated), `vitest.config.ts`, `tsconfig.server.json`, `plans.ts`/`workstreams.ts`/`reviews.ts` (test-friendly exports), `server/migrations/runner.test.ts`, `server/api/routes/{plans,workstreams,reviews}.test.ts`

## Commits (this branch)

1. `Phase 1 (R1 readiness): mark scaffold todo-routes deprecated, respond to Polly`
2. `Phase 2 (R1 readiness): enable real test gate, add unit tests`
3. Phase 3a identity middleware (deployed as part of the Phase 3b commit below's predecessor deployment)
4. `Phase 3b (R1 readiness, first validation pass): write-integrity RLS on dispatch.plans/plan_snapshots`
5. `Persist app SPN CAN_USE grant in dev target permissions`

## Remaining Work / Next Phase

1. Extend the `set_config` + `FORCE ROW LEVEL SECURITY` + INSERT-policy pattern to
   `workstreams.ts` / `reviews.ts` (`dispatch.orchestrations`, `dispatch.workstreams`,
   `dispatch.executions`, `dispatch.review_tasks`).
2. Extend to the `state` schema tables written by the 22 MCP tools — separate identity
   path (`developer_id` passed as an explicit tool argument over `/mcp`), not yet wired
   through `requireVerifiedIdentity` at all.
3. Phase 4: `/api/health/ready` database-backed readiness endpoint, MCP-tools-vs-migration
   schema/query contract trace, deployment audit (`databricks.yml`/`resources/`, stays
   separate per Polly).
