# 2026-08-20 — RLS Extension (Workstreams/Reviews) & MCP Contract Trace (in progress)

**Branch:** `mg-genie-r1-readiness-fixes`
**Follows:** `2026-08-19_identity-failclosed-and-rls-validation.md`
**Status:** Part 1 (RLS extension) shipped and deployed. Part 2 (MCP schema/query contract trace, triggered by tracing the `dispatch.orchestrations` creation gap) is **in progress, not complete** — this is the most important thing for the next session to pick up.

## Part 1 — Phase 3b extension: RLS on workstreams & reviews (shipped)

Extended the migration-005 pattern (`FORCE ROW LEVEL SECURITY` + per-transaction
`set_config('app.user_identity', ...)`) to the tables written by `workstreams.ts` and
`reviews.ts`. See prior session doc for the full pattern rationale.

**Migration 006** (`server/migrations/006_row_level_security_workstreams_reviews.ts`):
- `dispatch.orchestrations`: INSERT checks `created_by` (forward-looking — see Part 2, no
  route currently inserts into this table). UPDATE permissive.
- `dispatch.workstreams`: INSERT checks `created_by` (materialize handler). UPDATE permissive.
- `dispatch.executions`: INSERT checks `worker_identity` (no `created_by` column on this
  table) — makes the dispatch endpoint self-attesting: a caller can only create an
  execution record claiming to be the worker it's verified as. UPDATE permissive.
- `dispatch.review_tasks`: INSERT checks `created_by`. UPDATE checks `reviewer_identity`
  (remediation + approve handlers both set it to the caller's own identity in the same
  UPDATE that's checked).
- SELECT permissive everywhere (no project-membership/ACL model exists yet).

**Route changes:**
- `workstreams.ts`: `set_config` added to the materialize and dispatch handlers' existing transactions.
- `reviews.ts`: create handler (`POST /`) converted from a bare `pool.query` to an explicit
  transaction (required — there was nothing to attach `set_config` to before). `set_config`
  added to the remediation and approve handlers' existing transactions.
- `tsconfig.server.json`: added `server/routes/**/*` to `include` (closes Polly readiness
  item 3 — `todo-routes.ts` deletion is still blocked by this environment's safety
  guardrails, so per Polly's own stated fallback, typechecking it instead).

**Deployed & verified on dev** (two `bundle deploy` + forced `w.apps.deploy()` cycles this
session, both `SUCCEEDED`):
- `state._migration_history` shows version 6 (`row_level_security_workstreams_reviews`) applied.
- `pg_class` confirms `relrowsecurity`/`relforcerowsecurity` = `true` on all 4 tables.
- `pg_policies` confirms all 12 policies match the migration SQL exactly.
- **Not validated over live HTTP traffic** the way migration 005 was for `plans.ts` —
  attempted a SQL-level functional test (seed a `plan_snapshot` + `orchestration` as
  superuser, then `SET ROLE` to the app's SPN role to exercise the policies directly) but
  the `executeLakebasePostgresSql` tool doesn't support multi-statement execution or
  persisted session state across calls, so `SET ROLE` in one call doesn't carry to the
  next. Fell back to code review + exact `pg_policies` match as the confidence basis.
  Seed row was cleaned up.

**Commits (this branch, from the previous session, already pushed):**
1. `Phase 3b (extension): write-integrity RLS on workstreams and reviews`
2. `Close Polly readiness item 3: typecheck server/routes/`

## Part 2 — MCP schema/query contract trace (triggered by "trace the orchestrations creation gap")

### The original question

Migration 006 added a forward-looking `created_by` INSERT policy on `dispatch.orchestrations`,
noting that no route in `plans.ts`/`workstreams.ts`/`reviews.ts` actually creates an
orchestration row (`workstreams.ts`'s materialize handler only `UPDATE`s an existing one).
Asked to trace where/whether orchestrations actually get created anywhere in the codebase.

### What's confirmed so far

- **No `INSERT INTO dispatch.orchestrations` exists in `server/api/routes/*.ts`.** Confirmed
  by full manual read of `plans.ts`, `workstreams.ts`, `reviews.ts` (not by `regexAssetSearch`
  — see tooling note below).
- **`server/mcp/tools/` does not create orchestrations either**, and this is where the trail
  gets much more interesting than "just a missing endpoint."

### Major finding: MCP tools' assumed schema does not match migration 001 DDL at all

This is a bigger problem than the orchestrations creation gap itself, and it's squarely
Polly's finding 4 (schema/query contract reconciliation) materializing. Confirmed by reading
`server/mcp/tools/context.ts` and comparing its Drizzle table definitions against the real
DDL in `server/migrations/001_dispatch_schema.ts`:

| Drizzle def in `context.ts` | Real column (migration 001) | Problem |
| --- | --- | --- |
| `orchestrations.id` (PK) | `orchestration_id` | Wrong PK column name |
| `orchestrations.name` | *(does not exist)* | `dispatch.orchestrations` has no `name` column at all |
| `orchestrations.metadata` | *(does not exist)* | No `metadata` column either |
| *(missing)* | `plan_id`, `plan_snapshot_id`, `priority`, `correlation_id`, `configuration_version`, `created_by`, `started_at`, `completed_at` | Real columns entirely absent from the Drizzle schema |
| `workstreams.id` (PK) | `workstream_id` | Wrong PK column name |
| `workstreams.metadata` | *(does not exist)* | Real column is `config`, not `metadata` |
| *(missing)* | `created_by`, `max_retries`, `assigned_to`, `idempotency_key`, `correlation_id`, `started_at`, `completed_at` | Also absent |

**Concrete consequence:** `getWorkstreamContext` runs
`eq(workstreams.id, workstream_id)` — `workstreams.id` doesn't exist as a real column, so
this query would fail with a Postgres "column does not exist" error the moment it's actually
invoked. `getProjectContext` selects `orchestrations.name`/`.metadata`, same failure mode.

**Same problem, worse, in `server/mcp/tools/state.ts`:** `updateWorkstreamStatus` runs
`SELECT status, version FROM dispatch.workstreams WHERE id = $1 AND project_id = $2` — wrong
PK column (`id` vs `workstream_id`) **and** references a `version` column that
`dispatch.workstreams` does not have at all (the real table has no optimistic-concurrency
version column; the Supervisor API routes use `SELECT ... FOR UPDATE` row locking instead,
not a version column). The shared `optimisticUpdate()` helper in the same file hardcodes the
WHERE clause to an `id` column, so any tool routed through it against `dispatch.workstreams`
is broken by construction, independent of the specific column values passed in.

**Practical read:** `get_project_context`, `get_workstream_context`, and
`update_workstream_status` (at minimum) are very likely non-functional today against the real
schema — not tested end-to-end yet, but the column names alone would raise a Postgres error.
This strongly suggests these MCP tools were authored against an assumed/earlier schema design
that migration 001 didn't end up matching, and nobody has invoked them against live data since.

### Not yet checked (pick up here next session)

1. **`update_task_status`, `update_recovery_state`, `start_session`, `end_session`** in
   `state.ts` — same file as the confirmed-broken `updateWorkstreamStatus`; need the same
   column-by-column check against migration 001/002 DDL (`state.sessions`, `dispatch.executions`).
2. **`server/mcp/tools/records.ts`** (`record_decision`, `record_session_summary`,
   `record_error`, `record_workstream_event`, `record_task_attempt`, `record_task_completion`)
   — Drizzle defs for `state` schema tables were read but not yet cross-checked column-by-column
   against migration 002.
3. **`server/mcp/tools/search.ts`** — not read at all yet this session.
4. **`server/dispatch/*.ts`** (`index.ts`, `tick-evaluator.ts`, `listener.ts`,
   `review-dispatcher.ts`, `priority-tree.ts`) — not read yet. This is the most likely place
   left to check for an orchestrations-creation path, since the dispatch engine is the one
   component that autonomously acts on state rather than just responding to a route/tool call.
   If nothing creates orchestrations there either, the honest conclusion is that Release 1 has
   **no implemented path to create an orchestration row**, and `workstreams.ts`'s materialize
   endpoint is effectively unreachable in practice (it 404s on any real `orchId` today).
5. Once the above is done, reconcile findings into a single report back to Polly in
   `hey_polly/001_release-1-readiness.md` (finding 4), since Polly is waiting on this trace.

### Tooling note

`regexAssetSearch` returned **zero results** for `.*orchestrations.*` and even for the literal
string `dispatch.orchestrations`, despite it appearing dozens of times across
`server/api/routes/workstreams.ts` and `server/migrations/001_dispatch_schema.ts` (confirmed
by direct `readAssetById` reads of those exact files in the same session). This tool appears
unreliable for `.ts` files in this Git-backed folder — don't trust a `regexAssetSearch` "0
results" as evidence of absence here; fall back to manually reading directory listings and
file contents instead, as was done for everything in this write-up.

## Files Modified This Session

- `server/migrations/006_row_level_security_workstreams_reviews.ts` (new)
- `server/migrations/index.ts` (registered migration 006)
- `server/api/routes/workstreams.ts` (`set_config` wiring)
- `server/api/routes/reviews.ts` (`set_config` wiring + create-handler transaction refactor)
- `tsconfig.server.json` (`server/routes/**/*` added to `include`)
- `hey_polly/001_release-1-readiness.md` (status update on Phase 3b extension)
- (Part 2 is investigation only so far — no code changes yet for the MCP contract mismatches.)

## Remaining Work / Next Session

1. Finish the MCP contract trace (items 1–4 above) — this is the priority. Read
   `server/dispatch/*.ts` first since it's most likely to resolve the orchestrations-creation
   question one way or the other.
2. Decide + implement a fix for whatever's found: likely candidates are (a) add a
   `POST /api/v1/orchestrations` (or fold orchestration creation into `plans.ts`'s publish
   handler, since one plan snapshot → one orchestration seems like the intended flow) if no
   creation path exists anywhere, and (b) rewrite the broken Drizzle schemas / raw SQL in
   `context.ts` and `state.ts` to match migration 001/002 real column names.
3. Add regression tests for whichever MCP tools get fixed, so schema drift like this fails
   the test gate (Phase 2's `vitest.config.ts` work) instead of shipping silently.
4. Report findings back to Polly in `hey_polly/001_release-1-readiness.md` (finding 4).
5. Once finding 4 and finding 9 (review/remediation lifecycle enforcement, still not started)
   are closed, Phase 4 (readiness endpoint, remaining deployment audit) is what's left of the
   original 4-phase plan.
