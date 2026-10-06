---
module: backends/notebook
version: 1.0.0
purpose: Notebook execution backend — setup, execute, validate
depends_on: [core/state-machine]
consumed_by: [capabilities/prompt-synthesis]
---

# Backend: Notebook Run

## When to Use

Select this backend when the workstream's primary deliverable is notebook code
that must be authored, executed, and verified. Indicators:

- Workstream produces ETL logic, data transformations, or feature engineering
- Workstream trains/registers ML models (MLflow logging)
- Workstream performs data exploration with validated outputs
- Workstream creates reusable library notebooks
- Output is cell execution results (DataFrames, model artifacts, files written)

Do NOT use when the notebook is a source file for bundle deployment (use
`bundle`) or when work is pure SQL without Python logic (use `sql`).

## Setup

1. **Identify target notebook.** Create new (`createAsset`) or modify existing
   (`readAssetById`).
2. **Read existing notebook** (if modifying) — cell structure, imports, widgets.
3. **Check compute** — Serverless (always available), classic cluster, SQL warehouse.
4. **Identify dependencies** — Upstream tables, packages, secrets, experiments.

## Execute

1. **Author cells** — Write code cells using `editAsset` on the notebook.
2. **Execute cells** — Run via `openAsset` with `continueMessage` to hand off
   execution to the notebook page agent.
3. **Iterate** — Fix errors, re-run until outputs are correct.
4. **Persist results** — Ensure output tables/files/models are written durably.

## Validate (Gate Conditions)

- `table_has_rows` — Output table exists and has expected row count
- `model_registered` — MLflow model appears in UC registry
- `file_non_empty` — Output file exists with content
- `notebook_no_errors` — All cells executed without exceptions
- `metric_in_range` — A computed metric falls within acceptable bounds

## MCP Tools

| Tool | Usage |
| --- | --- |
| `get_workstream_context` | Load upstream table paths, config values |
| `update_workstream_status` | Transition through lifecycle |
| `append_workstream_notes` | Record notebook ID, output paths for downstream |
| `get_skill_content` | Load conventions, error-handling guidance |
