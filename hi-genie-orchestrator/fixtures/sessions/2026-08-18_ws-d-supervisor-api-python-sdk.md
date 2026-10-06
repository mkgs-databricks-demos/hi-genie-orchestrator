# Session: ws-d Supervisor API and Python SDK

**Date:** 2026-08-18  
**Workstream:** ws-d  
**Status:** COMPLETE  
**Duration:** ~10 min  

## Summary

Implemented the versioned `/api/v1` Supervisor dispatch routes and a thin typed
Python SDK (`hi-genie-sdk/`) wrapping all endpoints. The API surface covers the
full plan-to-completion lifecycle: plan ingestion with immutable SHA-256 content-
hashed snapshots, workstream materialization from those snapshots, dispatch/retry/
pause/unpause controls with status-transition guards, idempotent review task
creation, structured remediation envelope delivery, and supervisor-only
completion approval that transitions workstreams to COMPLETE.

## Problems & Root Causes

- **Placeholder barrel:** `server/api/index.ts` existed as a no-op stub from ws-a
  scaffold. Required full replacement with route registration logic.
- **No `routes/` directory:** Needed to create the sub-directory and three route
  modules from scratch.
- **SDK package missing:** `hi-genie-sdk/` did not exist in the workspace.
  Created the full hatchling-based package structure.

## Decisions

1. **Content hash for idempotent publish:** SHA-256 over deterministically
   serialized JSON (sorted keys). Unique constraint `(plan_id, content_hash)`
   makes duplicate publishes a no-op returning the existing snapshot.
2. **Status transition guards:** Hardcoded allowed-from arrays per operation
   (`DISPATCH_FROM`, `RETRY_FROM`, `PAUSE_FROM`, `UNPAUSE_FROM`). Returns 409 on
   invalid transitions.
3. **Transactional publish/materialize/approve:** All multi-step operations use
   explicit `BEGIN`/`COMMIT`/`ROLLBACK` with `FOR UPDATE` row locks.
4. **WS-INIT as client-side evaluation:** The Python SDK implements the priority-
   tree tick as a stateless evaluation method that reads workstream state and
   produces deterministic action lists — no server-side endpoint needed.
5. **OBOAuthProvider:** Integrates with `databricks-sdk` WorkspaceClient for
   token acquisition; falls back to explicit token injection.
6. **Review approval immutability:** Once a review reaches APPROVED or CANCELLED,
   further mutations are rejected with 409 IMMUTABLE.
7. **Workstream completion via review:** Only `POST /reviews/:id/approve` with
   `outcome: PASS` can transition a workstream to COMPLETE — workers cannot
   self-complete (Decision 21).

## Changes

### Files Created

| File | Lines | Purpose |
| --- | --- | --- |
| `mcp-hi-genie-orchestrator/server/api/routes/plans.ts` | ~180 | Plan CRUD + immutable publish with content hashes |
| `mcp-hi-genie-orchestrator/server/api/routes/workstreams.ts` | ~260 | Materialize, dispatch, retry, pause, unpause |
| `mcp-hi-genie-orchestrator/server/api/routes/reviews.ts` | ~250 | Review lifecycle: create, remediation, approve |
| `hi-genie-sdk/pyproject.toml` | ~40 | Hatchling package definition |
| `hi-genie-sdk/src/hi_genie/__init__.py` | ~55 | Package init with exports |
| `hi-genie-sdk/src/hi_genie/client.py` | ~380 | Typed async client + Pydantic models + WS-INIT |

### Files Modified

| File | Change |
| --- | --- |
| `mcp-hi-genie-orchestrator/server/api/index.ts` | Replaced placeholder with full barrel export and `setupApiRoutes(appkit)` |
| `orchestration/state/workstream-ws-d-status.md` | NOT_STARTED → COMPLETE with downstream notes |

## API Routes Implemented

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/plans` | Ingest plan |
| GET | `/api/v1/plans/:planId` | Retrieve plan + snapshots |
| POST | `/api/v1/plans/:planId/publish` | Immutable snapshot (content hash) |
| POST | `/api/v1/orchestrations/:orchId/materialize` | Materialize workstreams |
| GET | `/api/v1/orchestrations/:orchId/workstreams` | List workstreams |
| POST | `/api/v1/workstreams/:wsKey/dispatch` | Trigger execution |
| POST | `/api/v1/workstreams/:wsKey/retry` | Retry from BLOCKED |
| POST | `/api/v1/workstreams/:wsKey/pause` | Pause → BLOCKED |
| POST | `/api/v1/workstreams/:wsKey/unpause` | Resume → RETRYING |
| POST | `/api/v1/reviews` | Create review task (idempotent) |
| GET | `/api/v1/reviews/:reviewId` | Retrieve review |
| POST | `/api/v1/reviews/:reviewId/remediation` | Deliver remediation envelope |
| POST | `/api/v1/reviews/:reviewId/approve` | Completion approval (immutable) |

## Integration Notes for Downstream

- **ws-e (Event Dispatch):** Uncomment `setupApiRoutes` import/invocation in
  `server.ts` (lines 24/70). Add LISTEN/NOTIFY triggers on
  `dispatch.workstreams` status changes.
- **ws-c (MCP Tools):** May read from `dispatch.workstreams` and
  `dispatch.review_tasks` for context retrieval — use same pool.
- **Telemetry:** All handlers wrapped with `withToolSpan`/`withDbSpan`.
