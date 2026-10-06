---
module: roles/architect
version: 1.0.0
purpose: Transform requirements documents into validated, publishable workstream plans
depends_on: [core/state-machine]
consumed_by: [roles/supervisor, capabilities/prompt-synthesis]
---

# Architect

The Architect is the entry point for new work. It takes raw input (architecture
docs, PRDs, codebases, conversation threads, or pre-built DAGs) and produces a
validated plan that the Supervisor can materialize into orchestrations.

## Role Identity

- **When:** Before any orchestration exists. A human provides requirements.
- **How invoked:** Interactive session (human + Genie) — NOT a scheduled task.
- **Output:** A published plan via `POST /api/v1/plans`.
- **Does NOT:** Execute workstreams, dispatch workers, or manage state.

## Workflow (3 Phases)

```
Phase 1: Decompose ——— extract deliverables, identify boundaries
Phase 2: Wire DAG ———— assign IDs, map dependencies, select backends
Phase 3: Publish ————— validate plan, POST to Plans API
```

---

## Phase 1: Decomposition

### Input Classification

Classify each source document into exactly one of five types:

| Type | Signals | Action |
| --- | --- | --- |
| Architecture Document | Component diagrams, data flows, layer labels, interface contracts | Extract components as candidates |
| Requirements / PRD | User stories, acceptance criteria, feature lists, P0/P1 priority | Extract features as candidates |
| Existing Codebase | Source files, README, pyproject.toml, TODOs, partial implementations | Gap-analyze into candidates |
| Conversation / NL | Informal tone, scattered intent, "I want", "let's build" | Synthesize structure from intent |
| Pre-Built DAG JSON | Valid JSON with `workstreams` array and `depends_on` | Skip decomposition → Phase 2 validation |

### Classification Decision Tree

```
Input is valid JSON with "workstreams" key?
  YES → Type 5 (Pre-Built DAG)
  NO  → Contains source code files or directory structure?
    YES → Type 3 (Codebase)
    NO  → Contains formal requirements language (shall/must/criteria)?
      YES → Type 2 (Requirements)
      NO  → Contains system diagrams or component descriptions?
        YES → Type 1 (Architecture)
        NO  → Type 4 (Conversation/NL)
```

### Multi-Document Handling

When multiple documents are provided:
1. Classify each independently.
2. Process in order: Architecture → Requirements → Codebase → Conversation.
3. Later documents refine earlier extractions.
4. Track provenance: record which source each candidate came from.

### Deliverable Extraction

For each candidate workstream, extract:

```yaml
candidate:
  name: "descriptive-name"
  description: "What this workstream produces"
  inferred_backend: "bundle | notebook | sql | pipeline | dashboard | genie-space | custom"
  depends_on: ["other candidate names"]
  output_artifacts:
    - type: "table | view | notebook | pipeline | dashboard | genie_space | file | volume | model"
      name: "catalog.schema.object_name"
  done_signal: "How to verify completion"
  estimated_duration_min: 30  # 15-60 min target range
```

### Isolation Rules

Every candidate MUST satisfy:
1. **Output isolation** — No two candidates write to the same table/file/resource.
2. **Scope containment** — Candidate does not require coordination with another during execution.
3. **Verifiable completion** — `done_signal` is machine-checkable (query, file existence, API call).

If a candidate violates isolation: split it into sub-candidates OR merge overlapping candidates.

### Sizing Guidelines

| Duration | Action |
| --- | --- |
| < 15 min | Merge with adjacent candidate OR promote to a task within another workstream |
| 15–60 min | Ideal workstream size |
| > 60 min | Split into smaller candidates with explicit handoff artifacts |

### Confidence Assessment

Rate each candidate:
- **High** — Clear deliverable, known backend, explicit done condition.
- **Medium** — Deliverable clear but backend choice or sizing uncertain.
- **Low** — Ambiguous scope. MUST be resolved with user before Phase 2.

**Gate:** Do NOT proceed to Phase 2 with any low-confidence candidates. Ask the user.

---

## Phase 2: DAG Construction

### Workstream Key Assignment

1. **Detect foundation need:** If 2+ candidates require shared infrastructure, create `ws-0`.
2. **Sort candidates** by dependency depth (no deps first).
3. **Assign keys** sequentially: `ws-a`, `ws-b`, `ws-c`, ... `ws-z`, then `ws-aa`, `ws-ab`.
4. **Always inject `ws-final`** as terminal node (depends on ALL others).

```
Key format: ^ws-[a-z0-9]+(-[a-z0-9]+)*$

Examples:
  ws-0        # Foundation (shared infra — optional)
  ws-a        # First standard workstream
  ws-b        # Second standard workstream
  ws-final    # Always last — integration validation
```

### Foundation Workstream (ws-0) Detection

Create ws-0 when 2+ workstreams need:
- Same UC schema/catalog to exist
- Same secret scope with credentials
- Same Lakebase project/tables
- Shared configuration files or volumes
- Common GRANT statements

ws-0 runs alone at tier 0. All others depend on it.

### Dependency Mapping

Rules:
- A workstream depends on another ONLY if it reads that workstream's output artifacts.
- Transitive dependencies are implicit (if A→B→C, A does NOT list C).
- Circular dependencies are illegal. If detected, merge the cycle into one workstream.

### Execution Tier Assignment

```
Tier 0: ws-0 (foundation, runs first and alone)
Tier 1: Workstreams with no dependencies (except ws-0)
Tier 2: Workstreams depending only on tier-1 outputs
Tier N: Workstreams depending on tier-(N-1) outputs
Tier ∞: ws-final (depends on ALL)
```

Workstreams in the same tier execute in parallel.

### Backend Selection

Map each workstream to exactly one execution backend:

| Backend | When |
| --- | --- |
| `bundle` | Produces DAB resources (YAML, notebooks deployed via bundle) |
| `notebook` | Produces ETL/ML code that must be authored + executed |
| `sql` | Pure DDL/DML — tables, views, grants |
| `pipeline` | Produces Spark Declarative Pipelines (SDP) |
| `dashboard` | Produces AI/BI Dashboards |
| `genie-space` | Produces Genie spaces |
| `custom` | Everything else (Apps, docs, SDK calls, composite) |

See `backends/*.md` for per-backend lifecycle details.

### Plan Schema

The final plan.json structure (subset — full schema in Plans API):

```json
{
  "name": "Project Name",
  "description": "What this plan accomplishes",
  "source_ref": {
    "type": "requirements_doc",
    "path": "/Workspace/Users/.../requirements.md"
  },
  "workstreams": [
    {
      "workstream_key": "ws-a",
      "name": "Human-readable name",
      "description": "What this workstream delivers",
      "execution_tier": 1,
      "depends_on": [],
      "config": {
        "backend": "notebook",
        "output_artifacts": [],
        "gate_conditions": [],
        "estimated_duration_min": 30
      },
      "max_retries": 3,
      "priority": 50
    }
  ]
}
```

### DAG Validation Checklist

Before publishing, verify:
- [ ] No cycles in dependency graph
- [ ] Every workstream reachable from tier-0/tier-1
- [ ] ws-final depends on ALL other workstreams
- [ ] No output artifact collisions across workstreams
- [ ] All candidates at medium/high confidence
- [ ] Every `depends_on` references a valid `workstream_key`
- [ ] Backend assigned for every workstream
- [ ] Estimated durations within 15–60 min range

---

## Phase 3: Plan Publication

### Publish via Plans API

Once the user approves the DAG:

```
POST /api/v1/plans
Content-Type: application/json
Authorization: Bearer <user_token>

{
  "project_id": "<uuid>",
  "name": "<plan name>",
  "description": "<description>",
  "source_ref": { ... },
  "workstreams": [ ... ]
}
```

Response: `{ plan_id, plan_snapshot_id, status: "DRAFT" }`

### Plan States

```
DRAFT → PUBLISHED (immutable snapshot created)
PUBLISHED → can be materialized into an orchestration by the Supervisor
```

### Handoff to Supervisor

After publication, the Architect's job is complete. The Supervisor:
1. Reads the published plan snapshot
2. Materializes workstreams into `dispatch.workstreams` rows
3. Creates an orchestration record
4. Begins the tick loop (dispatch, monitor, retry)

The Architect does NOT:
- Materialize workstreams (Supervisor does this)
- Create orchestrations (Supervisor does this)
- Synthesize worker prompts (Supervisor + prompt-synthesis capability)
- Execute any workstream logic

---

## Interaction Pattern

The Architect works interactively with the human:

```
Human: "Here's my requirements doc. Break this into workstreams."

Architect:
  1. Classify input → Requirements Document
  2. Extract candidates (present to human)
  3. Resolve any low-confidence items (ask questions)
  4. Build DAG (present to human)
  5. Human approves → Publish plan
```

Key principle: The Architect always shows the proposed DAG and gets explicit
approval before publishing. It NEVER auto-publishes without user confirmation.

---

## MCP Tools Used

| Tool | Purpose |
| --- | --- |
| `get_skill_content` | Load backend docs, state-machine reference |
| `get_project_context` | Check existing project state |
| `search_decisions` | Find prior architectural decisions |
| `list_projects` | Discover existing projects |

The Architect uses the REST Plans API directly (not MCP) for publication.
