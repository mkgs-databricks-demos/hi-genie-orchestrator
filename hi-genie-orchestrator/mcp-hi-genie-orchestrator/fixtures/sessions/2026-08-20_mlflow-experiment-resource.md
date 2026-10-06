# Session: MLflow 3 Experiment Resource — Platform-Native Trace Init

**Date:** 2026-08-20  
**Branch:** `mg-genie-r1-completion`  
**Phase:** 1+2 (Memory & MLflow fixes)  
**Deployment:** `01f19c547d541c49adfc6418df8b114c` (SUCCEEDED)

---

## Problem Statement

After the R1 readiness work, the MLflow tracer was degraded — `initMlflowTracer()` called `resolveExperiment()` which attempted to create/get an experiment via REST API using SPN `client_credentials`. This failed with:
1. **401 Unauthorized** — SPN didn't have CAN_EDIT on any experiment
2. **404 Not Found** — experiment didn't exist and SPN couldn't create one

The memory module was also degraded (KI-8: `EMBEDDING_ENDPOINT_NAME` env var missing from `app.yaml`).

---

## Root Cause

The correct Databricks Apps pattern for MLflow experiment access is platform-native:
- Declare an `experiment` resource in the app's resource manifest
- Platform auto-grants the app SPN `CAN_EDIT`
- Platform injects the experiment ID via `MLFLOW_EXPERIMENT_ID` env var (`valueFrom: experiment`)

The old approach (REST API `resolveExperiment()`) was a workaround that couldn't work because the SPN had no experiment permissions.

---

## Solution

### Infra Bundle (`hi-genie-infra/`)

1. **New:** `resources/hi_genie_traces.experiment.yml`
   - Creates MLflow experiment at `/Workspace/.experiments/{catalog}/{schema}/hi_genie_orchestrator_traces`
   - Tags: `project: hi-genie-orchestrator`, `mlflow.note.content` description

2. **New:** `src/ensure_experiment_directories.py`
   - Notebook that pre-creates `/Workspace/.experiments/{catalog}/{schema}` directory hierarchy
   - Required because DABs experiment resource fails if parent dirs don't exist
   - Idempotent; uses `w.workspace.mkdirs()`

3. **Updated:** `resources/uc_setup.job.yml`
   - New first task: `ensure_experiment_directories` -> `install_lakebase_extensions` -> `configure_app_secrets`

4. **Updated:** `databricks.yml`
   - Added `- resources/*.experiment.yml` to `include:` list

### App Bundle (`mcp-hi-genie-orchestrator/`)

5. **Updated:** `databricks.yml`
   - New variable: `mlflow_experiment_id` (description, dev default: `4038008988926083`)

6. **Updated:** `resources/hi_genie_app.app.yml`
   - New experiment resource: `experiment_id: '${var.mlflow_experiment_id}'`, `permission: CAN_EDIT`

7. **Updated:** `app.yaml`
   - New env: `MLFLOW_EXPERIMENT_ID` with `valueFrom: experiment`

8. **Updated:** `app_deploy.sh`
   - Resolves `mlflow_experiment_id` from infra bundle summary (`resources.experiments.hi_genie_traces.id`)

9. **Refactored:** `server/telemetry/mlflow-tracer.ts`
   - Removed `resolveExperiment()` function (dead code)
   - `initMlflowTracer()` now reads `MLFLOW_EXPERIMENT_ID` from env
   - Graceful fallback: if env var missing, traces use OTel only (no crash)
   - Kept: `exportTraceToMlflow()`, `mlflowApiCall()`, SPN token cache, `getAuthHeadersAsync()`

---

## Validation

### Post-Deploy Test Suite (all PASS)

| Test | Result | Evidence |
| --- | --- | --- |
| app_deployment | PASS | Deployment `01f19c547d541c49adfc6418df8b114c` (SUCCEEDED) |
| memory_embedding | PASS | Endpoint `databricks-gte-large-en` running |
| mlflow_tracer | PASS | `experiment_id=4038008988926083, retention=90d` |
| mcp_tools | PASS | 22 tools registered |
| dispatch_tick | PASS | Tick evaluator active (30s interval) |
| migrations | PASS | All migrations applied |

### OTel Traces Flowing

Spans confirmed in `hi_genie_otel_traces` table:
- `tool:dispatch_tick` (SPAN_KIND_INTERNAL, STATUS_CODE_OK)
- `db:fetch_workstream_states` (SPAN_KIND_CLIENT, STATUS_CODE_OK)
- `db:SELECT semantic_memory pending` (SPAN_KIND_CLIENT, STATUS_CODE_OK)
- `lakebase.query` (SPAN_KIND_CLIENT, STATUS_CODE_OK)
- `pg-pool.connect` (SPAN_KIND_CLIENT)

---

## Key IDs

| Resource | Value |
| --- | --- |
| MLflow Experiment ID | `4038008988926083` |
| Experiment Path (dev) | `/.experiments/hls_fde_dev/dev_matthew_giglia_hi_genie/[dev matthew_giglia] hi_genie_orchestrator_traces` |
| UC Setup Job Run | `860016824963172` / `1103660860869932` (all 3 tasks SUCCESS) |
| Infra Deploy | `bundle deploy --target dev --auto-approve` (SUCCEEDED) |

---

## Files Modified (11 total)

### Infra Bundle
- `databricks.yml` — added `*.experiment.yml` include
- `resources/hi_genie_traces.experiment.yml` — NEW
- `resources/uc_setup.job.yml` — added `ensure_experiment_directories` task
- `src/ensure_experiment_directories.py` — NEW

### App Bundle
- `databricks.yml` — added `mlflow_experiment_id` variable
- `resources/hi_genie_app.app.yml` — added experiment resource
- `app.yaml` — added `MLFLOW_EXPERIMENT_ID` env
- `app_deploy.sh` — added experiment ID resolution
- `server/telemetry/mlflow-tracer.ts` — removed `resolveExperiment()`, platform-native init
- `PROJECT_MEMORY.md` — updated module status, KI-8/KI-9 resolved

---

## Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | Platform-native experiment resource over REST API `resolveExperiment()` | Auto-grants SPN permissions, no token management needed, idiomatic for Apps |
| 2 | Pre-create experiment directories in UC Setup Job | DABs experiment resource fails if parent workspace dirs don't exist; must run before first deploy |
| 3 | Hardcode dev experiment ID in `databricks.yml` defaults | Avoids needing infra bundle summary for simple dev deploys; `app_deploy.sh` overrides dynamically for other targets |
| 4 | Keep `exportTraceToMlflow()` + SPN token auth | Still needed for actual trace export POSTs to `/api/2.0/mlflow/traces`; only the experiment resolution was replaced |

---

## Known Issues Resolved

- **KI-8** (`EMBEDDING_ENDPOINT_NAME` not in app.yaml) — RESOLVED: env var added with `valueFrom: embedding-endpoint`
- **KI-9** (`memory/index.ts` workspaceHost protocol) — RESOLVED: protocol guard added
- **MLflow 401** — RESOLVED: platform-native experiment resource eliminates SPN auth for experiment resolution
