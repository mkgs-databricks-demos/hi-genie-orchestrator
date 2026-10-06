---
module: core/prompt-synthesis
version: 1.0.0
purpose: Synthesize self-contained worker prompts from plan.json workstream definitions
depends_on: [core/state-machine, core/decomposition, core/dag-builder]
consumed_by: [supervisor scheduled task during worker creation]
---

# Prompt Synthesis Engine

Transform a workstream definition from plan.json into a fully self-contained scheduled-task instruction set. The synthesized instructions carry everything a fresh session needs — concrete file paths, explicit tool calls, and numbered steps. No persona assignment, no protocol framing, no identity language.

> **⚠️ CRITICAL — Prompt Tone (Platform Constraint):**
> Synthesized prompts MUST read as concrete Databricks workspace tasks — numbered
> steps using specific tools (readAssetById, editAsset, executeCode, createAsset).
> They MUST NOT:
> - Assign a persona or identity ("You are WS-X", "As the worker...")
> - Frame instructions as an operating protocol or state machine
> - Use possessive language ("your status file", "your file scope")
> - Include lifecycle/protocol vocabulary ("gate check", "claim", "lifecycle")
>
> The platform rejects prompts that appear to override the agent's identity or
> install an alternate operating system. Lead with `Task: [description]` and
> use `## Step N:` headers throughout.

> **This project: File Mode only.** Hi Genie Orchestrator's `plan.json` sets `state.mode: "file"`. Every "Lakebase" branch below (gate/claim/validate/complete SQL variants, `${lakebase_*}` substitution variables) is inert for this project — kept for portable-skill reference only. Only synthesize the File-Based / File Mode variants for this project's worker prompts.

> **⚠️ CRITICAL — Prompt Tone (Platform Constraint):**
> Synthesized prompts MUST read as concrete Databricks workspace tasks — numbered
> steps using specific tools (readAssetById, editAsset, executeCode, createAsset).
> They MUST NOT:
> - Assign a persona or identity ("You are WS-X", "As the worker...")
> - Frame instructions as an operating protocol or state machine
> - Use possessive language ("your status file", "your file scope")
> - Include lifecycle/protocol vocabulary ("gate check", "claim", "lifecycle")
>
> The platform rejects prompts that appear to override the agent's identity or
> install an alternate operating system. Lead with `Task: [description]` and
> use `## Step N:` headers throughout.

## Template Selection

Select the template based on the workstream `type` field from plan.json. Use this decision tree exactly:

```
workstream.type == "supervisor"?
  YES → ws-init-template (supervisor with 8-priority decision tree)
  NO  → workstream.type == "final"?
    YES → ws-final-template (gates on ALL, summary only, never writes code)
    NO  → worker-prompt-template (standard 5-section lifecycle)
```

### Template Characteristics

| Template | Trigger | Key Behavior |
| --- | --- | --- |
| ws-init-template | `type: supervisor` | Tick-based: reads all state files, evaluates conditions in priority order, takes one action (create a task, log a blocker, report status); never executes work directly |
| worker-prompt-template | `type: foundation \| standard \| batch` | 5-step task list (Verify/Read/Build/Verify outputs/Mark complete); does real work; writes files/tables/resources |
| ws-final-template | `type: final` | Waits for ALL workstream status files to show COMPLETE; generates summary report; never creates tables/resources; marks orchestration COMPLETED |

### Selection Rules

1. Exactly one workstream in any plan has `type: supervisor` — it becomes the WS-INIT scheduled task.
2. Exactly one workstream has `type: final` — it is always `ws-final`.
3. All other workstreams use the worker template regardless of `execution_backend`.
4. If `type` is missing or unrecognized, default to worker-prompt-template and log a warning.

## Variable Resolution

Resolve substitution variables from plan.json fields, computed values, and orchestration configuration. Every `${variable}` in a template maps to exactly one source.

### Substitution Table

| Variable | Source | Example Value |
| --- | --- | --- |
| `${project_name}` | `plan.project_name` | `"Customer Analytics Platform"` |
| `${orchestration_id}` | `plan.orchestration_id` | `"orch-2026-08-14-customer-analytics"` |
| `${workstream_key}` | `workstream.key` | `"ws-a"` |
| `${workstream_name}` | `workstream.name` | `"Ingestion Pipeline"` |
| `${workstream_description}` | `workstream.description` | `"Build bronze ingestion from S3"` |
| `${execution_backend}` | `workstream.execution_backend` | `"notebook-run"` |
| `${project_root}` | `plan.project_root` | `"/Workspace/Users/user@example.com/project"` |
| `${orchestration_root}` | `plan.orchestration_root` | `"/Workspace/Users/user@example.com/project/orchestration"` |
| `${state_directory}` | `plan.state.state_dir` | `"/Workspace/.../orchestration/state/"` |
| `${state_mode}` | `plan.state.mode` | `"file"` or `"lakebase"` |
| `${lakebase_host}` | `plan.state.lakebase.host` (if mode=lakebase) | `"instance-xxx.cloud.databricks.com"` |
| `${lakebase_project}` | `plan.state.lakebase.project_name` | `"my-project"` |
| `${lakebase_branch}` | `plan.state.lakebase.branch_name` | `"production"` |
| `${lakebase_database}` | `plan.state.lakebase.database` | `"orchestration_state"` |
| `${git_remote_url}` | `plan.git.remote_url` (if git.enabled) | `"https://github.com/user/project.git"` |
| `${branch_name}` | computed: `mg-genie-${workstream_key}` | `"mg-genie-ws-a"` |
| `${push_clone_path}` | `plan.git.push_clone_path` | `"/Workspace/.../project"` |
| `${bundle_target}` | computed from backend config | `"dev"` |
| `${bundle_path}` | `workstream.file_scope[0]` parent or project_root | `"/Workspace/.../project"` |
| `${notebook_path}` | first `.ipynb` in file_scope | `"src/bronze/ingestion.ipynb"` |
| `${warehouse_id}` | plan-level or workstream-level config | `"abc123def456"` |
| `${target_catalog}` | plan-level backend config | `"hls_fde_dev"` |
| `${target_schema}` | plan-level backend config | `"dev_matthew_giglia_analytics"` |
| `${estimated_duration_min}` | `workstream.estimated_duration_min` | `45` |
| `${max_retries}` | `workstream.max_retries` (default: 3) | `1` |
| `${ws_init_dispatcher_job_id}` | `plan.scheduling.dispatcher_job_id` (nullable) | `12345` or `null` |
| `${lakebase_endpoint}` | `plan.state.lakebase.host` (if mode=lakebase, else null) | `"instance-xxx.cloud.databricks.com"` or `null` |
| `${execution_tier}` | `workstream.execution_tier.tier` (default: `"tier_3"`) | `"tier_3"` |
| `${worker_cron}` | `plan.scheduling.worker_cron` (default: `"0 0 */1 * * ?"`) | `"0 0 */1 * * ?"` |

### Computed Variables

Some variables require computation beyond simple field lookups:

1. **`${branch_name}`** — If `plan.git.branch_per_workstream` is true: `mg-genie-${workstream_key}`. Otherwise: use `plan.git.shared_branch`.
2. **`${status_file_path}`** — `${state_directory}/workstream-${workstream_key}-status.md`
3. **`${upstream_status_paths}`** — For each key in `workstream.depends_on`: `${state_directory}/workstream-${key}-status.md`
4. **`${own_status_file}`** — Alias for `${status_file_path}` used in gate check.

### Resolution Precedence

When the same variable could come from multiple sources:
1. Workstream-level config (highest priority)
2. Plan-level config
3. Computed defaults (lowest priority)

If a required variable cannot be resolved, STOP synthesis and report: `"Cannot resolve ${variable_name} — missing from plan.json workstream '${workstream_key}' and no default exists."`

## Content Block Generation

Generate each content block by combining plan.json fields with template-specific logic. Content blocks are the large text regions injected into the 5 steps.

### Gate Check Block

Generate gate logic based on `state_mode` and `depends_on`.

#### File-Based State (state.mode = "file")

Template:
```
## Step 1: Verify preconditions

Read the status file at `${status_file_path}` using readAssetById (assetType "file").
- If the `status` field is `COMPLETE` → respond "Already done" and stop.
- If the `status` field is `IN_PROGRESS` → respond "Already running" and stop.
- If the `status` field is `BLOCKED` → respond "Blocked" and stop.
- If the `status` field is `RETRYING` → read the `prior_error` field, then continue with adapted strategy.

Check dependencies:
${FOR EACH dep IN workstream.depends_on}
- Read the file at `${state_directory}/workstream-${dep}-status.md`
${END FOR}
- If ANY dependency has a `status` field that is not `COMPLETE` → report which and stop.
${IF workstream.gate_conditions}

Additional checks:
${FOR EACH condition IN workstream.gate_conditions}
- Verify: ${condition.type} for ${condition.target}
${END FOR}
${END IF}
```

#### Lakebase State (state.mode = "lakebase") [reference only — this project uses File Mode]

Template:
```
## 1. GATE CHECK

Query own status:
SELECT status, error_message, prior_error, attempt_count
FROM workstreams
WHERE orchestration_id = '${orchestration_id}'
  AND workstream_key = '${workstream_key}';

- If status is COMPLETE → respond "Already complete." STOP.
- If status is IN_PROGRESS → respond "Already running." STOP.
- If status is BLOCKED → respond "Blocked." STOP.
- If status is RETRYING → load prior_error, proceed with adapted strategy.

Query upstream:
SELECT workstream_key, status
FROM workstreams
WHERE orchestration_id = '${orchestration_id}'
  AND workstream_key IN (${depends_on_quoted_list});

- If ANY row has status != 'COMPLETE' → report which and STOP.
```

#### Gate Condition Expansion

Expand each `gate_condition` entry into a concrete check:

| Condition Type | Generated Check |
| --- | --- |
| `table_exists` | `SELECT COUNT(*) FROM ${target} LIMIT 1` — must return >= 1 row |
| `file_exists` | `readAssetById(assetType="file", id="${target}")` — must succeed |
| `resource_deployed` | `runDatabricksCli("bundle summary")` or API check for named resource |
| `status_complete` | Read status file — assert status = COMPLETE |
| `endpoint_ready` | `runDatabricksCli("serving-endpoints get ${target}")` — state = READY |

### Context Block

Assemble all context the workstream needs to read (NOT write). Populate from three sources.

#### Prompt Size Strategy

Prompts MUST stay within platform character limits. Use these strategies in priority order:

**Strategy B (Default): Context-by-Reference**

Never inline large document excerpts into prompts. Instead, instruct the worker to read context files at runtime:

```
Read `${path}` for: ${purpose}
```

The prompt carries execution logic, gate checks, and output requirements. All reference material (architecture docs, upstream notes, conventions) lives in workspace files that the worker reads via `readAssetById` at the start of its session. This keeps prompts lean (~2,000–4,000 chars) regardless of project complexity.

Benefits:
- Prompts stay small and focused
- Context can be arbitrarily large (no truncation risk)
- Context files can be updated without re-synthesizing prompts
- Workers read only what they need (selective loading)

**Strategy A (Large Workstreams): Hierarchical Sub-Stream Splitting**

When a single workstream would require >8,000 chars of execution instructions (typically: large migrations, 30+ table DDLs, complex multi-step pipelines), split into parent→child sub-streams:

1. Parent workstream prompt is lean: just the sub-stream DAG + gate logic
2. Each child gets a focused prompt with only its slice of execution steps
3. Parent gates on all children completing
4. Children share the same `file_scope` partition (non-overlapping within the split)

Sub-stream key convention: `${parent_key}-1`, `${parent_key}-2`, etc.
Example: `ws-a` splits into `ws-a-1` (tables 1–10), `ws-a-2` (tables 11–20), `ws-a-3` (views).

**Future: Lakebase + AppKit MCP Memory Layer** (skill roadmap item — not this project's tracking layer; see note below)

A future enhancement to *this orchestration skill* uses Lakebase Postgres as a durable memory layer accessible via a custom MCP server running in a Databricks AppKit app. Note: this is unrelated to Hi Genie Orchestrator's own ws-f (Semantic Memory Layer) deliverable, which builds this exact pattern as the *product* — do not conflate the two. This enables:
- Long-term context storage (project conventions, prior decisions, error patterns)
- Cross-session memory without file I/O in the prompt
- Shared context between WS-INIT and workers via SQL queries
- Token-efficient retrieval (query only what's needed vs. reading full files)

This pattern decouples context from prompt size entirely — workers query the MCP for context at runtime rather than carrying it inline or reading large files.

#### Architecture Excerpts

For each entry in `workstream.context_docs`:
1. Look up the key in `plan.context_documents[]` to find the absolute path.
2. Inject a **read instruction** (NOT the content itself): `Read ${path} for: ${purpose}`.
3. If the context document is another skill module, reference the specific sections relevant to this workstream.

Template:
```
## Step 2: Read reference files

Read these files for reference (do NOT modify them):
${FOR EACH doc IN resolved_context_docs}
- `${doc.path}` — ${doc.purpose}
${END FOR}

### Architecture notes
${IF backend == "databricks-bundle"}
- Bundle resource patterns: YAML with `resources:` key, target-specific variable substitution
- Deploy validation: `databricks bundle validate --target ${bundle_target}`
${END IF}
${IF backend == "notebook-run"}
- Notebook conventions: First cell = pip install + restart, widgets for parameters
- Compute: Serverless default, use dbutils.library.restartPython()
${END IF}
${IF backend == "sql-execution"}
- SQL conventions: CREATE OR REPLACE, fully-qualified names, CLUSTER BY AUTO
- Warehouse: Use ${warehouse_id} for execution
${END IF}
```

#### Upstream Notes

For each entry in `workstream.depends_on`:
1. Reference the upstream's status file path.
2. Instruct the workstream to read the "Notes for Downstream Sessions" section.
3. Summarize what to expect (artifact names, key decisions).

Template:
```
### Notes from Upstream
${FOR EACH dep IN workstream.depends_on}

#### From ${dep} (${dep_name})
Read: `${state_directory}/workstream-${dep}-status.md`
Expected outputs: ${dep_artifacts_summary}
Key decisions: ${dep_key_decisions_summary}
${END FOR}
```

#### File Scope Declaration

Declare the workstream's exclusive write territory:

Template:
```
### File scope (exclusive write paths — no other task writes here)
${FOR EACH path IN workstream.file_scope}
- `${project_root}/${path}`
${END FOR}

### Required output artifacts
${FOR EACH artifact IN workstream.output_artifacts}
- ${artifact.type}: `${artifact.name}` (tier: ${artifact.tier})
  Verification: ${artifact.verification.type} → ${artifact.verification.target}
${END FOR}
```

### Execute Block

Generate the execution section with claim logic, backend-specific instructions, and workstream-specific steps.

#### Structure

Template:
```
## Step 3: Build

### 3a. Claim the work
${claim_block}

### 3b. Documentation check
If uncertain about a Databricks feature or API, search documentation first. After 2 failures with the same error, stop and search for the current correct approach before retrying.

### 3c. Execution steps
${execution_steps_from_notes}

### 3d. Backend instructions
${backend_specific_block}

### Constraints
- Only modify files within the file scope listed in Step 2.
- Use fully-qualified names for all tables and resources.
- Do not add scheduling or cron logic — this task runs as a scheduled automation.
- Make operations idempotent (CREATE OR REPLACE, IF NOT EXISTS).
- Do not reference external documents not listed in Step 2.
- State files are the single source of truth for coordination.
- Targeted edits only (file mode) — use one editAsset patch per field. Never rebuild or replace the full YAML frontmatter. Other actors write to the same status file.
```

#### Claim Block Generation

Generate based on state_mode:

**File-based claim:**
```
Use editAsset to update the status file at `${status_file_path}`:
- Patch: old_text "status: NOT_STARTED" → new_text "status: IN_PROGRESS"
- If the edit returns changed: false → another instance already claimed this work. Respond "Already claimed" and stop.

If the status field was RETRYING instead of NOT_STARTED:
- Patch: old_text "status: RETRYING" → new_text "status: IN_PROGRESS"
- Read the `prior_error` field from the same file and adapt strategy per retry escalation.
```

> ⚠️ **CRITICAL — Targeted Patches Only (File Mode):**
> When synthesizing file-based state edits, emit ONE editAsset patch per field
> changed. NEVER emit a patch that replaces the entire YAML frontmatter block
> or the full file content. The supervisor writes metadata fields
> (scheduled_task_id, task_paused, created_at_tick) to the same status file.
> A full-file replace overwrites those fields and breaks coordination.
>
> Correct pattern to emit:
> ```json
> {"patches": [{"old_text": "status: NOT_STARTED", "new_text": "status: IN_PROGRESS", "replace_all": false}]}
> ```
>
> Also emit this constraint in every synthesized worker prompt's CONSTRAINTS
> section: "Targeted edits only (file mode) — use one editAsset patch per field.
> Never rebuild or replace the full YAML frontmatter. Other actors (supervisor)
> write to the same file."

**Lakebase claim:** [reference only]
```
Claim via atomic UPDATE:
UPDATE workstreams
SET status = 'IN_PROGRESS',
    last_attempt_at = NOW()
WHERE orchestration_id = '${orchestration_id}'
  AND workstream_key = '${workstream_key}'
  AND status IN ('NOT_STARTED', 'RETRYING');

If 0 rows affected → another instance claimed. STOP.
```

#### Backend-Specific Instruction Blocks

Inject the appropriate backend contract instructions based on `execution_backend`:

**databricks-bundle:**
```
### Backend: Databricks Bundle

Setup:
1. Read bundle root at `${bundle_path}`.
2. Identify target: `${bundle_target}`.
3. Read existing `databricks.yml` for resource patterns.

Execute:
1. Write source files to `${file_scope}` paths.
2. Write resource YAML to `resources/` directory.
3. Run `databricks bundle validate --target ${bundle_target}` — must exit clean.
4. Run `databricks bundle deploy --target ${bundle_target}`.

Validate:
- `bundle validate` exits 0 with no errors.
- `bundle summary --target ${bundle_target}` shows expected resources.
- Table/resource existence checks per gate_conditions.

Teardown: None (bundle deploys are idempotent).
```

**notebook-run:**
```
### Backend: Notebook Run

Setup:
1. Read target notebook (or create if in file_scope).
2. Confirm serverless compute is available.

Execute:
1. Create/edit notebook cells with implementation.
2. First cell: `%pip install --upgrade databricks-sdk` + `dbutils.library.restartPython()`
3. Execute notebook cells in sequence.
4. Verify cell outputs are clean (no errors).

Validate:
- All cells executed without error.
- Output tables exist and have rows: `SELECT COUNT(*) FROM ${table}`.
- Any models logged to MLflow are registered.

Teardown: None.
```

**sql-execution:**
```
### Backend: SQL Execution

Setup:
1. Verify catalog `${target_catalog}` and schema `${target_schema}` exist.
2. Confirm SQL warehouse `${warehouse_id}` is accessible.

Execute:
1. Write SQL files to `${file_scope}` paths.
2. Execute each statement using `executeCode(language="sql")`.
3. Use CREATE OR REPLACE for idempotency.
4. Use fully-qualified names: `${target_catalog}.${target_schema}.object_name`.

Validate:
- `DESCRIBE TABLE ${target_catalog}.${target_schema}.${table}` returns columns.
- `SELECT COUNT(*) FROM ${table}` returns expected row count.
- No error output from any statement.

Teardown: None.
```

**custom:**
```
### Backend: Custom

Setup:
- Per workstream execution_notes.

Execute:
- Follow execution_notes verbatim.
- Use any available tools: editAsset, createAsset, executeCode, runDatabricksCli, API calls.
- Respect file_scope boundaries.

Validate:
- Verify all declared output_artifacts exist.
- Per-artifact verification checks as specified.

Teardown: Per execution_notes (default: none).
```

**pipeline-editor:**
```
### Backend: Pipeline Editor

Setup:
1. Check for an existing pipeline_id in upstream notes. If none, create one.
2. Read source table names, target schema, bronze/silver/gold layering from architecture docs.

Execute:
1. If no pipeline exists: createAsset (assetType: "pipeline", name: "${workstream_name}").
2. Hand off SDP authoring: openAsset (assetType: "pipeline-editor", assetId: <id>,
   continueMessage: describing source tables, target tables, layering, data-quality requirements
   — requirements ONLY, never @dp.* syntax, function signatures, or SDP implementation details).
3. After authoring confirmed: capture into bundle via resources/pipelines/*.yml (or bundle generate
   pipeline --existing-pipeline-id <id> + bundle deployment bind).
4. Run bundle validate --target ${bundle_target} and bundle deploy --target ${bundle_target}.

Validate:
- bundle validate exits clean. Pipeline state is IDLE (not FAILED).
- Target tables queryable: SELECT COUNT(*) FROM catalog.schema.table.

Teardown: Leave partial pipeline in place. Do NOT bundle destroy for SDP code issues.

Critical: Do NOT write or debug @dp.table/@dp.materialized_view code yourself. Set BLOCKED if
the pipeline update fails with an SDP error — it requires a pipeline editor session to fix.
```

**dashboard-editor:**
```
### Backend: Dashboard Editor

Setup:
1. Check for an existing dashboard_id in upstream notes. If none, create one.
2. Read source tables, metrics, and layout requirements from architecture docs.

Execute:
1. If no dashboard exists: createAsset (assetType: "dashboard", name: "${workstream_name}").
2. Hand off widget authoring: openAsset (assetType: "dashboard", assetId: <id>,
   continueMessage: describing metrics to show, source tables/views, desired charts —
   intent only, no widget JSON or dashboard serialization details).
3. After authoring confirmed: capture into bundle via bundle generate dashboard --existing-id <id>
   (writes src/*.lvdash.json). Declare in resources/dashboards/*.yml. Add src/*.lvdash.json to
   sync.exclude in databricks.yml.
4. Run bundle validate --target ${bundle_target} and bundle deploy --target ${bundle_target}.

Validate:
- src/*.lvdash.json exists and is non-empty. bundle validate exits clean.
- Dashboard accessible: readAssetById (assetType: "dashboard", assetId: <id>).

Teardown: Leave empty dashboard in place. Do not manually edit .lvdash.json.

Convention: warehouse_id is required in resources/dashboards/*.yml.
```

**genie-space-editor:**
```
### Backend: Genie Space Editor

Setup:
1. Check for an existing genie_space_id in upstream notes. If none, create one.
2. Collect fully-qualified tableIdentifiers from workstream spec.
3. Confirm engine: direct is present in databricks.yml bundle block.

Execute:
1. Create Genie space: createAsset (assetType: "genie", name: "${workstream_name}",
   tableIdentifiers: <list>).
2. Hand off instruction/benchmark tuning: openAsset (assetType: "genie", assetId: <id>,
   continueMessage: describing the domain, key columns, expected question types, sample questions,
   and curated SQL patterns or trust filters — intent and data context only).
3. After configuration confirmed: capture into bundle via bundle generate genie-space
   --existing-id <id> (writes .geniespace.json). Declare in resources/genie_spaces/*.yml.
4. Run bundle validate --target ${bundle_target} and bundle deploy --target ${bundle_target}.

Validate:
- bundle validate exits clean (engine: direct must be present).
- Space accessible: readAssetById (assetType: "dataroom", assetId: <id>).
- Space has data sources and at least one sample question.

Teardown: Leave partial space in place.

Critical: genie_spaces resources require engine: direct under bundle: in databricks.yml.
```

#### Execution Steps from Notes

Embed `workstream.execution_notes` verbatim as the primary execution instructions. If execution_notes is multi-line, number each line as a step:

```
### Execution Steps
${IF execution_notes is multi-line}
${ENUMERATE lines as numbered steps}
${ELSE}
1. ${execution_notes}
${END IF}
```

### Validate Block

Generate validation checks from `output_artifacts` and `gate_conditions`.

#### Structure

Template:
```
## Step 4: Verify outputs

First, update the status file at `${status_file_path}`:
${validating_state_update}

### Artifact checks
${FOR EACH artifact IN workstream.output_artifacts}
${artifact_check_for_type}
${END FOR}

### Additional checks
${FOR EACH condition IN workstream.gate_conditions}
${gate_condition_check}
${END FOR}

### If a check fails
- Retriable error (timeout, transient API failure, empty table that may need time):
  - Edit the status file: patch `status` to `RETRYING` (only if attempt_count < ${max_retries})
  - Edit the status file: patch `error_message` with what failed and suggested fix
  - Stop here — the supervisor task will handle re-scheduling.
- Permanent error (wrong schema, permission denied, logic error):
  - Edit the status file: patch `status` to `BLOCKED`
  - Edit the status file: patch `error_message` with an actionable description of what went wrong
  - Stop here — human intervention required.
```

#### Per-Artifact-Type Validation Generation

| Artifact Type | Generated Validation |
| --- | --- |
| `table` | `SELECT COUNT(*) FROM ${artifact.name}` — assert > 0 |
| `view` | `DESCRIBE ${artifact.name}` — assert returns columns; `SELECT COUNT(*) FROM ${artifact.name}` — assert > 0 |
| `model` | `runDatabricksCli("serving-endpoints get ${name}")` — assert state READY |
| `endpoint` | API health check — assert 200 response |
| `file` | `readAssetById(assetType="file", id="${path}")` — assert non-empty content |
| `dashboard` | `readAssetById(assetType="dashboard", id="${id}")` — assert exists |
| `genie_space` | `readAssetById(assetType="dataroom", id="${id}")` — assert exists |
| `pipeline` | `runDatabricksCli("pipelines get --pipeline-id ${id}")` — assert state |
| `volume` | `readAssetById(assetType="volume", id="${path}")` — assert exists |

#### Validating State Update

**File-based:**
```
Use editAsset to patch the status file:
- old_text "status: IN_PROGRESS" → new_text "status: VALIDATING"
(Single-field patch only — do not replace other frontmatter fields.)
```

**Lakebase:** [reference only]
```sql
UPDATE workstreams SET status = 'VALIDATING' WHERE workstream_key = '${workstream_key}' AND orchestration_id = '${orchestration_id}';
```

### Complete Block

Generate the completion section. Status update is ALWAYS the last action.

#### Structure

Template:
```
## Step 5: Mark complete

If ALL checks in Step 4 pass:

1. Use editAsset to append a "## Notes for Downstream Sessions" section to the status file at `${status_file_path}` containing:
   - What was built (file paths, table names, resource IDs)
   - Key decisions made during execution
   - Anything downstream tasks need to know
   - Approximate artifact sizes (line counts, row counts)

2. ${IF git.enabled}
   Commit and push:
   - Call runGit(operation="commit_and_push", commitMessage="${workstream_key}: ${workstream_name} complete", repoPath="${push_clone_path}")
   - Branch: `${branch_name}`
   ${END IF}

3. Edit the status file at `${status_file_path}`:
   ${complete_state_update}
   (This must be the last action. Do not write anything after this edit.)

If validation FAILS:
- Edit the status file: patch `status` to `BLOCKED`
- Edit the status file: patch `error_message` describing what failed
- Include: which artifact/check failed, what was expected vs actual, suggested remediation
```

#### Complete State Update

**File-based:**
```
Use editAsset to patch the status file:
- old_text "status: VALIDATING" → new_text "status: COMPLETE"

Fallback: If the patch fails (status field has an unexpected value due to a
concurrent edit), re-read the file with readAssetById, use the ACTUAL current
`status:` line as old_text, and retry. The work is done — the status just
needs correcting. Do not set BLOCKED for a status-write race.
```

**Lakebase:** [reference only]
```sql
UPDATE workstreams SET status = 'COMPLETE', completed_at = NOW() WHERE workstream_key = '${workstream_key}' AND orchestration_id = '${orchestration_id}';
```

#### Notes for Downstream Template

Every completed status file must include this section structure:

```markdown
## Notes for Downstream Sessions

### Artifacts Produced
- [List each artifact with full path/name]

### Key Decisions
- [Architectural choices, tradeoffs, non-obvious implementations]

### Deviations from Plan
- [Anything that differed from execution_notes, or "None"]

### For Downstream Consumers
- [Specific notes for workstreams that depend on this one]
- [Table schemas, API contracts, file formats they should expect]
```

## State-Reference Injection

Weave state names from `core/state-machine` into gate, claim, error, and validation logic. Use EXACT enum values — never abbreviate or rephrase.

### State Usage Map

| Prompt Section | States Referenced | Purpose |
| --- | --- | --- |
| Step 1 (Verify preconditions) | COMPLETE, IN_PROGRESS, BLOCKED, RETRYING | Exit conditions — if any of these, stop or adapt |
| Step 3a (Claim) | NOT_STARTED → IN_PROGRESS | Atomic transition (file: editAsset old_text match) |
| Step 3a (Retry entry) | RETRYING → IN_PROGRESS | Load prior_error, adapt strategy |
| Step 4 (Verify outputs) | IN_PROGRESS → VALIDATING | Explicit phase marker before checks run |
| Step 5 (Mark complete) | VALIDATING → COMPLETE | Terminal transition — last action |
| Step 4 (Retriable error) | IN_PROGRESS/VALIDATING → RETRYING | Supervisor sets; include attempt_count < max_retries guard |
| Step 4 (Permanent error) | IN_PROGRESS/VALIDATING → BLOCKED | Task sets with error_message |

### Retry Context Injection

When generating Step 1, include RETRYING handling:

```
- If the `status` field is `RETRYING`:
  1. Read the `prior_error` field from the status file.
  2. Read `attempt_count` — this is attempt #${attempt_count + 1}.
  3. Apply retry strategy escalation:
     - Attempt 2: Re-read all context docs, search docs for errors from attempt 1.
     - Attempt 3: Minimal execution — focus only on the failing step.
  4. Proceed to Step 3a (claim: transition RETRYING → IN_PROGRESS).
```

### Timeout Injection

Include timeout awareness in Step 3:

```
### Timeout awareness
- Session limit: 60 minutes total.
- Before each major operation, check elapsed time.
- If > 55 minutes elapsed: save partial artifacts, write progress notes to the status file, edit the `status` field to `BLOCKED`, and edit `error_message` to "Session timeout — progress saved at step N." Then stop.
```

## Self-Containment Verification

Before emitting a synthesized prompt, verify it passes ALL of these checks. If any check fails, fix the prompt — do not emit.

### Checklist

```
All file paths are absolute (/Workspace/Users/...)
All table names are fully qualified (catalog.schema.table)
All architecture context is referenced by path with read instructions
All conventions are stated explicitly (not assumed from prior sessions)
State read/write instructions use exact editAsset syntax with concrete old_text/new_text
Status file path is spelled out in full (never "your status file" or possessive language)
Upstream dependency status file paths are listed individually
Backend instructions include specific tool calls (editAsset, executeCode, runDatabricksCli)
Output artifacts include verification method with concrete expected values
Git operations include full repo path and branch name (not just "commit")
Retry handling includes prior_error loading and strategy escalation
No reference to "see protocol.md" or "follow the standard process"
Workstream description is stated (not just key/name)
Orchestration ID is embedded for state queries
No persona/identity language ("You are...", "Your role...", "As the worker...")
No protocol/operating-system framing ("state machine", "priority tree", "lifecycle")
The prompt reads as a numbered task list using Databricks workspace tools
```

### Common Violations

| Violation | Fix |
| --- | --- |
| Relative path (`./src/main.py`) | Prepend project_root: `${project_root}/src/main.py` |
| Unqualified table (`bronze_events`) | Prepend catalog.schema: `${target_catalog}.${target_schema}.bronze_events` |
| Implicit convention ("use standard patterns") | Spell out the pattern inline |
| External reference ("per architecture.md") | Embed the relevant excerpt directly |
| Vague validation ("verify it works") | Specify: `SELECT COUNT(*) FROM X` returns > 0 |
| Missing tool name ("update the file") | Specify: `editAsset(asset={type:"file", id:"${path}", ...})` |

## Prompt Assembly Algorithm

Follow these steps in order to synthesize a complete prompt from a plan.json workstream entry.

### Step 1: Select Template

```
INPUT: workstream.type
OUTPUT: template_id (ws-init-template, worker-prompt-template, or ws-final-template)

Apply template selection decision tree (see Template Selection above).
```

### Step 2: Resolve Identity Variables

```
INPUT: plan.json top-level fields + workstream entry
OUTPUT: resolved map of all identity variables

Resolve: project_name, orchestration_id, workstream_key, workstream_name,
         workstream_description, execution_backend.

Fail if any required identity variable is null or empty.
```

### Step 3: Resolve Path Variables

```
INPUT: plan.json paths + state config
OUTPUT: resolved map of all path variables

Resolve: project_root, orchestration_root, state_directory,
         status_file_path, upstream_status_paths.

Compute: status_file_path = state_directory + "/workstream-" + key + "-status.md"
Compute: upstream paths for each depends_on entry.
```

### Step 4: Resolve State Variables

```
INPUT: plan.state configuration
OUTPUT: state_mode + connection details

IF state.mode == "file":
  Set state_connection_info = state_directory path
IF state.mode == "lakebase":
  Resolve: lakebase_host, lakebase_project, lakebase_branch, lakebase_database
```

### Step 5: Resolve Backend Variables

```
INPUT: workstream.execution_backend + plan-level backend config
OUTPUT: backend-specific variables

IF backend == "databricks-bundle":
  Resolve: bundle_target, bundle_path
IF backend == "notebook-run":
  Resolve: notebook_path
IF backend == "sql-execution":
  Resolve: warehouse_id, target_catalog, target_schema
IF backend == "pipeline-editor":
  Resolve: pipeline_id (null if pipeline to be created), bundle_target, bundle_path
IF backend == "dashboard-editor":
  Resolve: dashboard_id (null if dashboard to be created), warehouse_id, bundle_target, bundle_path
IF backend == "genie-space-editor":
  Resolve: genie_space_id (null if space to be created), warehouse_id, table_identifiers (array), bundle_target
IF backend == "custom":
  No additional variables required.
```

### Step 6: Generate Content Blocks

```
INPUT: resolved variables + workstream spec
OUTPUT: 5 content blocks (gate, context, execute, validate, complete)

1. Generate gate_check_block using depends_on + state_mode.
2. Generate context_block using context_docs + upstream notes + file_scope.
3. Generate execute_block using backend + execution_notes + claim logic.
4. Generate validate_block using output_artifacts + gate_conditions.
5. Generate complete_block using state_mode + git config.
```

### Step 7: Inject State References

```
INPUT: content blocks
OUTPUT: content blocks with state enum values woven in

Verify: All state references use exact enum values from core/state-machine:
  NOT_STARTED, GATED, IN_PROGRESS, VALIDATING, COMPLETE, BLOCKED, RETRYING

Verify: Transition directions match the state transition table.
Verify: Retry logic references attempt_count and max_retries.
```

### Step 8: Assemble Prompt

```
INPUT: template + resolved variables + content blocks
OUTPUT: final synthesized prompt

Assemble in fixed section order:
  TASK HEADER (one-line task description + workspace paths)
  Step 1: Verify preconditions
  Step 2: Read reference files
  Step 3: Build (with 3a Claim)
  Step 4: Verify outputs
  Step 5: Mark complete
  CONSTRAINTS (appended after Step 5)
```

### Step 9: Self-Containment Check

```
INPUT: assembled prompt
OUTPUT: PASS or list of violations

Run Self-Containment Verification checklist.
If any violation: fix and re-run.
Only emit when all checks pass.
```

### Step 10: Emit

```
OUTPUT: The synthesized prompt string, ready for scheduleAgentTool(instructions=...)

The prompt is complete. It contains:
- Task description (what to build, one line)
- Workspace paths (project root, status file, state directory)
- Precondition checks (read status files, verify dependencies met)
- Reference file list (context docs to read at runtime)
- Concrete build steps (exact tools, file paths, commands)
- Output verification (specific checks with expected values)
- Completion edit (exact editAsset patch to mark done)
```

## Synthesized Prompt Examples

Concrete fragments showing how each backend type synthesizes differently.

### Example: databricks-bundle Backend

```markdown
Task: Create UC schema, volumes, grants, and deploy the foundation bundle for ws-0 (Customer Analytics Platform).

## Paths
- Project: /Workspace/Users/user@example.com/project
- State directory: /Workspace/Users/user@example.com/project/orchestration/state/
- Status file: /Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-0-status.md
- Orchestration ID: orch-2026-08-14-customer-analytics

## Step 1: Verify preconditions
Read the file at `/Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-0-status.md` using readAssetById (assetType "file").
- If the `status` field is `COMPLETE` → respond "Already done" and stop.
- If the `status` field is `IN_PROGRESS` → respond "Already running" and stop.
- If the `status` field is `BLOCKED` → respond "Blocked" and stop.

(No dependencies — proceed directly to Step 2.)

## Step 2: Read reference files
Read these files for reference (do not modify them):
- `/Workspace/Users/user@example.com/project/architecture.md` — System design reference

File scope (exclusive write paths — no other task writes here):
- `/Workspace/Users/user@example.com/project/databricks.yml`
- `/Workspace/Users/user@example.com/project/resources/`

Required output artifact:
- Volume: `catalog.schema.raw_data` — must exist after deploy

## Step 3: Build
Use editAsset to update the status file at `/Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-0-status.md`:
- Patch: old_text "status: NOT_STARTED" → new_text "status: IN_PROGRESS"

### Execution steps
1. Deploy the foundation bundle. Create schema, volumes, grants.

### Backend: Databricks Bundle
1. Read the bundle root at `/Workspace/Users/user@example.com/project`.
2. Write resource YAML for UC schema and volume.
3. Run `databricks bundle validate --target dev` — must exit clean.
4. Run `databricks bundle deploy --target dev`.

## Step 4: Verify outputs
- `databricks bundle validate --target dev` exits 0.
- `SELECT 1 FROM catalog.schema.raw_data LIMIT 1` confirms volume accessible.

## Step 5: Mark complete
Use editAsset to update the status file:
- Patch: old_text "status: IN_PROGRESS" → new_text "status: COMPLETE"
(This must be the last action.)
```

### Example: notebook-run Backend

```markdown
Task: Build bronze ingestion from S3 using Auto Loader for ws-a (Customer Analytics Platform).

## Paths
- Project: /Workspace/Users/user@example.com/project
- State directory: /Workspace/Users/user@example.com/project/orchestration/state/
- Status file: /Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-a-status.md
- Orchestration ID: orch-2026-08-14-customer-analytics

## Step 1: Verify preconditions
Read the file at `/Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-a-status.md` using readAssetById (assetType "file").
- If the `status` field is `COMPLETE` → respond "Already done" and stop.
- If the `status` field is `IN_PROGRESS` → respond "Already running" and stop.
- If the `status` field is `BLOCKED` → respond "Blocked" and stop.

Check dependency:
- Read the file at `/Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-0-status.md`
- If ws-0’s `status` field is not `COMPLETE` → report and stop.

## Step 2: Read reference files

From ws-0 (Foundation Infrastructure):
Read `/Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-0-status.md` — look for the "Notes for Downstream Sessions" section for artifact paths.

File scope (exclusive write paths):
- `/Workspace/Users/user@example.com/project/src/bronze/`

Required output artifact:
- Table: `catalog.schema.bronze_events`

## Step 3: Build
Use editAsset to update the status file at `/Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-a-status.md`:
- Patch: old_text "status: NOT_STARTED" → new_text "status: IN_PROGRESS"

### Execution steps
1. Build Auto Loader ingestion notebook. Source: S3 bucket. Target: bronze_events table.

### Backend: Notebook Run
1. Create a notebook at `/Workspace/Users/user@example.com/project/src/bronze/ingestion.ipynb`.
2. Cell 1: `%pip install --upgrade databricks-sdk` + `dbutils.library.restartPython()`
3. Cell 2+: Auto Loader ingestion logic reading from S3, writing to `catalog.schema.bronze_events`.
4. Execute all cells — verify no errors in output.

## Step 4: Verify outputs
- `SELECT COUNT(*) FROM catalog.schema.bronze_events` — assert > 0.

## Step 5: Mark complete
Use editAsset to update the status file:
- Patch: old_text "status: IN_PROGRESS" → new_text "status: COMPLETE"
(This must be the last action.)
```

### Example: sql-execution Backend

```markdown
Task: Create gold aggregate views and configure Genie space for ws-c (Customer Analytics Platform).

## Paths
- Project: /Workspace/Users/user@example.com/project
- State directory: /Workspace/Users/user@example.com/project/orchestration/state/
- Status file: /Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-c-status.md
- Orchestration ID: orch-2026-08-14-customer-analytics

## Step 1: Verify preconditions
Read the file at `/Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-c-status.md` using readAssetById (assetType "file").
- If the `status` field is `COMPLETE` → respond "Already done" and stop.
- If the `status` field is `IN_PROGRESS` → respond "Already running" and stop.
- If the `status` field is `BLOCKED` → respond "Blocked" and stop.

Check dependency:
- Read the file at `/Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-b-status.md`
- If ws-b’s `status` field is not `COMPLETE` → report and stop.

## Step 2: Read reference files

From ws-b (Transformation Layer):
Read `/Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-b-status.md` — look for "Notes for Downstream Sessions" for schema details.

File scope (exclusive write paths):
- `/Workspace/Users/user@example.com/project/src/gold/`

Required output artifacts:
- View: `catalog.schema.gold_customer_metrics`
- Genie Space: `Customer Analytics Space`

## Step 3: Build
Use editAsset to update the status file at `/Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-c-status.md`:
- Patch: old_text "status: NOT_STARTED" → new_text "status: IN_PROGRESS"

### Execution steps
1. Create gold views with SQL. Set up Genie space over gold tables.

### Backend: SQL Execution
1. Verify catalog `catalog` and schema `schema` exist.
2. Execute using executeCode (language "sql"):
   CREATE OR REPLACE VIEW catalog.schema.gold_customer_metrics AS
   SELECT customer_id, SUM(revenue) as total_revenue, COUNT(*) as order_count
   FROM catalog.schema.silver_customers
   GROUP BY customer_id;
3. Create Genie space using createAsset(asset={assetType:"genie", name:"Customer Analytics Space", tableIdentifiers:["catalog.schema.gold_customer_metrics"]}).

## Step 4: Verify outputs
- `DESCRIBE catalog.schema.gold_customer_metrics` returns columns.
- `SELECT COUNT(*) FROM catalog.schema.gold_customer_metrics` > 0.
- readAssetById(assetType="dataroom", id="${genie_space_id}") — exists.

## Step 5: Mark complete
Use editAsset to update the status file:
- Patch: old_text "status: IN_PROGRESS" → new_text "status: COMPLETE"
(This must be the last action.)
```

### Example: custom Backend (ws-final)

```markdown
Task: Validate all workstream outputs and generate the completion report for ws-final (Customer Analytics Platform).

## Paths
- Project: /Workspace/Users/user@example.com/project
- State directory: /Workspace/Users/user@example.com/project/orchestration/state/
- Status file: /Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-final-status.md
- Orchestration ID: orch-2026-08-14-customer-analytics

## Step 1: Verify preconditions
Read the file at `/Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-final-status.md` using readAssetById (assetType "file").
- If the `status` field is `COMPLETE` → respond "Already done" and stop.
- If the `status` field is `IN_PROGRESS` → respond "Already running" and stop.
- If the `status` field is `BLOCKED` → respond "Blocked" and stop.

Check all dependencies:
- Read the file at `/Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-0-status.md`
- Read the file at `/Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-a-status.md`
- Read the file at `/Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-b-status.md`
- Read the file at `/Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-c-status.md`
- If ANY has a `status` field that is not `COMPLETE` → report which and stop.

## Step 2: Read reference files
No architecture docs needed. Read all upstream status files listed above for their "Notes for Downstream Sessions" sections.

## Step 3: Build
Use editAsset to update the status file at `/Workspace/Users/user@example.com/project/orchestration/state/workstream-ws-final-status.md`:
- Patch: old_text "status: NOT_STARTED" → new_text "status: IN_PROGRESS"

### Execution steps
1. Read all workstream status files.
2. Verify all dependencies confirmed COMPLETE.
3. Generate a summary report at `/Workspace/Users/user@example.com/project/orchestration/state/plan-summary.md` using createAsset + editAsset.
4. Include: aggregate artifact lists from all status files, total execution metrics, any partial failures, next-steps if applicable.

## Step 4: Verify outputs
- readAssetById(assetType="file", id="/Workspace/Users/user@example.com/project/orchestration/state/plan-summary.md") — non-empty.
- All workstream statuses confirmed COMPLETE.

## Step 5: Mark complete
Use editAsset to update the status file:
- Patch: old_text "status: IN_PROGRESS" → new_text "status: COMPLETE"
(This must be the last action.)
```

---

*This module is consumed by the supervisor scheduled task when creating a new worker task. It reads a workstream entry from plan.json and produces the `instructions` parameter for `scheduleAgentTool`. Cross-references: `core/state-machine` for state names and transition rules; `core/dag-builder` for plan.json schema and workstream field definitions.*
