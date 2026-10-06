# Session: Persona-Based MCP Routing

**Date:** 2026-08-24  
**Branch:** `mg-genie-r2-mcp-consolidation`  
**Focus:** UC MCP Service 20-tool platform limit → per-persona endpoints  

---

## Problem

UC MCP Service enforces a hard limit of **20 enabled tools across ALL MCP servers per user**. Our single `/mcp` endpoint exposes 39 tools. Users hit "Could not enable tool: You have reached the maximum of 20" when trying to enable more than 20. Neither agents nor humans can access the full tool set simultaneously.

## Architecture Decision

Split into two persona-specific endpoints, each ≤20 tools, served by the same app server on different paths:

| Path | Persona | Tools | Count |
| --- | --- | --- | --- |
| `/mcp/worker` | Worker agents | context, records, state, search, skill | 20 |
| `/mcp/supervisor` | Human/supervisor | projects, plans, orchestration, reviews, health | 20 |
| `/mcp` | Legacy | All tools | 39 |

Decision record IDs:
- Initial split decision: `9f5be277-90d0-4d2a-a4d2-5934945a50ba`
- Revised grouping (remove get_health + list_projects from worker, add search_decisions + get_session_context): `afb48941-3ff2-45a6-bed2-4d061ef7bf10`

## Worker Tools (20)

| Category | Tools |
| --- | --- |
| Context (3) | `get_project_context`, `get_workstream_context`, `get_session_context` |
| Records (6) | `record_decision`, `record_session_summary`, `record_error`, `record_workstream_event`, `record_task_attempt`, `record_task_completion` |
| State (5) | `update_workstream_status`, `update_task_status`, `update_recovery_state`, `start_session`, `end_session` |
| Search (5) | `search_context`, `get_task_history`, `get_relevant_errors`, `get_recent_session_summaries`, `search_decisions` |
| Skill (1) | `get_skill_content` |

**Rationale for omissions:**
- `list_projects`: dispatcher provides `project_id` at assignment — workers never discover projects
- `get_health`: if tool calls work, server is healthy

## Supervisor Tools (20)

| Category | Tools |
| --- | --- |
| Context (4) | `list_projects`, `get_project_context`, `get_workstream_context`, `get_execution_summary` |
| Plans (3) | `create_plan`, `get_plan`, `publish_plan` |
| Orchestration (7) | `orchestrate_plan`, `materialize_workstreams`, `list_workstreams`, `dispatch_workstream`, `retry_workstream`, `pause_workstream`, `unpause_workstream` |
| Reviews (4) | `create_review`, `get_review`, `deliver_remediation`, `approve_review` |
| Utility (2) | `get_skill_content`, `get_health` |

## Unassigned (REST Proxy Only)

`get_schema_version`, `update_skill` — niche admin ops, not needed at runtime via AI Gateway.

## Implementation

### `server/mcp/transport.ts`

- `Persona` type exported: `'worker' | 'supervisor'`
- `WORKER_TOOLS`: `Set<string>` of 20 worker tool names
- `SUPERVISOR_TOOLS`: `Set<string>` of 20 supervisor tool names
- `PERSONA_TOOLS`: `Record<Persona, Set<string>>` for keyed lookup
- `McpTransportOptions.persona?: Persona` added
- `createMcpTransport`: derives `allowedTools = persona ? PERSONA_TOOLS[persona] : null`
- `handleToolsList`: filters `toolRegistry.definitions` by `allowedTools` when set
- `handleToolsCall`: enforces allowedTools BEFORE handler lookup (returns `METHOD_NOT_FOUND` — no tool name leak)

### `server/mcp/index.ts`

- Three `createMcpTransport` calls: worker, supervisor, legacy
- Express mount order: `/mcp/worker` and `/mcp/supervisor` BEFORE `/mcp` (prefix match safety)
- Startup log shows all three paths and tool counts

## Commit

`feat: persona-based MCP routing (/mcp/worker, /mcp/supervisor)`

## Next Steps for Next Session

1. **Deploy and validate** — test `/mcp/worker` tools/list returns exactly 20, `/mcp/supervisor` returns exactly 20, `/mcp` returns 39
2. **Register new MCP Services** in post-deploy job — add `hi_genie_worker_dev` and `hi_genie_supervisor_dev` services pointing to new paths
3. **Add UC Connections** for new paths — `hi_genie_worker_mcp_conn_dev` (base_path `/mcp/worker`), `hi_genie_supervisor_mcp_conn_dev` (base_path `/mcp/supervisor`)
4. **Update persona_tool_policy.sql** (Phase 3) — now simpler since tool visibility is pre-filtered by path
5. **Update mcp-catalog.test.ts** — add assertions for worker/supervisor counts (20 each)
