# Genie Workstream Orchestrator

A generic, reusable framework for decomposing projects into autonomous, parallel
workstreams that self-coordinate via Genie Code scheduled tasks.

## Project Status

| Phase | Status | Description |
| --- | --- | --- |
| Architecture Review | DONE | Reviewed original skill in genieCodeWorkshop |
| Architecture Spec | DONE | 11 documents defining the full orchestration contract |
| WS-INIT Protocol | DONE | Supervisor workstream design (centralized control plane) |
| Bundle Strategy | DONE | Dependency-ordered Declarative Automation Bundle partitioning |
| Templates | DONE | 7 templates: WS-INIT, worker, status, orchestration, ws-final, plan schema, provisioning |
| Skill Modules | DONE | 11 modules (~4,529 lines): core/, backends/, tracking/ |
| Self-Build Orchestration | DONE | Dogfooded: 6 workstreams, 12 ticks, 0 retries, 6/6 checks PASS |
| Integration Test (file-mode) | **PASS** | 2 workers + final, dependency gating, CAS claims, self-complete — all verified |
| Lakebase Deployment | TODO | Create `genie-orchestrator` project, deploy schema |
| Integration Test (Lakebase) | TODO | Same test with Lakebase state mode |
| Real Project Test | TODO | Point at scAuditor or similar real architecture, run end-to-end |
| Examples | TODO | Data platform, migration, microservices patterns |

## Directory Structure

```
genie-workstream-orchestrator/
├── README.md                    # This file (overview + roadmap)
├── PROJECT_MEMORY.md            # Project state, decisions, conventions
├── plan.json                    # Self-build orchestration plan (dogfood)
├── skill/                       # The skill itself (11 modules, ~4,529 lines)
│   ├── SKILL.md                 # Entry point: triggers, concepts, module index
│   ├── core/                    # Planning & synthesis engine
│   │   ├── state-machine.md     # 7-state lifecycle, 3 contracts, 10 invariants
│   │   ├── decomposition.md     # 5-phase work breakdown algorithm
│   │   ├── dag-builder.md       # DAG construction, Kahn's sort, plan.json generation
│   │   └── prompt-synthesis.md  # Template selection, 25+ vars, assembly pipeline
│   ├── backends/                # Execution interfaces
│   │   ├── bundle.md            # Declarative Automation Bundle deploy lifecycle
│   │   ├── notebook.md          # Notebook creation + execution
│   │   ├── sql.md               # SQL DDL/DML/grant execution
│   │   └── custom.md            # Free-form, composite, WS-FINAL patterns
│   └── tracking/                # State & observability
│       ├── lakebase-schema.md   # 8-table Postgres DDL + indexes
│       ├── status-protocol.md   # Dual-mode (Lakebase/file) read/write
│       └── observability.md     # Tick logging, duration, dashboard views
├── architecture/                # Contract documents (11 files)
│   ├── INDEX.md                 # Document manifest + build order
│   ├── input-contract.md        # What the skill accepts as input
│   ├── workstream-spec.md       # What a valid workstream is (5 types)
│   ├── decomposition-rules.md   # How to break input → DAG
│   ├── state-layer.md           # Lakebase schema + file fallback
│   ├── prompt-contract.md       # 5-section prompt structure + supervisor prompt
│   ├── backend-contracts.md     # Pluggable execution backends
│   ├── scheduling-contract.md   # WS-INIT model + cron strategy
│   ├── execution-protocol.md    # Worker lifecycle + supervisor tick protocol
│   ├── ws-init-protocol.md      # Supervisor workstream (creates & monitors workers)
│   └── bundle-strategy.md       # Dependency-ordered bundle partitioning
├── templates/                   # Reusable templates (7 files)
│   ├── ws-init-template.md      # Supervisor prompt (fill variables, schedule)
│   ├── worker-prompt-template.md # Worker prompt (5-section, synthesized by WS-INIT)
│   ├── status-file-template.md  # Per-workstream state file (file-based mode)
│   ├── orchestration-status-template.md # Top-level orchestration tracker
│   ├── ws-final-template.md     # Final workstream (summary, merge plan, deploy plan)
│   ├── plan-schema.md           # plan.json JSON Schema spec + full example
│   └── provisioning-protocol.md # Bootstrap: plan.json → running WS-INIT (6 steps)
├── fixtures/                    # Convention-based artifacts
│   └── sessions/                # Session summaries (13 sessions + INDEX.md)
└── orchestration/               # Self-build state (COMPLETED, 12 ticks)
    ├── orchestration-status.md  # Status: COMPLETED, tick_count: 12
    ├── SUMMARY.md               # Executive summary of all modules
    ├── INTEGRATION_REPORT.md    # 6/6 cross-reference checks PASS
    └── state/                   # Per-workstream status (all COMPLETE)
```

## Collaboration Protocol

The Hi Genie Orchestrator app bundle (`hi-genie-orchestrator/mcp-hi-genie-orchestrator/`) includes an async review protocol for cross-agent architecture collaboration:

| Path (relative to app bundle root) | Purpose |
| --- | --- |
| `.review-protocol/SKILL.md` | Protocol definition — roles, debate rules, activation triggers |
| `.review-protocol/debate_state.json` | Programmatic state tracking (v2.0, compare-and-swap) |
| `hi_genie/` | Polly → Genie channel (recommendations) |
| `hey_polly/` | Genie → Polly channel (responses) |

**Scope:** Advisory architecture discussion only — does not override the orchestrator's state machine, reviewer skill, Lakebase findings, or Supervisor authorization. See `.review-protocol/SKILL.md` for full protocol.

---

## Origin

Extracted from `genieCodeWorkshop/docs/skills/workstream-orchestration/` and
generalized to remove workshop-specific coupling (hardcoded paths, bundle-only
execution, manual prompt authoring, no persistent state).

---

## Architecture Review & Redesign

### Purpose

A skill that acts as an SDK-like interface: point it at requirements or architecture documents to decompose, schedule, and execute multi-workstream projects autonomously via Genie Code scheduled tasks.

---

## Part 1: Architecture Review of Existing Skill

### File Inventory

| File | Role |
| --- | --- |
| `SKILL.md` | Entry point — triggers, prerequisites, quick-start, key concepts |
| `planning.md` | Decomposition methodology — DAG construction, file isolation, sizing |
| `writing-prompts.md` | 5-section prompt template (GATE → CONTEXT → EXECUTE → VALIDATE → COMPLETE) |
| `protocol.md` | Runtime protocol — status state machine, Hub-Lite architecture, git sync, scheduling, error recovery |
| `templates/prompt-template.md` | Copy-paste prompt skeleton per workstream |
| `templates/status-file-template.md` | YAML-frontmatter status file starter |
| `templates/ws-final-template.md` | Mandatory final summary workstream |
| `templates/orchestration-readme-template.md` | README for the scheduled-tasks folder |

### Core Architecture Concepts

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ORCHESTRATION MODEL                               │
│                                                                     │
│  Requirements Doc ──► Decomposition ──► DAG of Workstreams          │
│                                              │                      │
│                                    ┌─────────┼─────────┐            │
│                                    ▼         ▼         ▼            │
│                                  WS-A      WS-B      WS-D          │
│                                    │         │         │            │
│                                    └────┬────┘         │            │
│                                         ▼              │            │
│                                       WS-C ◄───────────┘            │
│                                         │                           │
│                                         ▼                           │
│                                     WS-FINAL                        │
│                                                                     │
│  Coordination: Status files (workspace FS, not git)                 │
│  Execution: Genie Code scheduled tasks (cron-fired)                 │
│  Isolation: One git branch per workstream, push-clone at end        │
│  Gating: Table-existence checks + status-file state machine         │
└─────────────────────────────────────────────────────────────────────┘
```

### State Machine

```
NOT_STARTED ──► IN_PROGRESS ──► COMPLETE
                            ──► BLOCKED (human intervention required)
```

Transitions are one-way. Only a human can reset BLOCKED → NOT_STARTED.

### Execution Model (Hub-Lite)

1. **Single bundle root** as source of truth (no separate orchestration hub vs working clone during execution)
2. **Status files** live in bundle root at `fixtures/handoffs/`, updated via `editAsset` (instant workspace-layer persistence)
3. **Git is write-only archival** — pushed at session end via a dedicated push-clone
4. **WS-INIT lifecycle control** — the supervisor (WS-INIT) pauses worker tasks externally after confirming they've fired; workers are scheduling-unaware
5. **Branch stacking** — downstream branches fork from upstream's pushed branch, inheriting code without merging

### Scheduling Strategy

| Type | Cron | Rationale |
| --- | --- | --- |
| WS-INIT (supervisor) | `0 0 */1 * * ?` | Hourly (platform minimum); periodic health check |
| All workers | `0 0 */1 * * ?` | Hourly safety net; primary trigger is manual "Run now" |
| WS-FINAL | `0 0 */1 * * ?` | Gates on ALL; fires once |

> **Platform constraint (verified 2026-08-14):** Sub-hourly cron is rejected by the API. The hourly cron serves as a safety net / auto-retry, not the primary execution trigger. WS-INIT owns all task lifecycle control (pause/unpause/delete). Workers are scheduling-unaware.

### Strengths

1. **Well-defined state machine** — simple, debuggable, recoverable
2. **File-scope isolation** — parallel workstreams can't conflict
3. **Table-gated dependencies** — decouples from PR review timing
4. **Self-terminating** — idempotent, safe to leave running
5. **WS-FINAL as bookend** — guaranteed summary + merge plan
6. **Prompt template** — consistent 5-section structure makes prompts predictable

### Weaknesses / Coupling Points

1. **Hard-coded to Databricks Bundles** — assumes `databricks.yml`, `bundle validate/deploy`, resource YAML
2. **Workshop-specific paths** — references `~/genieCodeWorkshop/`, `PROJECT_MEMORY.md`, `fixtures/` conventions
3. **Manual prompt authoring** — user must hand-write each workstream prompt (no synthesis from docs)
4. **No persistent execution log** — status files are flat markdown; no queryable history
5. **No retry intelligence** — BLOCKED is a dead end requiring human reset
6. **Self-pause uses internal API** — `alerts-internal/scheduled-insights-list` is undocumented/fragile
7. **No cost/duration tracking** — can't answer "how long did this take" or "what did it cost"
8. **Single-tenant design** — assumes one user, one project, one workspace

---

## Part 2: Generic Redesign — "Workstream Orchestrator SDK"

### Vision

A skill that acts as an **SDK-like interface**: you point it at a requirements document, architecture document, or project spec, and it:

1. **Analyzes** the document to identify deliverables
2. **Decomposes** into a DAG of workstreams with dependency edges
3. **Synthesizes** prompt files for each workstream using templates
4. **Provisions** the orchestration infrastructure (status tracking, scheduling)
5. **Monitors** execution with queryable state
6. **Reports** on completion with merge plans and summaries

### Design Principles

1. **Input-driven, not convention-driven** — works with ANY project structure, not just Databricks Bundles
2. **Pluggable execution backends** — Bundle deploy, raw SQL, API calls, notebook runs, or custom
3. **Document-first decomposition** — reads PRDs, architecture docs, READMEs to synthesize workstreams
4. **Queryable state** — execution history in a durable store (Lakebase), not just flat files
5. **Observable** — every prompt fire, gate check, and state transition is logged
6. **Multi-project** — track multiple orchestrations concurrently
7. **Resumable** — intelligent retry with context from prior attempts

### Proposed Module Structure

```
workstream-orchestrator/
├── SKILL.md                          # Entry point + triggers
├── core/
│   ├── decomposition.md              # How to analyze docs → workstreams
│   ├── dag-builder.md                # Dependency mapping + validation
│   ├── prompt-synthesis.md           # Auto-generate prompts from specs
│   └── state-machine.md              # Generic state transitions
├── backends/
│   ├── databricks-bundle.md          # Bundle validate/deploy execution
│   ├── notebook-run.md               # Run notebooks as workstream steps
│   ├── sql-execution.md              # Raw SQL DDL/DML as steps
│   └── custom.md                     # Bring-your-own execution pattern
├── tracking/
│   ├── lakebase-schema.md            # Postgres schema for state + history
│   ├── status-protocol.md            # Read/write protocol for state
│   └── observability.md              # OTel integration for tracing
├── templates/
│   ├── prompt-template.md            # Universal prompt skeleton
│   ├── ws-final-template.md          # Summary workstream
│   └── decomposition-output.md       # Standard format for DAG output
└── examples/
    ├── data-platform.md              # Pipeline + metrics + features
    ├── migration.md                  # Batch conversion pattern
    └── microservices.md              # Parallel services + integration
```

### SDK-Like Interface: "Point at a Document"

#### Input Contract

The orchestrator accepts any of:

| Input Type | Example | What It Extracts |
| --- | --- | --- |
| Requirements doc | PRD, user stories, feature spec | Deliverables, acceptance criteria, dependencies |
| Architecture doc | System design, data model, component diagram | Components, data flows, build order |
| Existing codebase | README + directory structure | Current state, gaps to fill, extension points |
| Conversation thread | "Build me X with Y and Z" | Intent, constraints, success criteria |

#### Synthesis Pipeline

```
Document(s) ──► Extract Deliverables ──► Map Dependencies ──► Validate Isolation
                                                                    │
                                              ┌─────────────────────┘
                                              ▼
                                    Generate DAG JSON
                                              │
                                              ▼
                              Synthesize Prompt per Workstream
                                              │
                                              ▼
                              Provision Tracking (Lakebase)
                                              │
                                              ▼
                              Create Scheduled Tasks
                                              │
                                              ▼
                              Return Execution Plan for Review
```

#### DAG Output Format (Machine-Readable)

```json
{
  "project": "customer-360-platform",
  "source_documents": ["architecture.md", "requirements.md"],
  "workstreams": [
    {
      "id": "ws-a",
      "name": "Data Ingestion Pipeline",
      "description": "Bronze/silver/gold layers for customer events",
      "depends_on": [],
      "file_scope": ["src/pipelines/", "resources/pipeline.yml"],
      "output_artifacts": ["catalog.schema.bronze_events", "catalog.schema.gold_customers"],
      "estimated_duration_min": 45,
      "execution_backend": "databricks-bundle",
      "gate_conditions": [
        {"type": "table_exists", "target": "catalog.schema.gold_customers", "min_rows": 1}
      ]
    },
    {
      "id": "ws-b",
      "name": "Metric Views",
      "depends_on": ["ws-a"],
      "...": "..."
    }
  ],
  "scheduling": {
    "ws_init_cron": "0 0 */1 * * ?",
    "worker_cron": "0 0 */1 * * ?"
  }
}
```

### Execution Backend Abstraction

The existing skill assumes `databricks bundle deploy`. The generic version uses a pluggable backend:

```
Interface: ExecutionBackend
  ├── validate(workstream) → success/errors
  ├── execute(workstream) → artifacts[]
  ├── verify(workstream) → passed/failed
  └── rollback(workstream) → cleaned

Implementations:
  ├── DatabricksBundleBackend    → bundle validate/deploy/run
  ├── NotebookRunBackend         → notebook execution via Jobs API
  ├── SQLExecutionBackend        → SQL statements via warehouse
  ├── PipelineRunBackend         → SDP pipeline updates
  └── CompositeBackend           → chain multiple backends per workstream
```

---

## Part 3: Lakebase Integration for State Tracking

### Why Lakebase?

| Concern | Current (Flat Files) | Proposed (Lakebase) |
| --- | --- | --- |
| State persistence | Markdown in workspace FS | Postgres tables with ACID |
| Query history | Manual grep | `SELECT * FROM executions WHERE project = ?` |
| Concurrent access | Single-writer convention | Row-level locking |
| Audit trail | Git log (delayed) | Every transition timestamped |
| Cost tracking | Not possible | Duration + token usage logged |
| Cross-project view | Separate folders | Single schema, filtered by project |
| Retry intelligence | None | Query prior attempts, error patterns |
| Dashboard-ready | No | Direct SQL from any BI tool |

### Proposed Lakebase Schema

```sql
-- Core orchestration tracking
CREATE TABLE orchestrations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_name    TEXT NOT NULL,
    source_documents TEXT[],           -- paths to input docs
    dag_json        JSONB NOT NULL,    -- full DAG definition
    status          TEXT NOT NULL DEFAULT 'PLANNING',
        -- PLANNING, ACTIVE, COMPLETED, FAILED, CANCELLED
    created_at      TIMESTAMPTZ DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    created_by      TEXT               -- user email
);

CREATE TABLE workstreams (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    orchestration_id  UUID REFERENCES orchestrations(id),
    workstream_key    TEXT NOT NULL,    -- e.g. "ws-a"
    name              TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'NOT_STARTED',
        -- NOT_STARTED, GATED, IN_PROGRESS, VALIDATING, COMPLETE, BLOCKED, RETRYING
    depends_on        TEXT[],           -- workstream_keys
    file_scope        TEXT[],
    output_artifacts  TEXT[],
    execution_backend TEXT NOT NULL,
    scheduled_task_id TEXT,             -- Genie Code automation ID
    branch_name       TEXT,
    started_at        TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ,
    attempt_count     INT DEFAULT 0,
    UNIQUE(orchestration_id, workstream_key)
);

CREATE TABLE prompts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workstream_id     UUID REFERENCES workstreams(id),
    version           INT NOT NULL DEFAULT 1,
    prompt_text       TEXT NOT NULL,    -- full synthesized prompt
    template_used     TEXT,             -- which template generated it
    parameters        JSONB,            -- substitution values used
    created_at        TIMESTAMPTZ DEFAULT now(),
    is_active         BOOLEAN DEFAULT true
);

CREATE TABLE executions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workstream_id     UUID REFERENCES workstreams(id),
    prompt_id         UUID REFERENCES prompts(id),
    attempt_number    INT NOT NULL,
    status            TEXT NOT NULL,
        -- GATE_CHECK, EXECUTING, VALIDATING, SUCCEEDED, FAILED, TIMED_OUT
    gate_result       JSONB,            -- what the gate check found
    started_at        TIMESTAMPTZ DEFAULT now(),
    completed_at      TIMESTAMPTZ,
    duration_seconds  INT,
    error_message     TEXT,
    artifacts_created TEXT[],           -- tables, files, resources
    notes_for_downstream TEXT,          -- "Notes for Downstream" content
    session_summary   TEXT
);

CREATE TABLE state_transitions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workstream_id     UUID REFERENCES workstreams(id),
    execution_id      UUID REFERENCES executions(id),
    from_status       TEXT NOT NULL,
    to_status         TEXT NOT NULL,
    reason            TEXT,
    transitioned_at   TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX idx_workstreams_orch ON workstreams(orchestration_id);
CREATE INDEX idx_executions_ws ON executions(workstream_id);
CREATE INDEX idx_transitions_ws ON state_transitions(workstream_id);
CREATE INDEX idx_orchestrations_status ON orchestrations(status);
```

### State Protocol (Lakebase-Backed)

Instead of reading/writing markdown status files, workstreams would:

```python
# Gate check (replaces: read upstream status file)
SELECT status FROM workstreams
WHERE orchestration_id = :orch_id
  AND workstream_key = ANY(:upstream_keys);
-- Proceed only if ALL are 'COMPLETE'

# Set IN_PROGRESS (replaces: editAsset on status file)
UPDATE workstreams SET status = 'IN_PROGRESS', started_at = now(), attempt_count = attempt_count + 1
WHERE id = :ws_id AND status IN ('NOT_STARTED', 'GATED');

INSERT INTO executions (workstream_id, prompt_id, attempt_number, status)
VALUES (:ws_id, :prompt_id, :attempt, 'EXECUTING');

INSERT INTO state_transitions (workstream_id, execution_id, from_status, to_status, reason)
VALUES (:ws_id, :exec_id, 'NOT_STARTED', 'IN_PROGRESS', 'Gate passed, starting execution');

# Mark COMPLETE (replaces: editAsset on status file)
UPDATE workstreams SET status = 'COMPLETE', completed_at = now(), branch_name = :branch
WHERE id = :ws_id;

UPDATE executions SET status = 'SUCCEEDED', completed_at = now(),
  duration_seconds = EXTRACT(EPOCH FROM now() - started_at),
  artifacts_created = :artifacts, notes_downstream = :notes
WHERE id = :exec_id;
```

### Dual-Write Strategy (Migration Path)

During transition, write to BOTH:
1. **Lakebase** — durable, queryable, source of truth
2. **Status files** — backward-compatible, human-readable in workspace

Gate checks read from Lakebase (faster, ACID). Status files become read-only artifacts.

### Observability Queries

```sql
-- How long did the full orchestration take?
SELECT project_name,
       completed_at - created_at AS total_duration,
       (SELECT COUNT(*) FROM workstreams w WHERE w.orchestration_id = o.id) AS workstream_count
FROM orchestrations o
WHERE status = 'COMPLETED'
ORDER BY created_at DESC;

-- Which workstreams are slowest?
SELECT w.name, AVG(e.duration_seconds) AS avg_seconds, COUNT(*) AS attempts
FROM executions e
JOIN workstreams w ON e.workstream_id = w.id
WHERE e.status = 'SUCCEEDED'
GROUP BY w.name
ORDER BY avg_seconds DESC;

-- What's currently running?
SELECT o.project_name, w.workstream_key, w.name, w.status, e.started_at
FROM workstreams w
JOIN orchestrations o ON w.orchestration_id = o.id
LEFT JOIN executions e ON e.workstream_id = w.id AND e.status = 'EXECUTING'
WHERE w.status = 'IN_PROGRESS';

-- Failure patterns (retry intelligence)
SELECT w.name, e.error_message, COUNT(*) AS occurrences
FROM executions e
JOIN workstreams w ON e.workstream_id = w.id
WHERE e.status = 'FAILED'
GROUP BY w.name, e.error_message
ORDER BY occurrences DESC;
```

---

## Part 4: Roadmap & Open Questions

### Phase 1: Extract & Generalize (Skill Rewrite)
- [ ] Remove all workshop-specific paths and conventions
- [ ] Abstract execution backend (not just Bundle deploy)
- [ ] Add document-analysis step to decomposition flow
- [ ] Make prompt synthesis automatic (not manual copy-paste)
- [ ] Support non-git projects (not everything needs branch stacking)

### Phase 2: Lakebase State Layer
- [ ] Design Lakebase project for orchestration tracking
- [ ] Implement read/write protocol as executeCode snippets in prompt templates
- [ ] Dual-write to both Lakebase + status files during transition
- [ ] Build observability queries as a companion dashboard
- [ ] Add retry intelligence (query prior failures before re-attempting)

### Phase 3: SDK Polish
- [ ] Single entry point: "Here's my architecture doc, orchestrate this"
- [ ] Auto-generate DAG visualization (mermaid in markdown)
- [ ] Cost estimation before execution (based on historical durations)
- [ ] Webhook/notification on completion (not just status file)
- [ ] Multi-user support (concurrent orchestrations, different projects)

### Open Questions

1. **Lakebase vs. Delta table for state?** — Lakebase gives row-level locking and instant reads (no eventual consistency). Delta gives schema evolution and time travel. Lakebase wins for coordination; Delta wins for analytics. Could do both: Lakebase for live state, Lakehouse Sync for historical analytics.

2. **How much decomposition can be automated?** — The current skill requires the human to identify workstreams. Can we reliably have the agent read an architecture doc and propose the DAG? Risk: over-decomposition or missed dependencies.

3. **Self-pause API stability** — The current skill uses `alerts-internal` (undocumented). If this breaks, the single-fire guard fails. Alternative: use the execution table itself as a lock (check `IN_PROGRESS` in Lakebase before starting).

4. **Cross-workspace orchestration** — Should this support workstreams that span multiple Databricks workspaces? If so, Lakebase as shared state becomes essential.

5. **Token/cost attribution** — Genie Code doesn't currently expose token usage per scheduled task. Can we infer cost from duration + model tier? Or do we need an OTel integration?

6. **Prompt versioning** — When a workstream fails and the prompt is revised, do we track the diff? The `prompts` table with `version` supports this, but the synthesis pipeline needs to know when to bump vs. replace.