---
workstream_key: ws-0
name: Infrastructure Bundle
status: COMPLETE
depends_on: []
scheduled_task_id: bdc99dd1d10c4fd1a604aa62a5142796
task_paused: false
attempt_count: 1
max_retries: 5
started_at: "2026-08-17T22:30:00Z"
completed_at: "2026-08-17T22:45:00Z"
error_message: null
prior_error: null
last_attempt_at: "2026-08-17T22:30:00Z"
---

# Workstream ws-0: Infrastructure Bundle

## Scope

Create the `hi-genie-infra/` Declarative Automation Bundle:
- Lakebase project (Autoscaling, PG17, 0.5-4 CU)
- UC schema resource
- Volumes (if needed for trace export)
- Secret scope for cross-bundle credentials
- SQL warehouse (2X-Small serverless PRO)
- Grants, target variables

## Notes for Downstream Sessions

## Resource Names and References

### Schema
- Resource key: `hi_genie_schema`
- Catalog ref: `${resources.schemas.hi_genie_schema.catalog_name}`
- Schema ref: `${resources.schemas.hi_genie_schema.name}`
- Schema ID: `${resources.schemas.hi_genie_schema.id}`
- Dev: `hls_fde_dev.hi_genie`
- hls_fde: `hls_fde.hi_genie`

### Lakebase Project
- Resource key: `hi_genie_lakebase`
- PG version: 17
- Autoscaling: 0.5–4 CU (all targets)
- Dev project_id: `dev-matthew-giglia-hi-genie`
- hls_fde project_id: `hi-genie`
- Branch: `production` (auto-created)
- Database: `databricks_postgres`
- Endpoint: `primary` (READ_WRITE)
- Schemas inside Lakebase: `dispatch` (Supervisor) + `state` (MCP)

### SQL Warehouse
- Resource key: `infra_warehouse`
- Ref: `${resources.sql_warehouses.infra_warehouse.id}`
- Size: 2X-Small serverless PRO, Photon, preview channel

### Secret Scope
- Resource key: `hi_genie_secret_scope`
- Scope name: `hi_genie_credentials`
- Dev keys: `client_id_dev_matthew_giglia_hi_genie`, `client_secret_dev_matthew_giglia_hi_genie`
- hls_fde keys: `client_id_hi_genie`, `client_secret_hi_genie`

### Volume
- Resource key: `traces_volume`
- Path: `/Volumes/{catalog}/{schema}/traces/`
- Purpose: MLflow trace exports, session artifacts

## Variable References for Downstream Bundles

The app bundle (`mcp-hi-genie-orchestrator`) should declare matching variables:
- `catalog`, `schema` — same per-target values
- `secret_scope_name` — `hi_genie_credentials`
- `client_id_dbs_key`, `client_secret_dbs_key` — schema-qualified per target
- `lakebase_project_id` — target-specific slug

## Decisions Made During Build

1. **Single volume** (`traces`) for MLflow trace exports and artifacts. Additional volumes can be added later if needed.
2. **0.5–4 CU for all targets** — requirements specify 0.5–4 CU; dev gets same ceiling since orchestration workloads need headroom for semantic memory.
3. **No UC setup job yet** — the SPN setup notebook will be created by ws-a (App Bundle Scaffold) which owns the runtime identity.
4. **Pattern follows scAuditor_infra and lakeloom-infra** exactly — proven DAB conventions.
