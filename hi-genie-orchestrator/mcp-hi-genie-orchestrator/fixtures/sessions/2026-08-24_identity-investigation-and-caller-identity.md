# Session: Identity Investigation & _caller_identity Implementation

**Date:** 2026-08-24  
**Branch:** `mg-genie-r2-mcp-consolidation`  
**Focus:** KI-21 — UC MCP Service identity resolution  

---

## Problem

All MCP writes via the UC MCP Service were attributed to the App SPN UUID (`84b36586-1ca7-4756-b39e-551a79058c55`) instead of the human caller's email. RLS `created_by` column showed the SPN identity because the UC HTTP Connection authenticates with OAuth M2M (shared credentials).

## Investigation Findings

1. **Auth sidecar IS in the UC MCP path** — confirmed via `x-forwarded-email` header resolution
2. **AI Gateway does NOT send `initialize`** — operates statelessly with raw `tools/call` (no handshake)
3. **`_meta` is `undefined`** in Gateway tool calls — no identity injected via MCP protocol
4. **MCP protocol `2025-11-25`** has no user identity mechanism; `clientInfo` is implementation identity only
5. **Per-user OAuth (U2M)** requires account-level custom OAuth app registration — blocked without account admin access

## Attempted: U2M Per User Connection

- Created `hi_genie_orchestrator_u2m_mcp_conn_dev` (schema-scoped in `hls_fde_dev.dev_matthew_giglia_hi_genie`)
- Auth type: `OAUTH_U2M_MAPPING`, Client ID: App SPN applicationId
- **Failed on login:** `"OAuth application with client_id: '84b36586-...' not available in Databricks account '05d08df7-...'."`
- Root cause: App SPNs only support `client_credentials` grant (M2M), not `authorization_code` (U2M)
- Fix requires: account admin registers a custom OAuth app with authorization_code grant
- Connection kept in dev schema for future use

## Solution Implemented: `_caller_identity` Transport Parameter

**Commit:** `feat: add _caller_identity transport-level param for RLS attribution`

**Design:**
- `handleToolsList` → injects `_caller_identity` into every tool's `inputSchema` via `injectCallerIdentity()`
- `handleToolsCall` → extracts `_caller_identity` from tool args, overrides `session.userId`, strips it before forwarding to handler
- All existing handlers automatically get correct identity with zero code changes
- Trust model: MCP Service only reachable via UC Connection (USE CONNECTION grant)

**File changed:** `server/mcp/transport.ts`

**Verification:**
- Direct proxy call with `_caller_identity: "matthew.giglia@databricks.com"` → `created_by = 'matthew.giglia@databricks.com'` ✅
- `tools/list` response confirms all 39 tools expose `_caller_identity` property ✅
- AI Gateway call in same session → `created_by = '84b36586-...'` (expected: Gateway cached stale schema)
- Next session: Gateway refreshes schemas → model passes `_caller_identity` → email attribution

## Also This Session (Earlier)

### Commit: `fix: wrap record handlers in withIdentity for RLS + add identity diagnostics`

- Fixed `recordSessionSummary` and `recordWorkstreamEvent` — were using raw `pool.connect()` without `withIdentity()`
- RLS policy `created_by = current_setting('app.user_identity')` was always false → INSERT blocked
- Both now wrapped in `withIdentity(pool, session.userId, async (client) => { ... })`

### Commit: `feat: add session protocol tracking + document AI Gateway behavior (KI-21)`

- Added `initialized` and `methodsReceived` to `McpSession` interface
- Confirmed Gateway behavior: `initialized: false`, methods: `['tools/call(...)']`
- Expanded `extractUserId` to check multiple identity headers

## Deployment

- Deployment `01f19f68` — SUCCEEDED
- App healthy: database OK (3ms latency), pool idle

## Decisions

| Decision | Rationale |
| --- | --- |
| Transport-level injection (not per-tool) | Single point of change, all 39 tools get it automatically |
| Underscore prefix (`_caller_identity`) | Signals transport-level concern, won't conflict with domain params |
| Strip before handler | Handlers remain clean, no awareness of identity plumbing |
| Accept trust model | Controlled access (USE CONNECTION grant), no public path |
| Keep U2M connection | May be useful when account admin registers OAuth app |

## Outstanding

- [ ] Request account admin to register OAuth app for true U2M
- [ ] Verify Gateway schema refresh in next chat session
- [ ] Phase 3: `persona_tool_policy.sql` update for 14 new tools
- [ ] Phase 4: UC function deprecation
- [ ] MCP 2026-07-28 protocol evaluation (when Databricks confirms support)
