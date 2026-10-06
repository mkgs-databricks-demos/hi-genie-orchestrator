---
module: backends/bundle
version: 1.0.0
purpose: Declarative Automation Bundle execution backend — setup, execute, validate, teardown
depends_on: [core/state-machine]
consumed_by: [core/prompt-synthesis]
---

# Backend: Databricks Bundle

## When to Use

Select this backend when the workstream produces infrastructure-as-code via Declarative Automation Bundles (`databricks.yml`). Indicators:

- Workstream creates or modifies `resources/*.yml` files (schemas, volumes, jobs, pipelines, serving endpoints)
- Workstream writes notebook source in `src/` that is deployed as bundle resources
- Workstream produces a `deploy.sh` for multi-bundle orchestration
- Workstream target output includes bundle variable interpolation (`${var.*}`, `${resources.*}`)
- The project follows the tiered bundle pattern (infra → ai → app)

Do NOT use this backend for one-off SQL execution, notebook cell runs without deployment, or free-form resource creation (use sql or custom backends instead). Also do NOT use this backend for the *authoring* of a Spark Declarative Pipeline, AI/BI Dashboard, or Genie Space — those have their own dedicated editor-handoff backends (`backends/pipeline.md`, `backends/dashboard.md`, `backends/genie-space.md`) that hand authoring off to the specialized editor page before capturing the result here. This backend still applies once those resources need to be declared/redeployed as part of a broader bundle change.

## Setup Operation

**State transition triggered:** None — setup is pre-claim context gathering.

### Steps

1. **Identify bundle root.** Read the project's `databricks.yml` to confirm:
   - Bundle name and description
   - Available targets (dev, staging, prod)
   - Variable definitions (`variables:` block)
   - Resource file includes (`include:` patterns)

2. **Read existing resources.** Scan `resources/` directory for existing `.yml` files:
   - Identify naming conventions in use
   - Note cross-resource references (`${resources.schemas.<name>.*}`)
   - Check for `prevent_destroy: true` markers on critical resources

3. **Read existing source.** Scan `src/` directory:
   - Identify notebook paths and their extensions (`.ipynb`, `.sql`, `.py`)
   - Note existing patterns (SDK install cells, widget patterns, import structures)

4. **Determine target.** Identify which bundle target this workstream deploys to:
   - Read from workstream spec or infer from environment context
   - Note target-specific variable overrides

5. **Check conventions.** Enforce:
   - All resources defined via `resources/*.yml` (never hardcoded in `databricks.yml`)
   - Schema references use `${resources.schemas.<name>.*}` (never raw `${var.schema}`)
   - Notebook paths default to `.ipynb` unless task has `warehouse_id`
   - First code cell pattern: `%pip install --upgrade databricks-sdk` + `dbutils.library.restartPython()`

## Execute Operation

**State: IN_PROGRESS throughout.**

### Steps

1. **Write resource YAML files.** Create or update files in `resources/`:

   ```yaml
   # resources/schemas.yml — example
   resources:
     schemas:
       my_schema:
         catalog_name: ${var.catalog}
         name: ${var.schema}
         grants:
           - principal: ${var.service_principal}
             privileges:
               - ALL_PRIVILEGES
   ```

   Use `editAsset` with `asset.type: "file"` and full workspace path as `id`.

2. **Write source notebooks.** Create or update files in `src/`:
   - Use `createAsset` for new notebooks (type: "notebook")
   - Use `editAsset` for modifications to existing notebooks
   - Follow extension conventions: `.ipynb` for multi-lang, `.sql` for SQL warehouse tasks

3. **Write or update `databricks.yml`.** If new resources or targets needed:
   - Add `include:` entries for new resource files
   - Add variables for new parameterizable values
   - Never inline resource definitions — always use separate files

4. **Validate the bundle.** Run:

   ```
   databricks bundle validate --target ${bundle_target}
   ```

   Via `runDatabricksCli` tool. Parse output for:
   - `Error` lines → fix and re-validate (up to 2 retries)
   - `Warning` lines → note but proceed
   - Clean output → proceed to deploy

5. **Deploy the bundle.** Run:

   ```
   databricks bundle deploy --target ${bundle_target}
   ```

   Via `runDatabricksCli` tool. Monitor for:
   - Successful deployment confirmation
   - Resource creation/update summaries
   - Permission or conflict errors (may require teardown first)

6. **For multi-bundle projects — generate/update `deploy.sh`.** If project has multiple bundles:

   ```bash
   #!/bin/bash
   set -euo pipefail

   safe_url() { echo "$1"; }  # preserves ://
   safe() { printf '%q' "$1"; }

   # Deploy infra first
   databricks bundle deploy --target "$(safe "$TARGET")" \
     -p "$(safe_url "$WORKSPACE_HOST")"

   # Extract outputs for downstream
   INFRA_SUMMARY=$(databricks bundle summary --target "$(safe "$TARGET")" --output json)
   SCHEMA_ID=$(echo "$INFRA_SUMMARY" | jq -r '.resources.schemas["my_schema"].id')

   # Deploy AI bundle with upstream outputs
   cd ../my-project-ai
   databricks bundle deploy --target "$(safe "$TARGET")" \
     --var "schema_id=$SCHEMA_ID"
   ```

### Tool Usage Patterns

| Action | Tool | Key Parameters |
| --- | --- | --- |
| Read bundle config | `readAssetById` (file) | Full workspace path |
| Write resource YAML | `editAsset` (file) | Workspace path, patches |
| Write notebooks | `createAsset` / `editAsset` (notebook) | Name, cell content |
| Validate bundle | `runDatabricksCli` | `bundle validate --target X` |
| Deploy bundle | `runDatabricksCli` | `bundle deploy --target X` |
| Get deploy outputs | `runDatabricksCli` | `bundle summary --target X --output json` |

## Validate Operation

**State transition: IN_PROGRESS → VALIDATING** (set via editAsset on status file).

### Checks

1. **Bundle validates clean:**
   ```
   databricks bundle validate --target ${bundle_target}
   ```
   Must exit 0 with no `Error` lines.

2. **Resources exist post-deploy:**
   ```
   databricks bundle summary --target ${bundle_target} --output json
   ```
   Parse JSON to confirm all declared resources have IDs and expected states:
   - Pipelines: status is `IDLE` or `RUNNING`
   - Jobs: exist with correct task configurations
   - Schemas: `ACTIVE`

3. **Output tables accessible (if applicable):**
   ```sql
   SELECT COUNT(*) FROM catalog.schema.target_table
   ```
   Execute via `executeCode` (language: sql). Must return without error.

4. **File artifacts exist:**
   For each declared output artifact, verify the file exists and has content:
   ```
   readAssetById(assetType: "file", assetId: <path>)
   ```

### Validation Decision

- ALL checks pass → transition to COMPLETE
- Any check fails with retriable cause → note failure, let supervisor decide RETRYING
- Any check fails with permanent cause → transition to BLOCKED

## Teardown Operation

**State: Only on failure path (before RETRYING or BLOCKED).**

Bundle deployments are idempotent — teardown is generally unnecessary. However:

1. **On resource conflict:** If deploy fails because a resource exists from a prior failed attempt:
   ```
   databricks bundle destroy --target ${bundle_target} --auto-approve
   ```
   Use sparingly — only when deploy conflict is confirmed.

2. **On partial deploy failure:** Do not destroy. The next `bundle deploy` will reconcile.

3. **General rule:** Prefer re-deploy over destroy+deploy. Bundles handle drift.

## State Transitions This Backend Triggers

| Phase | Transition | editAsset Pattern |
| --- | --- | --- |
| Claim | NOT_STARTED → IN_PROGRESS | `old: "status: NOT_STARTED"` → `new: "status: IN_PROGRESS"` |
| Post-execute | IN_PROGRESS → VALIDATING | `old: "status: IN_PROGRESS"` → `new: "status: VALIDATING"` |
| Validation pass | VALIDATING → COMPLETE | `old: "status: VALIDATING"` → `new: "status: COMPLETE"` |
| Unrecoverable error | IN_PROGRESS → BLOCKED | `old: "status: IN_PROGRESS"` → `new: "status: BLOCKED"` |

Never set: NOT_STARTED, GATED, RETRYING (per core/state-machine Backend Contract).

## Error Handling

| Error Category | Example | Response | Retriable? |
| --- | --- | --- | --- |
| Validation syntax error | `Error: unknown field "x" in resources` | Fix YAML, re-validate | Yes (self-correct) |
| Deploy permission denied | `PERMISSION_DENIED: cannot create schema` | Set BLOCKED with grant instructions | No |
| Deploy conflict | `Resource already exists with different owner` | Attempt `bundle destroy` then redeploy | Yes (1 attempt) |
| Network/API timeout | `context deadline exceeded` | Retry deploy (up to 2 times) | Yes |
| Variable not found | `variable "x" not defined` | Add variable to databricks.yml, re-validate | Yes (self-correct) |
| Target not found | `target "prod" not defined` | Set BLOCKED — configuration issue | No |
| Source file missing | `notebook not found at src/x.ipynb` | Create the notebook, re-validate | Yes (self-correct) |

### Self-Correction Protocol

For retriable errors during execution:
1. Parse the error message for the specific issue
2. Apply the fix (edit YAML, add variable, create file)
3. Re-run `bundle validate` to confirm fix
4. Continue execution
5. If same error persists after 2 fix attempts → search documentation → if still failing, set BLOCKED

## Prompt Injection Template

The following text is injected into the worker prompt's EXECUTE section when this backend is selected:

```
### Execution Backend: databricks-bundle

You are deploying a Declarative Automation Bundle. Follow these steps:

1. Read the existing `databricks.yml` and `resources/` directory to understand current state.
2. Write your resource definitions to `resources/*.yml` files using editAsset.
3. Write any source notebooks to `src/` using createAsset (new) or editAsset (modify).
4. Run `databricks bundle validate --target {bundle_target}` via runDatabricksCli.
   - If errors: fix and re-validate (max 2 attempts).
   - If clean: proceed.
5. Run `databricks bundle deploy --target {bundle_target}` via runDatabricksCli.
   - On success: proceed to validation.
   - On conflict: attempt destroy + redeploy once.
   - On permission error: set BLOCKED immediately.
6. After deploy, run `databricks bundle summary --target {bundle_target} --output json` to confirm resources.

Conventions:
- Resources always in `resources/*.yml` (never inline in databricks.yml)
- Schema refs: `${resources.schemas.<name>.*}` (never raw `${var.schema}` in resource defs)
- Notebook extensions: `.ipynb` default; `.sql` only with `warehouse_id`
- First notebook cell: `%pip install --upgrade databricks-sdk` + `dbutils.library.restartPython()`
- deploy.sh: `safe_url()` for host, `safe()` for all other interpolations

On error: self-correct up to 2 times per error type. If stuck, search docs. If still failing, set BLOCKED.
```
