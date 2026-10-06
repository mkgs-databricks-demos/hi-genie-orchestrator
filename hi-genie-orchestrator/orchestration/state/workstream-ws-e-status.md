---
workstream_key: ws-e
name: Event Dispatch and WS-INIT
status: COMPLETE
depends_on: [ws-b, ws-d]
scheduled_task_id: b8cd1e71fd30470792dc736711e893d7
task_paused: false
attempt_count: 1
max_retries: 5
started_at: "2026-08-18T12:00:00Z"
completed_at: "2026-08-18T12:10:00Z"
error_message: null
prior_error: null
last_attempt_at: "2026-08-18T12:00:00Z"
---

# Workstream ws-e: Event Dispatch and WS-INIT

## Scope

Implement event-driven dispatch in `server/dispatch/`:
- `completion_signals` table + pg_notify trigger
- LISTEN/NOTIFY consumer in App process
- Scheduled tick recovery (periodic fallback when notifications missed)
- WS-INIT stateless priority-tree:
  HANDLE_STUCK > RESUME_RETRY > CREATE_NEXT > SURFACE_BLOCKER >
  UNPAUSE_READY > GIT_SYNC > STATUS_REPORT > NO_OP
- Review dispatch: detect READY_FOR_REVIEW, create review tasks
- Completion signal processing: advance DAG on task completion

## Notes for Downstream Sessions

### Files Created

All paths relative to `mcp-hi-genie-orchestrator/server/dispatch/`:

| File | Lines | Purpose |
| --- | --- | --- |
| `index.ts` | 346 | Module entry point, `setupDispatch(appkit)`, action executor, graceful shutdown, barrel re-exports |
| `listener.ts` | 333 | Lakebase LISTEN/NOTIFY consumer, `completion_signals` DDL, pg_notify trigger, exponential backoff reconnect |
| `tick-evaluator.ts` | 268 | Periodic interval (60s), state fetch, fingerprint deduplication, signal drain recovery |
| `priority-tree.ts` | 337 | 8-priority stateless decision tree (HANDLE_STUCK through NO_OP), typed evaluator |
| `review-dispatcher.ts` | 312 | READY_FOR_REVIEW detection, idempotent review task creation (SHA-256 review_task_id) |

### Key Function Signatures

```typescript
// Entry point (server.ts onPluginsReady)
export async function setupDispatch(appkit: AppKit): Promise<void>;

// Graceful shutdown
export async function shutdownDispatch(): Promise<void>;

// Priority-tree evaluator (stateless, pure)
export function evaluatePriorityTree(
  states: WorkstreamState[],
  config?: Partial<PriorityTreeConfig>,
): DispatchDecision;

// All-actions evaluator (for batch/status reporting)
export function evaluateAllActions(
  states: WorkstreamState[],
  config?: Partial<PriorityTreeConfig>,
): DispatchDecision[];
```

### Integration Notes for ws-final

- **Import in server.ts:** Already uncommented: `import { setupDispatch } from './dispatch/index.js'` (line 25) and `await setupDispatch(appkit)` (line 53).
- **Pool access:** Uses `appkit.lakebase.pool` for all DB operations.
- **Telemetry:** All operations wrapped with `withToolSpan` and `withDbSpan` from `../telemetry/index.js`.
- **DDL at startup:** `listener.ts` installs `dispatch.completion_signals` table and `trg_workstream_status_notify` trigger via `IF NOT EXISTS` / `CREATE OR REPLACE`. These are runtime DDL additions to the dispatch schema (additive to ws-b migrations).
- **Environment variables consumed:** `DISPATCH_TICK_INTERVAL_MS` (default 60000), `DISPATCH_STUCK_THRESHOLD_MIN` (default 90), `DISPATCH_LISTEN_ENABLED` (default true), `DISPATCH_GIT_SYNC_ENABLED` (default true).
- **Notification channel:** `workstream_status_changed` — fires on any status column UPDATE in `dispatch.workstreams`.
- **Review task idempotency:** `review_task_id` = SHA-256(`orchestration_id:workstream_key:attempt_count`) formatted as UUID-like hex.
- **Action routing:** Priority-tree produces decisions; `executeAction()` in `index.ts` routes to DB mutations (HANDLE_STUCK → RETRYING, RESUME_RETRY → IN_PROGRESS+1, CREATE_NEXT → IN_PROGRESS, UNPAUSE_READY → NOT_STARTED+unpaused).
- **Graceful shutdown:** Call `shutdownDispatch()` before pool.end() in the App shutdown handler.

### Deviations from Plan

- Skill files `skill/surfaces/lakebase.md` and `skill/roles/supervisor.md` were not found at the specified paths; implementation proceeded using ws-b, ws-d, and ws-g integration notes as primary references.
- `completion_signals` DDL is applied at listener startup (not as a numbered migration) since it's a runtime infrastructure table that the trigger depends on; this is consistent with the pattern of guarded `IF NOT EXISTS` DDL for dispatch-owned infrastructure.
- Git sync detection (`has_uncommitted_changes`) defaults to `false` in the tick evaluator's DB query — actual detection requires an out-of-band mechanism (scheduled git-status check) that is Release 1.1 scope.
