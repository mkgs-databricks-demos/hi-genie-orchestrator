# Error Handling & Recovery

Error handling for both dispatcher-side (Supervisor) and worker-side operations.
Covers status semantics, timeout detection, retry logic, and escalation paths.

## Status Recovery Table

| Status | Meaning | Who Detects | Recovery |
| --- | --- | --- | --- |
| `IN_PROGRESS` + heartbeat stale | Worker died or hung | Dispatcher (tick) | Mark `RETRYING` if attempts < max; else `BLOCKED` |
| `BLOCKED` | Unrecoverable without human intervention | Worker (self) or Dispatcher | Human reads error, fixes root cause, resets to `NOT_STARTED` |
| `RETRYING` | Failed but auto-retryable | Dispatcher | Create new worker task with error context, transition to `IN_PROGRESS` |
| `VALIDATING` + stale | Worker died during validation | Dispatcher (tick) | Same as stale `IN_PROGRESS` |
| `READY_FOR_REVIEW` | Worker done, awaiting review | Dispatcher (tick) | Create review task |
| `FIX_REQUIRED` | Review found issues | Supervisor (after review) | Deliver remediation, worker re-enters `IN_PROGRESS` |

## Timeout Detection (Implicit Heartbeat)

Every MCP tool call updates `heartbeat_at` on the execution record. The
dispatcher tick checks:

```text
IF status IN (IN_PROGRESS, VALIDATING)
  AND heartbeat_at < (now - timeout_threshold_min)
  THEN workstream is stuck
```

Default `timeout_threshold_min`: 45 minutes (configurable per workstream).

### Why 45 minutes?

- Genie Code sessions have a ~60-minute execution limit
- A 45-minute threshold catches dead workers before the session expires
- Workers should call MCP tools every 15–20 minutes minimum during long operations

## Dispatcher-Side Error Handling

### Tick Evaluation Failures

| Failure | Impact | Recovery |
| --- | --- | --- |
| App unreachable (5xx/timeout) | Cannot evaluate workstreams | Retry on next tick (hourly safety net) |
| MCP Service `EXECUTE` revoked | Workers can't connect | Alert human; re-grant permission |
| Lakebase connection failure | State reads fail | App health endpoint reports unhealthy; retry |
| Orchestration not found | Invalid orchestration_id | Log error; skip this orchestration |

### Worker Spawn Failures

| Failure | Impact | Recovery |
| --- | --- | --- |
| `scheduleAgentTool` fails | Worker not created | Log error; retry on next tick |
| Worker starts but never calls MCP | Bootstrap prompt may be malformed | Detect via heartbeat; mark `RETRYING` with diagnostic context |
| Worker calls MCP but status claim fails | Another worker already claimed it (race) | Expected — optimistic concurrency working correctly |

### Review Routing Failures

| Failure | Impact | Recovery |
| --- | --- | --- |
| Review task creation fails | Worker stays in `READY_FOR_REVIEW` | Retry on next tick |
| Reviewer never starts | Review task idle | Timeout detection on review session |
| Reviewer errors out | Review incomplete | Create new reviewer task |

## Worker-Side Error Handling

### Self-Correction Protocol

```text
1. Encounter error
2. Check if same error class seen before:
   get_relevant_errors(project_id, workstream_id, error_class)
3. If prior resolution exists: apply it
4. If not: attempt self-correction (max 3 tries per error)
5. After 3 failed self-corrections:
   record_error(project_id, error_class, message, is_blocking=true)
   update_workstream_status(workstream_id, "BLOCKED", reason="...")
   end_session(session_id, summary="Blocked: ...")
```

### Error Recording Best Practices

Always record errors — even self-corrected ones. This builds the error corpus
that helps future attempts:

```text
record_error(
  project_id,
  error_class="AnalysisException",
  message="Table not found: hls_fde.hi_genie_prod.claims_raw",
  is_blocking=false,  // self-corrected
  resolution="Created table via DDL in uc_setup notebook",
  workstream_id="ws-claims-etl"
)
```

### Heartbeat Maintenance

During long-running operations (bundle deploys, notebook executions, pipeline runs):

```text
// Before starting a 10+ minute operation:
record_workstream_event(project_id, workstream_id, "long_operation_start", {
  operation: "bundle deploy",
  estimated_duration_min: 15
})

// After completion:
record_workstream_event(project_id, workstream_id, "long_operation_complete", {
  operation: "bundle deploy",
  actual_duration_min: 12,
  result: "success"
})
```

## Retry Semantics

| Config | Default | Description |
| --- | --- | --- |
| `max_retries` | 3 | Maximum automatic retry attempts |
| `timeout_threshold_min` | 45 | Minutes of heartbeat silence before "stuck" |
| `retry_delay_min` | 0 | Delay before spawning retry worker (immediate) |
| `error_context_lines` | 50 | Lines of error context passed to retry prompt |

Retry workers receive:
- Full prior error history via `get_relevant_errors`
- Last error summary in the bootstrap prompt (truncated)
- Incremented `attempt_number`
- Same `orchestration_id` and `workstream_key`

## Escalation Path

```text
Attempt 1 fails → Dispatcher marks RETRYING → Spawns attempt 2
Attempt 2 fails → Dispatcher marks RETRYING → Spawns attempt 3
Attempt 3 fails → Dispatcher marks BLOCKED → Surfaces to human with:
  - All 3 error records
  - Consolidated error pattern
  - Suggested resolution (from error corpus if available)
  - Link to workstream context for manual inspection
```

Human intervention for `BLOCKED` workstreams:
1. Read the error records (via UI or MCP)
2. Fix the root cause (external resource, permission, code bug)
3. Reset status to `NOT_STARTED`
4. Dispatcher picks it up on next tick and dispatches attempt 4
