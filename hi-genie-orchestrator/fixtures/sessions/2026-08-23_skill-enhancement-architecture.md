# Session: Skill Enhancement Architecture

**Date:** 2026-08-23  
**Branch:** `mg-genie-sdk-reconciliation-and-prod-alignment`  
**Scope:** Skill folder rewrite with UC MCP Service governance and transport-agnostic design

## Problems Solved

1. **Skill folder was skeletal** — Only had role boundaries and basic rules; no tool catalog,
   no worker bootstrapping sequence, no error recovery, no cross-workspace story.
2. **No transport-agnostic design** — Previous drafts hardcoded MCP URLs and auth flows in
   bootstrap prompts, coupling workers to a specific deployment.
3. **No governance model** — Workers had unrestricted MCP access with no role-level enforcement.
4. **Missing lifecycle documentation** — No clear mapping from workstream state to tool calls.

## Architectural Decisions

### 1. UC MCP Service as the Worker Access Layer

- The MCP server stays deployed as a Databricks App in one workspace
- It gets registered as a Unity Catalog MCP Service via AI Gateway
- Workers in any workspace on the metastore connect via `EXECUTE` grant
- AI Gateway manages credentials, routing, audit logging, and rate limiting
- Workers never handle raw app URLs or OAuth tokens

### 2. Dispatcher Uses REST, Workers Use MCP

| Consumer | Surface | Reason |
| --- | --- | --- |
| Dispatcher | REST `/api/v1` via Python/TS SDK | Trusted SPN, high-frequency ticks, elevated permissions |
| Workers | MCP via UC MCP Service | Governed, auditable, cross-workspace, tool-restricted |
| Reviewers | MCP via UC MCP Service | Same governance as workers, read-heavy access |
| External harnesses | REST `/api/v1` via SDK | Network-reachable, M2M OAuth2 |

### 3. `get_skill_content` — Composable, Multi-Call, Both Surfaces

- Available as MCP tool (for workers) AND REST endpoint (for dispatchers)
- Composable: call multiple times to load different sections on demand
- Versioned per-project and per-orchestration (pinned at creation)
- Returns `available_sections` for discovery without a separate catalog call

### 4. AI Gateway Service Policies Enforce Role Boundaries

- Worker policy: allows context + records + state + search + skill
- Reviewer policy: read-heavy, limited writes (only `record_workstream_event`)
- Blocks forbidden tool calls at infrastructure level (even if LLM hallucinates)

### 5. Bootstrap Prompt Framing: "We are working on..."

- Collaborative language (not directive "You are...")
- Transport-agnostic (references UC MCP Service name, not URLs)
- Minimal (everything else loaded via `get_skill_content`)

### 6. Implicit Heartbeat via MCP Tool Calls

- Every MCP tool call updates `heartbeat_at` on the execution record
- Dispatcher detects stuck workers when heartbeat exceeds threshold (45 min default)
- Workers keep heartbeat alive by calling `record_workstream_event` during long ops

### 7. Skill Versioning (R2 Design, Documented in R1)

- Authoring source stays in git (`skill/` folder)
- `publish_skill_version` publishes to Lakebase at deploy time
- Orchestrations pin to a skill version at creation
- No `create_skill_content` or `update_skill_content` — single publish path from git

## Files Changed (8)

| File | Action | Lines |
| --- | --- | --- |
| `skill/SKILL.md` | Rewritten | ~237 → full architecture, Quick Start, state machine, module index |
| `skill/surfaces/mcp-tools.md` | Created | 24-tool catalog, role access matrix, lifecycle-to-tool mapping |
| `skill/surfaces/api-routes.md` | Created | Supervisor API routes, SDK methods, execution tracking |
| `skill/roles/supervisor.md` | Extended | SDK setup, tick loop, worker spawning, execution tracking |
| `skill/roles/worker.md` | Extended | Session startup, validation checklist, evidence manifest, error handling |
| `skill/examples/bootstrap-templates.md` | Created | Worker/dispatcher/reviewer templates, transport variants |
| `skill/capabilities/error-handling.md` | Created | Status recovery, timeout, retry semantics, escalation |
| `skill/capabilities/governance.md` | Created | UC MCP Service registration, policies, audit, DR |

## Key Discussions (Not Yet Implemented)

1. **`get_skill_content` server-side implementation** — The MCP tool and REST endpoint
   need to be added to the app's server code. Currently documented but not built.

2. **Lakebase `skill_versions` table** — Schema designed but not created. Stores
   published skill content per version with project overrides.

3. **AI Gateway service registration** — Steps documented in `governance.md` but not
   executed. Requires `CREATE CONNECTION` and `CREATE SERVICE` privileges.

4. **Dispatcher harness flexibility** — Confirmed architecture supports Genie Code
   scheduled tasks, Omnigent, Claude CLI, and any REST-speaking process.
   All use the same Python/TypeScript SDK. Workers don't care which harness dispatched them.

## Open Questions Resolved This Session

| Question | Resolution |
| --- | --- |
| Should bootstrap say "You are..."? | No — use "We are working on... with the role of..." |
| Tool name for skill loading? | `get_skill_content` (soft, descriptive) |
| Can workers call it multiple times? | Yes — composable sections, loaded on demand |
| Do we need `create_skill_content`? | No for R1 — single publish path from git source |
| Cross-workspace access? | UC MCP Service via AI Gateway (same metastore) |
| Does this work for external dispatchers? | Yes — REST SDK with M2M OAuth2, no MCP needed |
| Does Omnigent work as dispatcher? | Yes — any process that speaks REST to `/api/v1` |
