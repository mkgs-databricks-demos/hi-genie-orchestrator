---
name: hi-genie-orchestrator
triggers:
  - use hi genie orchestration
  - plan and orchestrate with hi genie
  - use the hi genie app
  - create a hi genie workstream plan
  - supervise hi genie workstreams
  - review a hi genie workstream
  - dispatch workstreams with hi genie
  - set up hi genie for this project
---

# Hi Genie Orchestrator Skill

Durable planning, supervised workstream execution, review-gated completion, and
Lakebase-backed context — delivered through a Databricks App with MCP and REST
surfaces, governed by Unity AI Gateway for cross-workspace access.

## When to Use

- Project has 3+ distinct deliverables that can be built independently
- Deliverables have clear dependency order and produce distinct artifacts
- Total work exceeds a single session (~60 min limit)
- Need durable state, retry intelligence, and audit trail
- Multiple workspaces or agent harnesses may participate
- Review-gated quality is required (no self-approval)

## When NOT to Use

- Single deliverable that takes <60 min (just do it)
- Exploratory work where requirements aren't yet clear
- Work requiring continuous human feedback at each step
- No need for durable state or cross-session coordination
- Project scope is unclear and requirements need more conversation before planning

## Prerequisites

- Hi Genie Orchestrator App deployed and running
- UC MCP Service registered (e.g., `hls_fde.hi_genie_prod.orchestrator_mcp`)
- `EXECUTE` grant on the MCP Service for participating users/SPNs
- For dispatchers: M2M OAuth2 credentials (SPN client_id/client_secret in secret scope)
- One or more input documents describing what to build
- Clear understanding of what "done" looks like for each deliverable

## Quick Start (6 Steps)

1. **Load skill content** — Call `get_skill_content(project_id, role, section="core")`
   via the UC MCP Service (workers/reviewers) or REST SDK (dispatchers).
   The returned content is versioned per-project and per-orchestration.

2. **Plan** — Capture requirements, decisions, features, and workstream specs
   as structured planning records in Lakebase. Validate dependencies and sizing.

3. **Publish** — Create an immutable plan snapshot. This locks the scope for
   orchestration. Mutable drafts never drive dispatch.

4. **Orchestrate + Materialize** — Dispatcher calls `orchestrate(plan_id)` then
   `materialize(orchestration_id, ...)` to create workstream records from the snapshot.

5. **Dispatch** — Dispatcher runs `ws_init_tick()` evaluation. For each ready
   workstream, creates a Genie Code scheduled task with a bootstrap prompt.
   Workers load their skill content from MCP and execute autonomously.

6. **Review + Complete** — Workers submit `READY_FOR_REVIEW`. Dispatcher creates
   review tasks. Reviewer evaluates evidence. On PASS, Supervisor marks `COMPLETE`.

## Core Model

```text
Planning Records (Lakebase)
  → Immutable Plan Snapshot (publish)
  → Orchestration + Materialized Workstreams
  → Dispatcher tick evaluation (WS-INIT)
  → Worker execution via MCP tools
  → Validation → READY_FOR_REVIEW
  → Independent review + remediation
  → Supervisor-authorized COMPLETE
```

Lakebase is the collaborative working source for active planning and runtime state.
Git remains the canonical reviewed record for architecture, project memory, and
session summaries. Published plan snapshots are immutable runtime inputs.

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│  Dispatcher (any harness)                                       │
│  Genie Code scheduled task / Omnigent / Claude CLI / custom     │
│  Uses: Python SDK or TypeScript SDK → REST /api/v1              │
└──────────────────────────────┬──────────────────────────────────┘
                               │ dispatch_workstream()
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Hi Genie Orchestrator App (Databricks App)                     │
│  /api/v1 — Supervisor REST API (plans, orchestrate, dispatch)   │
│  /mcp    — Workstream MCP (context, records, state, search)     │
└──────────────────────────────┬──────────────────────────────────┘
                               │ UC MCP Service (AI Gateway)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Workers (any workspace on the metastore)                       │
│  Genie Code sessions / Supervisor Agents / external harnesses   │
│  Uses: UC MCP Service → AI Gateway → App /mcp                  │
│  Governed: tool-level policies, audit logging, rate limits      │
└─────────────────────────────────────────────────────────────────┘
```

## Consumer Access Paths

| Consumer | Surface | Transport | Auth |
| --- | --- | --- | --- |
| Workers (any workspace) | `/mcp` | UC MCP Service → AI Gateway | `EXECUTE` grant (Gateway-managed credentials) |
| Reviewers (any workspace) | `/mcp` | UC MCP Service → AI Gateway | `EXECUTE` grant |
| Dispatcher (trusted SPN) | `/api/v1` | Direct REST via SDK | M2M OAuth2 (client_credentials) |
| React UI | `/api/v1` | Direct REST via TypeScript SDK | Browser session (auth sidecar) |
| External harnesses | `/api/v1` | Direct REST via SDK | M2M OAuth2 |

## Role Selection

Select the role before loading skill content:

- **Supervisor / Dispatcher** — Owns plan validation, publication, materialization,
  scheduling, retries, review routing, and completion authority.
  See `roles/supervisor.md`.
- **Worker** — Executes one assigned workstream via MCP tools, validates outputs,
  and submits `READY_FOR_REVIEW`. See `roles/worker.md`.
- **Independent Reviewer** — Evaluates evidence and acceptance criteria, records
  findings, requests remediation. See `roles/reviewer.md`.

## State Machine

```text
NOT_STARTED ──► IN_PROGRESS ──► VALIDATING ──► READY_FOR_REVIEW ──► COMPLETE
                            ──► BLOCKED (human intervention required)
                            ──► RETRYING (auto-retry with prior-attempt context)
```

Transitions are one-way except:
- Human resets BLOCKED → NOT_STARTED (manual recovery)
- System sets RETRYING → IN_PROGRESS (automatic with error context)
- Only Supervisor marks READY_FOR_REVIEW → COMPLETE (after review PASS)

## Skill Content Delivery

Skill content is versioned in Lakebase and served at runtime via MCP tool
or REST endpoint. This enables:

- **Version pinning** — Orchestrations lock to a skill version at creation
- **Project-specific customization** — Override sections per project
- **Harness-agnostic loading** — Any consumer calls `get_skill_content`
- **Auditability** — Every execution records which skill version was used

### Loading pattern (composable, multi-call)

```text
get_skill_content(project_id, role="worker", section="core")
get_skill_content(project_id, role="worker", section="mcp-tools")
get_skill_content(project_id, role="worker", section="backends/notebook")
```

Sections are loaded on demand. The `available_sections` field in the response
discovers what else can be loaded without a separate catalog call.

## Key Concepts

- **Plan Snapshot** — Immutable, content-hashed record of scope. Drives dispatch.
- **Orchestration** — A running instance created from a plan snapshot.
- **Workstream** — A self-contained unit of work (15–60 min) executed by a worker.
- **Execution** — A single attempt at completing a workstream (tracks attempts).
- **UC MCP Service** — Unity Catalog securable providing governed cross-workspace
  access to the MCP endpoint via AI Gateway.
- **Bootstrap prompt** — Minimal instructions given to a worker at spawn time.
  References `get_skill_content` for full operational context.
- **Implicit heartbeat** — Each MCP tool call proves the worker is alive.
  Dispatcher detects stuck workers by checking last-tool-call timestamp.
- **Service policies** — AI Gateway rules restricting which MCP tools each role
  can invoke. Enforces role boundaries at infrastructure level.

## Skill Modules

### Roles (4 files)

| Module | Purpose |
| --- | --- |
| `roles/architect.md` | Decomposition, DAG construction, plan publication via Plans API |
| `roles/supervisor.md` | Dispatcher responsibilities, SDK setup, tick loop, worker creation, execution tracking |
| `roles/worker.md` | Worker lifecycle, MCP tool sequences, validation checklist, error handling |
| `roles/reviewer.md` | Review protocol, finding categories, remediation flow |

### Surfaces (5 files)

| Module | Purpose |
| --- | --- |
| `surfaces/mcp-tools.md` | Full 25-tool catalog, categorized by lifecycle phase, role access matrix |
| `surfaces/api-routes.md` | Supervisor API route table, SDK method mapping, request/response shapes |
| `surfaces/lakebase.md` | Lakebase schema boundaries (state vs dispatch), access by role |
| `surfaces/api.md` | REST API surface overview — planning, dispatch, skill endpoints |
| `surfaces/mcp.md` | MCP surface — what workers/reviewers can do, what it does not own |

### Capabilities (3 files)

| Module | Purpose |
| --- | --- |
| `capabilities/error-handling.md` | Status recovery table, timeout detection, retry semantics |
| `capabilities/governance.md` | UC MCP Service setup, AI Gateway policies, EXECUTE grants, audit |
| `capabilities/detection-fallback.md` | App connectivity detection, availability troubleshooting, no-fallback guarantee |

### Examples (1 file)

| Module | Purpose |
| --- | --- |
| `examples/bootstrap-templates.md` | Dispatcher and worker prompt templates, transport-agnostic |

## Execution Rules

- Workers load context via `get_skill_content`, then use MCP tools for state.
- Supervisor operations use versioned `/api/v1` routes via typed SDKs.
- Dispatcher state (orchestrations, executions) is separate from MCP `state` schema.
- Successful worker validation ends in `READY_FOR_REVIEW`, never `COMPLETE`.
- Review findings are stored in Lakebase; workers retrieve via MCP reference.
- Unrelated workstreams continue when their dependencies are satisfied.
- Workers never schedule themselves, publish plans, or mark their own work complete.

## Connectivity

Before starting any work, confirm app availability via `get_skill_content` (MCP)
or `GET /api/v1/health` (API). See `capabilities/detection-fallback.md` for
troubleshooting when the app is unreachable.


## Release Scope (R1)

Planning records, structured MCP retrieval and writes, immutable publication,
Supervisor-controlled dispatch, review/remediation, UC MCP Service governance,
and skill versioning. Rich planning UI, per-project config
customization, cross-project memory, and Omnigent integration are R2+ unless
separately approved.
