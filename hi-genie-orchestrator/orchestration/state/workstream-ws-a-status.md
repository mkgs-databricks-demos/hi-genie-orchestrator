---
workstream_key: ws-a
name: App Bundle Scaffold
status: COMPLETE
depends_on: [ws-0]
scheduled_task_id: 54e33c4684ab416e892f9f79fb18fb7d
task_paused: false
attempt_count: 1
max_retries: 5
started_at: "2026-08-17T23:10:00Z"
completed_at: "2026-08-17T23:15:00Z"
error_message: null
prior_error: null
last_attempt_at: "2026-08-17T23:10:00Z"
---

# Workstream ws-a: App Bundle Scaffold

## Scope

Scaffold `mcp-hi-genie-orchestrator/` App bundle from AppKit template:
- `databricks.yml` with app resource, lakebase plugin, OTel, targets
- `app.yaml` with `command: ['npm', 'run', 'start']`
- `package.json` with `@databricks/appkit`, `@databricks/lakebase`, `drizzle-orm`
- `server/server.ts` entry point (`createApp` + lakebase plugin)
- `appkit.plugins.json` plugin registry
- Directory skeleton: `server/`, `client/`, `config/`

## Notes for Downstream Sessions

### Files Created

All paths relative to `mcp-hi-genie-orchestrator/`:

- `databricks.yml` — Bundle manifest (app resource, Lakebase, OTel, 3 targets)
- `app.yaml` — App runtime config (`command: ['npm', 'run', 'start']`)
- `package.json` — `@databricks/appkit@0.61.1`, `drizzle-orm@^0.38.0`, `zod@^3.24.0`, `uuid@^11.1.0`
- `tsconfig.json` — Strict ESNext, bundler moduleResolution
- `appkit.plugins.json` — Lakebase + Server plugins
- `server/server.ts` — Entry point (`createApp` + `lakebase()` + `server()`)
- `server/migrations/.gitkeep` — ws-b populates
- `server/mcp/index.ts` — ws-c populates
- `server/api/index.ts` — ws-d populates
- `server/dispatch/index.ts` — ws-e populates
- `server/memory/index.ts` — ws-f populates
- `server/telemetry/index.ts` — ws-g populates
- `client/.gitkeep` — Future UI (Release 1.1)
- `config/.gitkeep` — Runtime policy config

### Variable Names for Downstream

| Variable | Purpose | Dev Value |
| --- | --- | --- |
| `catalog` | UC catalog | `hls_fde_dev` |
| `schema` | UC schema | `hi_genie` |
| `secret_scope_name` | Secret scope | `hi_genie_credentials` |
| `lakebase_project_id` | Lakebase project slug | `dev-matthew-giglia-hi-genie` |
| `lakebase_database_id` | Lakebase DB ID | Resolved by deploy.sh |
| `client_id_dbs_key` | SPN client_id key name | `client_id_dev_matthew_giglia_hi_genie` |
| `client_secret_dbs_key` | SPN client_secret key name | `client_secret_dev_matthew_giglia_hi_genie` |
| `mlflow_trace_retention_days` | Trace retention | `90` |
| `app_name` | Platform app name | `mcp-hi-genie-orchestrator-dev` |

### Package Versions

- `@databricks/appkit`: `0.61.1`
- `drizzle-orm`: `^0.38.0` (with `drizzle-kit@^0.30.0` dev)
- `typescript`: `^5.7.0`
- `tsx`: `^4.20.0`
- `tsdown`: `^0.20.0`
- `vitest`: `^4.0.0`
- `zod`: `^3.24.0`

### How Downstream Modules Register

Each downstream workstream adds its module to `server/server.ts`:

1. **Uncomment the import** for the module (e.g., `import { runMigrations } from './migrations/migrate'`)
2. **Uncomment the invocation** in `onPluginsReady` at the marked location
3. Module receives the `appkit` context (`.lakebase`, `.server`, pool, etc.)

Pattern:
```typescript
// In server/server.ts onPluginsReady:
await setupMcpRoutes(appkit);     // ws-c
await setupApiRoutes(appkit);     // ws-d
await setupDispatch(appkit);      // ws-e
await setupMemory(appkit);        // ws-f
await setupTelemetry(appkit);     // ws-g
```

### Plugin Configuration

- Lakebase connects via `valueFrom: postgres` in `app.yaml` (platform-injected endpoint)
- AppKit `lakebase()` plugin handles OAuth credential refresh and connection pooling
- `CAN_CONNECT_AND_CREATE` permission allows DDL for migrations
- Two Lakebase schemas: `dispatch` (Supervisor) + `state` (Workstream MCP)
- Server plugin provides Express with `appkit.server.extend((app) => { ... })`

### OTel Tables

- `${catalog}.${schema}.hi_genie_otel_logs`
- `${catalog}.${schema}.hi_genie_otel_metrics`
- `${catalog}.${schema}.hi_genie_otel_traces`
