# 2026-08-19 — Runtime Fixes & Infra Integration

**Branch:** `mg-genie-server-modules-r1`  
**Deployment:** `01f19bce69b01e74b590ca2883d5da0a` (SUCCEEDED)  
**Follows:** `2026-08-19_full-module-reactivation.md`

## Summary

Resolved all runtime errors from module reactivation. Restructured dispatch to work within Lakebase PgBouncer constraints (tick-only mode by default). Created migration 004 for missing columns. Infra bundle gains `configure_app_secrets` UC Setup Job task to fix SPN scope access and inject embedding endpoint name.

## Problems Fixed

### 1. Dispatch Tick-Evaluator (SQL Schema Drift)

| Error | Root Cause | Fix |
| --- | --- | --- |
| `column o.id does not exist` | PK is `orchestration_id` (migration 001) | `o.id` -> `o.orchestration_id` |
| `column w.last_heartbeat_at does not exist` | Column not in original DDL | `w.updated_at::text AS last_heartbeat_at` |
| `column w.paused does not exist` | Column not in original DDL | `FALSE AS paused` |
| `'{}' AS depends_on` invalid for jsonb | Expected array not object | `'[]'::jsonb AS depends_on` |

### 2. MLflow Tracer (Invalid URL)

`DATABRICKS_HOST` env var is just `fevm-hls-fde.cloud.databricks.com` (no protocol). `new URL(path, host)` fails. Fix: prepend `https://` when host lacks protocol prefix.

### 3. Dispatch LISTEN/NOTIFY (PgBouncer Incompatibility)

**Research findings:**
- PL/pgSQL IS supported (in Lakebase extensions list)
- Triggers ARE supported (`tcn` extension available)
- LISTEN/NOTIFY NOT supported through PgBouncer transaction mode (Lakebase default)
- Dollar-quoting BUG: single `$` instead of `$$` in trigger function body

**Restructuring:**
- `listener.ts`: Fixed dollar-quoting (`$` -> `$$`), added `installDDL()` method (DDL-only, no LISTEN)
- `dispatch/index.ts`: Default `DISPATCH_LISTEN_ENABLED` = `'false'`; always install DDL trigger; only attempt LISTEN if explicitly enabled
- Fallback: tick + outbox polling (60s interval) — works reliably through PgBouncer

### 4. Missing Workstream Columns (Migration 004)

Created `server/migrations/004_workstream_columns.ts`:
- `ALTER TABLE dispatch.workstreams ADD COLUMN last_heartbeat_at TIMESTAMPTZ`
- `ALTER TABLE dispatch.workstreams ADD COLUMN paused BOOLEAN NOT NULL DEFAULT FALSE`
- `ALTER TABLE dispatch.workstreams ADD COLUMN error_message TEXT`

**Status:** File created, NOT yet registered in `server/migrations/index.ts`.

### 5. Infra: App SPN Scope Access (UC Setup Job)

Added to `hi-genie-infra` bundle:
- New task `configure_app_secrets` in UC Setup Job
- Looks up App's managed SPN via `w.apps.get()` -> `w.service_principals.get()`
- Grants `AclPermission.READ` on secret scope (fixes `valueFrom` resolution)
- Writes embedding endpoint name to scope (fixes memory module env var)
- Verified green: both UC Setup Job tasks pass

## Commits

1. `fix: resolve runtime errors in dispatch tick-evaluator and mlflow-tracer` (app bundle)
2. `feat(infra): add configure_app_secrets task to UC Setup Job` (infra bundle)

## Current Runtime Status

| Module | Status | Notes |
| --- | --- | --- |
| Migrations | Running | v1-v3 applied; v4 pending registration |
| Telemetry/OTel | Running | Duplicate registration warnings (cosmetic) |
| Telemetry/MLflow | Degraded | URL fixed; 401 until next deploy picks up scope grant |
| Memory | Degraded | Embedding endpoint now in scope; needs app redeploy |
| Dispatch | Running | Tick-only (LISTEN disabled); tick SQL fixed |
| MCP | Running | 22 tools registered at `/mcp` |
| API | Running | Supervisor routes registered |

## Remaining Work

1. Register migration 004 in `server/migrations/index.ts`
2. Fix `server/memory/index.ts` workspaceHost protocol (same `https://` pattern)
3. Add `embedding-endpoint` secret resource to `resources/hi_genie_app.app.yml`
4. Add `EMBEDDING_ENDPOINT_NAME` env entry to `app.yaml`
5. Deploy app to pick up infra scope grant + embedding env var
6. Verify MLflow tracer + memory module initialize cleanly
