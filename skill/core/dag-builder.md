---
module: core/dag-builder
version: 1.0.0
purpose: Wire candidate deliverables into a validated, schedulable DAG; produce plan.json
depends_on: [core/decomposition]
consumed_by: [core/prompt-synthesis, tracking/lakebase-schema]
---

# DAG Builder

Accept candidate deliverables from the decomposition engine and produce a validated, cycle-free, isolation-checked plan.json that the supervisor can schedule and execute.

## Input

Receive the finalized candidate list from `core/decomposition`. Each candidate has:

```yaml
candidate:
  name: "string"
  description: "string"
  inferred_backend: "databricks-bundle | notebook-run | sql-execution | pipeline-editor | dashboard-editor | genie-space-editor | custom"
  depends_on: ["candidate name references"]
  output_artifacts: [{type, name, tier}]
  done_signal: "string"
  confidence: "high | medium | low"  # All should be high/medium by this point
  estimated_duration_min: integer
```

Pre-condition: All low-confidence candidates have been resolved through user interaction. The candidate list is stable.

## ID Assignment

Assign sequential workstream keys following these rules:

### Assignment Algorithm

1. **Detect foundation need**: If 2+ candidates require shared infrastructure (schemas, grants, volumes, config), create `ws-0` as foundation.
2. **Sort candidates** by dependency depth (no dependencies first, then single-depth, etc.).
3. **Assign keys** sequentially: `ws-a`, `ws-b`, `ws-c`, ... `ws-z`, then `ws-aa`, `ws-ab`, etc.
4. **Always inject `ws-final`** as the terminal node (depends on ALL others).

### Key Format

```
Pattern: ^ws-[a-z0-9]+(-[a-z0-9]+)*$

Examples:
  ws-0        # Foundation (optional, only when needed)
  ws-a        # First standard workstream
  ws-b        # Second standard workstream
  ws-final    # Always last

Compound keys for related workstreams:
  ws-data-bronze    # If descriptive keys are preferred
  ws-data-silver
  ws-ml-features
```

### Foundation Workstream (ws-0) Detection

Create `ws-0` when ANY of these conditions hold:
- 2+ workstreams need the same UC schema created
- 2+ workstreams need shared secret scopes
- 2+ workstreams need common grants/permissions
- Shared configuration files (databricks.yml) must exist before others run
- A bundle must be deployed before workstreams can use its resources

`ws-0` characteristics:
- `type: foundation`
- `depends_on: []` (no upstream)
- Every other workstream implicitly depends on ws-0
- Typically `execution_backend: databricks-bundle` or `sql-execution`
- Estimated duration: 10–20 min (often merged with small setup tasks)

### Example: ID Assignment

```
Input candidates:
  "Infrastructure Setup" (no deps)
  "Ingestion Pipeline" (needs infra)
  "Transformation" (needs ingestion)
  "Metrics Views" (needs transformation)
  "Dashboard" (needs metrics)

Assignment:
  ws-0:     Infrastructure Setup (foundation — 2+ depend on it)
  ws-a:     Ingestion Pipeline
  ws-b:     Transformation
  ws-c:     Metrics Views
  ws-d:     Dashboard
  ws-final: Summary & Validation
```

## Dependency Inference

Build explicit dependency edges from candidate data plus inferred relationships.

### Explicit Dependencies

Direct from candidate `depends_on` arrays. Resolve name references to assigned ws-keys.

```
Candidate "Transformation" depends_on: ["Ingestion Pipeline"]
→ ws-b depends_on: [ws-a]
```

### Inferred Dependencies

Detect implicit dependencies from artifact relationships:

| Pattern | Inference | Example |
| --- | --- | --- |
| B reads table that A creates | B depends on A | ws-b reads `bronze_events` → depends on ws-a that creates it |
| B uses schema that A creates | B depends on A | ws-b needs `analytics` schema → depends on ws-0 |
| B queries view that A defines | B depends on A | ws-c reads `silver_users` view → depends on ws-b |
| B deploys to endpoint A configures | B depends on A | ws-d serves model from ws-c's endpoint |
| B references file A creates | B depends on A | ws-b imports module from ws-a's notebook |

### Inference Algorithm

```
For each workstream W:
  For each input W reads/uses:
    Find which workstream produces that input
    If found and not already in W.depends_on:
      Add edge: W depends on producer
      Log: "Inferred dependency: {W.key} → {producer.key} (reason: {input})"
```

### Dependency Types

Annotate each edge with its type for the supervisor:

```yaml
dependency_edge:
  from: ws-b
  to: ws-a
  type: status_complete | table_exists | soft
  reason: "ws-b reads bronze_events table created by ws-a"
```

| Type | Behavior | Use When |
| --- | --- | --- |
| `status_complete` | Downstream blocked until upstream status = COMPLETE | Default. Full completion required. |
| `table_exists` | Downstream starts when artifact exists (decoupled from status) | Artifact is the only thing needed; upstream may do more work after. |
| `soft` | Downstream proceeds regardless; uses upstream output if available | Nice-to-have enrichment; degraded output acceptable. |

## Adjacency List Construction

Build the DAG data structure from finalized dependencies.

### Data Structure

```python
# Adjacency list: key → list of keys it depends on
depends_on = {
    "ws-0":     [],
    "ws-a":     ["ws-0"],
    "ws-b":     ["ws-0", "ws-a"],
    "ws-c":     ["ws-b"],
    "ws-d":     ["ws-c"],
    "ws-final": ["ws-a", "ws-b", "ws-c", "ws-d"]
}

# Reverse adjacency (downstream consumers)
downstream_of = {
    "ws-0":     ["ws-a", "ws-b"],
    "ws-a":     ["ws-b", "ws-final"],
    "ws-b":     ["ws-c", "ws-final"],
    "ws-c":     ["ws-d", "ws-final"],
    "ws-d":     ["ws-final"],
    "ws-final": []
}
```

### Construction Steps

1. Initialize empty adjacency list with all ws-keys.
2. For each workstream, add its `depends_on` entries.
3. For ws-final, add ALL other workstream keys to its depends_on.
4. Build reverse adjacency for downstream lookups.
5. Validate: every key in any depends_on list must exist as a workstream key.

## Cycle Detection

Verify the DAG is acyclic using topological sort. A cycle means the plan is invalid and cannot be scheduled.

### Algorithm: Kahn's Topological Sort

```
1. Compute in-degree for each node (count of depends_on entries).
2. Initialize queue with all nodes having in-degree = 0.
3. While queue is not empty:
   a. Remove node N from queue.
   b. Add N to sorted order.
   c. For each downstream consumer of N:
      - Decrement its in-degree by 1.
      - If in-degree becomes 0, add to queue.
4. If sorted order contains ALL nodes: DAG is valid.
5. If sorted order is INCOMPLETE: cycle exists among remaining nodes.
```

### Cycle Reporting

When a cycle is detected, report:

```
## Cycle Detected

The following workstreams form a circular dependency:
  ws-b → depends on ws-c → depends on ws-b

This means neither can start because each waits for the other.

### Resolution Options:
1. Remove edge ws-b → ws-c (ws-b no longer needs ws-c's output)
2. Remove edge ws-c → ws-b (ws-c no longer needs ws-b's output)
3. Merge ws-b and ws-c into a single workstream
4. Introduce an intermediate workstream that breaks the cycle

Which resolution do you prefer?
```

### Cycle Resolution Strategies

1. **Remove weakest edge**: If one dependency is `soft`, remove it.
2. **Merge**: If the cycle is between two tightly-coupled workstreams, merge them.
3. **Extract shared dependency**: Pull the shared artifact into its own ws-0/foundation workstream.
4. **Reorder**: If the cycle is caused by inference error, correct the inferred dependency.

## Topological Levels

Assign each workstream to a level (depth from root). Workstreams at the same level can execute in parallel.

### Level Assignment Algorithm

```
1. Level 0: All workstreams with no dependencies (in-degree = 0).
2. Level N: All workstreams whose dependencies are ALL at levels < N.
3. Formally: level(W) = max(level(dep) for dep in W.depends_on) + 1
4. If W.depends_on is empty: level(W) = 0
```

### Example

```
Level 0: ws-0
Level 1: ws-a, ws-b  (both depend only on ws-0)
Level 2: ws-c        (depends on ws-a and ws-b)
Level 3: ws-d        (depends on ws-c)
Level 4: ws-final    (depends on all)

Parallelism: ws-a and ws-b execute concurrently at Level 1.
```

### Critical Path Computation

The critical path is the longest chain through the DAG. It determines minimum total execution time.

```
critical_path_duration = sum(estimated_duration_min for ws in longest_chain)
parallel_duration = sum(max(durations at each level))
sequential_duration = sum(all workstream durations)
parallelism_gain = 1 - (parallel_duration / sequential_duration)
```

Report:
```
Critical Path: ws-0 → ws-a → ws-c → ws-d → ws-final
Critical Path Duration: 145 min
Total Sequential Duration: 210 min
Parallel Duration: 165 min (ws-b runs alongside ws-a)
Parallelism Gain: 21%
```

## Isolation Validation

Ensure parallel workstreams (same level or no dependency path between them) cannot conflict.

### Step 1: Identify Parallel Pairs

Two workstreams are parallel if:
- They are at the same topological level, OR
- Neither has a dependency path to the other (even if at different levels)

```
parallel_pairs = []
for each pair (ws_i, ws_j) where i ≠ j:
  if no path exists from ws_i to ws_j AND no path from ws_j to ws_i:
    parallel_pairs.append((ws_i, ws_j))
```

### Step 2: Output Artifact Overlap Check

For each parallel pair, verify their output artifacts are disjoint:

```
for (ws_i, ws_j) in parallel_pairs:
  artifacts_i = set(ws_i.output_artifacts[*].name)
  artifacts_j = set(ws_j.output_artifacts[*].name)
  overlap = artifacts_i & artifacts_j
  if overlap:
    CONFLICT: "{ws_i.key} and {ws_j.key} both produce: {overlap}"
```

### Step 3: File Scope Overlap Check

For each parallel pair, verify their file scopes are disjoint:

```
for (ws_i, ws_j) in parallel_pairs:
  scope_i = set(ws_i.file_scope)
  scope_j = set(ws_j.file_scope)
  # Check exact overlap
  overlap = scope_i & scope_j
  # Check glob overlap (e.g., "src/" contains "src/main.py")
  for path_i in scope_i:
    for path_j in scope_j:
      if is_prefix(path_i, path_j) or is_prefix(path_j, path_i):
        overlap.add(f"{path_i} overlaps {path_j}")
  if overlap:
    CONFLICT: "{ws_i.key} and {ws_j.key} file scope overlap: {overlap}"
```

### Step 4: Implicit Conflict Detection

Check for conflicts that aren't captured by explicit artifacts:

| Conflict Type | Detection Rule | Example |
| --- | --- | --- |
| Serving endpoint | Two ws configure same endpoint name | Both set `my_model_endpoint` |
| Pipeline | Two ws modify same pipeline | Both add tables to pipeline X |
| Config file | Two ws write to shared config | Both modify `databricks.yml` |
| Schema DDL | Two ws run DDL on same schema | Both ALTER same table |
| Secret scope | Two ws write to same secret key | Both set `api_key` secret |
| Git branch | Two ws commit to same branch | Both push to `feature-x` |

### Conflict Resolution

When any conflict is detected:

1. **Add edge** (preferred): Make one workstream depend on the other.
   - Choose: the one that logically comes first gets priority.
   - If unclear, choose the one with fewer downstream consumers (minimizes cascade).

2. **Split artifact**: Rename outputs to be distinct.
   - E.g., both produce `metrics_view` → rename to `metrics_view_daily` and `metrics_view_hourly`.

3. **Merge workstreams**: If conflict indicates tight coupling.
   - Check: would merged duration exceed 90 min? If yes, prefer option 1 or 2.

Report all resolutions to the user for confirmation.

## Sizing Validation

Re-validate workstream sizes after DAG construction (merges/splits may have changed estimates).

### Duration Re-estimation

After DAG modifications, recalculate:
```
for each workstream:
  if was_merged:
    new_duration = sum(merged durations) * 0.8  # Slight efficiency gain
  if was_split:
    new_duration = original_duration * 0.6  # Each piece is ~60% of original
  validate against sizing rules
```

### Violation Handling

| Violation | Severity | Action |
| --- | --- | --- |
| < 15 min | Warning | Suggest merge candidates; proceed if user confirms |
| 60–90 min | Note | Log as borderline; proceed |
| > 90 min | Error | MUST resolve before plan.json generation |

### Report Format

```
## Sizing Validation

| Workstream | Duration | Status |
|------------|----------|--------|
| ws-0       | 15 min   | ✅ OK   |
| ws-a       | 45 min   | ✅ OK   |
| ws-b       | 95 min   | ❌ TOO LARGE — must split |
| ws-c       | 12 min   | ⚠️ TOO SMALL — consider merge |

### Required Actions:
- ws-b: Split into ws-b1 (pipeline logic, ~50 min) and ws-b2 (validation, ~45 min)
- ws-c: Consider merging into ws-b2 or ws-d
```

## WS-FINAL Injection

Always create a terminal workstream that runs after everything else.

### WS-FINAL Specification

```yaml
workstream:
  key: ws-final
  name: "Plan Completion & Summary"
  description: "Validate all workstream outputs, generate completion report, clean up state"
  type: final
  execution_backend: custom
  depends_on: [ALL other workstream keys]
  file_scope:
    - "orchestration/state/plan-summary.md"
  output_artifacts:
    - type: file
      name: "orchestration/state/plan-summary.md"
      verification:
        type: file_exists
        path: "orchestration/state/plan-summary.md"
      tier: platform
  gate_conditions:
    - type: status_complete
      target: "ALL"
  estimated_duration_min: 10
  max_retries: 1
  execution_notes: |
    1. Read all workstream status files.
    2. Verify all gates passed.
    3. Generate summary report.
    4. Report any partial failures.
    5. Provide next-steps if applicable.
```

### WS-FINAL Responsibilities

1. **Gate verification**: Confirm every workstream reached COMPLETE.
2. **Artifact validation**: Spot-check that key artifacts exist.
3. **Summary generation**: Produce human-readable completion report.
4. **Error aggregation**: Collect and summarize any warnings from workstreams.
5. **Cleanup**: Archive state files, pause scheduled tasks.

## Plan JSON Generation

Assemble the validated DAG into the final plan.json structure.

### Assembly Steps

1. **Project metadata**: Set `project_name`, `orchestration_id`, `version`, paths.
2. **Source documents**: Record absolute paths of all input documents.
3. **Context documents**: Identify files workstreams need to read (not write).
4. **State configuration**: Set mode (file or lakebase), paths.
5. **Git configuration**: Branch strategy, remote URL.
6. **Workstream array**: Convert each workstream to plan schema format.
7. **Scheduling**: Set WS-INIT and worker cron expressions.

### Workstream Conversion

Convert internal representation to plan.json schema:

```yaml
# Internal representation
workstream:
  key: ws-a
  name: "Ingestion Pipeline"
  description: "Read from S3, land in bronze tables"
  type: standard
  inferred_backend: notebook-run
  depends_on: [ws-0]
  file_scope: ["src/bronze/"]
  output_artifacts:
    - type: table
      name: "catalog.schema.bronze_events"
      tier: platform
  estimated_duration_min: 45

# Plan.json format
{
  "key": "ws-a",
  "name": "Ingestion Pipeline",
  "description": "Read from S3, land in bronze tables",
  "type": "standard",
  "execution_backend": "notebook-run",
  "depends_on": ["ws-0"],
  "file_scope": ["src/bronze/"],
  "output_artifacts": [
    {
      "type": "table",
      "name": "catalog.schema.bronze_events",
      "verification": {
        "type": "table_exists",
        "target": "catalog.schema.bronze_events"
      },
      "tier": "platform"
    }
  ],
  "gate_conditions": [
    {
      "type": "table_exists",
      "target": "catalog.schema.bronze_events"
    }
  ],
  "estimated_duration_min": 45,
  "max_retries": 1,
  "context_docs": ["architecture"],
  "execution_notes": "Build ingestion from S3 to bronze. Use Auto Loader for incremental reads."
}
```

### Gate Condition Generation

Infer gate conditions from output artifacts:

| Artifact Type | Default Gate | Target |
| --- | --- | --- |
| table | `table_exists` | Fully qualified table name |
| view | `table_exists` | Fully qualified view name |
| model | `resource_deployed` | Model serving endpoint name |
| endpoint | `endpoint_ready` | Endpoint URL or name |
| file | `file_exists` | Absolute workspace path |
| dashboard | `resource_deployed` | Dashboard ID |
| genie_space | `resource_deployed` | Space ID |
| pipeline | `resource_deployed` | Pipeline ID |
| volume | `resource_deployed` | Volume path |

### Pre-Output Validation

Run these checks before emitting plan.json:

```
Validation Checklist:
☐ project_name is non-empty
☐ workstreams array has ≥ 2 entries
☐ Every depends_on reference points to existing workstream key
☐ No circular dependencies (DAG is acyclic)
☐ file_scope of parallel workstreams does not overlap
☐ Every execution_backend is a recognized value
☐ Every output_artifact type is from recognized enum
☐ ws-final exists and depends on all others
☐ Every workstream has ≥ 1 gate_condition
☐ Every workstream has estimated_duration_min within bounds
☐ orchestration_id follows pattern: orch-YYYY-MM-DD-<slug>
☐ All file paths are absolute workspace paths
```

If any validation fails, report the error and do NOT emit plan.json.

### Complete Plan.json Example

```json
{
  "project_name": "Customer Analytics Platform",
  "orchestration_id": "orch-2026-08-14-customer-analytics",
  "version": "1.0.0",
  "source_documents": [
    "/Workspace/Users/user@example.com/project/architecture.md",
    "/Workspace/Users/user@example.com/project/requirements.md"
  ],
  "context_documents": [
    {
      "key": "architecture",
      "path": "/Workspace/Users/user@example.com/project/architecture.md",
      "purpose": "System design reference for all workstreams"
    }
  ],
  "project_root": "/Workspace/Users/user@example.com/project",
  "orchestration_root": "/Workspace/Users/user@example.com/project/orchestration",
  "state": {
    "mode": "file",
    "state_dir": "/Workspace/Users/user@example.com/project/orchestration/state"
  },
  "git": {
    "enabled": true,
    "remote_url": "https://github.com/user/project.git",
    "branch_per_workstream": true
  },
  "workstreams": [
    {
      "key": "ws-0",
      "name": "Foundation Infrastructure",
      "description": "Create UC schema, volumes, grants, and deploy bundle skeleton",
      "type": "foundation",
      "execution_backend": "databricks-bundle",
      "depends_on": [],
      "file_scope": ["databricks.yml", "resources/"],
      "output_artifacts": [
        {
          "type": "volume",
          "name": "catalog.schema.raw_data",
          "verification": {"type": "resource_deployed", "target": "catalog.schema.raw_data"},
          "tier": "platform"
        }
      ],
      "gate_conditions": [
        {"type": "resource_deployed", "target": "catalog.schema"}
      ],
      "estimated_duration_min": 15,
      "max_retries": 1,
      "context_docs": ["architecture"],
      "execution_notes": "Deploy foundation bundle. Create schema, volumes, grants."
    },
    {
      "key": "ws-a",
      "name": "Ingestion Pipeline",
      "description": "Build bronze ingestion from S3 using Auto Loader",
      "type": "standard",
      "execution_backend": "notebook-run",
      "depends_on": ["ws-0"],
      "file_scope": ["src/bronze/"],
      "output_artifacts": [
        {
          "type": "table",
          "name": "catalog.schema.bronze_events",
          "verification": {"type": "table_exists", "target": "catalog.schema.bronze_events"},
          "tier": "platform"
        }
      ],
      "gate_conditions": [
        {"type": "table_exists", "target": "catalog.schema.bronze_events"}
      ],
      "estimated_duration_min": 45,
      "max_retries": 1,
      "context_docs": ["architecture"],
      "execution_notes": "Build Auto Loader ingestion notebook. Source: S3 bucket. Target: bronze_events table."
    },
    {
      "key": "ws-b",
      "name": "Transformation Layer",
      "description": "Join and transform bronze into silver tables with business logic",
      "type": "standard",
      "execution_backend": "notebook-run",
      "depends_on": ["ws-a"],
      "file_scope": ["src/silver/"],
      "output_artifacts": [
        {
          "type": "table",
          "name": "catalog.schema.silver_customers",
          "verification": {"type": "table_exists", "target": "catalog.schema.silver_customers"},
          "tier": "downstream"
        }
      ],
      "gate_conditions": [
        {"type": "table_exists", "target": "catalog.schema.silver_customers"}
      ],
      "estimated_duration_min": 40,
      "max_retries": 1,
      "context_docs": ["architecture"],
      "execution_notes": "Transform bronze_events into silver_customers. Apply dedup, joins, type casting."
    },
    {
      "key": "ws-c",
      "name": "Gold Metrics & Serving",
      "description": "Create gold aggregate views and configure Genie space",
      "type": "standard",
      "execution_backend": "sql-execution",
      "depends_on": ["ws-b"],
      "file_scope": ["src/gold/"],
      "output_artifacts": [
        {
          "type": "view",
          "name": "catalog.schema.gold_customer_metrics",
          "verification": {"type": "table_exists", "target": "catalog.schema.gold_customer_metrics"},
          "tier": "app"
        },
        {
          "type": "genie_space",
          "name": "Customer Analytics Space",
          "verification": {"type": "resource_deployed", "target": "Customer Analytics Space"},
          "tier": "app"
        }
      ],
      "gate_conditions": [
        {"type": "table_exists", "target": "catalog.schema.gold_customer_metrics"},
        {"type": "resource_deployed", "target": "Customer Analytics Space"}
      ],
      "estimated_duration_min": 35,
      "max_retries": 1,
      "context_docs": ["architecture"],
      "execution_notes": "Create gold views with SQL. Set up Genie space over gold tables."
    },
    {
      "key": "ws-final",
      "name": "Plan Completion & Summary",
      "description": "Validate all outputs, generate completion report",
      "type": "final",
      "execution_backend": "custom",
      "depends_on": ["ws-0", "ws-a", "ws-b", "ws-c"],
      "file_scope": ["orchestration/state/plan-summary.md"],
      "output_artifacts": [
        {
          "type": "file",
          "name": "orchestration/state/plan-summary.md",
          "verification": {"type": "file_exists", "path": "orchestration/state/plan-summary.md"},
          "tier": "platform"
        }
      ],
      "gate_conditions": [
        {"type": "status_complete", "target": "ALL"}
      ],
      "estimated_duration_min": 10,
      "max_retries": 1,
      "context_docs": [],
      "execution_notes": "Read all status files. Verify gates. Generate summary. Report results."
    }
  ],
  "scheduling": {
    "ws_init_cron": "0 */5 * * * ?",
    "worker_cron": "0 */5 * * * ?"
  }
}
```

## DAG Visualization

Generate a text-based DAG representation for user review.

### ASCII Format

```
                    DAG: Customer Analytics Platform
                    ================================

Level 0:  [ ws-0: Foundation Infrastructure (15 min) ]
               |
               v
Level 1:  [ ws-a: Ingestion Pipeline (45 min) ]
               |
               v
Level 2:  [ ws-b: Transformation Layer (40 min) ]
               |
               v
Level 3:  [ ws-c: Gold Metrics & Serving (35 min) ]
               |
               v
Level 4:  [ ws-final: Completion (10 min) ]

Critical Path: ws-0 → ws-a → ws-b → ws-c → ws-final = 145 min
Parallelism: None (linear chain)
```

### Parallel DAG Example

```
                    DAG: Multi-Stream Analytics
                    ===========================

Level 0:  [ ws-0: Foundation (15 min) ]
               /           \
              v             v
Level 1:  [ ws-a: Users    [ ws-b: Events
            Pipeline         Pipeline
            (45 min) ]       (50 min) ]
              \             /
               v           v
Level 2:  [ ws-c: Join & Enrich (35 min) ]
               /           \
              v             v
Level 3:  [ ws-d: Dashboard [ ws-e: ML Model
            (30 min) ]        (55 min) ]
              \             /
               v           v
Level 4:  [ ws-final: Completion (10 min) ]

Critical Path: ws-0 → ws-b → ws-c → ws-e → ws-final = 165 min
Sequential Duration: 240 min
Parallel Duration: 165 min
Parallelism Gain: 31%

Parallel Pairs: (ws-a, ws-b), (ws-d, ws-e)
Isolation: ✅ All parallel pairs have disjoint file scopes
```

### Visualization Rules

1. Use box notation `[ ws-key: name (duration) ]` for each node.
2. Show arrows indicating dependency direction (upstream → downstream).
3. Align parallel workstreams horizontally at the same level.
4. Highlight the critical path with bold or `*` markers.
5. Include summary statistics below the diagram.
6. Show isolation status for parallel pairs.

---

*Output of this module (plan.json) is consumed by `core/prompt-synthesis` for prompt generation and `tracking/lakebase-schema` for state table creation.*