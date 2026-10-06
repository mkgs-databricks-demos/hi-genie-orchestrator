# Hi Genie Orchestrator

A Databricks-native application for supervising autonomous Genie workstreams
with durable planning, review-gated completion, and Lakebase-backed context.
Combines a Supervisor REST API and typed SDKs with a Workstream MCP surface,
governed by Unity AI Gateway for cross-workspace access.

## Project Status

| Component | Status | Details |
| --- | --- | --- |
| Architecture | **ACCEPTED** | 46 decisions, 7 architecture docs, Omnigent R1.1 contracts |
| R1 Build Orchestration | **COMPLETED** | 9/9 workstreams, 15 ticks, ~95 min active build time |
| Infrastructure Bundle | **DEPLOYED (dev)** | Lakebase, UC schema, volumes, secrets, SQL warehouse |
| App Bundle | **DEPLOYED (dev)** | All 6 server modules running, 39 MCP tools, 9 migrations |
| Python SDK | **v0.2.0** | M2M auth, typed async client, Pydantic models |
| Skill | **COMPLETE** | 4 roles, 5 surfaces, 3 capabilities, 1 examples |
| UC MCP Services | **REGISTERED (dev)** | 5 persona services, single connection, YAML selectors |
| RLS | **LIVE** | 17+ tables, 34+ policies, write-integrity scope |
| Client UI | Scaffold | React SPA from AppKit template, not yet orchestrator-specific |
| MLflow Traces | Partial | POST-only v2.0, needs v3.0 two-phase lifecycle fix |

## Directory Structure

```
hi-genie-orchestrator/
├── README.md                     # This file
├── PROJECT_MEMORY.md             # Design context, decisions, current status
├── OPEN_QUESTIONS.md             # Unresolved implementation decisions
├── deploy.sh                     # Full deployment script (infra → UC setup → app)
│
├── architecture/                 # Contract documents (7 files)
│   ├── INDEX.md                  # Document manifest + implementation order
│   ├── requirements.md           # Product, surface, security, deployment requirements
│   ├── decisions.md              # 46 accepted architecture decisions
│   ├── omnigent-postgresql-contract.md  # R1.1 physical PostgreSQL contracts
│   ├── omnigent-agent-recommendation.md # Omnigent agent design
│   ├── release-1-readiness-review.md    # R1 readiness assessment
│   └── proposed-r1-ui-design.md         # UI design proposal
│
├── hi-genie-infra/               # Infrastructure Declarative Automation Bundle
│   ├── databricks.yml            # Bundle manifest (3 targets: dev, hls_fde, prod)
│   ├── resources/
│   │   ├── hi_genie.schema.yml           # UC schema
│   │   ├── hi_genie.lakebase.yml         # Lakebase Autoscaling project (PG17, 0.5-4 CU)
│   │   ├── hi_genie_branches.lakebase.yml # Lakebase branch definitions
│   │   ├── hi_genie_endpoints.lakebase.yml # Lakebase endpoints
│   │   ├── traces.volume.yml             # UC volume for MLflow exports
│   │   ├── hi_genie.secret_scope.yml     # Secret scope for credentials
│   │   ├── infra_warehouse.sql_warehouse.yml # SQL warehouse (2X-Small serverless)
│   │   ├── hi_genie_traces.experiment.yml    # MLflow experiment
│   │   └── uc_setup.job.yml              # UC Setup Job (extensions + grants + secrets)
│   └── src/
│       ├── lakebase_platform_setup       # Lakebase extensions self-healing
│       ├── configure_app_secrets         # SPN scope grants + embedding secrets
│       └── ensure_experiment_directories # MLflow experiment directory creation
│
├── mcp-hi-genie-orchestrator/    # App Declarative Automation Bundle
│   ├── databricks.yml            # App bundle (AppKit, Lakebase plugin, OTel, 3 targets)
│   ├── app.yaml                  # Runtime config (npm run start)
│   ├── package.json              # Dependencies (@databricks/appkit, drizzle-orm, zod, OTel)
│   ├── appkit.plugins.json       # Lakebase + Server plugin registry
│   ├── server/
│   │   ├── server.ts             # Entry point wiring all 6 modules
│   │   ├── migrations/           # 9 versioned Lakebase migrations
│   │   ├── telemetry/            # OTel NodeSDK + MLflow 3 tracer + sanitizer
│   │   ├── memory/               # Short-term, episodic, semantic + embeddings
│   │   ├── dispatch/             # Tick evaluator, priority tree, LISTEN/NOTIFY, review
│   │   ├── mcp/                  # 39-tool MCP server (Streamable HTTP)
│   │   ├── api/                  # Supervisor REST API v1 (plans, workstreams, reviews)
│   │   └── services/             # Shared service layer (plans, orchestration, reviews)
│   ├── client/                   # React SPA (scaffold from AppKit template)
│   ├── shared/                   # Shared types and TypeScript SDK
│   ├── config/                   # Runtime configuration
│   ├── tests/                    # Vitest (115+) and Playwright (13) tests
│   ├── resources/                # Bundle resource YAMLs (app, permissions)
│   ├── docs/design/              # Design documents and RFCs
│   ├── omnigent/                 # Omnigent agent design artifacts
│   ├── .review-protocol/         # Polly collaboration protocol
│   ├── hi_genie/                 # Polly → Genie channel
│   ├── hey_polly/                # Genie → Polly channel
│   ├── app_deploy.sh             # App deployment with infra var resolution
│   ├── bootstrap_credentials.sh  # First-deploy SPN credential bootstrap
│   └── deploy_source.sh          # Source-linked deployment via SDK
│
├── hi-genie-sdk/                 # Typed Python SDK
│   ├── pyproject.toml            # Hatchling package (httpx, pydantic>=2.0)
│   └── src/hi_genie/
│       ├── __init__.py           # Package init, re-exports
│       └── client.py             # Async client, Pydantic models, OBO auth, tick evaluator
│
├── skill/                        # Hi Genie operating skill (28 files)
│   ├── SKILL.md                  # Entry point — roles, surfaces, state machine, modules
│   ├── core/
│   │   └── state-machine.md      # 7-state lifecycle, transition rules
│   ├── roles/                    # Architect, supervisor, worker, reviewer
│   ├── surfaces/                 # MCP tools, API routes, Lakebase, legacy surface docs
│   ├── capabilities/             # Error handling, governance, detection/fallback
│   ├── backends/                 # Bundle, notebook, SQL, custom, pipeline, dashboard, genie-space
│   └── examples/                 # Bootstrap prompt templates
│
├── orchestration/                # R1 build state (COMPLETED)
│   ├── plan.json                 # 9-workstream DAG definition
│   └── state/                    # All 9 workstreams COMPLETE (15 ticks)
│
└── fixtures/sessions/            # 22 session summaries (2026-08-15 through 2026-08-23)
```

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│  Dispatcher (any harness)                                       │
│  Genie Code / Omnigent / Claude CLI / custom                    │
│  Uses: Python SDK or TypeScript SDK → REST /api/v1              │
└──────────────────────────────┬──────────────────────────────────┘
                               │ dispatch_workstream()
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Hi Genie Orchestrator App (Databricks App)                     │
│  /api/v1 — Supervisor REST API (plans, orchestrate, dispatch)   │
│  /mcp    — Workstream MCP (39 tools, 4 persona scopes)          │
│  /api/docs — Swagger UI (OpenAPI 3.1)                           │
└──────────────────────────────┬──────────────────────────────────┘
                               │ UC MCP Service (AI Gateway)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Workers (any workspace on the metastore)                       │
│  Genie Code / Supervisor Agents / external harnesses            │
│  Uses: UC MCP Service → AI Gateway → App /mcp                  │
│  Governed: per-persona tool selectors, audit, rate limits       │
└─────────────────────────────────────────────────────────────────┘
```

## Consumer Access Paths

| Consumer | Surface | Auth |
| --- | --- | --- |
| Workers (any workspace) | `/mcp` via UC MCP Service | `EXECUTE` grant (Gateway credentials) |
| Reviewers (any workspace) | `/mcp` via UC MCP Service | `EXECUTE` grant |
| Dispatcher (trusted SPN) | `/api/v1` via SDK | M2M OAuth2 (client_credentials) |
| React UI | `/api/v1` via TypeScript SDK | Browser session (auth sidecar) |
| External harnesses | `/api/v1` via SDK | M2M OAuth2 |

## Deployment

Two bundles deployed in sequence via `deploy.sh`:

1. **hi-genie-infra** — UC schema, Lakebase project, volumes, secrets, SQL warehouse
2. **UC Setup Job** — Lakebase extensions, App SPN grants, embedding endpoint secret
3. **mcp-hi-genie-orchestrator** — AppKit app with container build and deployment

```bash
./deploy.sh --target dev --auto-approve
```

Options: `--skip-infra`, `--skip-app`, `--skip-uc-setup` for partial deploys.

## Key Resources (dev)

| Resource | Value |
| --- | --- |
| App URL | `https://mcp-hi-genie-orchestrator-dev-7474657291520070.aws.databricksapps.com` |
| Lakebase project | `hi-genie-orchestrator` |
| Catalog / Schema | `hls_fde_dev` / `dev_matthew_giglia_hi_genie` |
| Secret scope | `hi_genie_credentials` |
| Post-deploy job | `468754756167374` |
| MCP Services | 5 in `hls_fde_dev.dev_matthew_giglia_hi_genie` (architect:14, reviewer:14, worker:17, dispatcher:16, orchestrator:39) |

## Documents

- `architecture/` — requirements, decisions (46), Omnigent contracts, readiness review
- `OPEN_QUESTIONS.md` — unresolved implementation decisions
- `PROJECT_MEMORY.md` — comprehensive design context and current status
- `skill/SKILL.md` — operating skill entry point (roles, surfaces, state machine)
- `mcp-hi-genie-orchestrator/PROJECT_MEMORY.md` — detailed app bundle state, known issues, conventions
- `mcp-hi-genie-orchestrator/docs/design/` — design documents and RFCs
- `fixtures/sessions/` — 22 session summaries

## Release Scope

**Release 1 (current):** Planning records, MCP retrieval/writes, immutable
publication, Supervisor-controlled dispatch, review/remediation, UC MCP Service
governance, skill versioning, RLS write-integrity, OTel + MLflow traces.

**Release 1.1:** React DAG UI, cross-project memory, migration hardening,
full Omnigent Agent (durable handoffs, planning-research provenance).
