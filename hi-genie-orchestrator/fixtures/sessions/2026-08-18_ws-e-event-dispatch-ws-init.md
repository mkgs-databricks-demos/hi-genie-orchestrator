# Session: ws-e Event Dispatch and WS-INIT

**Date:** 2026-08-18  
**Workstream:** ws-e  
**Status:** COMPLETE  
**Duration:** ~10 min  

## Problem

The Hi Genie Orchestrator needed an event-driven dispatch engine to:
- React to workstream status changes in real-time via Lakebase LISTEN/NOTIFY
- Provide a scheduled tick fallback when notifications are missed
- Evaluate the full DAG state through a deterministic priority-tree (WS-INIT model)
- Automatically create review tasks when workstreams reach READY_FOR_REVIEW

## Root Causes / Context

- Supervisor model requires stateless, deterministic dispatch — no AI/LLM in the critical path
- Lakebase pg_notify is best-effort (notifications lost on connection drop), so a periodic tick recovery is essential
- Review-gated completion (workers write READY_FOR_REVIEW, supervisor owns COMPLETE) needs automated review task creation with idempotency guarantees

## Changes Made

### Files Created

All in `mcp-hi-genie-orchestrator/server/dispatch/`:

| File | Lines | Purpose |
| --- | --- | --- |
| `index.ts` | 346 | Module entry point, `setupDispatch(appkit)`, action executor routing, graceful `shutdownDispatch()`, barrel re-exports |
| `listener.ts` | 333 | Lakebase LISTEN/NOTIFY consumer, `dispatch.completion_signals` DDL + `trg_workstream_status_notify` trigger, exponential backoff reconnect, `drainUnprocessedSignals()` recovery |
| `tick-evaluator.ts` | 268 | Periodic interval (configurable, default 60s), state-fingerprint deduplication, signal drain on each tick, event-driven wakeup bridge |
| `priority-tree.ts` | 337 | Stateless 8-priority decision tree (HANDLE_STUCK > RESUME_RETRY > CREATE_NEXT > SURFACE_BLOCKER > UNPAUSE_READY > GIT_SYNC > STATUS_REPORT > NO_OP), typed evaluator |
| `review-dispatcher.ts` | 312 | READY_FOR_REVIEW detection, idempotent review task creation via SHA-256 deterministic `review_task_id`, remediation context inclusion |

**Total:** 1,596 lines across 5 files.

### Files Modified

| File | Change |
| --- | --- |
| `server/server.ts` | Uncommented `import { setupDispatch }` (line 25) and `await setupDispatch(appkit)` (line 53) |
| `orchestration/state/workstream-ws-e-status.md` | Status: NOT_STARTED → IN_PROGRESS → COMPLETE |

## Key Decisions

1. **Dual-path event delivery:** LISTEN/NOTIFY for real-time + periodic tick for recovery. Neither alone is sufficient.
2. **Completion signals table:** Durable `dispatch.completion_signals` records every status transition, enabling recovery when the LISTEN connection was down.
3. **Stateless priority-tree:** Pure function — takes state array, produces single decision. No side effects. Callers own execution.
4. **Fingerprint deduplication:** Tick evaluator computes a deterministic fingerprint of `(key:status:attempt:paused)` sorted tuples; skips evaluation when unchanged.
5. **Review task idempotency:** `review_task_id` = SHA-256 of `(orchestration_id:workstream_key:attempt_count)` formatted as UUID-like hex. `ON CONFLICT DO NOTHING` guarantees no duplicates.
6. **DDL at listener startup:** `completion_signals` table and trigger installed via `IF NOT EXISTS`/`CREATE OR REPLACE` at runtime (not a numbered migration), since the trigger depends on the listener being active.
7. **Git sync detection:** Defaults to `false` in DB queries — actual file-change detection is Release 1.1 scope (requires out-of-band git-status mechanism).

## Architecture Notes

### Priority-Tree Evaluation Model

```
Input: WorkstreamState[] (from dispatch.workstreams + dispatch.orchestrations)
  ↓
Rule 1: HANDLE_STUCK — IN_PROGRESS > 90 min, no heartbeat
Rule 2: RESUME_RETRY — RETRYING with attempt_count < max_retries
Rule 3: CREATE_NEXT — NOT_STARTED with all depends_on COMPLETE
Rule 4: SURFACE_BLOCKER — BLOCKED (advisory)
Rule 5: UNPAUSE_READY — paused but deps met
Rule 6: GIT_SYNC — uncommitted changes (advisory)
Rule 7: STATUS_REPORT — active but nothing actionable
Rule 8: NO_OP — all complete or idle
  ↓
Output: { action, target, reasoning, priority }
```

### Action Routing

| Action | DB Mutation |
| --- | --- |
| HANDLE_STUCK | status → RETRYING, error_message set |
| RESUME_RETRY | status → IN_PROGRESS, attempt_count + 1 |
| CREATE_NEXT | status → IN_PROGRESS, attempt_count = 1 |
| UNPAUSE_READY | paused → false, status → NOT_STARTED |
| SURFACE_BLOCKER | Log warning (Release 1.1: notification) |
| GIT_SYNC | Log advisory (scheduled task handles commits) |

### Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISPATCH_TICK_INTERVAL_MS` | 60000 | Tick evaluator period |
| `DISPATCH_STUCK_THRESHOLD_MIN` | 90 | Minutes before IN_PROGRESS is "stuck" |
| `DISPATCH_LISTEN_ENABLED` | true | Enable/disable LISTEN/NOTIFY |
| `DISPATCH_GIT_SYNC_ENABLED` | true | Enable/disable GIT_SYNC detection |

## Integration Points

- **Upstream (ws-b):** Uses `dispatch.workstreams` and `dispatch.orchestrations` tables from migration 001
- **Upstream (ws-d):** Review tasks inserted into `dispatch.review_tasks` (same table the API routes read/update)
- **Upstream (ws-g):** All operations wrapped with `withToolSpan`/`withDbSpan` from telemetry module
- **Downstream (ws-final):** Validate LISTEN/NOTIFY fires on workstream status changes; confirm tick evaluator produces correct decisions; verify review task idempotency

## Deviations from Plan

- Skill files `skill/surfaces/lakebase.md` and `skill/roles/supervisor.md` not found at specified paths; used ws-b/ws-d/ws-g integration notes instead
- `completion_signals` installed at listener startup rather than as numbered migration (runtime DDL, consistent with AppKit guarded-DDL pattern for infrastructure tables)
- `has_uncommitted_changes` field always `false` from DB — actual git-status detection deferred to Release 1.1
