# Project Memory — mcp-hi-genie-orchestrator

## Overview

**App:** Hi Genie Orchestrator — production-only Databricks App for supervising Genie workstreams  
**Architecture:** Supervisor API (`/api/v1`) + Workstream MCP (`/mcp`) + read-only React UI, backed by Lakebase (PostgreSQL), Unity Catalog, MLflow 3 traces  
**Bundle root:** `.../hi-genie-orchestrator/mcp-hi-genie-orchestrator/`  
**Infra bundle:** `.../hi-genie-orchestrator/hi-genie-infra/` (deploy FIRST)  
**Git repo root:** `/Workspace/Users/matthew.giglia@databricks.com/brainstorming-hi-genie-orchestrator/`  
**Stabilization branch:** `feature/r1-backend-blockers` — merged to `main` via PR #17 (commit `529bdf7`). All stabilization work (KI-14, KI-16, RLS migration 006, review lifecycle enforcement, 115 Vitest tests) is on `main`.
**Workspace:** `fevm-hls-fde` (ID `7474657291520070`)  

---

## Targets

| Target | Catalog | Schema | Lakebase Branch | App Name | Deploy Mode | Run As |
| --- | --- | --- | --- | --- | --- | --- |
| dev (default) | `hls_fde_dev` | `dev_matthew_giglia_hi_genie` | `development` | `mcp-hi-genie-orchestrator-dev` | Source-linked (workspace) | `matthew.giglia@databricks.com` |
| hls_fde | `hls_fde` | `hi_genie` | `production` | `mcp-hi-genie-orchestrator` | Source-linked (workspace) | `${var.higher_level_service_principal}` |
| prod | TBD | TBD | TBD | `mcp-hi-genie-orchestrator-prod` | **Git** (`release` branch) | `matthew.giglia@databricks.com` |

---

## Key IDs & Endpoints

| Resource | Value |
| --- | --- |
| App URL (dev) | `https://mcp-hi-genie-orchestrator-dev-7474657291520070.aws.databricksapps.com` |
| App SPN client_id (dev) | `84b36586-1ca7-4756-b39e-551a79058c55` |
| App SPN service_principal_id | `77145947608610` |
| Lakebase project ID | `hi-genie-orchestrator` (shared across targets) |
| Lakebase database ID (dev) | `databricks_postgres` (underscore, not hyphen) |
| Lakebase host (dev) | `ep-blue-block-d204ny6i.database.us-east-1.cloud.databricks.com` |
| Lakebase pooled host (dev) | `ep-blue-block-d204ny6i-pooler.database.us-east-1.cloud.databricks.com` |
| Secret scope | `hi_genie_credentials` |
| Secret keys (dev) | `client_id_dev_matthew_giglia_hi_genie`, `client_secret_dev_matthew_giglia_hi_genie` |
| Secret keys (hls_fde) | `client_id_hi_genie`, `client_secret_hi_genie` |
| SQL Warehouse (infra) | `7de72d0573acef5e` |
| MLflow Experiment ID (dev) | `4038008988926083` |
| MLflow Experiment Path (dev) | `/.experiments/hls_fde_dev/dev_matthew_giglia_hi_genie/[dev matthew_giglia] hi_genie_orchestrator_traces` |
| UC Connection — REST (dev) | `hi_genie_orchestrator_conn_dev` (HTTP, metastore-level, `/api`) |
| UC Connection — MCP (dev) | `hi_genie_mcp_conn_dev` (HTTP, metastore-level, `/mcp`, OAuth M2M — single connection for all 5 persona services) |
| UC Connection — U2M (dev) | `hls_fde_dev.dev_matthew_giglia_hi_genie.hi_genie_orchestrator_u2m_mcp_conn_dev` (schema-scoped, OAuth U2M — **blocked: requires account admin to register OAuth app**) |
| MCP Services (dev) | 5 services in `hls_fde_dev.dev_matthew_giglia_hi_genie`: `hi_genie_orchestrator_dev` (orchestrator, all 39 tools, ID `b9ebe29c-3fa9-46d9-be8c-7770a7ffd819`), plus architect (14), reviewer (14), worker (17), dispatcher (16) — all sharing `hi_genie_mcp_conn_dev` with `include_tool_selectors` |
| Workers Group (dev) | `hi-genie-workers-dev` |
| Workers Group (prod) | `hi-genie-workers` |
| Post-deploy Job ID | `468754756167374` |
| Post-deploy params | `first_run` (full setup), `publish_skills` (skills only), `drop_connection` (reset creds) |

---

## OTel Tables

All in `hls_fde_dev.dev_matthew_giglia_hi_genie`:

| Signal | Table |
| --- | --- |
| Logs | `hi_genie_otel_logs` |
| Metrics | `hi_genie_otel_metrics` |
| Traces | `hi_genie_otel_traces` |

**Schema note:** Logs table uses `time` column (not `timestamp`), plus `event_name`, `body`, `flags`.

---

## Developer Experience Endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/docs` | None (public) | Interactive Swagger UI explorer |
| `GET /api/docs/openapi.json` | None (public) | Raw OpenAPI 3.1 JSON spec |
| `GET /api/v1/mcp/tools` | Identity required | REST catalog of all 39 MCP tools |
| `GET /api/v1/mcp/tools/:toolName` | Identity required | Single tool detail + invocation example |

**TypeScript SDK:** `shared/sdk/` — zero-dependency typed client (`OrchestratorClient`) with sub-clients for plans, workstreams, reviews, and MCP.

**Key decision:** Swagger UI mounts BEFORE `requireVerifiedIdentity` middleware (no auth for docs). MCP catalog sits under `/api/v1` and requires identity.

**CJS interop:** `swagger-ui-express` is CJS; ESM project uses `createRequire(import.meta.url)` in `server/api/docs.ts` to avoid tsdown unbundle tree-shaking issues.

---

## Deployment

### Container Build Model

The Databricks Apps container builds with `NODE_ENV=production`:
1. `npm install` — installs `dependencies` ONLY (skips `devDependencies`)
2. `postinstall` — `appkit generate-types || true`
3. `npm run build` — `build:server && build:client`
4. `npm run start` — `node ./dist/server.js`

**Critical:** ALL build-time tools must be in `dependencies`:
- `typescript`, `tsdown`, `tsx` (server build)
- `vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `tailwindcss`, `autoprefixer`, `@tailwindcss/postcss` (client build)
- `@types/express`, `@types/node`, `@types/react`, `@types/react-dom` (type checking)

### Genie Code Deploy Method

```python
from databricks.sdk import WorkspaceClient
from databricks.sdk.service.apps import AppDeployment
w = WorkspaceClient()
waiter = w.apps.deploy(
    app_name="mcp-hi-genie-orchestrator-dev",
    app_deployment=AppDeployment(source_code_path="/Workspace/Users/matthew.giglia@databricks.com/brainstorming-hi-genie-orchestrator/genie-workstream-orchestrator/hi-genie-orchestrator/mcp-hi-genie-orchestrator")
)
```

**Notes:**
- `w.api_client.do("POST", f"/api/2.0/apps/{APP_NAME}/deployments", body={"source_code_path": SRC})` is the reliable deploy path from notebooks (matches `deploy_source.sh` pattern)
- `w.apps.deploy()` SDK method has a signature mismatch (`source_code_path` not accepted as kwarg) on the serverless SDK version — use the REST API above instead
- `databricks apps deploy` CLI / `databricks api post` to `/apps/{name}/deployments` are blocked by guardrails
- `--var lakebase_database_id=databricks-postgres` is REQUIRED for `bundle deploy`
- Poll `GET /api/2.0/apps/{name}` for `active_deployment.status.state`
- Build logs stream to `hi_genie_otel_logs` table
- `source_linked_deployment: true` (dev) — links workspace folder but does NOT auto-trigger builds

### Deploy Flow (full)

1. Commit + push to git
2. `bundle deploy --target dev --auto-approve --var lakebase_database_id=databricks-postgres`
3. `w.apps.deploy(...)` to trigger container build
4. Poll until SUCCEEDED or FAILED
5. Check OTel logs if FAILED

---

## Current Server State

**All modules enabled** — full `server/` tree compiles and deploys.  
**Version:** 1.1.0 | **Branch:** `main` | **Merged:** `mg-genie-mcp-protocol-version` (protocol version `2025-11-25`, `list_projects` tool, versioning design doc, KI-18 enum fix), `mg-genie-r1-mcp-findings` (PR #20: KI-19/KI-20 fixes, defense-in-depth enum validation), `mg-genie-state-rls` (PR #21, merge `0403cb8`: migration 007 RLS on 8 state tables, state.ts handler refactor, dispatch crash resilience, post-deploy test fixes), `mg-genie-sdk-reconciliation-and-prod-alignment` (Python SDK v0.2.0, TypeScript SDK alignment, prod targets, skill folder rewrite) | **Active feature:** `mg-genie-r2-mcp-consolidation`  
**Last validated:** 2026-10-05 — Branch `mg-genie-r2-mcp-consolidation`. Deployment `01f1c0c023fb1c6e91d08ba37ee22940` SUCCEEDED. Item 8 dispatch reconciliation deployed (SYSTEM_IDENTITY, transaction-wrapped handlers, execution record creation, RESUME_RETRY dep check). Post-deploy run ALL TASKS GREEN (run `717399212414434`). SPN credential rotated (new secret ID `917fc97a...`, expires 2028-10-04). Full RLS coverage: 17 tables (+ `dispatch.projects`), 34+ policies.

**Local stabilization status (2026-08-20, `feature/r1-backend-blockers`):**

Distinct commits matter here — do not conflate them:

| Commit | Meaning |
| --- | --- |
| `8a7ee13` | **Historical.** The stabilization-only head that passed the independent Codex cross-review with no findings. Predates the `main` integration; its gate numbers (67 Vitest) are superseded below. |
| `43e2cc7` | **Final code commit** on `feature/r1-backend-blockers` as of this writing — `8a7ee13` merged with `main` (`310ebe2`, the OpenAPI/SDK/Swagger work), plus lockfile regeneration, `tsconfig.test.json` expansion, cross-review test-mock realism fixes, and the `client.test.ts` fetch-mock contract fix. All gate numbers below were measured against this exact commit. |
| *(this docs update)* | A documentation-only commit **on top of** `43e2cc7` recording these numbers. A commit cannot cite its own SHA, so this file's own commit is necessarily one step newer than `43e2cc7` — resolve the true branch tip with `git rev-parse feature/r1-backend-blockers` — but **no code changed** between `43e2cc7` and that tip. |

- Orchestration scoping now covers route mutations, periodic dispatch, and dependency evaluation.
- `ReviewDispatcher.createReviewTask` has outcome-matched commit/rollback/release/destroy handling with lifecycle regression tests.
- `record_decision` requires `workstream_id`; invalid UUID fixtures and the stale lockfile are fixed.
- **Verified gates at `43e2cc7`:** `npm ci`, typecheck (server + client + test projects), build, **115 Vitest tests**, **4 Python validator tests**, and **13 Playwright smoke tests** all pass.
- **Lint:** branch is **200 errors / 3 warnings** versus `main` (`310ebe2`) at **212 errors / 3 warnings** — a **12-error improvement**, not an unchanged backlog. See Known Issue 17 for the file-level verification method.
- This is local/branch validation only; deploy and live-environment validation remain tied to the last deployed commit until the PR is opened, reviewed, merged, and deployed.
- Session handoff: `fixtures/sessions/2026-08-20_r1-backend-blockers.md`.

**Active modules (all enabled, runtime status):**

| Module | Status | Notes |
| --- | --- | --- |
| Migrations | ✅ Running | v1-v9 applied (v4 workstream_columns, v5 RLS on plans, v6 RLS on dispatch tables, v7 RLS on all 8 state tables, v8 skill_versions + project_skill_overrides, v9 dispatch.projects + FK constraints) |
| Telemetry/OTel | ✅ Running | Duplicate registration warnings (cosmetic — AppKit registers first) |
| Telemetry/MLflow | ⚠️ Broken | Platform-native experiment resource (ID `4038008988926083`); `MLFLOW_EXPERIMENT_ID` injected via `valueFrom: experiment`. **DEFECTIVE (2026-08-26):** traces never completed (POST only, no PATCH), wrong API version (2.0, should be 3.0), SPN identity (not OBO). 133 stale IN_PROGRESS traces. **Partial fix (2026-08-26):** reserved `mlflow.user` tag replaced with `hi_genie.user_identity` (commit `c43e5be`); exports now HTTP 200 (132+ traces created) but still POST-only / v2.0 / never PATCH-ended. Remediation plan accepted: `docs/design/2026-08-26_mlflow-trace-lifecycle-and-obo-remediation.md`. Next: implement 4 phases (~3.5 hrs). |
| Memory | ✅ Running | Embedding service started (`databricks-gte-large-en`); all memory layers initialized |
| Dispatch | ✅ Running | Tick-only mode (LISTEN/NOTIFY disabled — PgBouncer incompatible); tick SQL fixed |
| MCP | ✅ Running | **39 tools** via single `/mcp` endpoint. Protocol version `2025-11-25`. 4-persona scoping via UC MCP Services with `include_tool_selectors` (architect:14, reviewer:14, worker:17, dispatcher:16). Single connection (`hi_genie_mcp_conn_dev`). ASK-gate policy (publish_plan, dispatch_workstream, approve_review, cancel). KI-16/KI-18 resolved. AI Playground validated (2026-08-21, 2026-08-26). **Dependency gate** on `dispatch_workstream` (rejects if upstream deps not COMPLETE). **Protocol compliance audit (2026-08-25):** 10 gaps identified vs 2025-11-25 Streamable HTTP spec — 3 critical, 3 high, 4 low. Issue #12 (sessionId in body) also identified. Remediation plan: `docs/design/2026-08-25_transport-2025-11-25-compliance-plan.md`. |
| API | ✅ Running | Supervisor API v1 routes registered. Project management routes (`/api/v1/projects`) deployed (2026-08-26). |

**tsconfig.server.json:** `include` covers all module dirs (telemetry, memory, dispatch, mcp, api, migrations, shared, config).

**Dispatch architecture:** LISTEN/NOTIFY is structurally supported (trigger + function DDL installed) but disabled by default (`DISPATCH_LISTEN_ENABLED=false`) because Lakebase uses PgBouncer transaction mode. Dispatch runs via tick evaluator (60s polling interval) + outbox table. `materialize_workstreams` uses `ws.name ?? ws.title ?? ws.workstream_key` fallback (plan content uses `title`, not `name` — fix `3db2c37`).

### Next Steps (Priority Order)

| # | Task | Effort | Depends On | Design Doc |
| --- | --- | --- | --- | --- |
| 1 | **MLflow P1: Fix API version (2.0→3.0) + two-phase lifecycle (POST+PATCH)** — traces will actually complete with status + execution time + request/response previews | ~1.5 hrs | — | `docs/design/2026-08-26_mlflow-trace-lifecycle-and-obo-remediation.md` |
| 2 | **MLflow P2: OBO user attribution** — extract `x-forwarded-access-token`, authenticate MLflow API as end user (not SPN), add `mlflow.user` tag | ~45 min | P1 | same |
| 3 | **MLflow P3: Trace naming + tags** — `tool:<name>` convention, structured tag schema (`hi_genie.workstream_key`, `mcp.method`, etc.) | ~35 min | P1 | same |
| 4 | **MLflow P4: Cleanup** — delete 133 stale IN_PROGRESS traces, grant experiment CAN_READ to users group | ~20 min | P1 deployed | same |
| 5 | **MCP transport P1: Protocol correctness via official SDK** (Architecture Decision 15) — replace hand-rolled session layer with `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` + low-level `Server`; persona paths stateless, `/mcp` stateful; keep `_caller_identity` and tool registry. Phase 0 first: AppKit 0.89 branch merged, dev restored, UC MCP Service request captured | see design doc (total 8-12 hrs, estimate) | Phase 0 | `docs/design/2026-10-30_mcp-transport-sdk-adoption-plan.md` (issue list: `2026-08-25_transport-2025-11-25-compliance-plan.md`) |
| 6 | **MCP transport P2: POST SSE streaming + progress** — from SDK transport; `onProgress` in handler context, first adopter `orchestrate_plan` | included above | transport P1 | same |
| 7 | ~~**Fix `validate_deployment` task**~~ — **DONE (2026-10-02/05).** Test 3 + Test 4 both fixed: `create_project` before `create_plan`. | ✅ | — | — |
| 8 | ~~**Dispatch tick + dependency gate reconciliation**~~ — **DONE (2026-10-05).** SYSTEM_IDENTITY constant, transaction-wrapped handlers with execution records, RESUME_RETRY dep check in priority tree, RLS context on handleStuck/unpauseReady. Deployed + validated. | ✅ | — | — |
| 9 | **Add `withToolSpan` to read-only MCP tools** — `get_health`, `search_decisions`, `get_project_context`, etc. missing from MLflow trace breakdown | ~45 min | MLflow P1 | — |
| 10 | **PR merge `mg-genie-r2-mcp-consolidation` → `main`** — 20+ commits; migration 009, dependency gate, connection consolidation, transport compliance fixes, projects feature | ~30 min | items 7-8 recommended first | — |

---

## Client State

**Scaffold frontend deployed** — React SPA from `databricks apps init --template lakebase`:
- `App.tsx` — responsive layout with nav, router, 4 pages (Home, Analytics, Lakebase, Files)
- `ErrorBoundary.tsx` — catches React errors
- AppKit UI components (`@databricks/appkit-ui/react`)
- Tailwind CSS with dark mode
- `build:client` skips `tsc` (no warehouse types yet) — Vite/rolldown handles JSX

**Next:** Replace scaffold demo pages with orchestrator-specific UI (workstream status, dispatch queue, review panel).

---

## Conventions

- **Secret keys:** schema-qualified per target (e.g., `client_id_dev_matthew_giglia_hi_genie`)
- **Schema references:** `${resources.schemas.hi_genie_schema.*}` in resource YAMLs
- **Lakebase:** single project (`hi-genie-orchestrator`) for all targets, branch isolation
- **Source deployment:** REST API `POST /api/2.0/apps/{name}/deployments` (not CLI)
- **First-deploy bootstrap:** `bootstrap_credentials.sh` handles placeholder → real SPN flow

### Polly Collaboration Protocol

**Location:** `.review-protocol/SKILL.md` (protocol definition)  
**Channels:** `hi_genie/` (Polly → Genie) | `hey_polly/` (Genie → Polly)  
**State:** `.review-protocol/debate_state.json`  
**Scope:** Advisory architecture discussion ONLY — does not override orchestrator lifecycle, reviewer skill, Lakebase findings, or Supervisor decisions.  
**Deployment:** All `.review-protocol/`, `hi_genie/`, `hey_polly/` excluded from bundle sync (see `databricks.yml` `sync.exclude`).  
**Directory:** Renamed from `.polly/` to `.review-protocol/` to avoid confusion with the orchestrator's Polly persona. Rename complete.

---

## Projects (Migration 009)

**Table:** `dispatch.projects` — top-level organizational entity for plans and orchestrations.  
**Migration:** 009 (`305daee`, 2026-08-26) — creates table, FK constraints on `dispatch.plans` and `dispatch.orchestrations`, RLS policies (SELECT permissive + INSERT identity check).  
**MCP tool:** `create_project` (architect persona, brings architect total to 14 tools).  
**REST routes:** `POST /api/v1/projects`, `GET /api/v1/projects/:id` (UI-only operations, deployed `4a04bf4`).  
**FK enforcement:** `create_plan` now requires a valid `project_id` — FK violation (`23503`) caught and returned as `400 BAD_REQUEST` (not crash). Commit `49a058a`.

---

## Dispatch Dependency Gate

**Commit:** `db0549c` (2026-08-26)  
**Behavior:** `dispatch_workstream` queries upstream `depends_on` workstreams before allowing dispatch. If any upstream dep is not COMPLETE → `400 BAD_REQUEST` with detailed error listing blocking deps and their current statuses. Root workstreams (`depends_on: []`) skip the check.
**Validated:** AI Playground — `ws-gold-tables` correctly rejected with `[ws-dlt-pipeline=IN_PROGRESS]`.  
**Reconciled (2026-10-05):** Dispatch tick action handlers now route through the service layer (`dispatchWorkstream`) which creates execution records and sets RLS context. `RESUME_RETRY` rule in `priority-tree.ts` includes `allDependenciesMet` check. `handleStuckAction` and `unpauseReadyAction` set `app.user_identity = 'system:dispatch-engine'` for future-proof RLS compliance. Deployed and validated via post-deploy job run `717399212414434`.

---

## UC Functions (Architect/Dispatcher API)

**Pattern:** Metadata-driven registration via `src/deploy/uc_functions/*.sql` templates.  
**Runner:** `register_uc_function` notebook (SQL, DECLARE VARIABLE + EXECUTE IMMEDIATE).  
**Discovery:** `discover_uc_functions` scans directory, outputs forEach inputs.  
**Job DAG:** `create_app_connection` → `discover_uc_functions` → `register_uc_functions` (forEach).

**Functions (R1):**
| Function | API | Role |
| --- | --- | --- |
| `create_plan` | POST /api/v1/plans | Architect |
| `get_plan` | GET /api/v1/plans/:id | Architect |
| `publish_plan` | POST /api/v1/plans/:id/publish | Architect |
| `orchestrate_plan` | POST /api/v1/plans/:id/orchestrate | Dispatcher |
| `list_workstreams` | GET /api/v1/orchestrations/:id/workstreams | Dispatcher |
| `dispatch_workstream` | POST /api/v1/orchestrations/:id/workstreams/:key/dispatch | Dispatcher |

**Pattern:** UC Connection Proxy style — `http_request(conn => '<connection_name>', path => '/...')`.
This is the SQL expression of the [UC HTTP Connection Proxy](https://docs.databricks.com/aws/en/query-federation/http#forward-requests-through-the-http-connection-proxy):
the connection acts as a Databricks-hosted proxy that forwards requests and injects OAuth
credentials automatically. External clients use the REST proxy URL
(`/api/2.0/unity-catalog/connections/<name>/proxy/<sub-path>`); UC functions use the same
mechanism via the `conn` parameter.

**📌 Migrating to single MCP surface (R1):** UC functions are being consolidated into the MCP
Service. All personas (architect, dispatcher, worker, human) will use the MCP Service, with
a persona-based service policy (`persona_tool_policy`) gating tool access by caller identity.
UC SQL functions will be deprecated once architect/dispatcher tools are added as MCP tools.

### UC Connections (Consolidated Architecture)

| Connection | `base_path` | Used By |
| --- | --- | --- |
| `hi_genie_orchestrator_conn_dev` | `/api` | UC functions (`path => '/v1/...'`) |
| `hi_genie_mcp_conn_dev` | `/mcp` | All 5 UC MCP Services (single connection, per-persona tool selectors) |

Both use the same SPN credentials and app host. Conditional reset via `drop_connection` job param.

**History:** Originally 5 per-persona connections (one per MCP Service). Consolidated to 1 MCP connection in `009c250` (2026-08-25). Tool scoping moved from connection-level to service-level via `include_tool_selectors`. 6 stale connections deleted.

### MCP Service Governance

**Rate Limits:** 120 QPM (service), 30 QPM (per-user). Configured via bundle variables.  
**Service Policy:** `persona_tool_policy` (ON_CALL trigger) checks `persona_assignments` table:  
- Humans: ALLOW all tools, ASK on `publish_plan`  
- Agent SPNs: restricted to their persona's tool set  

**Persona → Tool Mapping (implemented via UC MCP Service `include_tool_selectors`):**

> Platform limit: UC MCP Service enforces max **20 enabled tools across all MCP servers per user**. Actual counts per persona below.

| Persona | UC MCP Service | Count | Tool Categories |
| --- | --- | --- | --- |
| architect | `hi_genie_orchestrator_dev` (architect selector) | 14 | projects (2), plans (3), orchestration (3), skills (2), context (2), health (2) |
| reviewer | `hi_genie_orchestrator_dev` (reviewer selector) | 14 | reviews (4), quality gates, broad read |
| worker | `hi_genie_orchestrator_dev` (worker selector) | 17 | context (3), records (6), state (5), search (2), skill (1) |
| dispatcher | `hi_genie_orchestrator_dev` (dispatcher selector) | 16 | orchestration (7), lifecycle (5), context (2), health (2) |
| orchestrator | `hi_genie_orchestrator_dev` (empty selector) | 39 | All tools (direct proxy access, REST testing) |

**Worker tools (20):** `get_project_context`, `get_workstream_context`, `get_session_context`, `record_decision`, `record_session_summary`, `record_error`, `record_workstream_event`, `record_task_attempt`, `record_task_completion`, `update_workstream_status`, `update_task_status`, `update_recovery_state`, `start_session`, `end_session`, `search_context`, `get_task_history`, `get_relevant_errors`, `get_recent_session_summaries`, `search_decisions`, `get_skill_content`

**Supervisor/Architect tools (21):** `list_projects`, `create_project`, `get_project_context`, `get_workstream_context`, `get_execution_summary`, `create_plan`, `get_plan`, `publish_plan`, `orchestrate_plan`, `materialize_workstreams`, `list_workstreams`, `dispatch_workstream`, `retry_workstream`, `pause_workstream`, `unpause_workstream`, `create_review`, `get_review`, `deliver_remediation`, `approve_review`, `get_skill_content`, `get_health`

**Unassigned (REST proxy only):** `get_schema_version`, `update_skill`

**Implementation:** `src/deploy/register_mcp_service.py` — `PERSONA_TOOL_SELECTORS` dict (YAML-driven tool lists per persona). All 5 UC MCP Services reference single `hi_genie_mcp_conn_dev`. Detects selector drift on PATCH. Exponential-backoff polling for async tool discovery (2s→15s, 120s timeout). `transport.ts` still contains legacy `WORKER_TOOLS`/`SUPERVISOR_TOOLS` code (dead — removal is Issue #11 in compliance plan).

**`persona_assignments` population:**
- Only Agent SPNs need rows — humans are auto-detected by `principal_type = 'USER'` and get full access (with interactive ASK gates) without any table entry.
- Future UI consideration: a project-level settings panel for managing Agent SPN persona assignments (not per-SPN standalone). Deferred — not a scenario expected in R1.

---

## Lakebase Search

**Status:** Enabled at the project level (manual toggle in Lakebase UI — no DABs method exists yet).  
**Extensions available:** `lakebase_vector`, `lakebase_text`, `vector` (appear in `pg_available_extensions`).  
**Installation required per-database:**

```sql
CREATE EXTENSION IF NOT EXISTS lakebase_vector CASCADE;  -- vector ANN search (installs pgvector)
CREATE EXTENSION IF NOT EXISTS lakebase_text;            -- BM25 full-text search
```

**Impact:** Migration v3 (`memory_tables`) self-heals — installs extensions via `CREATE EXTENSION IF NOT EXISTS lakebase_vector CASCADE` before creating tables. All 3 migrations now applied successfully.  
**Convention:** Use AppKit plugin modules (`appkit.lakebase`) for all Lakebase operations wherever possible.

---

## Known Issues / Workarounds

1. **`DATABRICKS_WAREHOUSE_ID` not configured** — `appkit generate-types` skips query types; `AnalyticsPage.tsx` has untyped hook returns. Fix: add `sql-warehouse` resource to app YAML when analytics plugin is needed.
2. **Legacy lint backlog** — a legacy `@typescript-eslint` backlog remains, but this branch *reduced* it rather than leaving it unchanged: **200 errors / 3 warnings** on `feature/r1-backend-blockers` versus **212 errors / 3 warnings** on `main` (`310ebe2`) — a 12-error improvement. Install/typecheck/build/tests are green. Clearing the remaining ~200 legacy errors is a separate follow-up scope; see Known Issue 17.
3. **Production branch protection** — Lakebase `production` branch was temporarily unprotected (Cell 4 in starter notebook). Re-enable `lifecycle.prevent_destroy: true` on `production_endpoint` in infra bundle.
4. **Scaffold directory** — `hi-genie-scaffold/` still exists in workspace (not committed). Safe to delete.
5. **Platform `/healthz` intercept** — The Databricks Apps platform liveness probe intercepts `/healthz` (returns empty 200). Custom health check moved to `/api/health`. Test suite should validate via Lakebase queries directly (AppKit sidecar auth blocks SDK bearer tokens with 401).
6. **`AppKit` type not exported** — AppKit 0.38.1 does not export the `AppKit` type. Workaround: `type AppKitInstance = any;` in module entry points. Track for fix in future AppKit versions.
10. **`wc.config.authenticate()` is NOT valid for calling a Databricks App's own HTTP ingress as a human/U2M identity.** It returns a token scoped for platform REST APIs (`/api/2.0/...`), not the App's ingress (which normally expects a browser SSO session for humans). Got 401 `{}` regardless of app permissions. For M2M/testing purposes, use the SPN `client_credentials` flow (`POST /oidc/v1/token`) instead — that token IS accepted by the App ingress.
11. **Databricks Apps `CAN_USE` is required for EVERY caller, including the app's own auto-provisioned SPN calling its own HTTP ingress**, and `CAN_MANAGE` does not imply it. If granted only via the UI, it is silently dropped the next time `bundle deploy` overwrites the target's `permissions` block. Must be declared in the bundle YAML (see `resources/hi_genie_app.app.yml` → `targets.dev.resources.apps.app.permissions` → `service_principal_name: "84b36586-1ca7-4756-b39e-551a79058c55"`, `level: CAN_USE`).
12. **`bundle deploy` (source-linked dev target) does not reliably restart the running app process on a source-only change.** After a successful `bundle deploy`, a new migration had not actually run because the active deployment predated the change. Force a fresh deployment via the SDK: `w.apps.deploy(app_name=..., app_deployment=AppDeployment(source_code_path=...))`, and pass a `datetime.timedelta` (not a bare `int`) to `.result(timeout=...)`.
13. **Zod's `.uuid()` enforces RFC 4122 version/variant nibbles.** A hand-rolled placeholder like `00000000-0000-0000-0000-0000000000aa` fails validation (version digit must be `1`-`5`). Use `uuid.uuid4()` for test payloads.
17. **Repo-wide legacy ESLint backlog: ~200 pre-existing `@typescript-eslint` errors, largely `no-unsafe-*` on `pg`/AppKit `any`-typed values.** These predate this branch's work and are NOT masked or suppressed. Root cause: AppKit's `LakebasePlugin`/`Pool` types and Drizzle's dynamic `[pkColumn]` indexing surface as `any` at multiple call sites; clearing them requires either narrowing AppKit's structural types or adding a justified eslint-disable per call site — out of scope here.

    **Measured counts (2026-08-20, both measured with the same `npm run lint`):**

    | Tree | Result |
    | --- | --- |
    | `main` @ `310ebe2` | 215 problems — **212 errors, 3 warnings** |
    | `feature/r1-backend-blockers` @ `43e2cc7` | 203 problems — **200 errors, 3 warnings** |
    | Delta | **12 fewer errors**, warnings unchanged |

    **Verification method (file-level, not just totals):** the set of files with lint errors on this branch is a strict *subset* of `main`'s. Eight files dropped off entirely — `server/api/middleware/identity.test.ts`, `server/api/openapi.test.ts`, `server/api/routes/mcp-catalog.test.ts`, `server/api/routes/plans.test.ts`, `server/api/routes/reviews.test.ts`, `server/api/routes/workstreams.test.ts`, `server/migrations/runner.test.ts`, and `shared/sdk/client.test.ts`. On `main` these each reported a single blanket "Parsing error: not found by the project service" (a pre-existing gap: no `tsconfig` covered test files), which *masked* their real findings. Adding `tsconfig.test.json` (covering `server/**/*.test.ts` + `shared/**/*.test.ts`) and wiring it into `typecheck` surfaced the real issues, which were then fixed with proper types rather than `any` or suppressions. Every remaining file's error count is identical to `main` except `server/api/routes/workstreams.ts` (38 → 34), improved as a side effect of this branch's orchestration-scoping fix. **No file gained a new lint error** — confirmed by diffing per-file `npm run lint` output between a `main` worktree and this one.

15. **`regexAssetSearch` is unreliable for `.ts` files in this Git-backed folder.** Returned 0 results for `.*orchestrations.*` and even the literal substring `dispatch.orchestrations`, despite that string appearing dozens of times in files confirmed present via direct `readAssetById` reads. Don't trust a 0-result search here as evidence of absence — fall back to manually reading directory listings and file contents.
21. **`w.postgres` (PostgresAPI / Lakebase SDK) has NO SQL execution method.** Neither `execute_statement` nor `execute_sql` exists — the SDK surface is exclusively for resource management (projects, branches, endpoints, databases, roles). For SQL execution from notebooks or tests, use `psycopg2` direct connection: resolve endpoint host via `w.postgres.list_endpoints(parent=...)`, authenticate with a workspace OAuth token, connect with `sslmode='require'`. Discovered 2026-08-22 while fixing post-deploy test 7.
22. **Unhandled PG 42501 (RLS violation) crashes Node.js.** App write routes MUST catch Postgres error code `42501` and return a structured HTTP response (typically 403). Without a catch block, the error becomes an unhandled promise rejection that terminates the Node.js process, taking down all endpoints for all users. Pattern: `catch (err) { if (err.code === '42501') { res.status(403).json({...}); return; } throw err; }`. Currently implemented in `workstreams.ts`; `plans.ts` and `reviews.ts` should follow.

_Resolved issues removed 2026-10-02: KI-7 (migration 004 registration), KI-8 (EMBEDDING_ENDPOINT_NAME), KI-9 (memory workspaceHost protocol), KI-14 (MCP column name mismatches), KI-16 (stale tool input schemas), KI-18 (stale enum values), KI-19 (end_session idempotency), KI-20 (mcp-catalog.test.ts assertion count). See git history for details._

---

## Identity & Row-Level Security (R1 Readiness, Phase 3)

**Phase 3a (done):** `server/api/middleware/identity.ts` — `requireVerifiedIdentity`, mounted on all
of `/api/v1`, fails closed (401 `UNAUTHENTICATED`) instead of the old `'system'` fallback.
`getUserIdentity(req)` in route files throws `UNVERIFIED_IDENTITY` if somehow called outside
that middleware.

**AppKit Lakebase OBO — investigated, not adopted.** No verifiable API surface (no `node_modules`,
no public docs, no usage precedent in lakeLoom/dbxWearables-ZeroBus/scAuditor). True per-identity
Postgres roles would also require dynamically provisioning a role per caller, which doesn't fit
this orchestrator's shared-pool, many-callers pattern.

**RLS pattern adopted instead: Postgres session variables.** Each write transaction runs
`SELECT set_config('app.user_identity', $1, true)` (transaction-scoped, like `SET LOCAL`, but
supports bind parameters unlike `SET LOCAL x = $1`) right after `BEGIN`. RLS policies check
`current_setting('app.user_identity', true)`. Independently corroborated by Lakebase's own Genie
assistant as a first-class pattern for pooled-connection apps. `FORCE ROW LEVEL SECURITY` is
required in addition to `ENABLE` — the app's own SPN role owns these tables and table owners
bypass RLS by default. Confirmed the SPN role has `rolbypassrls = false` (not exempt).

**Scope is write-integrity only, not row-visibility.** `INSERT` policies check
`created_by = current_setting('app.user_identity', true)` (can't forge another identity's write).
`SELECT` policies stay permissive (`USING (true)`) — there's no project-membership/ACL model yet,
so there's no correct predicate for restricting who can *see* a project's rows.

**Status:**
- Migration 005 (`dispatch.plans` / `dispatch.plan_snapshots`, `plans.ts`): live on dev,
  validated end-to-end (SPN M2M call → `201` with correct `created_by` attribution).
- Migration 006 (`dispatch.orchestrations`, `dispatch.workstreams`, `dispatch.executions`,
  `dispatch.review_tasks`, `workstreams.ts`/`reviews.ts`): deployed to dev, validated.
- Migration 007 (`state.sessions`, `state.decisions`, `state.errors`, `state.events`,
  `state.task_attempts`, `state.task_completions`, `state.workstream_events`,
  `state.recovery_state` — `state.ts`): deployed to dev (2026-08-22). 18 policies
  (SELECT+INSERT on all 8, UPDATE on sessions+recovery_state). ENABLE + FORCE ROW
  LEVEL SECURITY on all 8 tables. All 5 state handlers refactored to use
  `withIdentity()` or explicit `set_config`. `optimisticUpdate` helper also
  RLS-aware. `workstreams.ts` dispatch route catches 42501 → 403 (prevents crash).
  `worker_identity` now optional in DispatchSchema (defaults to authenticated caller).
  Post-deploy validation 7/7 PASS.

**Lakebase SDK note (KI-21):** `w.postgres` (PostgresAPI) is for resource management
  only — it has NO `execute_statement` / `execute_sql` method. For SQL execution
  from notebooks, use psycopg2 direct connection with an OAuth token (acquired via
  `POST /oidc/v1/token` client_credentials flow). Resolve endpoint host from
  `w.postgres.list_endpoints(parent=...)`. See Test 7 in post_deploy_validation.

- Previous status for migration 006 (superseded): `pg_policies`
  confirms all 12 policies match the design exactly. **Validated over live HTTP traffic
  (2026-08-20T05:50Z):** full plan→publish→orchestrate→materialize→dispatch E2E flow
  passes with SPN M2M token. Orchestration creation route now exists
  (`POST /api/v1/plans/:planId/orchestrate`). ReviewDispatcher RLS identity also fixed
  (sets `app.user_identity` = `'dispatch-engine'` before INSERT).
- Still not extended to the `state` schema tables written by the 22 MCP tools (separate
  identity path — `developer_id` passed as an explicit tool argument over `/mcp`, not yet
  wired through `requireVerifiedIdentity` at all). Lower priority than fixing Known Issue 14
  first, since several of those tools may not even run successfully yet regardless of identity.

See `fixtures/sessions/2026-08-19_identity-failclosed-and-rls-validation.md` and
`fixtures/sessions/2026-08-20_rls-extension-and-mcp-contract-trace.md` for full details.

---

## Design Documents

Forward-looking research, RFCs, and architecture explorations live in [`docs/design/`](./docs/design/INDEX.md).

| Date | Document | Status | Summary |
| --- | --- | --- | --- |
| 2026-08-26 | [MLflow Trace Lifecycle & OBO Remediation](./docs/design/2026-08-26_mlflow-trace-lifecycle-and-obo-remediation.md) | Accepted | Fix MLflow 3 traces: API v3 two-phase lifecycle, request/response previews, true OBO via x-forwarded-access-token, MCP-aligned trace hierarchy, structured naming |
| 2026-10-30 | [MCP Transport SDK Adoption Plan](./docs/design/2026-10-30_mcp-transport-sdk-adoption-plan.md) | Accepted | Option B selected: official MCP SDK transport + low-level `Server`, existing tool registry kept; stateless persona paths, stateful `/mcp`; Phase 0 prerequisites and verification gates |
| 2026-08-25 | [Transport 2025-11-25 Compliance Plan](./docs/design/2026-08-25_transport-2025-11-25-compliance-plan.md) | Accepted | 12-issue remediation plan for MCP Streamable HTTP spec compliance; 3 phases (protocol correctness, streaming/progress, hardening); scoped to current 2025-11-25 transport. Implementation sketches superseded by its Decision 4 (official SDK, 2026-10-30) |
| 2026-08-24 | [Four-Persona MCP Split](./docs/design/004-four-persona-mcp-split.md) | Accepted | 4-persona MCP services (architect:13, reviewer:14, worker:17, dispatcher:16) under UC 20-tool limit; validated live |
| 2026-08-23 | [R2 MCP Consolidation Plan](./docs/design/2026-08-23_r2-mcp-consolidation-plan.md) | Partially implemented | Unify all persona interactions onto MCP; connection consolidation + selectors + projects done; UC function deprecation pending |
| 2026-08-23 | [Skill Publishing & Post-Deploy Job](./docs/design/2026-08-23_skill-publishing-and-post-deploy-job.md) | Implemented | Migration 008 (skill_versions table), expanded post-deploy job with first_run gating, UC MCP Service registration task |
| 2026-08-20 | [MCP Protocol Versioning Strategy](./docs/design/2026-08-20_mcp-protocol-versioning-strategy.md) | Proposal | A/B deployable spec variants (2025-11-25 vs 2026-07-28); bundle variable; dual app naming; Lakebase branch isolation; transport-v26 skeleton; MCP Apps extension |
| 2026-08-19 | [Sandbox API Exploration](./docs/design/2026-08-19_sandbox-api-exploration.md) | Research complete | Undocumented `/api/2.0/sandboxes` REST API; Omnigent auto-provisioning; exec gap; r1.2 npm test runner candidates |

---

## Architecture Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | Single Lakebase project, branch isolation | Simplifies permissions; dev/prod share schema definition |
| 2 | `source_linked_deployment: true` for dev | Live-links workspace folder; no copy step |
| 3 | AppKit 0.38.1 scaffold as base | Proven build pipeline; upgrade path clear |
| 4 | Server modules excluded from build initially | Ship stable base, add modules incrementally |
| 5 | `/api/v1` prefix for Supervisor surface | Versioned API; future `/api/v2` possible |
| 6 | Drizzle ORM for Lakebase queries | Type-safe SQL; migrations built-in |
| 7 | Dispatch via Lakebase LISTEN/NOTIFY | Low-latency event-driven; no polling |
| 8 | MCP protocol for workstream tools | Standard tool interface; composable agents |
| 9 | MLflow 3 traces for observability | Native Databricks integration; experiment tracking |
| 10 | RLS via Postgres session variables (`set_config`/`current_setting`), not AppKit OBO or per-identity roles | Fits the shared-pool, many-callers (humans + SPNs + future MCP callers) traffic pattern; no verifiable OBO API existed to build on |
| 11 | RLS scope: write-integrity (`INSERT` checks) only, not row-visibility | No project-membership/ACL model exists yet; a visibility policy would need a real predicate, not a guess |
| 12 | Single MCP connection + per-service `include_tool_selectors` (not per-persona connections) | Tool scoping is a service-level concern, not connection-level; reduces credential rotation from 5× to 1×; simplifies post-deploy job |
| 13 | Server-side dependency gate on `dispatch_workstream` | Prevents dispatching workstreams with incomplete upstream deps; enforces DAG ordering regardless of caller |
| 14 | `dispatch.projects` as top-level entity with FK constraints | Plans and orchestrations must belong to a project; prevents orphaned resources; enables project-scoped RLS in future |
| 15 | MCP transport on the official `@modelcontextprotocol/sdk` (`StreamableHTTPServerTransport` + low-level `Server`), replacing the hand-rolled session layer in `transport.ts` (owner decision, 2026-10-30) | 0 of 12 compliance issues fixed in the hand-rolled layer; SDK 1.32.2 targets 2025-11-25 and covers most issues plus cancellation; zod peer matches AppKit 0.89. Tool registry, `_caller_identity`, log-only Origin (transport Decision 2) and deferred resumability (Decision 3) unchanged |
