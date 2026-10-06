---
module: tracking/observability
version: 1.0.0
purpose: Tick logging, duration tracking, queryable history, dashboard-ready views, and alerting patterns
depends_on: [core/state-machine, tracking/lakebase-schema, tracking/status-protocol]
consumed_by: [core/ws-init, backends/*, dashboards]
---

# Observability

This module defines how orchestration execution is observed, measured, and surfaced. It covers tick logging by the supervisor, duration inference for workstreams, queryable history patterns, pre-built dashboard views, and alerting conditions.

> **Not used in this project.** This module's tick-logging, dashboard views, and alerting patterns all assume Lakebase-mode tracking (see `tracking/lakebase-schema.md`). Hi Genie Orchestrator runs File Mode (`plan.json` → `state.mode: "file"`), so this module is inert here — kept for portable-skill reference only. This project's own observability deliverable is ws-g (OpenTelemetry + MLflow 3), which is unrelated to this orchestrator-skill module.

## Tick Logging

The supervisor fires on a schedule (typically every 5–15 minutes). Each fire is a **tick** — a stateless evaluation of the orchestration DAG that produces exactly one action. Ticks are the fundamental unit of supervisor observability.

### Tick Record Format

Every tick produces one record in the `ticks` table:

| Field | Type | Description |
| --- | --- | --- |
| tick_number | INT | Monotonically increasing per orchestration |
| orchestration_id | UUID | Which orchestration this tick evaluated |
| action_taken | TEXT | The decision made (see enum below) |
| action_target | TEXT | Workstream key affected, or NULL for orchestration-level actions |
| decision_reasoning | TEXT | Human-readable explanation of why this action was chosen |
| state_snapshot | JSONB | Full state map at time of evaluation: `{"ws-a": "COMPLETE", "ws-b": "IN_PROGRESS", ...}` |
| started_at | TIMESTAMPTZ | When the tick evaluation began |
| completed_at | TIMESTAMPTZ | When the tick evaluation finished |
| duration_ms | INT | Tick processing time in milliseconds |

### Action Enum

| Action | Meaning | Target |
| --- | --- | --- |
| LAUNCH_WORKSTREAM | Unpaused a workstream task for first execution | workstream_key |
| UNPAUSE_RETRY | Unpaused a workstream task for retry | workstream_key |
| SET_BLOCKED | Marked a workstream as BLOCKED (timeout or error) | workstream_key |
| MARK_COMPLETE | Detected workstream completion externally | workstream_key |
| DETECT_TIMEOUT | Identified a timed-out workstream | workstream_key |
| SYNTHESIZE_PROMPT | Generated/updated a workstream prompt | workstream_key |
| EVALUATE_GATES | Checked gate conditions for pending workstreams | workstream_key |
| NO_ACTION | All workstreams either COMPLETE, BLOCKED, or waiting | NULL |
| ORCHESTRATION_COMPLETE | All workstreams reached COMPLETE | NULL |
| ORCHESTRATION_FAILED | Orchestration entered FAILED state | NULL |

### Tick Logging Protocol (Lakebase)

```sql
-- Record a tick at the START of evaluation
INSERT INTO ticks (orchestration_id, tick_number, action_taken, action_target,
                   decision_reasoning, state_snapshot, started_at)
VALUES (
    :orch_uuid,
    (SELECT COALESCE(MAX(tick_number), 0) + 1 FROM ticks WHERE orchestration_id = :orch_uuid),
    'NO_ACTION',  -- placeholder, updated after decision
    NULL,
    NULL,
    :state_json,
    now()
)
RETURNING id, tick_number;

-- After decision is made, update the tick record
UPDATE ticks
SET action_taken = :action,
    action_target = :target,
    decision_reasoning = :reasoning,
    completed_at = now(),
    duration_ms = EXTRACT(EPOCH FROM (now() - started_at))::INT * 1000
WHERE id = :tick_uuid;
```

### Tick Logging Protocol (File Mode)

In file mode, append tick records to the orchestration status file:

```markdown
## Tick History

| Tick | Time | Action | Target | Reasoning | Duration |
| --- | --- | --- | --- | --- | --- |
| 6 | 2026-08-14T11:30:00Z | LAUNCH_WORKSTREAM | ws-e | Upstream ws-a complete, gate passed | 3200ms |
| 5 | 2026-08-14T11:15:00Z | NO_ACTION | - | ws-c, ws-d still IN_PROGRESS | 1500ms |
```

Append new rows at the top (most recent first). Keep the last 50 ticks in-file; older ticks are implicitly archived (available in file revision history).

## Duration Inference

Workstream duration is computed, not stored as a running counter. This avoids clock-drift issues and works across session boundaries.

### Computing Duration

```sql
-- For completed workstreams:
SELECT workstream_key,
       EXTRACT(EPOCH FROM (completed_at - started_at))::INT AS duration_seconds,
       EXTRACT(EPOCH FROM (completed_at - started_at))::INT / 60.0 AS duration_minutes
FROM workstreams
WHERE orchestration_id = :orch_uuid
  AND status = 'COMPLETE';

-- For in-progress workstreams (elapsed time):
SELECT workstream_key,
       EXTRACT(EPOCH FROM (now() - started_at))::INT AS elapsed_seconds,
       EXTRACT(EPOCH FROM (now() - started_at))::INT / 60.0 AS elapsed_minutes
FROM workstreams
WHERE orchestration_id = :orch_uuid
  AND status = 'IN_PROGRESS';
```

### Timeout Detection

A workstream is considered timed out when elapsed time exceeds its estimated duration by a factor of 2:

```sql
-- Detect timed-out workstreams
SELECT workstream_key, started_at, estimated_duration_min,
       EXTRACT(EPOCH FROM (now() - started_at))::INT / 60.0 AS elapsed_min
FROM workstreams
WHERE orchestration_id = :orch_uuid
  AND status = 'IN_PROGRESS'
  AND started_at IS NOT NULL
  AND estimated_duration_min IS NOT NULL
  AND EXTRACT(EPOCH FROM (now() - started_at)) > (estimated_duration_min * 2 * 60);
```

Timeout thresholds:
- Default: `estimated_duration_min * 2`
- Minimum: 30 minutes (never timeout before 30 min)
- Maximum: 120 minutes (always timeout after 2 hours regardless of estimate)

### Silent Failure Detection

A workstream is "silently failed" if its scheduled task completed but state never changed from IN_PROGRESS:

```sql
-- Workstreams stuck IN_PROGRESS with no recent activity
SELECT workstream_key, started_at,
       EXTRACT(EPOCH FROM (now() - started_at))::INT / 60.0 AS stuck_minutes
FROM workstreams
WHERE orchestration_id = :orch_uuid
  AND status = 'IN_PROGRESS'
  AND started_at < now() - INTERVAL '45 minutes'
  AND workstream_key NOT IN (
      SELECT DISTINCT action_target FROM ticks
      WHERE orchestration_id = :orch_uuid
        AND started_at > now() - INTERVAL '15 minutes'
        AND action_target IS NOT NULL
  );
```

## Queryable History

Common observability queries for Lakebase mode:

### Current Orchestration State

```sql
-- "What's the current state of orchestration X?"
SELECT o.orchestration_id, o.status AS orch_status,
       o.total_workstreams, o.completed_workstreams,
       ROUND(o.completed_workstreams::NUMERIC / NULLIF(o.total_workstreams, 0) * 100, 1) AS pct_complete,
       EXTRACT(EPOCH FROM (COALESCE(o.completed_at, now()) - o.activated_at))::INT / 60 AS elapsed_min
FROM orchestrations o
WHERE o.orchestration_id = :orch_id;
```

### Workstream State Summary

```sql
-- All workstreams with current state
SELECT workstream_key, name, status, attempt_count,
       started_at, completed_at,
       CASE WHEN completed_at IS NOT NULL
            THEN EXTRACT(EPOCH FROM (completed_at - started_at))::INT / 60
            WHEN started_at IS NOT NULL
            THEN EXTRACT(EPOCH FROM (now() - started_at))::INT / 60
            ELSE NULL
       END AS duration_min,
       error_message
FROM workstreams
WHERE orchestration_id = :orch_uuid
ORDER BY created_at_tick;
```

### Transition History for a Workstream

```sql
-- "Show me all transitions for workstream Y"
SELECT st.from_status, st.to_status, st.reason,
       st.transitioned_at, st.transitioned_by
FROM state_transitions st
JOIN workstreams w ON st.workstream_id = w.id
WHERE w.orchestration_id = :orch_uuid
  AND w.workstream_key = :ws_key
ORDER BY st.transitioned_at;
```

### Longest-Running Workstreams

```sql
-- "Which workstreams took longest?"
SELECT workstream_key, name, status,
       EXTRACT(EPOCH FROM (COALESCE(completed_at, now()) - started_at))::INT / 60 AS duration_min,
       attempt_count
FROM workstreams
WHERE orchestration_id = :orch_uuid
  AND started_at IS NOT NULL
ORDER BY EXTRACT(EPOCH FROM (COALESCE(completed_at, now()) - started_at)) DESC
LIMIT 10;
```

### Supervisor Tick History

```sql
-- "Show me the supervisor tick history"
SELECT tick_number, action_taken, action_target,
       decision_reasoning, duration_ms,
       started_at
FROM ticks
WHERE orchestration_id = :orch_uuid
ORDER BY tick_number DESC
LIMIT 20;
```

### Error Report

```sql
-- "What errors occurred across the orchestration?"
SELECT w.workstream_key, w.name, w.status, w.error_message,
       e.error_category, e.attempt_number, e.started_at AS attempt_started,
       e.session_summary
FROM workstreams w
LEFT JOIN executions e ON e.workstream_id = w.id AND e.status IN ('FAILED', 'TIMED_OUT')
WHERE w.orchestration_id = :orch_uuid
  AND (w.status = 'BLOCKED' OR e.status IS NOT NULL)
ORDER BY e.started_at DESC;
```

### Artifact Inventory

```sql
-- "What artifacts were produced?"
SELECT w.workstream_key, a.artifact_path, a.artifact_type,
       a.verified, a.verified_at, a.line_count, a.size_bytes
FROM artifacts a
JOIN workstreams w ON a.workstream_id = w.id
WHERE w.orchestration_id = :orch_uuid
ORDER BY a.created_at;
```

## Dashboard-Ready Views

Create these views for direct consumption by dashboards and reporting tools:

### v_orchestration_summary

High-level orchestration progress and health.

```sql
CREATE OR REPLACE VIEW v_orchestration_summary AS
SELECT
    o.orchestration_id,
    o.project_name,
    o.status,
    o.total_workstreams,
    o.completed_workstreams,
    ROUND(o.completed_workstreams::NUMERIC / NULLIF(o.total_workstreams, 0) * 100, 1) AS progress_pct,
    o.activated_at,
    o.completed_at,
    EXTRACT(EPOCH FROM (COALESCE(o.completed_at, now()) - o.activated_at))::INT / 60 AS total_elapsed_min,
    COUNT(CASE WHEN w.status = 'BLOCKED' THEN 1 END) AS blocked_count,
    COUNT(CASE WHEN w.status = 'IN_PROGRESS' THEN 1 END) AS active_count,
    COUNT(CASE WHEN w.status = 'RETRYING' THEN 1 END) AS retrying_count,
    COUNT(CASE WHEN w.status IN ('NOT_STARTED', 'GATED') THEN 1 END) AS pending_count,
    CASE
        WHEN o.status = 'COMPLETED' THEN 'healthy'
        WHEN COUNT(CASE WHEN w.status = 'BLOCKED' THEN 1 END) > 0 THEN 'degraded'
        WHEN o.status = 'ACTIVE' THEN 'healthy'
        ELSE 'unknown'
    END AS health_indicator
FROM orchestrations o
LEFT JOIN workstreams w ON w.orchestration_id = o.id
GROUP BY o.id, o.orchestration_id, o.project_name, o.status,
         o.total_workstreams, o.completed_workstreams,
         o.activated_at, o.completed_at;
```

### v_workstream_timeline

Gantt-chart-ready view for visualizing workstream execution over time.

```sql
CREATE OR REPLACE VIEW v_workstream_timeline AS
SELECT
    w.workstream_key,
    w.name,
    w.status,
    w.depends_on,
    w.started_at,
    COALESCE(w.completed_at, now()) AS ended_at,
    w.attempt_count,
    w.estimated_duration_min,
    EXTRACT(EPOCH FROM (COALESCE(w.completed_at, now()) - w.started_at))::INT / 60 AS actual_duration_min,
    CASE
        WHEN w.completed_at IS NOT NULL AND w.estimated_duration_min IS NOT NULL
        THEN ROUND(
            EXTRACT(EPOCH FROM (w.completed_at - w.started_at))::NUMERIC / 60
            / w.estimated_duration_min * 100, 0
        )
        ELSE NULL
    END AS duration_pct_of_estimate,
    w.error_message,
    o.orchestration_id
FROM workstreams w
JOIN orchestrations o ON w.orchestration_id = o.id
WHERE w.started_at IS NOT NULL
ORDER BY w.started_at;
```

### v_tick_history

Human-readable tick log with enriched descriptions.

```sql
CREATE OR REPLACE VIEW v_tick_history AS
SELECT
    t.tick_number,
    o.orchestration_id,
    t.action_taken,
    t.action_target,
    t.decision_reasoning,
    t.state_snapshot,
    t.started_at,
    t.duration_ms,
    CASE t.action_taken
        WHEN 'LAUNCH_WORKSTREAM' THEN 'Launched ' || COALESCE(t.action_target, '?')
        WHEN 'UNPAUSE_RETRY' THEN 'Retrying ' || COALESCE(t.action_target, '?')
        WHEN 'SET_BLOCKED' THEN 'Blocked ' || COALESCE(t.action_target, '?')
        WHEN 'DETECT_TIMEOUT' THEN 'Timeout on ' || COALESCE(t.action_target, '?')
        WHEN 'SYNTHESIZE_PROMPT' THEN 'Synthesized prompt for ' || COALESCE(t.action_target, '?')
        WHEN 'EVALUATE_GATES' THEN 'Evaluated gates for ' || COALESCE(t.action_target, '?')
        WHEN 'NO_ACTION' THEN 'No action needed'
        WHEN 'ORCHESTRATION_COMPLETE' THEN 'Orchestration completed'
        WHEN 'ORCHESTRATION_FAILED' THEN 'Orchestration failed'
        ELSE t.action_taken
    END AS human_description
FROM ticks t
JOIN orchestrations o ON t.orchestration_id = o.id
ORDER BY t.started_at DESC;
```

### v_error_report

All errors with context, timestamps, and resolution status.

```sql
CREATE OR REPLACE VIEW v_error_report AS
SELECT
    w.workstream_key,
    w.name AS workstream_name,
    w.status AS current_status,
    e.attempt_number,
    e.error_message,
    e.error_category,
    e.started_at AS attempt_started,
    e.completed_at AS attempt_ended,
    e.duration_seconds,
    e.session_summary,
    CASE
        WHEN w.status = 'COMPLETE' THEN 'resolved'
        WHEN w.status = 'BLOCKED' THEN 'unresolved'
        WHEN w.status = 'RETRYING' THEN 'retrying'
        WHEN w.status = 'IN_PROGRESS' THEN 'in_progress'
        ELSE 'unknown'
    END AS resolution_status,
    o.orchestration_id
FROM executions e
JOIN workstreams w ON e.workstream_id = w.id
JOIN orchestrations o ON w.orchestration_id = o.id
WHERE e.status IN ('FAILED', 'TIMED_OUT')
ORDER BY e.started_at DESC;
```

## File-Based Observability

When running in file mode, full SQL observability is not available. Use these alternatives:

### State Reconstruction

Read all status files in the state directory to reconstruct the DAG:

```python
# Pseudo-code for file-mode state reconstruction
state = {}
for ws_key in all_workstream_keys:
    content = readAssetById("file", f".../state/workstream-{ws_key}-status.md")
    frontmatter = parse_yaml_frontmatter(content)
    state[ws_key] = frontmatter["status"]
```

### Duration Calculation (File Mode)

Not directly available (status files don't track `started_at` as TIMESTAMPTZ). Workarounds:
1. Add `started_at` and `completed_at` fields to YAML frontmatter
2. Infer from workspace file modification timestamps
3. Parse tick history section for timing data

### Limitations of File-Based Observability

| Capability | Lakebase | File Mode |
| --- | --- | --- |
| Real-time state query | Full SQL | Must read N files |
| Transition history | Complete, queryable | Limited to in-file log + revisions |
| Aggregate statistics | Views, GROUP BY | Manual computation |
| Duration tracking | Computed columns | Requires frontmatter timestamps |
| Error patterns | SQL filtering | Manual review |
| Tick history | Full table, indexed | Last 50 in status file |
| Cross-orchestration queries | JOIN across orchestrations | Not practical |

### Recommendation

Use file mode for development and single-orchestration runs. Switch to Lakebase mode when:
- Running multiple orchestrations concurrently
- Need historical comparison across runs
- Require dashboards or automated alerting
- DAG has > 10 workstreams

## Alerting Patterns

Conditions that should surface to humans for intervention:

### Critical Alerts (Immediate Action Required)

| Condition | Detection Query | Action |
| --- | --- | --- |
| Workstream BLOCKED | `SELECT * FROM workstreams WHERE status = 'BLOCKED'` | Human review error_message, fix root cause, reset to NOT_STARTED |
| Orchestration FAILED | `SELECT * FROM orchestrations WHERE status = 'FAILED'` | Review all BLOCKED workstreams, determine if recoverable |
| Max retries exhausted | `WHERE status = 'BLOCKED' AND attempt_count >= max_retries` | Design-level fix needed, not transient |

### Warning Alerts (Investigation Needed)

| Condition | Detection Query | Action |
| --- | --- | --- |
| Timeout approaching | `WHERE status = 'IN_PROGRESS' AND elapsed > estimate * 1.5` | Monitor — may self-resolve or need intervention |
| Silent failure | `WHERE status = 'IN_PROGRESS' AND elapsed > 45 min AND no recent ticks` | Check if task crashed without updating state |
| High retry rate | `WHERE attempt_count >= 2 AND status != 'COMPLETE'` | Pattern suggests flaky dependency or design issue |
| Tick with no action for 5+ consecutive | `GROUP BY ... HAVING COUNT(*) >= 5 AND all NO_ACTION` | Orchestration may be stuck — something is GATED that shouldn't be |

### Informational (No Action)

| Condition | Purpose |
| --- | --- |
| Workstream completed | Progress tracking |
| New tick recorded | Heartbeat — supervisor is alive |
| Orchestration completed | Celebration / notification |

### Alert Detection Query (Supervisor Tick)

Run this at each supervisor tick to identify alertable conditions:

```sql
-- Unified alert detection
SELECT
    workstream_key,
    CASE
        WHEN status = 'BLOCKED' AND attempt_count >= max_retries
            THEN 'CRITICAL: Max retries exhausted'
        WHEN status = 'BLOCKED'
            THEN 'CRITICAL: Workstream blocked'
        WHEN status = 'IN_PROGRESS'
             AND EXTRACT(EPOCH FROM (now() - started_at)) > estimated_duration_min * 2 * 60
            THEN 'CRITICAL: Timeout exceeded'
        WHEN status = 'IN_PROGRESS'
             AND EXTRACT(EPOCH FROM (now() - started_at)) > estimated_duration_min * 1.5 * 60
            THEN 'WARNING: Approaching timeout'
        WHEN status = 'RETRYING'
            THEN 'WARNING: Workstream retrying (attempt ' || attempt_count || ')'
        ELSE NULL
    END AS alert_level,
    error_message,
    started_at,
    attempt_count
FROM workstreams
WHERE orchestration_id = :orch_uuid
  AND status NOT IN ('COMPLETE', 'NOT_STARTED')
HAVING alert_level IS NOT NULL;
```

## Metrics Summary

Key metrics to track across orchestrations:

| Metric | Computation | Purpose |
| --- | --- | --- |
| Total elapsed time | `completed_at - activated_at` | Overall orchestration duration |
| Critical path duration | Sum of longest sequential chain | Theoretical minimum time |
| Parallelism efficiency | `sum(ws_durations) / total_elapsed` | How well parallelism was utilized |
| First-attempt success rate | `COUNT(complete at attempt 1) / total` | Code/prompt quality indicator |
| Mean time to recover | Avg `RETRYING → COMPLETE` duration | System resilience metric |
| Supervisor tick rate | `COUNT(ticks) / elapsed_hours` | Supervisor responsiveness |
| Error category distribution | `GROUP BY error_category` | Systemic issue identification |

## Catch-Up & Dispatcher Metrics

Metrics for the automated kick mechanism (Pattern A: Lakebase LISTEN/NOTIFY → Dispatcher App → jobs.run_now). These measure the event-driven pipeline that replaces passive hourly polling.

Reference: `architecture/automated-kick-mechanism.md`

### Signal Pipeline Metrics

| Metric | Source | Computation | Purpose |
| --- | --- | --- | --- |
| Signal-to-dispatch latency | `completion_signals` | `dispatched_at - created_at` | End-to-end time from worker completion to next-tier activation |
| Notification delivery latency | Dispatcher App logs | Time between `pg_notify` fire and `notifies()` yield | Lakebase event propagation speed |
| Dispatch success rate | `completion_signals` | `COUNT(dispatched=TRUE) / COUNT(*)` | Reliability of the dispatch pipeline |
| Pending signal age | `completion_signals` | `now() - created_at WHERE dispatched = FALSE` | Backlog indicator — should be near-zero in steady state |
| Signals per orchestration | `completion_signals` | `COUNT(*) GROUP BY orchestration_id` | Orchestration complexity / activity level |

### Catch-Up Metrics

| Metric | Source | Computation | Purpose |
| --- | --- | --- | --- |
| Catch-up batch size | Dispatcher App logs | Rows returned by catch-up query on reconnect | Measures notification loss during outage |
| Catch-up frequency | Dispatcher App logs | Count of reconnect events per hour | Connection stability indicator |
| Catch-up processing time | Dispatcher App logs | Duration of catch-up query + dispatch loop | Impact of missed signals on recovery speed |
| Max outage window | Dispatcher App logs | Longest gap between consecutive LISTEN sessions | Worst-case notification delay |
| Zero-catch-up rate | Dispatcher App logs | `COUNT(catch_up_size = 0) / COUNT(reconnects)` | % of reconnects with no missed signals (should be high) |

### Reconnect Metrics

| Metric | Source | Computation | Purpose |
| --- | --- | --- | --- |
| Reconnect count | Dispatcher App logs | Cumulative reconnection attempts | Connection stability over time |
| Mean time to reconnect | Dispatcher App logs | Avg duration from disconnect detection to LISTEN re-registered | Recovery speed |
| Reconnect cause distribution | Dispatcher App logs | `GROUP BY cause (tcp_reset, scale_to_zero, deploy, unknown)` | Root cause analysis |
| Backoff ceiling hits | Dispatcher App logs | Count of reconnects reaching max backoff (30s) | Persistent connectivity issues |
| Token generation latency | Dispatcher App logs | Duration of `generate_database_credential()` call | OAuth endpoint responsiveness |

### Tier Distribution Metrics

| Metric | Source | Computation | Purpose |
| --- | --- | --- | --- |
| Execution tier distribution | `executions` / plan metadata | `COUNT(*) GROUP BY execution_tier` | Which tiers are actually used |
| Tier 0 (inline) rate | WS-INIT logs | Workstreams executed inline vs. dispatched | Overhead savings from inline execution |
| Tier 1 (job-backed) activation time | `completion_signals` + Jobs API | `job_start_time - signal_created_at` | End-to-end latency for job-backed workers |
| Tier 2/3 (Genie) activation time | `completion_signals` + scheduled tasks | `task_execute_time - signal_created_at` | Genie worker responsiveness |

### Dashboard Queries

#### Signal Pipeline Health

```sql
-- Signal pipeline latency percentiles (last 24h)
SELECT
    orchestration_id,
    COUNT(*) AS total_signals,
    COUNT(*) FILTER (WHERE dispatched = TRUE) AS dispatched_count,
    COUNT(*) FILTER (WHERE dispatched = FALSE) AS pending_count,
    PERCENTILE_CONT(0.50) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (dispatched_at - created_at))
    ) AS p50_latency_sec,
    PERCENTILE_CONT(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (dispatched_at - created_at))
    ) AS p95_latency_sec,
    MAX(EXTRACT(EPOCH FROM (dispatched_at - created_at))) AS max_latency_sec
FROM completion_signals
WHERE created_at > now() - INTERVAL '24 hours'
GROUP BY orchestration_id;
```

#### Stale Signals (Catch-Up Backlog)

```sql
-- Signals pending dispatch for more than 60 seconds (should be 0 in healthy state)
SELECT
    id, orchestration_id, workstream_key, signal_type,
    created_at,
    EXTRACT(EPOCH FROM (now() - created_at))::INT AS age_seconds
FROM completion_signals
WHERE dispatched = FALSE
  AND created_at < now() - INTERVAL '60 seconds'
ORDER BY created_at ASC;
```

#### Dispatcher Heartbeat (Liveness Check)

```sql
-- Most recent dispatched signal per orchestration (heartbeat proxy)
-- If max(dispatched_at) is stale and pending signals exist, Dispatcher may be down
SELECT
    orchestration_id,
    MAX(dispatched_at) AS last_dispatch,
    EXTRACT(EPOCH FROM (now() - MAX(dispatched_at)))::INT / 60 AS minutes_since_last,
    COUNT(*) FILTER (WHERE dispatched = FALSE) AS pending_signals
FROM completion_signals
GROUP BY orchestration_id
HAVING COUNT(*) FILTER (WHERE dispatched = FALSE) > 0;
```

#### Catch-Up Effectiveness

```sql
-- Signals dispatched via catch-up (batch) vs. real-time (single)
-- Heuristic: if dispatched_at - created_at > 5 seconds, likely caught up after reconnect
SELECT
    orchestration_id,
    COUNT(*) AS total_dispatched,
    COUNT(*) FILTER (
        WHERE EXTRACT(EPOCH FROM (dispatched_at - created_at)) <= 5
    ) AS realtime_dispatched,
    COUNT(*) FILTER (
        WHERE EXTRACT(EPOCH FROM (dispatched_at - created_at)) > 5
    ) AS catchup_dispatched,
    ROUND(
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (dispatched_at - created_at)) <= 5)::NUMERIC
        / NULLIF(COUNT(*), 0) * 100, 1
    ) AS realtime_pct
FROM completion_signals
WHERE dispatched = TRUE
  AND created_at > now() - INTERVAL '7 days'
GROUP BY orchestration_id;
```

### Alerting Conditions (Dispatcher)

| Condition | Severity | Detection | Action |
| --- | --- | --- | --- |
| Pending signal age > 5 min | CRITICAL | Stale signals query returns rows | Dispatcher likely down — check App health |
| No dispatch in 30 min (active orch) | WARNING | Heartbeat query shows stale `last_dispatch` | May be healthy (no completions), or Dispatcher disconnected |
| Catch-up batch > 10 signals | WARNING | Dispatcher logs report large catch-up | Extended outage — check reconnect cause |
| Reconnect rate > 5/hour | WARNING | Reconnect count metric exceeds threshold | Unstable network or Lakebase endpoint issue |
| Signal-to-dispatch p95 > 60s | WARNING | Latency percentile query | Pipeline degraded — investigate Dispatcher or job queue |

### Verified Baselines (2026-08-15)

From pg_notify E2E testing on `dev-matthew-giglia-lakeloom`:

| Metric | Measured Value | Context |
| --- | --- | --- |
| pg_notify round-trip (3 signals) | 53ms total | <18ms per signal |
| Token generation latency | <1s | SDK call to `generate_database_credential()` |
| Reconnect (simulated drop) | ~2s | Includes backoff + token gen + LISTEN |
| NOTIFY after 5s idle | Delivered | No idle-timeout risk |
| NOTIFY after 30s sustained session | Delivered | Connection stable |
| Concurrent dispatcher safety | Exactly-one-wins | `FOR UPDATE SKIP LOCKED` verified |
| Connection survival after token expiry | Indefinite | `idle_session_timeout=0`, auth at connect time only |

## Cross-References

- Table definitions: `tracking/lakebase-schema`
- Read/write protocols: `tracking/status-protocol`
- State machine states and transitions: `core/state-machine`
- Supervisor tick logic: `core/ws-init` (tick decision tree)
- Automated kick mechanism: `architecture/automated-kick-mechanism`
- Completion signals schema: `tracking/lakebase-schema` (§ completion_signals)
