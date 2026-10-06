---
module: core/decomposition
version: 1.0.0
purpose: Parse source documents, extract deliverables, identify isolation boundaries, size workstreams
depends_on: []
consumed_by: [core/dag-builder, core/prompt-synthesis]
---

# Decomposition Engine

Transform raw user input (architecture docs, PRDs, codebases, conversation threads, or pre-built DAGs) into a validated list of candidate workstreams ready for DAG construction.

## Input Classification

Classify every source document into exactly one of five types. When a single document contains mixed signals, classify by its primary structure.

### Classification Rules

1. **Architecture Document** — Identify by: component diagrams, data flow arrows, layer labels (bronze/silver/gold), interface contracts, technology stack sections, system boundary notation.
   - Signal phrases: "component", "data flows from", "layer", "interface", "service boundary"
   - File patterns: `*.md` with diagram blocks, `*.drawio`, architecture decision records

2. **Requirements Document / PRD** — Identify by: user stories ("As a..."), acceptance criteria, feature lists, priority labels (P0/P1), stakeholder sections, success metrics.
   - Signal phrases: "must", "shall", "acceptance criteria", "user story", "requirement"
   - File patterns: PRD docs, requirements specs, feature briefs

3. **Existing Codebase + README** — Identify by: directory structure with source files, `README.md`, `pyproject.toml`/`setup.py`, existing table definitions, TODO comments, partially-implemented features.
   - Signal phrases: "TODO", "FIXME", "planned", existing function/class definitions
   - File patterns: source trees, config files, build manifests

4. **Conversation Thread / Natural Language** — Identify by: informal tone, multiple turns, questions and answers, scattered intent across messages, no formal structure.
   - Signal phrases: "I want", "we need", "let's build", "the idea is"
   - Source: chat history, meeting notes, brainstorm docs

5. **Pre-Built DAG JSON** — Identify by: valid JSON with `workstreams` array, `depends_on` fields, `gate_conditions`.
   - Action: Skip decomposition entirely. Validate schema and pass directly to DAG builder.

### Classification Decision Tree

```
Input is valid JSON with "workstreams" key?
  YES → Type 5 (Pre-Built DAG)
  NO  → Contains source code files or directory structure?
    YES → Type 3 (Codebase)
    NO  → Contains formal requirements language (shall/must/acceptance criteria)?
      YES → Type 2 (Requirements)
      NO  → Contains system diagrams or component descriptions?
        YES → Type 1 (Architecture)
        NO  → Type 4 (Conversation/NL)
```

### Multi-Document Handling

When the user provides multiple documents:
1. Classify each independently.
2. Process in order: Architecture → Requirements → Codebase → Conversation.
3. Later documents refine/override earlier extractions (e.g., requirements may split an architectural component into multiple workstreams).
4. Track provenance: record which source document each candidate came from.

## Deliverable Extraction

For each classified input type, apply the corresponding extraction rules.

### Type 1: Architecture Documents

| Signal | Extraction | Example |
| --- | --- | --- |
| Named component | Candidate workstream | "Ingestion Layer" → ws candidate |
| Data flow arrow A → B | Dependency edge A → B | "Raw → Bronze → Silver" → chain |
| Layer boundary | Execution ordering constraint | "Bronze before Silver" |
| Interface contract | Gate condition | "API endpoint must return 200" |
| Technology choice | Backend inference | "Spark pipeline" → notebook-run |
| Shared resource | Foundation workstream signal | "UC schema used by all" → ws-0 |

Extraction procedure:
1. List every named component or subsystem.
2. For each component, identify its inputs (what it reads) and outputs (what it writes).
3. Map data flows to dependency edges.
4. Group components by layer — each layer boundary suggests ordering.
5. Extract interface contracts as gate conditions.

### Type 2: Requirements Documents / PRDs

| Signal | Extraction | Example |
| --- | --- | --- |
| Feature / user story | Candidate workstream | "User can view dashboard" → ws |
| Acceptance criteria | Validation check / gate | "Data refreshes within 5 min" |
| "X before Y" language | Dependency edge | "Login required before profile" |
| Non-functional requirement | Constraint annotation | "< 2s latency" → sizing note |
| Priority label | Ordering hint | P0 features first |

Extraction procedure:
1. List every distinct feature or user story.
2. Group related stories into logical deliverables (one workstream per logical unit).
3. Extract temporal ordering from requirement language.
4. Map acceptance criteria to gate conditions.
5. Note priority — high priority features may warrant earlier scheduling.

### Type 3: Existing Codebase + README

| Signal | Extraction | Example |
| --- | --- | --- |
| Existing table/resource | Already-complete (skip) | `CREATE TABLE` in DDL → done |
| TODO/FIXME comment | Candidate workstream | `# TODO: add silver layer` → ws |
| Empty/stub file | Candidate workstream | `silver.py` with pass → ws |
| README planned features | Candidate workstream | "Planned: dashboard" → ws |
| Directory structure | File scope boundary | `src/bronze/` → scope for bronze ws |
| Config files | Constraint source | `databricks.yml` → target info |

Extraction procedure:
1. Scan for completed artifacts (existing tables, deployed resources) — mark as done.
2. Identify gaps: TODO comments, stub files, README planned sections.
3. Each gap becomes a candidate workstream.
4. Map directory structure to file_scope boundaries.
5. Extract config for target/environment context.

### Type 4: Conversation Thread / Natural Language

| Signal | Extraction | Example |
| --- | --- | --- |
| Named output | Candidate workstream | "We need a metrics view" → ws |
| Ordering language | Dependency edge | "After the pipeline runs" → edge |
| Technology mention | Backend inference | "Use a notebook" → notebook-run |
| Scope language | Workstream boundary | "Just the ingestion part" → scope |
| Uncertainty language | Low confidence flag | "Maybe we could" → low confidence |

Extraction procedure:
1. Scan all messages for concrete deliverable nouns ("pipeline", "dashboard", "table", "model").
2. Assign each deliverable noun as a candidate.
3. Look for ordering signals ("first", "then", "after", "before", "depends on").
4. Note uncertainty markers — these reduce confidence.
5. Consolidate duplicates (same deliverable mentioned multiple times).

### Type 5: Pre-Built DAG JSON

No extraction needed. Validate against plan.json schema and pass to DAG builder directly. Report any schema violations to user.

## Candidate Structure

Every extracted deliverable becomes a candidate with this structure:

```yaml
candidate:
  name: "Human-readable deliverable name"
  description: "1-3 sentence purpose statement"
  inferred_backend: "databricks-bundle | notebook-run | sql-execution | pipeline-editor | dashboard-editor | genie-space-editor | custom"
  depends_on:
    - "Name of upstream candidate (resolved to ws-key later)"
  output_artifacts:
    - type: "table | view | model | endpoint | file | dashboard | genie_space | pipeline | volume"
      name: "catalog.schema.artifact_name (fully qualified when possible)"
      tier: "platform | downstream | app"
  done_signal: "Description of completion condition"
  confidence: "high | medium | low"
  confidence_reason: "Why this confidence level"
  source_document: "Which input document this came from"
  estimated_duration_min: 30  # Initial estimate
```

### Example: Architecture Document Extraction

Given input:
```
System has three layers:
- Ingestion: reads from S3, lands in bronze tables
- Transformation: joins bronze tables, produces silver
- Serving: aggregates silver into gold metrics, serves via Genie space
```

Extracted candidates:
```yaml
candidates:
  - name: "Ingestion Pipeline"
    description: "Read from S3 source, land raw data in bronze tables"
    inferred_backend: notebook-run
    depends_on: []
    output_artifacts:
      - type: table
        name: "catalog.schema.bronze_*"
        tier: platform
    done_signal: "Bronze tables exist and contain data"
    confidence: high
    confidence_reason: "Explicitly named component with clear inputs/outputs"
    source_document: "architecture.md"
    estimated_duration_min: 45

  - name: "Transformation Layer"
    description: "Join bronze tables, apply business logic, produce silver tables"
    inferred_backend: notebook-run
    depends_on: ["Ingestion Pipeline"]
    output_artifacts:
      - type: table
        name: "catalog.schema.silver_*"
        tier: downstream
    done_signal: "Silver tables exist with correct schema"
    confidence: high
    confidence_reason: "Explicitly named with clear data flow from bronze"
    source_document: "architecture.md"
    estimated_duration_min: 40

  - name: "Serving Layer"
    description: "Aggregate silver into gold metrics, configure Genie space"
    inferred_backend: sql-execution
    depends_on: ["Transformation Layer"]
    output_artifacts:
      - type: view
        name: "catalog.schema.gold_metrics"
        tier: app
      - type: genie_space
        name: "Project Metrics Space"
        tier: app
    done_signal: "Gold views queryable, Genie space responds"
    confidence: high
    confidence_reason: "Explicitly named with clear data flow from silver"
    source_document: "architecture.md"
    estimated_duration_min: 35
```

## Backend Inference

Choose `execution_backend` based on content signals in the candidate's work:

| Backend | Choose When |
| --- | --- |
| `databricks-bundle` | Work involves deploying infrastructure: schemas, volumes, grants, jobs, secrets, Lakebase, ML models, serving endpoints. Uses `databricks bundle deploy`. Does NOT apply when the primary deliverable requires a dedicated editor page (use the editor-specific backends below for those). |
| `notebook-run` | Work involves writing and executing code: ETL pipelines, data transformations, ML training, complex multi-step logic. Produces notebooks as artifacts. |
| `sql-execution` | Work is pure SQL: DDL statements, view creation, metric definitions, grants, simple table operations. No Python/Scala needed. |
| `pipeline-editor` | Work produces a Spark Declarative Pipeline (SDP) — streaming tables, materialized views, Auto CDC, data-quality expectations. SDP authoring is handled by the pipeline editor page; the bundle resource YAML is captured after. |
| `dashboard-editor` | Work produces an AI/BI Dashboard — widgets, charts, datasets queried via SQL. Widget authoring requires the dashboard draft-canvas page; the `.lvdash.json` is captured into the bundle after. |
| `genie-space-editor` | Work produces a Genie Space / Agent — NL-to-SQL conversational analytics over Unity Catalog tables. Configuration/tuning is handled via the Genie space page; the `.geniespace.json` is captured into the bundle after. |
| `custom` | Work requires tools not covered by any of the above: Databricks Apps, external API calls, manual approval gates, WS-FINAL orchestration summary, composite multi-backend phases. |

### Inference Decision Tree

```
Is the primary deliverable a Spark Declarative Pipeline (streaming tables / MVs / CDC / expectations)?
  YES → pipeline-editor
  NO  → Is the primary deliverable an AI/BI Dashboard (widgets, charts, visualizations)?
    YES → dashboard-editor
    NO  → Is the primary deliverable a Genie Space / Agent (NL-to-SQL analytics)?
      YES → genie-space-editor
      NO  → Does the work deploy other infrastructure resources (schemas, jobs, apps, secrets)?
        YES → databricks-bundle
        NO  → Is the work purely SQL (DDL, views, grants)?
          YES → sql-execution
          NO  → Does it require multi-step code execution (Python/Scala)?
            YES → notebook-run
            NO  → custom
```

### Override Rules

- If the user explicitly specifies a backend, use it regardless of inference.
- If a workstream both deploys infra AND runs code, prefer `databricks-bundle` (it can include notebook tasks).
- If uncertain between `notebook-run` and `sql-execution`, prefer `notebook-run` (more flexible).
- **Editor-backed backends (pipeline-editor, dashboard-editor, genie-space-editor) still require the resulting resource to be declared in `resources/*.yml` and deployed via `bundle deploy`.** The editor-backed backend governs the *authoring* step; the bundle deployment step is part of that backend's own Execute lifecycle. Do not split editor authoring and bundle capture across separate workstreams unless they are genuinely large enough to warrant it.

## Isolation Boundary Detection

Determine `file_scope` — the set of paths each workstream has exclusive write access to.

### Detection Rules

1. **Directory-based**: If the project has a clear directory structure, assign each workstream ownership of its directory.
   ```
   src/bronze/  → owned by Ingestion workstream
   src/silver/  → owned by Transformation workstream
   src/gold/    → owned by Serving workstream
   ```

2. **File-based**: If workstreams share a directory, assign specific files.
   ```
   src/pipeline.py        → owned by Pipeline workstream
   src/metrics_views.sql  → owned by Metrics workstream
   ```

3. **Artifact-based**: For non-file outputs, scope by artifact type + name.
   ```
   tables: catalog.schema.bronze_*  → owned by Ingestion
   views: catalog.schema.gold_*     → owned by Serving
   ```

4. **Shared files**: Some files are legitimately shared (e.g., `databricks.yml`, `README.md`). Options:
   - Assign to `ws-0` (foundation) if it exists
   - Assign to the workstream that creates it first
   - Flag for user decision if ambiguous

### Conflict Detection

Two workstreams CANNOT both write to the same path. Check:
- Exact path overlap: `src/config.py` in both → conflict
- Glob overlap: `src/*.py` and `src/main.py` → conflict
- Artifact overlap: both create `catalog.schema.users` table → conflict

Resolution options:
1. **Add dependency edge** — make one sequential after the other
2. **Split artifact** — give each workstream a distinct output name
3. **Merge workstreams** — combine into one if tightly coupled

## Workstream Sizing

Estimate duration for each candidate and validate against bounds.

### Duration Heuristics

| Work Type | Typical Duration | Signals |
| --- | --- | --- |
| Multi-layer pipeline (bronze→gold) | 30–60 min | Multiple tables, transformations |
| Metric views (3–5 views) | 20–40 min | SQL aggregations, window functions |
| Feature tables (2–3 tables) | 25–45 min | Joins, feature engineering |
| Dashboard (5–10 widgets) | 20–35 min | Visualizations, layout |
| Genie space configuration | 15–25 min | Space setup, table registration |
| ML model training | 30–60 min | Feature prep, training, logging |
| Infrastructure setup | 10–20 min | Schemas, grants, volumes |
| Bundle deployment config | 15–30 min | YAML authoring, variable setup |
| API integration | 25–45 min | Auth, request logic, error handling |
| Documentation / README | 10–20 min | Markdown authoring |

### Sizing Validation Rules

| Estimated Duration | Assessment | Action |
| --- | --- | --- |
| < 15 min | Too small | Merge with logically adjacent workstream |
| 15–60 min | Right size | Proceed as-is |
| 60–90 min | Borderline | Accept if cannot split cleanly; add note |
| > 90 min | Too large | MUST split into smaller workstreams |

### Split Strategies (when > 90 min)

1. **By layer**: Separate bronze/silver/gold into distinct workstreams.
2. **By artifact type**: Tables in one WS, views in another, dashboard in a third.
3. **By logical phase**: Setup → Core Logic → Validation → Serving.
4. **By data domain**: Customer tables separate from transaction tables.

### Merge Strategies (when < 15 min)

1. **Into foundation (ws-0)**: If it's infrastructure setup, merge into ws-0.
2. **Into dependent**: If WS-B takes 10 min and WS-C depends only on WS-B, merge B into C.
3. **Into peer**: If two small workstreams are at the same DAG level with no conflicts, merge.

## Confidence Scoring

Assign confidence to each candidate based on extraction clarity.

### Scoring Rules

| Confidence | Criteria | User Action |
| --- | --- | --- |
| **high** | Explicitly named in source; clear inputs/outputs; unambiguous scope | No confirmation needed |
| **medium** | Inferred from context; scope somewhat ambiguous; reasonable but not certain | Present for confirmation |
| **low** | Guessed from vague signals; multiple valid interpretations; uncertain scope | MUST confirm with user before proceeding |

### Confidence Triggers

**High confidence when:**
- Component is explicitly named ("The ingestion pipeline will...")
- Inputs and outputs are both specified
- Technology/backend is stated
- No conflicting information in other documents

**Medium confidence when:**
- Component implied but not named ("We'll need some way to transform...")
- Inputs OR outputs specified but not both
- Scope boundary is inferred from context
- Minor ambiguity exists

**Low confidence when:**
- Deliverable is mentioned in passing ("maybe a dashboard")
- Scope is completely undefined
- Multiple valid decompositions exist
- Contradictory signals in different documents
- User used uncertainty language ("perhaps", "might", "could")

## User Interaction Protocol

Decomposition is interactive. Present findings to the user at key decision points.

### Mandatory Interaction Points

1. **After classification** — Confirm input type(s) detected are correct.
2. **Low-confidence candidates** — Present each with alternatives; ask user to choose.
3. **Ambiguous splits** — When a component could be one WS or two, ask.
4. **Backend uncertainty** — When inference is unclear, present options.
5. **Before finalizing** — Show complete candidate list; get approval.

### Interaction Format

Present candidates in a structured summary:

```
## Decomposition Summary

I identified N candidate workstreams from your input:

| # | Name | Backend | Depends On | Duration | Confidence |
|---|------|---------|------------|----------|------------|
| 1 | ...  | ...     | ...        | ~30 min  | high       |
| 2 | ...  | ...     | ...        | ~45 min  | medium     |

### Needs Your Input:
- Candidate 2: I inferred this from [signal]. Should this be:
  a) A separate workstream as shown?
  b) Merged into Candidate 1?
  c) Something else entirely?

Shall I proceed with this decomposition?
```

### Iteration Protocol

1. Present initial decomposition.
2. User provides feedback (approve, modify, reject).
3. Apply modifications.
4. If modifications are substantial (>2 candidates changed), re-present.
5. If minor (≤2 candidates changed), confirm and proceed.
6. Maximum 3 iterations before asking user to provide explicit structure.

---

*Output of this module feeds into `core/dag-builder` for dependency wiring and validation.*