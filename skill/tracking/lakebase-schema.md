---
module: tracking/lakebase-schema
version: 1.0.0
purpose: Complete Lakebase Postgres DDL for orchestration state, execution history, and observability
depends_on: [core/state-machine]
consumed_by: [tracking/status-protocol, tracking/observability, backends/*]
---

# Lakebase Schema

This module defines the complete Postgres DDL for the orchestration tracking layer. All tables live in a single Lakebase Postgres database dedicated to the orchestrator. Deploy these tables before running any orchestration.

> **Not used in this project.** Hi Genie Orchestrator's `plan.json` sets `state.mode: "file"` — orchestration state lives in `orchestration/state/*.md`, not in a Lakebase tracking database. This entire module is inert here; kept for portable-skill reference only. Do not confuse this *tracking-layer* schema with the Lakebase project ws-0 (Infrastructure Bundle) provisions and ws-b (TypeScript Migration Module) builds DDL for — that Lakebase project is this orchestration's actual product, not its coordination backend.

## Connection Protocol

Connect to the Lakebase database using `executeLakebasePostgresSql`:

```python
# Required parameters for every Lakebase SQL call
executeLakebasePostgresSql(
    sql="<statement>",
    database="<database_name>",        # e.g., "genie-orchestrator"
    host="<lakebase_host>",            # e.g., "instance-xxx.cloud.databricks.com"
    project_name="<project_name>",     # from databricks bundle summary
    branch_name="production",          # always "production" for orchestration state
    read_only=False                    # False for writes, True for reads
)
```

Connection parameters are resolved from the bundle configuration:
- `project_name`: From `databricks bundle summary` → Lakebase project resource
- `host`: From workspace URL or Lakebase endpoint listing
- `database`: Defined in bundle variables (e.g., `var.lakebase_database`)
- `branch_name`: Always `production` for orchestration state (no dev branching of state)

## Tables

### orchestrations

Top-level record for each orchestration run. One row per DAG execution.

```sql
CREATE TABLE orchestrations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    orchestration_id TEXT NOT NULL UNIQUE,
    project_name    TEXT NOT NULL,
    source_documents TEXT[],
    dag_json        JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'PLANNING'
                    CHECK (status IN ('PLANNING','PROVISIONED','ACTIVE','COMPLETED','FAILED','CANCELLED')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_at    TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_by      TEXT,
    config          JSONB,
    total_workstreams INT NOT NULL DEFAULT 0,
    completed_workstreams INT NOT NULL DEFAULT 0
);
```

### workstreams

One row per workstream in an orchestration. Tracks current state and metadata.

```sql
CREATE TABLE workstreams (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    orchestration_id  UUID NOT NULL REFERENCES orchestrations(id) ON DELETE CASCADE,
    workstream_key    TEXT NOT NULL,
    name              TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'NOT_STARTED'
                      CHECK (status IN ('NOT_STARTED','GATED','IN_PROGRESS','VALIDATING','COMPLETE','BLOCKED','RETRYING')),
    execution_backend TEXT NOT NULL,
    depends_on        TEXT[],
    file_scope        TEXT[],
    output_artifacts  JSONB,
    gate_conditions   JSONB,
    context_files     TEXT[],
    scheduled_task_id TEXT,
    created_at_tick   INT,
    prompt_synthesized BOOLEAN NOT NULL DEFAULT false,
    branch_name       TEXT,
    started_at        TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ,
    attempt_count     INT NOT NULL DEFAULT 0,
    max_retries       INT NOT NULL DEFAULT 3,
    estimated_duration_min INT,
    error_message     TEXT,
    prior_error       TEXT,
    last_attempt_at   TIMESTAMPTZ,
    notes_for_downstream TEXT,
    UNIQUE(orchestration_id, workstream_key)
);
```

### prompts

Versioned prompts generated for each workstream. Enables audit trail of what instructions were dispatched.

```sql
CREATE TABLE prompts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workstream_id   UUID NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
    version         INT NOT NULL DEFAULT 1,
    prompt_text     TEXT NOT NULL,
    template_used   TEXT,
    parameters      JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    char_count      INT GENERATED ALWAYS AS (length(prompt_text)) STORED,
    UNIQUE(workstream_id, version)
);
```

### executions

One row per execution attempt. Records outcome, duration, errors, and artifacts.

```sql
CREATE TABLE executions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workstream_id   UUID NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
    prompt_id       UUID REFERENCES prompts(id),
    attempt_number  INT NOT NULL,
    status          TEXT NOT NULL
                    CHECK (status IN ('GATE_CHECK','GATE_BLOCKED','EXECUTING','VALIDATING','SUCCEEDED','FAILED','TIMED_OUT')),
    gate_result     JSONB,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    duration_seconds INT GENERATED ALWAYS AS (
        CASE WHEN completed_at IS NOT NULL
             THEN EXTRACT(EPOCH FROM (completed_at - started_at))::INT
             ELSE NULL
        END
    ) STORED,
    error_message   TEXT,
    error_category  TEXT
                    CHECK (error_category IS NULL OR error_category IN (
                        'PERMISSION_DENIED','RESOURCE_NOT_FOUND','TIMEOUT',
                        'VALIDATION_FAILED','API_ERROR','UNKNOWN'
                    )),
    artifacts_created TEXT[],
    notes_downstream TEXT,
    session_summary  TEXT,
    UNIQUE(workstream_id, attempt_number)
);
```

### state_transitions

Immutable audit log of every state change. Never deleted or updated.

```sql
CREATE TABLE state_transitions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workstream_id   UUID NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
    execution_id    UUID REFERENCES executions(id),
    from_status     TEXT NOT NULL,
    to_status       TEXT NOT NULL,
    reason          TEXT,
    transitioned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    transitioned_by TEXT NOT NULL DEFAULT 'system'
);
```

### ticks

Supervisor tick history. One row per evaluation cycle of the orchestration supervisor.

```sql
CREATE TABLE ticks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    orchestration_id    UUID NOT NULL REFERENCES orchestrations(id) ON DELETE CASCADE,
    tick_number         INT NOT NULL,
    action_taken        TEXT NOT NULL
                        CHECK (action_taken IN (
                            'LAUNCH_WORKSTREAM','UNPAUSE_RETRY','SET_BLOCKED',
                            'MARK_COMPLETE','DETECT_TIMEOUT','SYNTHESIZE_PROMPT',
                            'EVALUATE_GATES','NO_ACTION','ORCHESTRATION_COMPLETE',
                            'ORCHESTRATION_FAILED'
                        )),
    action_target       TEXT,
    decision_reasoning  TEXT,
    state_snapshot      JSONB,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ,
    duration_ms         INT,
    UNIQUE(orchestration_id, tick_number)
);
```

### artifacts

Explicit artifact registry. Tracks every file produced by workstreams with verification status.

```sql
CREATE TABLE artifacts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workstream_id   UUID NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
    execution_id    UUID REFERENCES executions(id),
    artifact_path   TEXT NOT NULL,
    artifact_type   TEXT NOT NULL DEFAULT 'file'
                    CHECK (artifact_type IN ('file','directory','table','view','endpoint')),
    verified        BOOLEAN NOT NULL DEFAULT false,
    verified_at     TIMESTAMPTZ,
    size_bytes      BIGINT,
    line_count      INT,
    checksum        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(workstream_id, artifact_path)
);
```

### schema_migrations

Tracks applied schema versions for safe evolution.

```sql
CREATE TABLE schema_migrations (
    version     INT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_by  TEXT
);
```

### completion_signals

Event-sourcing table for the automated kick mechanism. Workers INSERT a row on completion; a Postgres trigger fires `pg_notify()` to activate the Dispatcher App, which triggers the next tier of workers via `jobs.run_now()`. Append-only with a `dispatched` flag for at-least-once processing.

See: `architecture/automated-kick-mechanism.md` (Pattern A: LISTEN/NOTIFY + Dispatcher App)

```sql
CREATE TABLE completion_signals (
    id                BIGSERIAL PRIMARY KEY,
    orchestration_id  UUID NOT NULL REFERENCES orchestrations(id) ON DELETE CASCADE,
    workstream_key    TEXT NOT NULL,
    signal_type       TEXT NOT NULL DEFAULT 'COMPLETE'
                      CHECK (signal_type IN ('COMPLETE','FAILED','RETRY_REQUESTED','BLOCKED')),
    dispatched        BOOLEAN NOT NULL DEFAULT FALSE,
    dispatched_at     TIMESTAMPTZ,
    dispatcher_run_id TEXT,
    payload           JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Design notes:**
- Uses `BIGSERIAL` (not UUID) for PK — ordering matters for event replay
- `signal_type` allows non-completion events (failed workers, retry requests)
- `payload` carries arbitrary metadata (e.g., artifact paths, error context)
- `dispatched` + `FOR UPDATE SKIP LOCKED` guarantees exactly-once processing
- FK to `orchestrations` (not `workstreams`) — signal may arrive before workstream row exists in edge cases

### completion_signals — NOTIFY Trigger

Fires `pg_notify()` on every INSERT to the `orchestrator_completions` channel. The Dispatcher App listens on this channel and triggers `jobs.run_now()` immediately.

```sql
CREATE OR REPLACE FUNCTION notify_completion_signal() RETURNS trigger AS $
BEGIN
    PERFORM pg_notify(
        'orchestrator_completions',
        json_build_object(
            'id', NEW.id,
            'orchestration_id', NEW.orchestration_id,
            'workstream_key', NEW.workstream_key,
            'signal_type', NEW.signal_type
        )::text
    );
    RETURN NEW;
END;
$ LANGUAGE plpgsql;

CREATE TRIGGER trg_completion_signal_notify
    AFTER INSERT ON completion_signals
    FOR EACH ROW EXECUTE FUNCTION notify_completion_signal();
```

**Behavior:**
- Notification is transactional — only fires when the INSERT transaction commits
- Payload is JSON (channel max 8000 bytes; this payload is ~150 bytes)
- If no listener is connected, the notification is silently discarded (no queue)
- Multiple INSERTs in one transaction fire multiple notifications on commit

## Indexes

Create these indexes after table creation for query performance:

```sql
-- Orchestration lookups
CREATE INDEX idx_orch_status ON orchestrations(status);
CREATE INDEX idx_orch_project ON orchestrations(project_name);
CREATE INDEX idx_orch_human_id ON orchestrations(orchestration_id);

-- Workstream lookups
CREATE INDEX idx_ws_orch ON workstreams(orchestration_id);
CREATE INDEX idx_ws_status ON workstreams(orchestration_id, status);
CREATE INDEX idx_ws_key ON workstreams(orchestration_id, workstream_key);

-- Execution lookups
CREATE INDEX idx_exec_ws ON executions(workstream_id);
CREATE INDEX idx_exec_status ON executions(workstream_id, status);
CREATE INDEX idx_exec_started ON executions(started_at DESC);

-- State transition lookups
CREATE INDEX idx_trans_ws ON state_transitions(workstream_id);
CREATE INDEX idx_trans_time ON state_transitions(transitioned_at DESC);
CREATE INDEX idx_trans_ws_time ON state_transitions(workstream_id, transitioned_at DESC);

-- Tick lookups
CREATE INDEX idx_tick_orch ON ticks(orchestration_id);
CREATE INDEX idx_tick_orch_num ON ticks(orchestration_id, tick_number DESC);
CREATE INDEX idx_tick_action ON ticks(orchestration_id, action_taken);

-- Artifact lookups
CREATE INDEX idx_artifact_ws ON artifacts(workstream_id);
CREATE INDEX idx_artifact_exec ON artifacts(execution_id);
CREATE INDEX idx_artifact_verified ON artifacts(workstream_id, verified);
```

## Constraints Summary

| Table | Constraint | Type | Purpose |
| --- | --- | --- | --- |
| orchestrations | status IN (...) | CHECK | Valid orchestration states only |
| orchestrations | orchestration_id UNIQUE | UNIQUE | Human-readable ID is globally unique |
| workstreams | status IN (...) | CHECK | Valid workstream states (7-state enum) |
| workstreams | (orchestration_id, workstream_key) | UNIQUE | One workstream per key per orchestration |
| prompts | (workstream_id, version) | UNIQUE | Monotonic prompt versioning |
| executions | status IN (...) | CHECK | Valid execution states |
| executions | (workstream_id, attempt_number) | UNIQUE | One record per attempt |
| executions | error_category IN (...) | CHECK | Categorized errors for reporting |
| ticks | action_taken IN (...) | CHECK | Known supervisor actions only |
| ticks | (orchestration_id, tick_number) | UNIQUE | Monotonic tick numbering |
| artifacts | artifact_type IN (...) | CHECK | Known artifact types |
| artifacts | (workstream_id, artifact_path) | UNIQUE | No duplicate artifact paths per workstream |

## Advisory Lock Patterns

Use Postgres advisory locks to prevent concurrent claim races in Lakebase mode. Advisory locks are session-scoped (released on disconnect) or transaction-scoped.

### Claim Lock (Transaction-Scoped)

Prevent two workers from claiming the same workstream simultaneously:

```sql
BEGIN;

-- Acquire exclusive lock on this workstream's claim slot
-- Lock key derived from workstream UUID hashed to bigint
SELECT pg_advisory_xact_lock(
    ('x' || left(md5(ws_id::text), 15))::bit(64)::bigint
)
FROM (SELECT id AS ws_id FROM workstreams WHERE workstream_key = :ws_key AND orchestration_id = :orch_id) t;

-- Conditional update: only claim if still claimable
UPDATE workstreams
SET status = 'IN_PROGRESS',
    started_at = now(),
    attempt_count = attempt_count + 1,
    last_attempt_at = now()
WHERE orchestration_id = :orch_id
  AND workstream_key = :ws_key
  AND status IN ('NOT_STARTED', 'RETRYING');

-- Check rows affected: 0 = already claimed, 1 = success
-- If 0 rows: another worker claimed first, exit gracefully

COMMIT;
```

### Simplified Claim (Without Advisory Lock)

For environments where advisory locks are unavailable, use optimistic locking:

```sql
-- Single atomic UPDATE with WHERE guard
-- Returns 0 rows if already claimed (compare-and-swap semantics)
UPDATE workstreams
SET status = 'IN_PROGRESS',
    started_at = now(),
    attempt_count = attempt_count + 1,
    last_attempt_at = now()
WHERE orchestration_id = :orch_id
  AND workstream_key = :ws_key
  AND status IN ('NOT_STARTED', 'RETRYING')
RETURNING id, workstream_key;
```

This works because Postgres row-level locks prevent concurrent updates to the same row. If two workers race, one gets the lock first, updates the status, and the second sees `status = 'IN_PROGRESS'` (not in the WHERE set) and gets 0 rows.

### Orchestration-Level Lock

Prevent concurrent supervisor ticks from making conflicting decisions:

```sql
BEGIN;

-- Lock the orchestration for this tick evaluation
SELECT pg_advisory_xact_lock(
    ('x' || left(md5(:orchestration_id::text), 15))::bit(64)::bigint
);

-- ... evaluate state, make decisions, record tick ...

COMMIT;
```

## Migration Protocol

Schema evolution rules for safe upgrades:

### Adding Columns

```sql
-- Always add with DEFAULT or as NULLABLE
ALTER TABLE workstreams ADD COLUMN priority INT DEFAULT 5;

-- Never add NOT NULL without DEFAULT on existing tables
```

### Adding Tables

```sql
-- Use IF NOT EXISTS for idempotency
CREATE TABLE IF NOT EXISTS new_table (...);
```

### Modifying Constraints

```sql
-- Add new CHECK values: drop and recreate
ALTER TABLE workstreams DROP CONSTRAINT workstreams_status_check;
ALTER TABLE workstreams ADD CONSTRAINT workstreams_status_check
    CHECK (status IN ('NOT_STARTED','GATED','IN_PROGRESS','VALIDATING','COMPLETE','BLOCKED','RETRYING','NEW_STATE'));
```

### Migration Tracking

```sql
-- Record each migration
INSERT INTO schema_migrations (version, description, applied_by)
VALUES (1, 'Initial schema creation', 'ws-e');
```

### Rollback Strategy

Lakebase supports branch-based rollback:
1. Create a branch before migration: `databricks postgres create-branch projects/<id>/branches/pre-migration-v2`
2. Apply migration to `production` branch
3. If migration fails: restore from branch
4. If migration succeeds: delete the backup branch

## Full Deployment Order

Execute these statements in dependency order on a fresh database:

1. `CREATE TABLE orchestrations`
2. `CREATE TABLE workstreams` (references orchestrations)
3. `CREATE TABLE prompts` (references workstreams)
4. `CREATE TABLE executions` (references workstreams, prompts)
5. `CREATE TABLE state_transitions` (references workstreams, executions)
6. `CREATE TABLE ticks` (references orchestrations)
7. `CREATE TABLE artifacts` (references workstreams, executions)
8. `CREATE TABLE schema_migrations`
9. All `CREATE INDEX` statements
10. `INSERT INTO schema_migrations` (version 1)

## Cross-References

- State enum values: `core/state-machine` → Workstream States section
- Status protocol (read/write patterns): `tracking/status-protocol`
- Observability views over these tables: `tracking/observability`
- Backend implementations that write to these tables: `backends/*`
