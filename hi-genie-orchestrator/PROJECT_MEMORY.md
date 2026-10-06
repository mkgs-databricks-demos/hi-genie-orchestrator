# Project Memory — Hi Genie Orchestrator

## What This Is

Hi Genie Orchestrator is the planned production-only Databricks App that
combines supervisor-controlled workstream dispatch with a worker-facing MCP
for durable orchestration context and memory.

## Approved Architecture

- Product: `Hi Genie Orchestrator`
- Databricks App: `mcp-hi-genie-orchestrator`
- Supervisor surface: versioned `/api/v1` API and thin typed Python SDK
- Worker surface: user-authorized `/mcp` Workstream MCP
- Lakebase: one project with protected `production` branch
- Schemas: `dispatch` for supervision and `state` for worker context
- Supervisor model: WS-INIT stateless priority-tree ticks
- Triggering: Lakebase `LISTEN/NOTIFY` wakeups with scheduled tick recovery
- Completion: workers write `READY_FOR_REVIEW`; supervisor/reviewer owns
  `COMPLETE`
- UI: read-only React DAG and drill-down experience, phased after the API
- Deployment: Databricks Declarative Automation Bundle with pinned CLI and separate `dev`, `staging`, and `prod` targets
- Migrations: Release 1 keeps the LakeLoom-style TypeScript startup pattern as
  the minimal baseline: ordered migrations, basic history/version tracking,
  AppKit v1's service-principal DDL connection, and startup execution. Release
  1.1 adds checksums, advisory locking, fail-closed readiness, registry
  validation, a dedicated migration session, transactional history,
  future-schema rejection, comprehensive migration tests, and Lakeflow Jobs
  for large backfills. AppKit itself supplies no migration engine; child
  branches validate but are not promoted; request-path code never runs DDL
- Telemetry: OpenTelemetry plus MLflow 3 traces in Unity Catalog
- Trace retention: DAB variable `mlflow_trace_retention_days`, default `90`
- Memory: short-term session context, episodic history, and semantic patterns
  with pgvector-compatible Lakebase storage; Lakebase Search is optional Beta
- Review records: `dispatch.review_tasks`; immutable evidence, findings,
  remediation attempts, and review events in `state`
- Runtime policy: global Lakebase-backed configuration with DAB safety bounds,
  Supervisor Admin API, and configuration-version snapshots
- Deployment principle: all deployable resources remain Databricks-native
- Companion skill: additive app-specific skill under `skill/`; the portable
  reference skill remains unchanged and is the fallback for unavailable App
  access
- Omnigent persistence: Release 1 keeps shared correlation, identity, scope,
  provenance, and idempotency fields; Release 1.1 adds typed contracts for
  `dispatch.agent_handoffs`, `dispatch.agent_handoff_attempts`, and
  `state.planning_research_runs`, `state.planning_research_reports`, and
  `state.planning_research_synthesis`, with leases, immutable reports, and
  explicit disagreement states
- Omnigent physical contract: the five Release 1.1 tables use UUID keys,
  `timestamptz`, bounded typed `jsonb`, restrictive same-schema foreign keys,
  lifecycle/timestamp checks, scoped recovery indexes, forced RLS, and
  dependency-ordered dedicated-session migrations; see
  `architecture/omnigent-postgresql-contract.md`

## Ownership Boundaries

### Supervisor API and `dispatch` Schema

Owns plan ingestion, workstream materialization, dependency gating,
`execution_tier`, task dispatch, retries, pause/unpause, review dispatch,
completion approval, and operational scheduling state.

### Workstream MCP and `state` Schema

Owns project and workstream context, decisions, summaries, errors, bounded
status updates, task attempts/completions, sessions, recovery context, and
short-/long-term memory records.

Workers never schedule themselves and never mark workstreams complete. The
Dispatcher never becomes the canonical owner of worker memory.

## Release Plan

### Release 1

- Supervisor API and typed SDK foundation
- Workstream MCP context, append-first records, bounded mutable state, and
  structured search
- In-project developer semantic memory using sanitized summaries
- Review-gated lifecycle with immutable review evidence
- Event-driven dispatch with scheduled recovery
- Health, schema-version, and operational read models
- LakeLoom-style startup migrations with basic migration history/version
  tracking through AppKit Lakebase connections

### Release 1.1

- Cross-project developer memory with explicit authorization and consent
- React DAG, completion visualization, summaries, session drill-down, and
  review history
- Dependency and artifact read models where the surface contracts support them
- Migration hardening from the AppKit/LakeLoom review: checksums, advisory
  locking, fail-closed readiness, registry validation, dedicated migration
  session, transactional history, future-schema rejection, comprehensive
  migration tests, and Lakeflow Jobs for large backfills
- Full Omnigent Agent: durable handoff envelopes and delivery attempts, plus
  independent planning-research reports and parent synthesis

### Later

- UI-triggered supervisor mutations
- Semantic expansion beyond approved memory records
- Additional governance integrations and administrative operations

Release 1 may include an optional read-only Worker Insight sub-agent. It uses
the Workstream MCP to provide conversational visibility into workstreams,
blockers, dependencies, validation evidence, and summaries. It does not
implement work, access the Supervisor API, review artifacts, approve completion,
or replace the deterministic WS-INIT Dispatcher. Planning Research, Supervisor,
Reviewer, durable handoffs, and research provenance remain Release 1.1.

## Session Branch Naming Convention

For this session, every new feature branch starts with `mg-polly-`: `mg`
represents the user’s initials and `polly` identifies the Omnigent agent used
for the work. The current UI branch is `mg-polly-hi-genie-orchestrator-ui`,
stacked from the current Hi Genie Orchestrator feature branch.

## Current Status (as of 2026-10-02)

The architecture baseline is accepted through Decision 46. Schema ownership,
review records, surface contracts, bundle deployment, Lakeflow operations,
memory operations, tracing, and global runtime configuration are documented.
The Release 1 versus Release 1.1 migration split is also approved.

### R1 Build Orchestration: COMPLETED

The Release 1 build was executed via the Genie Workstream Orchestrator—a DAG
of 9 autonomous workstreams coordinating through file-based state. All 9
workstreams completed in 15 ticks over ~19h 46m wall-clock (~95 min active
build time). 0 retries on 8 of 9 workstreams; ws-final required 2 attempts
(integration fix for server.ts wiring). See `orchestration/state/` for full
tick history.

### Deployed Components (dev target)

| Component | Status | Key Detail |
| --- | --- | --- |
| hi-genie-infra | **DEPLOYED** | Lakebase PG17 (0.5-4 CU), UC schema, volumes, secrets, SQL warehouse, MLflow experiment |
| mcp-hi-genie-orchestrator | **DEPLOYED** | All 6 server modules running: migrations (v1-v9), telemetry, memory, dispatch, MCP (39 tools), API |
| hi-genie-sdk | **v0.2.0** | Typed async client with M2M auth, Pydantic models, OBO support |
| UC MCP Services | **REGISTERED** | 5 persona services (architect:14, reviewer:14, worker:17, dispatcher:16, orchestrator:39) |
| RLS | **LIVE** | 17+ tables, 34+ policies, write-integrity via Postgres session variables |
| Post-deploy Job | **VALIDATED** | Job `468754756167374` — all 8 tasks green (run `170949291493167`) |

### Active Branch

**`mg-genie-r2-mcp-consolidation`** (~20+ commits, not yet merged to `main`):
- Migration 009 (`dispatch.projects` table + FK constraints)
- Server-side dependency gate on `dispatch_workstream`
- UC connection consolidation (5→1 MCP connection + YAML selectors)
- Transport compliance fixes
- Project management routes (`/api/v1/projects`)

### Merged to `main`

- `feature/r1-backend-blockers` (PR #17): 115 Vitest tests, RLS migration 006,
  review lifecycle enforcement, orchestration scoping
- `mg-genie-mcp-protocol-version`: protocol version `2025-11-25`, `list_projects`
  tool, KI-18 enum fix
- `mg-genie-r1-mcp-findings` (PR #20): KI-19/KI-20 fixes, defense-in-depth
  enum validation
- `mg-genie-state-rls` (PR #21): migration 007 RLS on 8 state tables, state.ts
  refactor, dispatch crash resilience
- `mg-genie-sdk-reconciliation-and-prod-alignment`: Python SDK v0.2.0,
  TypeScript SDK alignment, prod targets, skill folder rewrite

### Known Defects

- MLflow traces defective: POST-only v2.0 (needs v3.0 two-phase lifecycle),
  SPN identity (needs OBO), 133 stale IN_PROGRESS traces. Design doc accepted.
- MCP transport: 10 gaps vs 2025-11-25 Streamable HTTP spec (3 critical).
  Design doc accepted.
- LISTEN/NOTIFY disabled (PgBouncer incompatible); dispatch runs via 60s tick
  polling.
- Client UI is scaffold only (React SPA from AppKit template).
- See `mcp-hi-genie-orchestrator/PROJECT_MEMORY.md` for full known issues list.

## Sub-Bundle Details

### hi-genie-infra/ (Infrastructure Bundle)

Declares all shared infrastructure as DAB resources. Deploy FIRST.

- **Targets:** dev (default), hls_fde, prod
- **Resources:** UC schema, Lakebase project (PG17 Autoscaling 0.5-4 CU),
  Lakebase branches + endpoints, UC volume, secret scope, SQL warehouse
  (2X-Small serverless PRO), MLflow experiment, UC Setup Job (3-task)
- **UC Setup Job tasks:** Lakebase extensions self-healing, App SPN scope grants
  + embedding endpoint secret, MLflow experiment directory creation

### mcp-hi-genie-orchestrator/ (App Bundle)

The Databricks App itself. AppKit v1 with Lakebase plugin, TypeScript,
Node.js/Express backend, React SPA frontend.

- **Server modules (6, startup order):**
  1. Migrations (9 versioned, dispatch + state + memory schemas, RLS)
  2. Telemetry (OTel NodeSDK + MLflow 3 tracer + secret sanitizer)
  3. Memory (short-term CRUD, episodic summaries, semantic pgvector, embeddings)
  4. Dispatch (tick evaluator, 8-priority tree, LISTEN/NOTIFY, review dispatcher)
  5. MCP (39 tools via Streamable HTTP at `/mcp`, 4-persona scoping)
  6. API (Supervisor REST v1: plans, workstreams, reviews, projects, health)
- **MCP tools:** context (3), records (6), state (5), search (2), skill (1),
  plans (3), orchestration (7), reviews (4), projects (2), identity (2),
  health (2), misc (2)
- **Tests:** 115+ Vitest unit tests, 13 Playwright smoke tests, 4 Python
  validator tests
- **Deployment:** source-linked (dev), git-linked (prod planned).
  Container builds with `NODE_ENV=production`.
- **Own PROJECT_MEMORY.md** with detailed known issues, conventions, deployment
  procedures, and module status.

### hi-genie-sdk/ (Python SDK)

Typed async Python client for the Supervisor REST API.

- **Package:** `hi-genie` (Hatchling, httpx, pydantic>=2.0)
- **Version:** 0.2.0
- **Features:** M2M OAuth2 auth, corrected workstream routes, `orchestrate()`
  method, Pydantic models for all API types, OBO auth support, WS-INIT tick
  evaluator

### skill/ (Hi Genie Operating Skill)

Additive app-specific skill for supervisors, workers, reviewers, and
architects. Loaded at runtime via `get_skill_content` MCP tool or REST
endpoint. The portable reference skill at `../skill/` is the fallback.

- **Entry point:** `SKILL.md` — role selection, state machine, module index
- **Roles (4):** architect, supervisor, worker, reviewer
- **Surfaces (5):** mcp-tools (39-tool catalog + role matrix), api-routes,
  lakebase schema boundaries, plus legacy api.md and mcp.md
- **Capabilities (3):** error-handling, governance (UC MCP Service setup),
  detection-fallback
- **Backends (7):** bundle, notebook, sql, custom, pipeline, dashboard,
  genie-space
- **Examples (1):** bootstrap-templates (dispatcher + worker prompt templates)
- **Core (1):** state-machine (7-state lifecycle, transition rules)

## Next Steps

### Immediate (priority order, from app PROJECT_MEMORY)

1. **MLflow P1:** Fix API version 2.0→3.0 + two-phase lifecycle (~1.5h)
2. **MLflow P2:** OBO user attribution (~45m)
3. **MLflow P3-P4:** Trace naming/tags + cleanup 133 stale traces (~55m)
4. **Fix validate_deployment task** — must `create_project` before `create_plan`
   (FK enforcement from migration 009) (~30m)
5. **Dispatch tick + dependency gate reconciliation** (~1-2h)
6. **Merge `mg-genie-r2-mcp-consolidation` → `main`** (~30m)

### Near-term

7. **MCP transport P1:** Protocol correctness (2025-11-25 spec) (2-3h)
8. **MCP transport P2:** POST SSE streaming (4-6h)
9. **Add `withToolSpan` to read-only MCP tools** (~45m)
10. **End-to-end test** — Dispatcher tick → worker spawn → MCP tool calls →
    READY_FOR_REVIEW → review → COMPLETE. Validates the full lifecycle.

### R2 (documented, not R1 scope)

- `skill_versions` versioning with orchestration pinning
- Per-project skill customization (override sections)
- Omnigent as dispatcher integration
- Cross-workspace worker deployment testing
- A/B testing of skill versions across orchestrations

## Key Architectural Decisions (2026-08-23)

- **Workers access MCP via UC MCP Service** (AI Gateway governs, audits, rate-limits)
- **Dispatchers access REST directly** (trusted SPN, M2M OAuth2, no Gateway)
- **`get_skill_content` on both surfaces** (MCP tool for workers, REST for dispatchers)
- **Bootstrap prompts use "We are working on..." framing** (collaborative, not directive)
- **Implicit heartbeat via MCP tool calls** (no explicit keep-alive needed)
- **AI Gateway service policies enforce role boundaries** (infrastructure-level, not prompt-level)
- **Skill authoring stays in git; Lakebase is distribution** (single publish path)

## Related Documents

- `README.md`
- `architecture/requirements.md`
- `architecture/decisions.md`
- `OPEN_QUESTIONS.md`
- `fixtures/sessions/`
- `skill/SKILL.md` — Skill entry point and architecture overview
- `skill/surfaces/mcp-tools.md` — Full 24-tool catalog with role access matrix
- `skill/capabilities/governance.md` — UC MCP Service registration and policies
