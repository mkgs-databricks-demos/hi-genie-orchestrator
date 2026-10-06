# Session: Backend Stabilization Gate

**Date:** 2026-08-20  
**Branch:** `mg-genie-r1-completion`  
**Deployment:** `01f19c5a8bee1a60845b696f61f5c794` (SUCCEEDED)  
**Trigger:** Independent main-branch review identified 6 backend blockers before UI Phase 4

---

## Problem

An independent review of the `main` branch identified six backend issues that must be resolved before the UI can connect to live data:

1. Orchestration creation route missing (OrchestratePlanSchema unused)
2. ReviewDispatcher INSERT rejected by RLS (no `set_config` before write)
3. Workstream ops (dispatch/retry/pause/unpause) not scoped by orchestration
4. `record_decision` tool definition mismatched handler signature
5. Authorization contract (permissive SELECTs) undocumented
6. `debate_state.json` stale vs. session completion evidence

## Changes Made

### 1. Orchestration Creation Route (`server/api/routes/plans.ts`)

- Added `POST /api/v1/plans/:planId/orchestrate`
- Validates via existing `OrchestratePlanSchema` (plan_snapshot_id optional, priority 0-100)
- Sets RLS identity context (`set_config('app.user_identity', ...)`) per migration 006
- Verifies plan exists + has published snapshot (or uses provided snapshot_id)
- Inserts into `dispatch.orchestrations` with PENDING status
- Returns full orchestration row

### 2. Dispatcher RLS Identity (`server/dispatch/review-dispatcher.ts`)

- Wrapped `createReviewTask` INSERT in `BEGIN/set_config/COMMIT` transaction
- Identity set to `'dispatch-engine'` (matches the `created_by` value)
- Added proper `ROLLBACK` on error, `COMMIT` on success/conflict

### 3. Workstream Operations Scoped by Orchestration (`server/api/routes/workstreams.ts`)

- **dispatch**: `/orchestrations/:orchId/workstreams/:wsKey/dispatch`
- **retry**: `/orchestrations/:orchId/workstreams/:wsKey/retry`
- **pause**: `/orchestrations/:orchId/workstreams/:wsKey/pause`
- **unpause**: `/orchestrations/:orchId/workstreams/:wsKey/unpause`
- All WHERE clauses now include `orchestration_id = $1 AND workstream_key = $2`
- Updated file header docstring to reflect new URL patterns

### 4. `record_decision` Tool Definition (`server/mcp/tools/records.ts`)

- Removed stale: `description`, `status`, `metadata`
- Added to match handler + DB: `context`, `decision`, `alternatives_considered`, `implications`, `tags`
- Updated `required` array: `['project_id', 'idempotency_key', 'title', 'context', 'decision']`
- This was a residual from KI-16 that only fixed 6 of 7 affected tools

### 5. Authorization Contract Documentation

- Added R1 limitation comment to `server/migrations/006_row_level_security_workstreams_reviews.ts`
- Explicitly approves `USING (true)` SELECT policies as R1 contract
- Documents the upgrade path for R1.1+ (project-membership predicate)
- Added Architecture Decision #12 to PROJECT_MEMORY

### 6. Debate State Reconciliation (`.review-protocol/debate_state.json`)

- `001_release-1-readiness`: status ACTIVE→AGREED, resolution→CONSENSUS, implementation_status→COMPLETE
- state_version: 5→6 (CAS increment)
- `implementation_commit`: set to `4225299` (this session's commit)

## Validation

| Test | Result |
| --- | --- |
| TypeScript build (deploy) | ✅ SUCCEEDED |
| GET /api/health | ✅ 200, all modules running |
| POST /plans/\<bogus\>/orchestrate | ✅ 404 NOT_FOUND (route exists, plan doesn't) |
| POST /orchestrations/\<bogus\>/workstreams/test/dispatch | ✅ 404 (route matches, workstream doesn't exist) |
| MCP tools/list → record_decision schema | ✅ context/decision present, description/status removed |
| **Full E2E flow** | ✅ plan→publish→orchestrate→materialize→dispatch all 201 |

## Decisions

- **Workstream URL pattern change is breaking** for any existing clients of the old `/workstreams/:wsKey/*` routes. Accepted because no external consumers exist yet (pre-UI). The new pattern `/orchestrations/:orchId/workstreams/:wsKey/*` is consistent with the existing materialize and list endpoints.
- **`USING (true)` is the approved R1 contract** — explicitly documented rather than left as an implicit gap. Upgrade path deferred to R1.1.
- **Dispatcher uses static identity `'dispatch-engine'`** rather than a verified caller identity, because it's an automated internal actor (not a user request). Acceptable for R1.

## Files Modified

- `server/api/routes/plans.ts` — orchestration creation route
- `server/api/routes/workstreams.ts` — orchestration-scoped URL patterns
- `server/dispatch/review-dispatcher.ts` — RLS transaction wrapping
- `server/mcp/tools/records.ts` — record_decision inputSchema fix
- `server/migrations/006_row_level_security_workstreams_reviews.ts` — authorization doc comment
- `.review-protocol/debate_state.json` — state reconciliation
- `PROJECT_MEMORY.md` — validation timestamp, architecture decisions, module notes
