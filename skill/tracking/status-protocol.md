---
module: tracking/status-protocol
version: 1.0.0
purpose: Dual-mode read/write protocol for workstream state (Lakebase SQL and file-based YAML)
depends_on: [core/state-machine, tracking/lakebase-schema]
consumed_by: [backends/*, core/prompt-synthesis, tracking/observability]
---

# Status Protocol

This module defines how workstream state is read and written in both operational modes. The orchestrator supports two mutually exclusive state backends: **Lakebase mode** (Postgres database) and **File mode** (workspace YAML files). Both provide the same logical semantics — atomic claims, guarded transitions, and audit logging.

> **This project: File Mode only.** Hi Genie Orchestrator's `plan.json` sets `state.mode: "file"` and will not switch to Lakebase mode. All "Lakebase Mode" subsections below are retained for portable-skill reference only — skip them when executing this project's workstreams. Do not confuse this dual-mode *tracking protocol* with the Lakebase project ws-0 and ws-b are building as this orchestration's own deliverable.

## Mode Selection

The active mode is determined by the orchestration plan file:

```json
// plan.json (excerpt)
{
  "state": {
    "mode": "file",           // "file" or "lakebase"
    "lakebase": {             // only when mode = "lakebase"
      "project_name": "genie-orchestrator",
      "branch_name": "production",
      "database": "orchestrator_db",
      "host": "instance-xxx.cloud.databricks.com"
    },
    "file": {                  // only when mode = "file"
      "state_directory": "orchestration/state/"
    }
  }
}
```

Rules:
- Read `plan.json` at orchestration root to determine mode
- If `state.mode` is absent, default to `"file"` (zero-infrastructure mode)
- Backends and supervisors MUST respect the mode — never mix reads from one with writes to another
- Mode cannot change mid-orchestration (would cause split-brain)

## File-Based Mode

### File Layout

```
orchestration/state/
├── orchestration-status.md     # Orchestration-level state
├── workstream-ws-a-status.md   # Per-workstream state
├── workstream-ws-b-status.md
└── ...
```

### Workstream Status File Format

```yaml
---
workstream_key: ws-a
name: Core State Machine
status: NOT_STARTED
depends_on: [none]
scheduled_task_id: e9810312567d401eafb81b2fb1826025
task_paused: false
attempt_count: 0
created_at_tick: 1
error_message: null
prior_error: null
last_attempt_at: null
---

# Workstream ws-a: Core State Machine

## Notes for Downstream Sessions

(Will be populated on COMPLETE)
```

### Orchestration Status File Format

```yaml
---
orchestration_id: orch-2026-08-14-self-build
project_name: genie-workstream-orchestrator
status: ACTIVE
total_workstreams: 8
completed_workstreams: 2
current_tick: 6
activated_at: 2026-08-14T10:00:00Z
---

# Orchestration: orch-2026-08-14-self-build

## Progress

...
```

### Read Protocol (File Mode)

Read operations use `readAssetById` with `assetType: "file"`:

#### Read Own Status

```python
# Gate check: read own workstream status
result = readAssetById(
    assetType="file",
    assetId="/Workspace/.../orchestration/state/workstream-{ws_key}-status.md"
)
# Parse YAML frontmatter between --- delimiters
status = parse_frontmatter(result.fileContent)["status"]
```

#### Read Upstream Dependencies

```python
# For each dependency in depends_on:
for dep_key in depends_on:
    if dep_key == "none":
        continue
    result = readAssetById(
        assetType="file",
        assetId=f"/Workspace/.../orchestration/state/workstream-{dep_key}-status.md"
    )
    dep_status = parse_frontmatter(result.fileContent)["status"]
    if dep_status != "COMPLETE":
        # Gate blocked — exit without mutation
        return GATE_BLOCKED
```

#### Read Orchestration Status

```python
result = readAssetById(
    assetType="file",
    assetId="/Workspace/.../orchestration/state/orchestration-status.md"
)
orch_status = parse_frontmatter(result.fileContent)["status"]
# Verify orchestration is ACTIVE (not CANCELLED or FAILED)
```

### Write Protocol (File Mode)

Write operations use `editAsset` with exact `old_text` matching for atomicity:

#### Atomic Claim (NOT_STARTED → IN_PROGRESS)

```python
import datetime
now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

editAsset(
    asset={"type": "file", "id": "<status_file_path>", "name": "..."},
    operation="update",
    content=[{"patches": [
        {
            "old_text": "status: NOT_STARTED",
            "new_text": "status: IN_PROGRESS",
            "replace_all": False
        },
        {
            "old_text": "started_at: null",
            "new_text": f"started_at: {now_iso}",
            "replace_all": False
        },
        {
            "old_text": "attempt_count: 0",
            "new_text": "attempt_count: 1",
            "replace_all": False
        }
    ]}]
)
# If result.changed == False: claim failed (another instance already claimed)
# If result.changed == True: claim succeeded — all 3 patches applied atomically
```

**Atomicity guarantee:** `editAsset` uses exact string matching. If another instance already changed `NOT_STARTED` to `IN_PROGRESS`, the `old_text` will not be found, and the edit returns `changed: false`. This provides compare-and-swap semantics.

**CRITICAL:** All nullable fields in the status file use explicit `null` (not empty string). Patches MUST match this convention exactly. See `templates/status-file-template.md` for the canonical initial values.

#### Claim from RETRYING State

When claiming from RETRYING, the worker must first READ the current file to
determine the current `attempt_count` and `started_at` values (needed for
exact `old_text` matching).

```python
import datetime
now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

# Read current values first
result = readAssetById(assetType="file", assetId="<status_file_path>")
current_attempt = parse_frontmatter(result)["attempt_count"]  # e.g., 1
current_started = parse_frontmatter(result)["started_at"]      # e.g., "2026-08-15T10:00:00Z"

editAsset(
    asset={"type": "file", "id": "<status_file_path>", "name": "..."},
    operation="update",
    content=[{"patches": [
        {
            "old_text": "status: RETRYING",
            "new_text": "status: IN_PROGRESS",
            "replace_all": False
        },
        {
            "old_text": f"started_at: {current_started}",
            "new_text": f"started_at: {now_iso}",
            "replace_all": False
        },
        {
            "old_text": f"attempt_count: {current_attempt}",
            "new_text": f"attempt_count: {current_attempt + 1}",
            "replace_all": False
        }
    ]}]
)
```

**Retry context:** Before executing, the worker reads `prior_error` from the
status file to understand what failed in the previous attempt and adapt strategy.

#### Transition to VALIDATING

```python
editAsset(
    asset={"type": "file", "id": "<status_file_path>", "name": "..."},
    operation="update",
    content=[{"patches": [{
        "old_text": "status: IN_PROGRESS",
        "new_text": "status: VALIDATING",
        "replace_all": False
    }]}]
)
```

#### Transition to COMPLETE

```python
import datetime
now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

editAsset(
    asset={"type": "file", "id": "<status_file_path>", "name": "..."},
    operation="update",
    content=[{"patches": [
        {
            "old_text": "status: IN_PROGRESS",  # or "status: VALIDATING"
            "new_text": "status: COMPLETE",
            "replace_all": False
        },
        {
            "old_text": "completed_at: null",
            "new_text": f"completed_at: {now_iso}",
            "replace_all": False
        }
    ]}]
)
```

#### Transition to BLOCKED (with error)

```python
editAsset(
    asset={"type": "file", "id": "<status_file_path>", "name": "..."},
    operation="update",
    content=[{"patches": [
        {
            "old_text": "status: IN_PROGRESS",
            "new_text": "status: BLOCKED",
            "replace_all": False
        },
        {
            "old_text": "error_message: null",
            "new_text": "error_message: \"<description of what failed>\"",
            "replace_all": False
        },
        {
            "old_text": "error_category: null",
            "new_text": "error_category: <category>",
            "replace_all": False
        }
    ]}]
)
# Valid error_category values:
# transient, permissions, schema_mismatch, timeout, logic_error, dependency_missing, unknown
```

#### Write Notes for Downstream

Append a markdown section to the status file body:

```python
editAsset(
    asset={"type": "file", "id": "<status_file_path>", "name": "..."},
    operation="update",
    content=[{"patches": [{
        "old_text": "(Will be populated on COMPLETE)",
        "new_text": "### Artifact Produced\n- File: `skill/tracking/lakebase-schema.md` (~300 lines)\n...",
        "replace_all": False
    }]}]
)
```

### Transition Recording (File Mode)

File mode does NOT maintain a separate transition log table. Transitions are implicit in the status file history (workspace file versioning). For audit purposes:

1. Each `editAsset` call is a recorded revision in the workspace
2. The `old_text` → `new_text` pair documents the transition
3. For richer audit, append to a `## Transition Log` section in the status file:

```markdown
## Transition Log

| Timestamp | From | To | Actor | Reason |
| --- | --- | --- | --- | --- |
| 2026-08-14T10:05:00Z | NOT_STARTED | IN_PROGRESS | ws-a-task | Gate passed, claimed |
| 2026-08-14T10:45:00Z | IN_PROGRESS | COMPLETE | ws-a-task | All artifacts verified |
```

## Lakebase Mode

_Not used in this project — Hi Genie Orchestrator runs File Mode exclusively (`plan.json` → `state.mode: "file"`). The full Lakebase-mode read/write protocol below is intentionally left out of scope here to avoid confusion with the Lakebase project ws-0/ws-b are building as this project's actual deliverable. See the portable skill source for the complete SQL protocol if a future release adopts Lakebase-mode tracking._

### Read Protocol (Lakebase Mode) [reference only]

#### Read Own Status

```sql
SELECT status, attempt_count, error_message, prior_error, started_at
FROM workstreams
WHERE orchestration_id = :orch_uuid
  AND workstream_key = :ws_key;
```

#### Read Upstream Dependencies

```sql
-- Check all upstream workstreams are COMPLETE
SELECT workstream_key, status
FROM workstreams
WHERE orchestration_id = :orch_uuid
  AND workstream_key = ANY(:depends_on_array)
  AND status != 'COMPLETE';

-- If any rows returned: gate is blocked
-- If zero rows: all dependencies satisfied
```

#### Read Orchestration Status

```sql
SELECT status, total_workstreams, completed_workstreams
FROM orchestrations
WHERE id = :orch_uuid;
```

#### Full State Reconstruction (Supervisor)

```sql
-- Single query to reconstruct full DAG state
SELECT workstream_key, status, attempt_count, started_at,
       estimated_duration_min, error_message, depends_on
FROM workstreams
WHERE orchestration_id = :orch_uuid
ORDER BY created_at_tick;
```

### Write Protocol (Lakebase Mode) [reference only]

#### Atomic Claim

```sql
-- Full claim with advisory lock (strongest guarantee)
BEGIN;

SELECT pg_advisory_xact_lock(
    ('x' || left(md5(ws_id::text), 15))::bit(64)::bigint
)
FROM (SELECT id AS ws_id FROM workstreams
      WHERE workstream_key = :ws_key AND orchestration_id = :orch_uuid) t;

UPDATE workstreams
SET status = 'IN_PROGRESS',
    started_at = now(),
    attempt_count = attempt_count + 1,
    last_attempt_at = now()
WHERE orchestration_id = :orch_uuid
  AND workstream_key = :ws_key
  AND status IN ('NOT_STARTED', 'RETRYING')
RETURNING id;

-- Record transition
INSERT INTO state_transitions (workstream_id, from_status, to_status, reason, transitioned_by)
SELECT id, 
       CASE WHEN attempt_count = 1 THEN 'NOT_STARTED' ELSE 'RETRYING' END,
       'IN_PROGRESS',
       'Claim acquired',
       :actor
FROM workstreams
WHERE orchestration_id = :orch_uuid AND workstream_key = :ws_key;

COMMIT;
```

#### Transition to VALIDATING

```sql
BEGIN;

UPDATE workstreams
SET status = 'VALIDATING'
WHERE orchestration_id = :orch_uuid
  AND workstream_key = :ws_key
  AND status = 'IN_PROGRESS'
RETURNING id;

INSERT INTO state_transitions (workstream_id, from_status, to_status, reason, transitioned_by)
VALUES (:ws_uuid, 'IN_PROGRESS', 'VALIDATING', 'Execution complete, validating outputs', :actor);

COMMIT;
```

#### Transition to COMPLETE

```sql
BEGIN;

UPDATE workstreams
SET status = 'COMPLETE',
    completed_at = now(),
    notes_downstream = :notes
WHERE orchestration_id = :orch_uuid
  AND workstream_key = :ws_key
  AND status IN ('IN_PROGRESS', 'VALIDATING')
RETURNING id;

INSERT INTO state_transitions (workstream_id, from_status, to_status, reason, transitioned_by)
VALUES (:ws_uuid, 'VALIDATING', 'COMPLETE', 'All gate conditions passed', :actor);

-- Update orchestration progress counter
UPDATE orchestrations
SET completed_workstreams = completed_workstreams + 1
WHERE id = :orch_uuid;

COMMIT;
```

#### Transition to BLOCKED

```sql
BEGIN;

UPDATE workstreams
SET status = 'BLOCKED',
    error_message = :error_msg
WHERE orchestration_id = :orch_uuid
  AND workstream_key = :ws_key
  AND status = 'IN_PROGRESS'
RETURNING id;

INSERT INTO state_transitions (workstream_id, from_status, to_status, reason, transitioned_by)
VALUES (:ws_uuid, 'IN_PROGRESS', 'BLOCKED', :error_msg, :actor);

COMMIT;
```

#### Transition to RETRYING (Supervisor Only)

```sql
BEGIN;

UPDATE workstreams
SET status = 'RETRYING',
    prior_error = error_message,
    error_message = NULL
WHERE orchestration_id = :orch_uuid
  AND workstream_key = :ws_key
  AND status IN ('BLOCKED', 'IN_PROGRESS')
  AND attempt_count < max_retries
RETURNING id;

INSERT INTO state_transitions (workstream_id, from_status, to_status, reason, transitioned_by)
VALUES (:ws_uuid, 'BLOCKED', 'RETRYING', 'Auto-retry: attempt_count < max_retries', 'supervisor');

COMMIT;
```

#### Record Execution Attempt

```sql
INSERT INTO executions (workstream_id, prompt_id, attempt_number, status, started_at)
VALUES (:ws_uuid, :prompt_uuid, :attempt_num, 'EXECUTING', now())
RETURNING id;
```

#### Complete Execution Record

```sql
UPDATE executions
SET status = :outcome,  -- 'SUCCEEDED', 'FAILED', or 'TIMED_OUT'
    completed_at = now(),
    error_message = :error_msg,
    error_category = :error_cat,
    artifacts_created = :artifacts_array,
    session_summary = :summary,
    notes_downstream = :notes
WHERE id = :execution_uuid;
```

#### Write Notes for Downstream

```sql
UPDATE workstreams
SET notes_downstream = :notes_text
WHERE orchestration_id = :orch_uuid
  AND workstream_key = :ws_key;
```

### Transition Recording (Lakebase Mode) [reference only]

Every state change inserts into `state_transitions` within the same transaction as the status update. This guarantees the audit log is consistent with the actual state:

```sql
-- Always within the same BEGIN...COMMIT as the status UPDATE
INSERT INTO state_transitions (
    workstream_id, execution_id, from_status, to_status, reason, transitioned_by
) VALUES (
    :ws_uuid, :exec_uuid, :from_state, :to_state, :reason, :actor
);
```

Actors:
- `'system'` — automatic transitions (supervisor, scheduler)
- `'ws-{key}'` — self-transitions by the workstream backend
- `'human:{email}'` — manual interventions

## Error Handling

### Write Failure Recovery

| Mode | Failure | Recovery |
| --- | --- | --- |
| File | `editAsset` returns `changed: false` | Claim race lost — exit gracefully, do not retry |
| File | `editAsset` returns error | Transient — retry once after 2s. If still fails: set BLOCKED |
| File | `old_text` not found (state already changed) | State moved — re-read to determine new state, act accordingly |

### Consistency Rules

1. **Never write both modes** — use plan.json mode exclusively
2. **Read before write** — always verify current state before attempting transition
3. **Fail-safe to BLOCKED** — if uncertain whether write succeeded, read back and verify
4. **No partial transitions** — if multi-field update fails partway, read back and reconcile
5. **Idempotent operations** — repeated writes of the same transition are safe (already in target state)

### Stale Read Protection

In file mode, reads can be stale if another process wrote between read and write:
- The `old_text` guard in `editAsset` protects against this
- If `old_text` doesn't match: state was mutated since read — re-read and re-evaluate


## Protocol Selection Guide

_This project has already selected File Mode — see `plan.json` (`state.mode: "file"`). The full File vs. Lakebase comparison table lives in the portable skill source only; it's not actionable once a mode is chosen for a given orchestration._

## Cross-References

- State enum and transition rules: `core/state-machine`
- Table DDL and indexes: `tracking/lakebase-schema` (reference only — not used for this project's own tracking, which runs File Mode)
- Observability views consuming this data: `tracking/observability`
- Backend implementations using this protocol: `backends/*`
