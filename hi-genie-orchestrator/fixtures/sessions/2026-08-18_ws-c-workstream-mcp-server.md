# Session Summary: ws-c Workstream MCP Server

**Date:** 2026-08-18  
**Workstream:** ws-c  
**Status:** COMPLETE  
**Duration:** ~10 min  

## Objective

Implement the `/mcp` endpoint in `mcp-hi-genie-orchestrator/server/mcp/` — MCP
transport (Streamable HTTP), tool registration and dispatch, and the Release 1
tool catalog (22 tools across 4 groups).

## Problems Solved

1. **No MCP surface existed** — ws-a created a placeholder `index.ts` with a
   no-op `setupMcpRoutes`. This session replaced it with the full Streamable
   HTTP transport and all Release 1 tools.
2. **Transport protocol selection** — Chose Streamable HTTP (2025-03-26 protocol)
   over legacy SSE-only for simpler client integration and batch request support.
3. **Drizzle ORM vs raw SQL tradeoff** — Drizzle's `onConflictDoNothing` doesn't
   report whether an insert occurred. Used raw parameterized SQL for idempotent
   inserts (ON CONFLICT pattern), Drizzle for all read queries.

## Key Decisions

- **In-memory session store** (30 min TTL, 1000 max) — sufficient for single-
  instance Release 1. External store deferred to Release 1.1.
- **Application-level RLS** — all queries filter by `project_id`. DB-level RLS
  policies are Release 1.1 (per ws-b notes).
- **Optimistic concurrency** for mutable state — `WHERE version = $expected` on
  all updates to sessions, workstreams, recovery_state.
- **Status transition validation** — server-side transition map prevents invalid
  workstream state changes. Workers cannot self-complete (no COMPLETE transition
  exposed).
- **Bounded responses** — MAX_LIMIT=100, DEFAULT_LIMIT=20 on all queries.

## Files Created / Modified

### Created (all in `mcp-hi-genie-orchestrator/server/mcp/`)

| File | Size | Purpose |
| --- | --- | --- |
| `transport.ts` | 11.9 KB | Streamable HTTP transport: JSON-RPC 2.0 POST, SSE GET, DELETE session |
| `tools/context.ts` | 16 KB | 6 context retrieval tools (project, workstream, decisions, summaries, errors, session) |
| `tools/records.ts` | 19.8 KB | 6 append-first record tools with idempotency keys |
| `tools/state.ts` | 14.4 KB | 5 mutable state tools with optimistic concurrency |
| `tools/search.ts` | 15 KB | 5 search/operational tools (context search, task history, execution summary, health, schema version) |

### Modified

| File | Change |
| --- | --- |
| `server/mcp/index.ts` | Replaced placeholder with full barrel export: builds tool registry, creates transport, mounts at `/mcp` |
| `server/server.ts` | Uncommented `import { setupMcpRoutes }` and `await setupMcpRoutes(appkit)` in `onPluginsReady` |
| `orchestration/state/workstream-ws-c-status.md` | NOT_STARTED → IN_PROGRESS → COMPLETE with downstream notes |

## Tool Catalog (22 tools)

**Context Retrieval (6):** `get_project_context`, `get_workstream_context`,
`search_decisions`, `get_recent_session_summaries`, `get_relevant_errors`,
`get_session_context`

**Append-First Records (6):** `record_decision`, `record_session_summary`,
`record_error`, `record_workstream_event`, `record_task_attempt`,
`record_task_completion`

**Mutable State (5):** `update_workstream_status`, `update_task_status`,
`update_recovery_state`, `start_session`, `end_session`

**Search & Operational (5):** `search_context`, `get_task_history`,
`get_execution_summary`, `get_health`, `get_schema_version`

## Architecture Notes

- Transport: MCP Streamable HTTP (POST `/mcp` for JSON-RPC, GET for SSE, DELETE
  for session termination). Session ID via `Mcp-Session-Id` header.
- User identity extracted from OBO headers (`x-forwarded-email`,
  `x-databricks-user`) set by Databricks Apps auth sidecar.
- Pool access: `appkit.lakebase.pool` (same `pg.Pool` instance used by ws-b
  migrations).
- Tool registration: static definitions array + handler Map, assembled in
  `buildToolRegistry()` and passed to transport factory.

## Downstream Impact

- **ws-e (Dispatch):** Can import handler maps directly for internal context
  lookups without HTTP roundtrip.
- **ws-f (Memory):** Extends tool registry by adding imports to
  `buildToolRegistry()` in `index.ts`.
- **External SDK clients:** Connect via Streamable HTTP at app URL `/mcp`.
