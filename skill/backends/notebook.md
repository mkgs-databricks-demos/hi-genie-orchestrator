---
module: backends/notebook
version: 1.0.0
purpose: Notebook execution backend — setup, execute, validate, teardown
depends_on: [core/state-machine]
consumed_by: [core/prompt-synthesis]
---

# Backend: Notebook Run

## When to Use

Select this backend when the workstream's primary deliverable is notebook code that must be authored, executed, and verified. Indicators:

- Workstream produces ETL logic, data transformations, or feature engineering
- Workstream trains/registers ML models (MLflow logging)
- Workstream performs data exploration with validated outputs
- Workstream creates reusable library notebooks for downstream consumption
- The output is cell execution results (DataFrames, model artifacts, files written)

Do NOT use this backend when the notebook is merely a source file for a bundle deployment (use bundle backend) or when work is pure SQL without Python logic (use sql backend).

## Setup Operation

**State transition triggered:** None — setup is pre-claim context gathering.

### Steps

1. **Identify target notebook.** Determine whether to:
   - Create a new notebook (`createAsset` with type: "notebook")
   - Modify an existing notebook (read via `readAssetById`)
   - Execute an existing notebook as-is (read to verify structure)

2. **Read existing notebook (if modifying).** Use `readAssetById` to inspect:
   - Current cell structure (nuids for targeting edits)
   - Existing imports and variable definitions
   - Widget parameters (for parameterized notebooks)
   - Compute requirements (serverless vs. cluster)

3. **Check compute availability.**
   - Serverless: Always available for Python, SQL, sh
   - Classic cluster: Verify cluster ID and state if required
   - SQL warehouse: Verify warehouse ID if SQL-only notebook

4. **Identify dependencies.**
   - Upstream tables that must exist (verify with quick `SELECT 1 FROM table LIMIT 1`)
   - Required packages (identify `%pip install` needs)
   - Secrets or environment variables needed
   - MLflow experiment paths (if model training)

5. **Plan cell structure.** Design the notebook layout:
   - Cell 1: SDK/package installation + restart
   - Cell 2: Imports and configuration
   - Cell 3+: Logic cells
   - Final cell: Output verification / artifact logging

## Execute Operation

**State: IN_PROGRESS throughout.**

### Creating a New Notebook

1. **Create the notebook:**
   ```
   createAsset(asset: {assetType: "notebook", name: "descriptive-name"})
   ```
   Returns the notebook ID and path.

2. **Add cells via editAsset (add operation):**

   ```
   editAsset(
     asset: {type: "notebook", id: "<notebook_id>", name: "<name>"},
     operation: "add",
     content: [
       {
         target: "BEGIN",
         title: "Install latest Databricks SDK",
         language: "python",
         patches: [{old_text: "", new_text: "%pip install --upgrade databricks-sdk\ndbutils.library.restartPython()", replace_all: false}]
       },
       {
         title: "Imports and Configuration",
         language: "python",
         patches: [{old_text: "", new_text: "import mlflow\nfrom databricks.sdk import WorkspaceClient\n\nw = WorkspaceClient()", replace_all: false}]
       }
     ]
   )
   ```

   Key rules:
   - First item needs `target` ("BEGIN" or cell nuid); subsequent items chain automatically
   - Always include a descriptive `title` for each cell
   - Set `language` explicitly ("python", "sql", "md")

3. **Add logic cells** following the planned structure from Setup.

### Modifying an Existing Notebook

1. **Read the notebook** to get cell nuids:
   ```
   readAssetById(assetType: "notebook", assetId: "<id>")
   ```

2. **Update specific cells:**
   ```
   editAsset(
     asset: {type: "notebook", id: "<id>", name: "<name>"},
     operation: "update",
     content: [
       {
         target: "<cell_nuid>",
         title: "Updated Title",
         patches: [{old_text: "old code", new_text: "new code", replace_all: false}]
       }
     ]
   )
   ```

3. **Insert new cells after a specific position:**
   ```
   editAsset(
     asset: {...},
     operation: "add",
     content: [{target: "<cell_nuid_to_insert_after>", ...}]
   )
   ```

### Executing Notebook Code

1. **Interactive execution (cell by cell):**
   ```
   executeCode(code: "<cell_content>", language: "python", summary: "Run ETL step 3")
   ```
   Use for iterative development and debugging.

2. **Full notebook run (via Jobs API):**
   For production-grade execution that must run all cells in order:
   ```python
   from databricks.sdk import WorkspaceClient
   w = WorkspaceClient()
   run = w.jobs.submit(
       run_name="workstream-execution",
       tasks=[{
           "task_key": "run_notebook",
           "notebook_task": {
               "notebook_path": "/path/to/notebook",
               "base_parameters": {"param1": "value1"}
           },
           "new_cluster": {...} or "existing_cluster_id": "..."
       }]
   ).result()
   ```
   Execute this via `executeCode` (language: python).

### ML Model Training Pattern

When the workstream trains a model:

```python
# Cell: Train and log model
import mlflow
from mlflow.models import infer_signature

mlflow.set_experiment("/path/to/experiment")

with mlflow.start_run(run_name="workstream-training") as run:
    # Training logic
    model = train_model(X_train, y_train)
    
    # Log metrics
    mlflow.log_metrics({"rmse": rmse, "r2": r2})
    
    # Log model with signature
    signature = infer_signature(X_train, model.predict(X_train))
    mlflow.sklearn.log_model(model, "model", signature=signature)
    
    # Register model
    mlflow.register_model(
        f"runs:/{run.info.run_id}/model",
        "catalog.schema.model_name"
    )
```

### Tool Usage Patterns

| Action | Tool | Key Parameters |
| --- | --- | --- |
| Create notebook | `createAsset` | `{assetType: "notebook", name: ...}` |
| Read notebook | `readAssetById` | `assetType: "notebook"`, `assetId: "<id>"` |
| Add cells | `editAsset` (add) | target, title, language, patches |
| Update cells | `editAsset` (update) | target (nuid), patches |
| Delete cells | `editAsset` (delete) | target (nuid) |
| Execute code | `executeCode` | code, language, summary |
| Run full notebook | `executeCode` (python) | Jobs API submit |

## Validate Operation

**State transition: IN_PROGRESS → VALIDATING** (set via editAsset on status file).

### Checks

1. **No cell execution errors:**
   After executing cells, verify no exceptions were raised. Check `executeCode` results for error indicators.

2. **Output tables populated (if ETL):**
   ```sql
   SELECT COUNT(*) as row_count FROM catalog.schema.output_table
   ```
   Must return row_count > 0 (or meets expected threshold).

3. **Model registered (if ML):**
   ```python
   from mlflow import MlflowClient
   client = MlflowClient()
   versions = client.search_model_versions(f"name='catalog.schema.model_name'")
   assert len(versions) > 0, "No model version registered"
   ```

4. **Files written (if file output):**
   Verify output files exist via `readAssetById` or:
   ```python
   dbutils.fs.ls("/path/to/output/")
   ```

5. **Notebook exists with expected cells:**
   ```
   readAssetById(assetType: "notebook", assetId: "<id>")
   ```
   Verify cell count and titles match expectations.

### Validation Decision

- ALL checks pass → transition to COMPLETE
- Cell execution error (fixable) → note error, may RETRY
- Missing compute or permissions → BLOCKED

## Teardown Operation

**State: Only on failure path.**

Notebook execution generally requires no teardown. However:

1. **Failed model training:** If a partial run logged artifacts, the next attempt will create a new run. No cleanup needed.

2. **Partial table writes:** If ETL wrote partial data, either:
   - Use `CREATE OR REPLACE` pattern in the notebook (self-cleaning)
   - Or truncate/drop target table before retry

3. **Orphaned resources:** If notebook created external resources (volumes, secrets), note them in status file for manual review.

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
| Import error | `ModuleNotFoundError: No module named 'x'` | Add `%pip install x`, re-execute | Yes (self-correct) |
| Compute unavailable | `No cluster available` | Set BLOCKED — infrastructure issue | No |
| Cell execution error | `AnalysisException: Table not found` | Check table exists, fix reference | Yes (self-correct) |
| Timeout | `executeCode` exceeds timeout | Increase timeout or chunk work | Yes (1 retry) |
| Permission denied | `PERMISSION_DENIED on catalog.schema` | Set BLOCKED with access instructions | No |
| Out of memory | `java.lang.OutOfMemoryError` | Reduce data scope or increase compute | Conditional |
| MLflow logging error | `RESOURCE_DOES_NOT_EXIST: Experiment` | Create experiment, re-run | Yes (self-correct) |

### Self-Correction Protocol

1. Parse error from cell output
2. Identify fix category (missing import, missing table, wrong path)
3. Apply fix (edit cell, add prerequisite cell, adjust parameters)
4. Re-execute the failing cell
5. If same error after 2 attempts → search documentation for current correct approach
6. If still failing → set BLOCKED with full error context

## Prompt Injection Template

The following text is injected into the worker prompt's EXECUTE section when this backend is selected:

```
### Execution Backend: notebook-run

You are creating and/or executing a Databricks notebook. Follow these steps:

1. Create the notebook via createAsset (if new) or read it via readAssetById (if existing).
2. Add/edit cells using editAsset:
   - First cell: `%pip install --upgrade databricks-sdk` + `dbutils.library.restartPython()`
   - Include descriptive titles for every cell.
   - Use language: "python" | "sql" | "md" explicitly.
3. Execute cells via executeCode to verify correctness.
   - Run cells incrementally (not all at once) to catch errors early.
   - Read and analyze execution results — check for errors, empty results, unexpected values.
4. For ML workloads: log with MLflow, register models to Unity Catalog.
5. After all cells execute successfully, verify outputs:
   - Tables: `SELECT COUNT(*) FROM target_table` must return > 0
   - Models: verify registration via MlflowClient
   - Files: verify existence via readAssetById or dbutils.fs.ls

Conventions:
- First cell always: SDK install + restartPython() (function, NOT magic)
- Notebook extensions: `.ipynb` for Python, `.sql` for SQL warehouse
- Fully qualify all table references: catalog.schema.table
- Use CREATE OR REPLACE for idempotent table writes

On error: self-correct up to 2 times per error type. If stuck, search docs. If still failing, set BLOCKED.
```
