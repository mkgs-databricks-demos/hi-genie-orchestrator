# Session: State RLS — Migration 007 + Post-Deploy Test Fixes

**Date:** 2026-08-22  
**Branch:** `mg-genie-state-rls`  
**Status:** All 7 post-deploy tests PASS; feature complete, pending PR  
**Commits:** 11 (full branch `origin/main..HEAD`)

---

## Summary

Completed the state schema RLS feature end-to-end: migration 007 deployed to dev, all 5 `state.ts` handlers refactored for RLS, dispatch route hardened against RLS violations, and post-deploy validation suite fixed and passing. This session focused on diagnosing and resolving 6 post-deploy test failures (reduced to 0 across 3 iterative job runs).

---

## Full Branch Scope (across prior sessions + this one)

### Migration 007 — `row_level_security_state`

**File:** `server/migrations/007_row_level_security_state.ts`

Applies ENABLE + FORCE ROW LEVEL SECURITY on all 8 mutable `state` schema tables:
- `sessions`, `decisions`, `errors`, `events`, `task_attempts`, `task_completions`, `workstream_events`, `recovery_state`

Creates 18 policies:
- SELECT + INSERT on all 8 tables (16 policies)
- UPDATE on `sessions` + `recovery_state` (2 policies)

All policies scope via `current_setting('app.user_identity', true)` — same session-variable pattern as migrations 005/006 for the dispatch schema.

### state.ts Handler Refactor

**File:** `server/mcp/tools/state.ts`

All 5 MCP handlers now set `app.user_identity` before touching RLS-protected tables:

| Handler | Pattern | Tables Touched |
| --- | --- | --- |
| `startSession` | `withIdentity(pool, userId, fn)` | `state.sessions` (INSERT) |
| `endSession` | `withIdentity` (pre-flight SELECT) + `optimisticUpdate` (UPDATE) | `state.sessions` |
| `updateWorkstreamStatus` | Explicit `BEGIN` + `set_config` | `dispatch.workstreams` (UPDATE), `state.workstream_events` (INSERT) |
| `updateTaskStatus` | Explicit `BEGIN` + `set_config` | `dispatch.executions` (UPDATE), `state.events` (INSERT) |
| `updateRecoveryState` | `withIdentity(pool, userId, fn)` | `state.recovery_state` (UPDATE) |

`optimisticUpdate` helper also updated to accept and destructure `userId`, wrapping its UPDATE in a transaction with `set_config`.

### Identity Helper

**File:** `server/mcp/tools/identity.ts`

```typescript
export async function withIdentity<T>(
  pool: Pool,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T>
```

Acquires a client, runs `BEGIN` + `set_config('app.user_identity', userId, true)`, executes `fn(client)`, commits, and releases. Rolls back on error.

### Dispatch Resilience

**File:** `server/api/routes/workstreams.ts`

Two changes with security implications:

1. **Graceful 42501 handling:** The dispatch route's catch block now detects PostgreSQL error code `42501` (insufficient_privilege / RLS violation) and returns HTTP 403 with a structured JSON response:
   ```json
   {
     "error": "RLS_POLICY_VIOLATION",
     "message": "worker_identity must match your authenticated identity...",
     "detail": {
       "worker_identity_sent": "<value from body>",
       "authenticated_as": "<value from x-forwarded-user>",
       "hint": "Set worker_identity to your own identity..."
     }
   }
   ```
   **Previous behavior:** Unhandled rejection → Node.js crash → app exit → 502 for all users. This was a **denial-of-service vulnerability** (any authenticated caller could crash the app).

2. **`worker_identity` made optional in `DispatchSchema`:**
   ```typescript
   // Before
   worker_identity: z.string().min(1),
   // After
   worker_identity: z.string().min(1).optional(),
   ```
   When omitted, defaults to `getUserIdentity(req)` (the authenticated caller from `x-forwarded-user` header set by Databricks auth sidecar).

   **Security analysis:** This is a security *improvement*, not a regression:
   - The RLS INSERT policy on `dispatch.executions` still enforces `worker_identity = current_setting('app.user_identity')` — unchanged
   - `app.user_identity` is set from `getUserIdentity(req)` which reads the sidecar-injected `x-forwarded-user` header — callers cannot forge this
   - Impersonation remains impossible: sending a mismatched `worker_identity` now returns 403 (previously crashed the app)
   - Omitting `worker_identity` does NOT avoid attribution: the server auto-fills from the authenticated identity
   - The body field was always redundant self-attestation — the RLS policy at the Postgres layer is the actual enforcement boundary
   - Eliminates the DoS vector (crash on mismatch)

---

## Post-Deploy Test Failures (This Session)

### Problem 1: App crash on `dispatch.executions` RLS violation (5 cascading 502s)

**Root cause:** The dispatch route (`workstreams.ts`) accepted `worker_identity` from the request body and inserted it into `dispatch.executions`. The RLS INSERT policy (migration 006) enforces `worker_identity = current_setting('app.user_identity')`. When the test sent `"post-deploy-validator"` but the auth sidecar set the identity to the SPN's resolved name (from `x-forwarded-user`), the INSERT was rejected with PG error 42501. The `catch` block re-threw into `withToolSpan`, which had no error boundary → unhandled promise rejection → `node:internal/process/promises` `triggerUncaughtException` → Node.js v22.16.0 process exit → all subsequent requests returned 502 `App Not Available`.

**OTel evidence:**
```
error: new row violates row-level security policy for table "executions"
    at .../node_modules/@databricks/lakebase/node_modules/pg/lib/client.js:624:17
    ...
    at async .../dist/api/routes/workstreams.js:217:5
  severity: 'ERROR', code: '42501', routine: 'ExecWithCheckOptions'
```

**Fix:** See "Dispatch Resilience" above (catch 42501 + optional worker_identity).

**Test fix:** Send `{}` as the dispatch body — server auto-fills `worker_identity` from the authenticated identity.

### Problem 2: Negative auth assertion too strict

**Root cause:** Test expected `resp.status_code == 401 AND body.get("error") == "UNAUTHENTICATED"`. The Databricks App auth sidecar intercepts unauthenticated requests at the infrastructure layer and returns HTTP 401 with an empty body `{}`. The request never reaches our Express middleware (which would have set `{"error": "UNAUTHENTICATED"}`). The test incorrectly treated the missing error field as a regression.

**Fix:** Accept HTTP 401 with any body as a PASS. The status code alone proves the fail-closed behavior — the body format depends on whether the sidecar or our middleware rejects the request.

### Problem 3: Lakebase SDK has no SQL execution method

**Root cause:** `w.postgres` (the `PostgresAPI` class in `databricks-sdk`) is exclusively a **resource management** surface: `list_projects`, `get_project`, `list_branches`, `create_endpoint`, etc. It has NO method for executing SQL queries (`execute_statement`, `execute_sql`, or anything similar). The test assumed such a method existed and tried `w.lakebase.execute_statement(...)` → `AttributeError` → fallback `w.postgres.execute_sql(...)` → `AttributeError`.

**Fix:** Replaced entirely with `psycopg2` direct connection:
1. Resolve endpoint host: `w.postgres.list_endpoints(parent=f"projects/{project}/branches/{branch}")` → `.status.hosts.host`
2. Auth: Reuse the SPN OAuth token already acquired via `POST /oidc/v1/token` (client_credentials flow)
3. Connect: `psycopg2.connect(host=..., dbname=..., user=SPN_CLIENT_ID, password=SPN_TOKEN, sslmode='require')`
4. Query: native `cur.execute(sql)` against `pg_class` / `pg_policies`

Also added `psycopg2-binary` to the `%pip install` cell.

### Problem 4: `start_session` NOT NULL constraint on `workstream_id`

**Root cause:** Test 6 (`rls_write_integrity`) called `start_session` with only `{"project_id": ..., "metadata": ...}`. The `state.sessions` table has `workstream_id TEXT NOT NULL` (added in migration 004 `workstream_columns`). The `startSession` handler inserts `workstream_id ?? null`, violating the constraint.

**Fix:** Added `"workstream_id": str(uuid.uuid4())` to the test MCP arguments.

---

## Iterative Job Runs

| Run | Failures | Key Learning |
| --- | --- | --- |
| Initial (pre-branch, from summary) | 6 critical | App crash (5 cascading 502s) + SDK method DNE |
| After first fix commit | 5 critical | Test fixes committed but app not redeployed; same crash |
| After dispatch resilience + optional worker_identity | 1 critical | `rls_write_integrity_start_session`: NOT NULL on workstream_id |
| After adding workstream_id | **0 critical** | ✅ 7/7 PASS |

**Final job run:** `1024502789013222` (TERMINATED SUCCESS, ~49s runtime)

---

## Changes Made (This Session)

| File | Change |
| --- | --- |
| `server/api/routes/workstreams.ts` | Catch PG 42501 → HTTP 403 with diagnostic JSON (prevents crash); `worker_identity` optional in DispatchSchema (defaults to `created_by`); `const worker_identity = parsed.data.worker_identity ?? created_by` |
| `src/tests/post_deploy_validation.py` | Cell 1: add `psycopg2-binary` to pip install; Test 2: accept 401 any body; Test 3: omit `worker_identity` from dispatch body; Test 6: add `workstream_id` arg; Test 7: full rewrite — psycopg2 + endpoint discovery + native boolean parsing |

## Changes Made (Earlier in Branch)

| File | Change |
| --- | --- |
| `server/migrations/007_row_level_security_state.ts` | New migration: RLS on 8 state tables, 18 policies |
| `server/migrations/index.ts` | Import + register `migration007` in MIGRATIONS array |
| `server/mcp/tools/identity.ts` | New `withIdentity(pool, userId, fn)` helper |
| `server/mcp/tools/state.ts` | Full refactor: all 5 handlers set `app.user_identity`; `optimisticUpdate` accepts `userId` |
| `server/mcp/tools/records.ts` | `withIdentity` for state INSERT operations |

---

## Decisions

1. **`worker_identity` is now optional (security improvement, not regression).** The RLS policy at Postgres layer is the enforcement boundary. The body field was redundant self-attestation. Omitting it eliminates the DoS vector while maintaining identical write-integrity guarantees. Callers CAN still pass it explicitly for audit/documentation purposes.

2. **Lakebase SQL in notebooks: use psycopg2, not SDK.** The `w.postgres` API will never have SQL execution — it's a resource management surface by design. For SQL from notebooks, connect directly with psycopg2 + OAuth token (`POST /oidc/v1/token` client_credentials). Resolve endpoint host from `w.postgres.list_endpoints(...).status.hosts.host`.

3. **App resilience pattern: catch PG 42501 in all write routes.** The dispatch route demonstrates the pattern. Other routes (`plans.ts`, `reviews.ts`) should follow the same catch-and-403 approach if their write paths can hit RLS violations.

4. **Auth sidecar body format is not under our control.** Tests should assert on HTTP status codes for auth behavior, not body format. The sidecar may return `{}`, `{"error": "..."}`  , or other formats depending on the rejection path.

---

## Verification

- **Post-deploy job:** `1024502789013222` (TERMINATED SUCCESS)
- **All 7 tests pass:** health_check, negative_auth, e2e_dispatch (5 substeps), negative_scoping, mcp_tools_list, rls_write_integrity, rls_policy_audit
- **Lakebase verified:** 8 tables with `rls_enabled=true, rls_forced=true`; 18 policies in `pg_policies`
- **App state:** RUNNING, no crashes during or after validation
- **Git:** Branch clean, 11 commits ahead of `origin/main`

---

## Commits (full branch, oldest first)

```
dd30d62 feat(state-rls): add RLS to state schema + withIdentity helper
42d68ef test(state-rls): unit tests for withIdentity + post-deploy RLS validation
50ba97e test(rls-audit): direct Lakebase pg_policies audit in post-deploy validation
c35f206 docs: update README migration count to v7 (state schema RLS)
d7b34f6 fix(state-rls): wire userId into optimisticUpdate for RLS + fix TS2345
efa205b fix(migrations): add migration007 to MIGRATIONS array (was imported but never registered)
6663ee0 feat(state-rls): complete state.ts refactor — all 5 handlers RLS-aware
dd4c920 fix(tests): fix 3 post-deploy validation failures
6693609 fix(dispatch+tests): graceful RLS error handling + identity auto-default + psycopg2
c5cb801 fix(tests): add workstream_id to rls_write_integrity test
<pending> docs: session summary 2026-08-22 + PROJECT_MEMORY update
```

---

## Architecture Notes

### Identity Flow (dispatch route)

```
HTTP Request
    │
    ▼
[Databricks Auth Sidecar] ──→ injects x-forwarded-user header
    │
    ▼
[requireVerifiedIdentity middleware] ──→ reads x-forwarded-user → sets req.verifiedIdentity
    │
    ▼
[dispatch route handler]
    ├─ getUserIdentity(req) → created_by
    ├─ worker_identity = body.worker_identity ?? created_by
    ├─ set_config('app.user_identity', created_by, true)  [transaction-scoped]
    ├─ INSERT INTO dispatch.executions (... worker_identity ...) VALUES (... $5 ...)
    │       └─ RLS policy checks: worker_identity = current_setting('app.user_identity')
    │       └─ If mismatch → PG 42501 → caught → HTTP 403
    │       └─ If match → INSERT succeeds
    └─ COMMIT
```

### RLS Coverage Summary (all migrations)

| Migration | Schema | Tables | Policies |
| --- | --- | --- | --- |
| 005 | dispatch | plans, plan_snapshots | 4 (SELECT + INSERT each) |
| 006 | dispatch | orchestrations, workstreams, executions, review_tasks | 10 |
| 007 | state | sessions, decisions, errors, events, task_attempts, task_completions, workstream_events, recovery_state | 18 |
| **Total** | | **14 tables** | **32 policies** |
