---
module: core/state-machine
version: 1.0.0
purpose: Defines the workstream state machine — states, transitions, guards, and contracts
depends_on: []
consumed_by: [core/prompt-synthesis, backends/*, tracking/*]
---

# State Machine

This module is the authoritative definition of workstream lifecycle states. All other modules implement against these definitions. Do not deviate from the state names, transitions, or guard conditions defined here.

## Workstream States

Every workstream exists in exactly one of these 7 states at any moment:

| State | Value | Description |
| --- | --- | --- |
| NOT_STARTED | `NOT_STARTED` | Initial state. Work has not begun. Set by system on init or by human after a reset from BLOCKED. |
| GATED | `GATED` | Gate check passed, upstream dependencies satisfied. Transient — immediately transitions to IN_PROGRESS in the same operation. |
| IN_PROGRESS | `IN_PROGRESS` | Actively executing. Only one instance may be IN_PROGRESS at any time. Self-pause enforced. |
| VALIDATING | `VALIDATING` | Execution steps complete. Output artifacts are being checked against gate_conditions. |
| COMPLETE | `COMPLETE` | Terminal state. All outputs verified. Never transitions to any other state. |
| BLOCKED | `BLOCKED` | Unrecoverable failure. Only a human can transition out of this state. |
| RETRYING | `RETRYING` | Failed but auto-retryable. System increments attempt_count and re-enters IN_PROGRESS. |

### State Enum (for programmatic use)

```python
from enum import Enum

class WorkstreamState(str, Enum):
    NOT_STARTED = "NOT_STARTED"
    GATED = "GATED"
    IN_PROGRESS = "IN_PROGRESS"
    VALIDATING = "VALIDATING"
    COMPLETE = "COMPLETE"
    BLOCKED = "BLOCKED"
    RETRYING = "RETRYING"
```

## State Transition Table

These are the ONLY valid transitions. Any transition not listed here is illegal and must be rejected.

| From | To | Trigger | Guard Condition |
| --- | --- | --- | --- |
| NOT_STARTED | GATED | Scheduled fire | Own status != COMPLETE AND all upstream dependencies = COMPLETE |
| GATED | IN_PROGRESS | Automatic | Same transaction as GATED (no separate trigger) |
| IN_PROGRESS | VALIDATING | Workstream (self) | All execution steps report complete |
| IN_PROGRESS | BLOCKED | Workstream (self) | Unrecoverable error detected |
| IN_PROGRESS | RETRYING | System (supervisor) | Retriable error AND attempt_count < max_retries |
| VALIDATING | COMPLETE | Workstream (self) | All gate_conditions pass AND output_artifacts verified |
| VALIDATING | RETRYING | System (supervisor) | Validation fails AND attempt_count < max_retries |
| BLOCKED | NOT_STARTED | Human | Manual reset after root cause fixed |
| RETRYING | IN_PROGRESS | System (auto) | Re-entry with prior_error context loaded |

### Illegal Transitions (explicitly prohibited)

- COMPLETE to any state (terminal, immutable)
- BLOCKED to any state except NOT_STARTED (only human reset allowed)
- NOT_STARTED to IN_PROGRESS (must pass through GATED)
- VALIDATING to IN_PROGRESS (must go through RETRYING)
- Any state to GATED (only NOT_STARTED can reach GATED)

## Guard Conditions

For each transition, these conditions MUST be true before the transition fires. Check them in order; fail on first unmet condition.

### NOT_STARTED to GATED

1. Read own status file — confirm current state is NOT_STARTED or RETRYING
2. Read all upstream dependency status files — confirm each is COMPLETE
3. If `depends_on: [none]`, skip step 2 (no upstream check needed)
4. Confirm orchestration state is ACTIVE (not CANCELLED or FAILED)

```yaml
# Example gate check logic
gate_check:
  read: own status file
  assert_current_state: [NOT_STARTED, RETRYING]
  read_each: depends_on[*] status files
  assert_all: status == COMPLETE
  on_fail: exit silently (do not mutate state)
```

### GATED to IN_PROGRESS

1. This is automatic — no separate guard. Fires in the same atomic operation as NOT_STARTED to GATED.
2. The claim protocol (see below) provides the atomicity guarantee.

### IN_PROGRESS to VALIDATING

1. All execution steps in the workstream's EXECUTE phase have completed
2. No unhandled errors remain in the execution context
3. Output artifacts declared in the workstream spec are addressable (file paths exist)

### IN_PROGRESS to BLOCKED

1. An unrecoverable error has occurred (permission denied, missing resource, impossible precondition)
2. OR session timeout reached (60 min) with incomplete work and no safe checkpoint
3. Set `error_message` in status file with actionable description

### IN_PROGRESS to RETRYING

1. A retriable error occurred (API timeout, transient failure, rate limit)
2. `attempt_count < max_retries` (default max_retries = 3)
3. System (supervisor) sets state, increments attempt_count, records prior_error

### VALIDATING to COMPLETE

1. All `gate_conditions` from the workstream spec evaluate to true
2. All `output_artifacts` exist and are non-empty
3. Content verification passes (file has substantive content, not just headers)

### VALIDATING to RETRYING

1. One or more gate_conditions failed
2. `attempt_count < max_retries`
3. The failure is potentially correctable by re-execution (not a design error)

### BLOCKED to NOT_STARTED

1. A human has reviewed the `error_message`
2. The root cause has been addressed
3. Human explicitly resets the state (edits status file)
4. `attempt_count` is preserved (not reset) — tracks total attempts across blocks

### RETRYING to IN_PROGRESS

1. System has incremented `attempt_count`
2. `prior_error` context is written to status file for the workstream to read
3. Cron is re-enabled (unpaused) for next fire
4. On next fire, workstream reads RETRYING state and loads error context

## Timeout Rules

| Scope | Timeout | Action on Timeout |
| --- | --- | --- |
| Session (overall) | 60 minutes | Save progress checkpoint, set BLOCKED with context |
| Gate check phase | 10 seconds | Exit silently (do not mutate state) |
| Claim phase | 5 seconds | Exit silently (assume another instance claimed) |
| Context phase | 60 seconds | Proceed with available context, note gaps |
| Execute phase | 50 minutes | If checkpoint possible: save + BLOCKED. If not: BLOCKED with partial progress note |
| Validate phase | 5 minutes | Set BLOCKED (validation should be fast) |
| Complete phase | 2 minutes | Set BLOCKED (completion should be fast) |

### Timeout Detection

Workstreams do not have wall-clock timers. Instead:
1. Record `started_at` timestamp when entering IN_PROGRESS
2. Before each major operation, check elapsed time
3. If approaching session limit (>55 min elapsed), enter graceful shutdown:
   - Save any partial artifacts
   - Write progress notes to status file
   - Set BLOCKED with `error_message: "Session timeout — progress saved at step N"`

## Retry Semantics

### Attempt Tracking

```yaml
# Status file fields for retry
attempt_count: 2          # Total attempts (never resets)
max_retries: 3            # Default; overridable per workstream
prior_error: |            # Context from last failure
  VALIDATING failed: output file state-machine.md was empty.
  Attempted fix: re-ran createAsset. Verify file write succeeded.
last_attempt_at: 2026-08-14T10:30:00Z
```

### Retry Flow

1. Supervisor detects failure (state stuck IN_PROGRESS after task completes, or VALIDATING failed)
2. Supervisor checks: `attempt_count < max_retries`?
   - YES: Set state to RETRYING, increment attempt_count, write prior_error, unpause cron
   - NO: Set state to BLOCKED with `error_message: "Max retries (3) exhausted"`
3. Cron fires, workstream reads RETRYING state
4. Workstream loads `prior_error` context into its execution prompt
5. Workstream transitions RETRYING to IN_PROGRESS (via GATED if dependencies need recheck)
6. Workstream executes with awareness of prior failure (adjusts strategy)

### Retry Strategy Escalation

| Attempt | Strategy |
| --- | --- |
| 1 | Standard execution |
| 2 | Re-read context, search docs for errors encountered in attempt 1 |
| 3 | Minimal execution — focus only on failing step, skip optional enrichments |
| 4+ | Not attempted — BLOCKED |

### What Carries Across Retries

- `attempt_count` — always increments, never resets
- `prior_error` — full error context from last attempt
- `last_attempt_at` — timestamp of last attempt start
- Partial artifacts — if prior attempt wrote files, they persist (do not delete)
- Status file notes — all accumulated notes preserved

### What Does NOT Carry

- In-memory state (each attempt is a fresh session)
- Transient variables or intermediate computations
- Any assumption about prior attempt's progress (re-verify everything)

## Orchestration States

The orchestration itself (the DAG of workstreams) has 6 states:

| State | Value | Description |
| --- | --- | --- |
| PLANNING | `PLANNING` | DAG is being constructed, workstreams defined. No execution. |
| PROVISIONED | `PROVISIONED` | All workstream tasks created and paused. Ready to launch. |
| ACTIVE | `ACTIVE` | At least one workstream is IN_PROGRESS or scheduled to fire. |
| COMPLETED | `COMPLETED` | The final workstream (WS-FINAL) has reached COMPLETE. |
| FAILED | `FAILED` | One or more workstreams are BLOCKED with no automatic recovery path. |
| CANCELLED | `CANCELLED` | Human cancelled before all workstreams completed. |

### Orchestration Transitions

| From | To | Trigger |
| --- | --- | --- |
| PLANNING | PROVISIONED | All workstream specs written + tasks created |
| PROVISIONED | ACTIVE | First workstream unpaused / fires |
| ACTIVE | COMPLETED | WS-FINAL status = COMPLETE |
| ACTIVE | FAILED | Any workstream BLOCKED + max_retries exhausted |
| ACTIVE | CANCELLED | Human cancellation signal |
| FAILED | ACTIVE | Human resets blocked workstream(s) |

## Claim Protocol

The claim protocol prevents duplicate execution. It is atomic from the workstream's perspective.

### Steps

1. **Read** own status file (gate check)
2. **Assert** state is NOT_STARTED or RETRYING
3. **Edit** status file: set `status: IN_PROGRESS` (this is the atomic claim)
4. **IN_PROGRESS state serves as duplicate-execution guard** — if another instance fires, it reads IN_PROGRESS at step 2 and exits

> **Note:** Workers do NOT self-pause. The orchestration supervisor (WS-INIT) owns all task lifecycle control — creating, pausing, unpausing, and deleting scheduled tasks. Workers are scheduling-unaware.

### Status File Format

```yaml
---
workstream_key: ws-a
name: Core State Machine
status: IN_PROGRESS
depends_on: [none]
scheduled_task_id: e9810312567d401eafb81b2fb1826025
task_paused: true
attempt_count: 1
created_at_tick: 1
error_message: null
prior_error: null
last_attempt_at: 2026-08-14T10:00:00Z
---

# Workstream ws-a: Core State Machine

## Notes for Downstream Sessions

(Populated on COMPLETE — consumed by dependent workstreams)
```

### Atomicity Guarantee

File-based state uses `editAsset` with exact `old_text` matching:
- If another instance already claimed (changed NOT_STARTED to IN_PROGRESS), the `old_text` match fails
- The edit returns `changed: false` — exit without executing
- This provides compare-and-swap semantics without a database

```yaml
# Claim operation
editAsset:
  old_text: "status: NOT_STARTED"
  new_text: "status: IN_PROGRESS"
  # If old_text not found: another instance claimed, exit
```

## Contracts for Downstream Modules

### Backend Contract

Every backend (file-backend, notebook-backend, etc.) MUST implement:

1. **State Reads**: Read status files and parse YAML frontmatter to extract current state
2. **State Writes**: Use editAsset with exact old_text matching for atomic transitions
3. **Transition Logging**: Record every state transition with timestamp and trigger reason
4. **Error Reporting**: On failure, set `error_message` with actionable context before transitioning to BLOCKED
5. **Artifact Registration**: On COMPLETE, list all output artifacts in the Notes section

**States backends set directly:**
- IN_PROGRESS (via claim protocol)
- VALIDATING (after execution completes)
- COMPLETE (after validation passes)
- BLOCKED (on unrecoverable error)

**States backends NEVER set:**
- NOT_STARTED (system init or human reset only)
- GATED (transient, part of claim)
- RETRYING (supervisor only)

### Tracking Contract

Tracking modules MUST record:

1. **Transition Events**: `{workstream_key, from_state, to_state, timestamp, trigger, actor}`
2. **Attempt Records**: `{workstream_key, attempt_number, started_at, ended_at, outcome, error_message}`
3. **Artifact Records**: `{workstream_key, artifact_path, verified_at, size_bytes}`
4. **Orchestration Events**: `{orchestration_id, from_state, to_state, timestamp, trigger}`

**Event Schema:**

```yaml
transition_event:
  workstream_key: string     # e.g., "ws-a"
  from_state: WorkstreamState
  to_state: WorkstreamState
  timestamp: ISO8601
  trigger: enum [scheduled_fire, self, supervisor, human]
  actor: string              # task_id, human email, or "system"
  context: string | null     # optional notes (error messages, etc.)
```

### Prompt Synthesis Contract

Prompt synthesis modules MUST embed:

1. **Gate Check Logic**: The exact sequence from Guard Conditions above (read state, check upstream, decide)
2. **Claim Logic**: The atomic edit pattern with old_text/new_text and failure-exit behavior
3. **State Names**: Use the exact enum values (NOT_STARTED, GATED, IN_PROGRESS, VALIDATING, COMPLETE, BLOCKED, RETRYING)
4. **Timeout Awareness**: Include session timeout warning and graceful shutdown protocol
5. **Retry Context Loading**: When state is RETRYING, prompt must instruct loading `prior_error` and adapting strategy

**Prompt must include these decision points:**

```
IF status == COMPLETE: respond "Already complete." STOP.
IF status == IN_PROGRESS: respond "Already running." STOP.
IF status == BLOCKED: respond "Blocked." STOP.
IF status == RETRYING: load prior_error, proceed with adapted strategy.
IF status == NOT_STARTED: check upstream, claim, execute.
```

## Invariants (Always True)

1. COMPLETE is terminal — never transitions out
2. Only humans transition out of BLOCKED
3. RETRYING always increments attempt_count
4. At most one instance IN_PROGRESS per workstream at any time
5. Gate checks are read-only (never mutate state on failure)
6. Every state transition is recorded (no silent mutations)
7. Status files are the single source of truth for workstream state
8. Orchestration COMPLETED only when WS-FINAL is COMPLETE
9. max_retries defaults to 3 unless overridden in workstream spec
10. prior_error context is always written before RETRYING is set
