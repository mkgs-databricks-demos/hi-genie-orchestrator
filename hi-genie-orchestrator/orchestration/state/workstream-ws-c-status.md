---
workstream_key: ws-c
name: Workstream MCP Server
status: COMPLETE
depends_on: [ws-b]
scheduled_task_id: e45859624402443799189c7384747826
task_paused: false
attempt_count: 1
max_retries: 5
started_at: "2026-08-17T23:45:00Z"
completed_at: "2026-08-17T23:55:00Z"
error_message: null
prior_error: null
last_attempt_at: "2026-08-17T23:45:00Z"
---

# Workstream ws-c: Workstream MCP Server

## Scope

Implement `/mcp` endpoint in `server/mcp/`:
- MCP transport (HTTP SSE or Streamable HTTP)
- Tool registration and dispatch
- Context retrieval tools (project, workstream, session, decisions, errors, summaries)
- Append-first record tools (decision, summary, error, event, task attempt/completion)
- Mutable state tools (workstream status, task status, recovery state, session lifecycle)
- Search and operational tools (context search, task history, execution summary, health, schema version)
- User-authorized via OBO, RLS-enforced, bounded responses

## Notes for Downstream Sessions

### Files Created

All paths relative to `mcp-hi-genie-orchestrator/server/mcp/`:

- `index.ts` — Barrel export. Exposes `setupMcpRoutes(appkit)` for `server.ts` `onPluginsReady`. Imports all tool groups, builds the unified `McpToolRegistry`, creates the Streamable HTTP transport, and mounts it at `/mcp` via `appkit.server.extend()`. Re-exports transport types.
- `transport.ts` — MCP Streamable HTTP transport layer. Handles JSON-RPC 2.0 over POST, SSE via GET, session termination via DELETE. In-memory session store with 30-min TTL, 1000 max sessions, 15s keepalive. Protocol version `2025-03-26`.
- `tools/context.ts` — 6 context retrieval tools: `get_project_context`, `get_workstream_context`, `search_decisions`, `get_recent_session_summaries`, `get_relevant_errors`, `get_session_context`. All read-only, bounded (max 100 results), Drizzle ORM queries against `state` and `dispatch` schemas.
- `tools/records.ts` — 6 append-first record tools: `record_decision`, `record_session_summary`, `record_error`, `record_workstream_event`, `record_task_attempt`, `record_task_completion`. All use `ON CONFLICT (project_id, idempotency_key) DO NOTHING` for retry-safe writes. Raw SQL for idempotent inserts (Drizzle doesn't expose ON CONFLICT elegantly).
- `tools/state.ts` — 5 mutable state tools: `update_workstream_status`, `update_task_status`, `update_recovery_state`, `start_session`, `end_session`. All use optimistic concurrency via `WHERE version = $expected`. Status transitions validated against allowed transition map. Audit events recorded on each mutation.
- `tools/search.ts` — 5 search/operational tools: `search_context`, `get_task_history`, `get_execution_summary`, `get_health`, `get_schema_version`. Health checks pool stats and DB connectivity. Schema version reads from `state._migration_history`.

Also updated:
- `server/server.ts` — Uncommented `import { setupMcpRoutes } from './mcp/index.js'` and `await setupMcpRoutes(appkit)` in `onPluginsReady`.

### Transport Protocol: Streamable HTTP

- **POST /mcp** — JSON-RPC 2.0 requests (single or batch). Returns JSON responses. Creates session on first request.
- **GET /mcp** — SSE endpoint for server-initiated notifications. Requires `Mcp-Session-Id` header.
- **DELETE /mcp** — Session termination. Requires `Mcp-Session-Id` header.
- Session ID passed via `Mcp-Session-Id` response/request header.
- Supported methods: `initialize`, `initialized`, `tools/list`, `tools/call`, `ping`.

### How Downstream Interacts

**ws-e (Dispatch):** The dispatch engine can invoke MCP tools programmatically by importing the handler maps directly (e.g., `contextToolHandlers.get('get_workstream_context')`) for internal context lookups without going through HTTP. The MCP session context provides `userId` for RLS enforcement.

**ws-f (Memory):** Memory service can register additional tools by extending the registry in `index.ts` — add imports and spread into `buildToolRegistry()`. The transport auto-discovers all registered tool definitions.

**SDK/External Clients:** Connect via Streamable HTTP at the app URL `/mcp`. Standard MCP client libraries (e.g., `@modelcontextprotocol/sdk`) work with this transport.

### Key Design Decisions

1. **Streamable HTTP over legacy SSE-only** — Modern MCP transport (2025-03-26 protocol). Simpler client integration, supports batch requests.
2. **Raw SQL for idempotent inserts** — Drizzle ORM's `onConflictDoNothing` doesn't return whether the insert occurred; raw parameterized SQL with `RETURNING id` gives the information needed.
3. **In-memory session store** — Sufficient for single-instance Release 1. Release 1.1 can externalize to Lakebase for multi-instance.
4. **User extraction from OBO headers** — Uses `x-forwarded-email` / `x-databricks-user` headers set by the Databricks Apps auth sidecar.
5. **Workstream status transitions validated** — Server-side transition map prevents invalid state changes. Workers cannot self-complete (no transition to COMPLETE from worker tools).
6. **All responses bounded** — MAX_LIMIT = 100, DEFAULT_LIMIT = 20. No unbounded queries.

### Deviations from Contract

- No RLS policies applied at database level in Release 1 (per ws-b notes). RLS enforcement is application-level via `project_id` filtering on all queries.
- Drizzle ORM used for read queries; raw parameterized SQL used for idempotent inserts (ON CONFLICT pattern).
- `get_health` and `get_schema_version` do not require `project_id` — they are operational tools.
