# Session: MCP Protocol Version Fix & AI Playground Integration

**Date:** 2026-08-20 (evening)  
**Branch:** `mg-genie-mcp-protocol-version`  
**Status:** Complete — ready for PR to `main`

---

## Problem

Databricks AI Playground rejected our MCP server with:
```
Error listing tools from custom MCP server mcp-hi-genie-orchestrator-dev:
INVALID_PARAMETER_VALUE: Unsupported MCP protocol version: 2025-03-26.
Expected: 2025-11-25
```

The server was responding with protocol version `2025-03-26` in its `initialize` response, but the platform requires `2025-11-25`.

---

## Root Cause

`server/mcp/transport.ts` line 76 had a hardcoded constant:
```typescript
const PROTOCOL_VERSION = '2025-03-26';
```

---

## Changes Made

### Commit 1: `fix: bump MCP protocol version to 2025-11-25`
- **File:** `server/mcp/transport.ts`
- **Change:** `PROTOCOL_VERSION = '2025-03-26'` → `'2025-11-25'`
- **Research:** Confirmed `tools/list` response shape is backward-compatible; new optional fields (`icons`, `title`, `outputSchema`, `annotations`) are additive

### Commit 2: `docs: add MCP protocol versioning strategy design doc`
- **File:** `docs/design/2026-08-20_mcp-protocol-versioning-strategy.md`
- **Content:** A/B deployable MCP spec variants (2025-11-25 vs 2026-07-28) via bundle variable; dual app naming; Lakebase branch isolation; transport-v26 skeleton
- **Key finding:** MCP 2026-07-28 (released July 28, 2026) introduces a fully stateless protocol — no `initialize`, no `Mcp-Session-Id`, `_meta` on every request, `server/discover` RPC. Also introduces the MCP Apps extension (iframe + postMessage for interactive tool UIs)

### Commit 3: `feat(mcp): add list_projects tool for UUID discoverability`
- **File:** `server/mcp/tools/context.ts`
- **Changes:**
  - Added `plans` Drizzle table definition for `dispatch.plans`
  - Added `list_projects` tool definition + handler
  - Queries distinct projects from `dispatch.plans` with plan names + workstream counts
  - Enables LLMs to discover valid project UUIDs instead of guessing
- **Tool count:** 22 → 23

---

## Validation Results (AI Playground)

| Test | Tool | Result |
| --- | --- | --- |
| Tool discovery | `tools/list` | ✅ 23 tools visible in Playground |
| Read (discoverability) | `list_projects` | ✅ Returned 4 projects with UUIDs, names, workstream counts |
| Read (aggregate) | `get_project_context` | ✅ 1 orchestration (RUNNING), 2 workstreams, 0 active sessions |
| Read (detail) | `get_execution_summary` | ✅ Status counts returned |
| Write | `record_decision` | ✅ Decision persisted (id: `de0c583f-62b4-4f57-8382-9afa1b0d4bb2`) |
| Multi-tool chaining | 2 tools in 1 turn | ✅ Model called `get_execution_summary` before `record_decision` |
| JSONB writes | alternatives, implications, tags | ✅ Structured data stored correctly |
| Idempotency | Key generation | ✅ Model-generated: `decision-mcp-protocol-version-strategy-20260820` |

---

## Key Findings

### Databricks MCP App Requirements
- App name MUST start with `mcp-` for AI Playground auto-discovery
- Must implement Streamable HTTP transport at `/mcp`
- Protocol version must match platform expectation (currently `2025-11-25`)
- No registration step needed — naming convention is the discovery mechanism

### MCP 2026-07-28 (Future)
- Stateless protocol core — `initialize`/`initialized` handshake REMOVED
- `Mcp-Session-Id` REMOVED — each request carries `_meta` with client info
- New headers: `Mcp-Method`, `Mcp-Name` for gateway routing
- `server/discover` RPC replaces capability negotiation
- Extensions framework: MCP Apps (interactive UI), Tasks
- TypeScript SDK v2 supports both versions via `createMcpHandler(factory)`

### Identity Gap (Confirmed)
- MCP `/mcp` endpoint defaults user to `'unknown'` (not fail-closed)
- Writes work with `'unknown'` identity since RLS only covers INSERT checks
- The `created_by` field captured `77145947608610@7474657291520070` (SPN compound ID)
- Real user identity passes through when AI Playground uses OBO auth

---

## Decisions Recorded

1. **Protocol version:** Bump to `2025-11-25` immediately; defer `2026-07-28` to R1.1/R2
2. **Versioning strategy:** Documented A/B deployment via bundle variables for future migration
3. **Discoverability:** Added `list_projects` tool rather than requiring clients to know UUIDs
4. **No schema change needed:** Both protocol versions share the same Lakebase tables (sessions are in-memory, not persisted)

---

## Files Modified

| File | Change |
| --- | --- |
| `server/mcp/transport.ts` | Protocol version constant: `2025-03-26` → `2025-11-25` |
| `server/mcp/tools/context.ts` | Added `plans` Drizzle def, `list_projects` tool definition + handler + registry entry |
| `docs/design/2026-08-20_mcp-protocol-versioning-strategy.md` | NEW — full design doc |
| `docs/design/INDEX.md` | Added entry for new design doc |

---

## Next Steps

1. Open PR: `mg-genie-mcp-protocol-version` → `main` (3 commits)
2. Monitor when Databricks adopts `2026-07-28` (watch for platform error messages changing)
3. Consider adding fail-closed identity to `/mcp` endpoint (R1.1 scope)
4. Consider `transport-v26.ts` implementation when platform requires it
5. Explore MCP Apps extension for interactive orchestration UIs (R2)
