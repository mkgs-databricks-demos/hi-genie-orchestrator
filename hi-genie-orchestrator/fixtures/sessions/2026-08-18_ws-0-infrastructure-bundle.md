# Session: ws-0 Infrastructure Bundle Build

**Date:** 2026-08-18  
**Workstream:** ws-0 (Infrastructure Bundle)  
**Status:** COMPLETE  
**Branch:** `mg-genie-hi-genie-r1-build`  

## Problem

The Hi Genie Orchestrator project needed its foundational infrastructure
Declarative Automation Bundle (`hi-genie-infra/`) created from scratch. This is
the first workstream in the 9-workstream DAG and blocks all downstream work
(ws-a through ws-final).

## Root Cause / Context

Greenfield build — no prior infrastructure existed. The architecture baseline
(Decisions 1–46) specified Lakebase, UC schemas, secret scopes, SQL warehouses,
and volumes but had no implementation artifacts.

## Changes Made

### Files Created

| File | Purpose |
| --- | --- |
| `hi-genie-infra/databricks.yml` | Bundle manifest, variables, 3 targets (dev, hls_fde, prod) |
| `hi-genie-infra/resources/hi_genie.schema.yml` | UC schema with per-target grants |
| `hi-genie-infra/resources/hi_genie.lakebase.yml` | Lakebase PG17, 0.5–4 CU autoscaling |
| `hi-genie-infra/resources/hi_genie.secret_scope.yml` | Credential scope (DATABRICKS backend) |
| `hi-genie-infra/resources/infra_warehouse.sql_warehouse.yml` | 2X-Small serverless PRO warehouse |
| `hi-genie-infra/resources/traces.volume.yml` | Managed volume for MLflow trace exports |

### Files Modified

| File | Change |
| --- | --- |
| `orchestration/state/workstream-ws-0-status.md` | `NOT_STARTED` → `IN_PROGRESS` → `COMPLETE` |

## Decisions Made

1. **Single volume** (`traces`) for MLflow trace exports and session artifacts.
   Additional volumes can be added later by downstream workstreams.

2. **0.5–4 CU for all targets** — requirements specify this range; dev gets the
   same ceiling since semantic memory workloads need compute headroom.

3. **No UC setup job yet** — the SPN setup notebook will be created by ws-a
   (App Bundle Scaffold) which owns the runtime identity. Following the
   scAuditor pattern where the setup job lives in infra but the notebook logic
   depends on the app's identity requirements.

4. **Pattern follows scAuditor_infra and lakeloom-infra exactly** — proven DAB
   conventions including: `${resources.schemas.<name>.*}` references,
   schema-qualified secret keys, `prevent_destroy: true` on stateful resources,
   target-specific Lakebase project IDs.

5. **Schema name `hi_genie`** (not `hi_genie_orchestrator`) — shorter, matches
   the variable convention in peer bundles. The full qualified name in dev:
   `hls_fde_dev.hi_genie`.

6. **Lakebase project IDs** — dev: `dev-matthew-giglia-hi-genie`, hls_fde:
   `hi-genie`. Follows the `{dev-user-slug}` / `{product-slug}` convention.

## Key Resource References (for downstream)

```yaml
# Schema
${resources.schemas.hi_genie_schema.catalog_name}   # catalog
${resources.schemas.hi_genie_schema.name}            # schema
${resources.schemas.hi_genie_schema.id}              # schema ID

# SQL Warehouse
${resources.sql_warehouses.infra_warehouse.id}

# Secret scope
hi_genie_credentials  # scope name
client_id_dev_matthew_giglia_hi_genie   # dev client ID key
client_secret_dev_matthew_giglia_hi_genie  # dev client secret key

# Lakebase
dev-matthew-giglia-hi-genie   # dev project_id
hi-genie                       # hls_fde project_id
```

## Observations

- Orchestration state machine worked correctly: claim → build → verify → complete.
- Git commit landed cleanly on `mg-genie-hi-genie-r1-build` (8 files).
- No validation run performed (DAB validate requires CLI execution context);
  structural correctness verified via read-back of all files.
- ws-a (App Bundle Scaffold) is now unblocked.
