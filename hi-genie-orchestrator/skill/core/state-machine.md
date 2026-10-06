---
module: core/state-machine
version: 1.0.0
purpose: Authoritative workstream lifecycle states, transitions, and guards (Lakebase-enforced)
depends_on: []
consumed_by: [roles/supervisor, roles/worker, capabilities/prompt-synthesis, backends/*]
---

# State Machine

This module is the authoritative definition of workstream lifecycle states.
All other modules implement against these definitions. Transitions are enforced
server-side by the `update_workstream_status` MCP tool — illegal transitions
are rejected with a 400 error.

## Workstream States

Every workstream exists in exactly one of these 7 states:

| State | Value | Description |
| --- | --- | --- |
| NOT_STARTED | `NOT_STARTED` | Initial state. Work has not begun. |
| GATED | `GATED` | Gate check passed, upstream dependencies satisfied. Transient — immediately transitions to IN_PROGRESS. |
| IN_PROGRESS | `IN_PROGRESS` | Actively executing. Worker session is running. |
| VALIDATING | `VALIDATING` | Execution complete. Output artifacts being verified against gate_conditions. |
| COMPLETE | `COMPLETE` | Terminal state. All outputs verified. Never transitions out. |
| BLOCKED | `BLOCKED` | Unrecoverable failure. Only a human can transition out via Supervisor override. |
| RETRYING | `RETRYING` | Failed but auto-retryable. System increments attempt_count and re-enters IN_PROGRESS. |

## State Transition Table

These are the ONLY valid transitions. The `update_workstream_status` MCP tool
rejects any transition not listed here.

| From | To | Trigger | Guard |
| --- | --- | --- | --- |
| NOT_STARTED | GATED | Supervisor tick | All `depends_on` workstreams = COMPLETE |
| GATED | IN_PROGRESS | Automatic | Same transaction as GATED (no separate trigger) |
| IN_PROGRESS | VALIDATING | Worker (self) | Worker reports execution steps complete |
| IN_PROGRESS | BLOCKED | Worker (self) | Unrecoverable error detected |
| IN_PROGRESS | RETRYING | Supervisor | Retriable error AND attempt_count < max_retries |
| VALIDATING | COMPLETE | Worker (self) | All gate_conditions pass |
| VALIDATING | RETRYING | Supervisor | Validation fails AND attempt_count < max_retries |
| BLOCKED | NOT_STARTED | Human (Supervisor override) | Manual reset after root cause fixed |
| RETRYING | IN_PROGRESS | Supervisor (auto) | Re-dispatch with prior_error context |

### Illegal Transitions (explicitly prohibited)

- COMPLETE to any state (terminal, immutable)
- NOT_STARTED to IN_PROGRESS (must pass through GATED)
- BLOCKED to IN_PROGRESS (must reset to NOT_STARTED first)
- Any state to NOT_STARTED (except BLOCKED → NOT_STARTED by human)

## Enforcement via MCP Tools

### `update_workstream_status`

```
Tool: update_workstream_status
Params:
  orchestration_id: string
  workstream_key: string
  status: WorkstreamState
  notes?: string
  error_message?: string  (required for BLOCKED/RETRYING)
```

The server validates:
1. Current state allows transition to requested state (per table above)
2. Caller identity matches expected role (worker can't reset BLOCKED)
3. Optimistic concurrency check on workstream row

### `get_workstream_context`

Returns current state + all metadata needed for transition decisions:
- `status` — current WorkstreamState
- `attempt_count` — how many times this workstream has been attempted
- `max_retries` — configured retry limit
- `depends_on` — upstream workstream keys
- `upstream_statuses` — resolved status of each dependency
- `error_history` — prior error messages (for retry context)

## Supervisor Tick Decision Tree

The Supervisor evaluates workstreams in this priority order each tick:

```
1. HANDLE_STUCK     — IN_PROGRESS with heartbeat > timeout_threshold
2. RESUME_RETRY     — RETRYING workstreams ready for re-dispatch
3. CREATE_NEXT      — NOT_STARTED with all deps COMPLETE (gate check)
4. SURFACE_BLOCKER  — BLOCKED workstreams needing human attention
5. UNPAUSE_READY    — Paused workers that can resume
6. GIT_SYNC         — Branch synchronization (if git mode)
7. STATUS_REPORT    — Log current orchestration state
8. NO_OP            — Nothing to do this tick
```

First match wins. One action per tick.

## Orchestration-Level States

The orchestration itself has a lifecycle:

| State | Meaning |
| --- | --- |
| PLANNING | Plan published, not yet materialized |
| ACTIVE | At least one workstream dispatched |
| COMPLETED | ws-final reached COMPLETE |
| FAILED | Unrecoverable (all retries exhausted, human intervention needed) |
| PAUSED | Human-initiated pause (no new dispatches) |

## Heartbeat and Timeout

Workers emit implicit heartbeats via MCP tool calls. The Supervisor detects
stuck workers when `heartbeat_at` exceeds `timeout_threshold_min`.

Default timeout: 15 minutes (configurable per workstream in plan config).

Stuck detection flow:
1. Supervisor tick finds IN_PROGRESS workstream with stale heartbeat
2. Transition to RETRYING (if attempts remain) or BLOCKED (if exhausted)
3. Log the stuck detection event for observability
