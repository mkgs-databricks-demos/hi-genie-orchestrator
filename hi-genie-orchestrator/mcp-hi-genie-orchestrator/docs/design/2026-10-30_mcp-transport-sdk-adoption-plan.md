# MCP Transport 2025-11-25 — Execution Plan and SDK Adoption Proposal

**Date:** 2026-10-30  
**Status:** Proposal — awaiting owner decision (Option A vs Option B)  
**Scope:** `server/mcp/transport.ts`, `server/mcp/index.ts`, new `server/mcp/transport.test.ts`, `tests/mcp.spec.ts`  
**Builds on:** `docs/design/2026-08-25_transport-2025-11-25-compliance-plan.md` (Accepted; issue numbers below refer to its Issue Inventory)  
**Related:** `docs/design/2026-08-20_mcp-protocol-versioning-strategy.md`, `fixtures/sessions/2026-08-24_identity-investigation-and-caller-identity.md`

---

## 1. Why a new document

The 2026-08-25 plan is still the authoritative issue list. This document adds what changed since then:

1. **Implementation audit (2026-10-29):** none of the 12 issues is implemented on `main`. Evidence in `server/mcp/transport.ts` (552 lines):

   | # | Evidence on `main` |
   | --- | --- |
   | 1 | `case 'initialized':` at line 432; no `notifications/initialized` |
   | 2 | `getOrCreateSession()` at line 187, called for every POST at line 408 |
   | 3 | Module-global `const sessions = new Map` at line 173 |
   | 4 | `res.setHeader(SESSION_HEADER, session.id)` unconditionally at line 460 |
   | 5, 6 | No `text/event-stream` on POST, no `progressToken` |
   | 7 | `session.sseResponse` stored (line 491), never written |
   | 8, 9, 10 | No `req.is('application/json')`, no Origin check, no `Allow` header |
   | 11 | `WORKER_TOOLS` / `SUPERVISOR_TOOLS` / `PERSONA_TOOLS` still at lines 66-130 |
   | 12 | `sessionId: session.id` in the `initialize` result at line 264 |

   There is no `server/mcp/transport.test.ts`.
2. **Spec target re-checked:** `@modelcontextprotocol/sdk` 1.32.2 (published 2026-10-23) has `LATEST_PROTOCOL_VERSION = '2025-11-25'`. The 2026-07-28 stateless spec is not in the stable SDK, so `2025-11-25` remains the target and `transport-v26.ts` stays deferred.
3. **Conflict with UC MCP Service behavior:** the 2026-08-24 identity investigation found that the AI Gateway / UC MCP Service path is **stateless — it does not send `initialize`**. Item 1.2 of the accepted plan (reject any non-`initialize` request without a session with HTTP 400) would break every UC MCP Service call on the persona paths. This must be resolved before Phase 1 ships (see section 4).
4. **Dependency baseline:** branch `mg-genie-appkit-0.89-upgrade` moves AppKit to 0.89.0 (zod 4.3.6, single copy). The SDK's zod peer range (`^3.25 || ^4.0`) is compatible, so adopting the SDK adds no second zod.

## 2. Options

### Option A — Patch the hand-rolled transport (accepted plan as written)

Implement items 1.1-3.4 of the 2026-08-25 plan inside `transport.ts`.

* Pros: smallest diff per change; no new dependency; keeps `_caller_identity` injection exactly where it is.
* Cons: we own every spec rule and its tests; cancellation (`notifications/cancelled`), resumability and future spec revisions stay manual.
* Effort (from the accepted plan): P1 2-3 h, P2 4-6 h, P3 1-2 h, tests 3-4 h — **10-15 h**.

### Option B — Adopt the official SDK transport (recommended)

Replace the HTTP/session layer with `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` and the **low-level** `Server` class (not `McpServer`), keeping our tool registry.

* Use `Server.setRequestHandler(ListToolsRequestSchema, ...)` and `CallToolRequestSchema` so the existing `McpToolRegistry` (raw JSON Schema `inputSchema`, see `transport.ts:132-140`) is reused unchanged. `McpServer.registerTool` would require rewriting all 39 schemas as zod shapes — not needed.
* One `Server` + transport factory per persona path (`/mcp`, `/mcp/architect`, `/mcp/reviewer`, `/mcp/worker`, `/mcp/dispatcher`) — this gives issue #3 (session isolation) by construction.
* Keep in our code: `_caller_identity` injection in `tools/list` and extraction/stripping in `tools/call` (`transport.ts:269-300` injection, `transport.ts:343-350` override and strip), OBO user extraction, `withIdentity` / RLS session variables, persona registries in `index.ts`.
* SDK covers: issues #1, #2, #4, #5, #6, #7, #8, #10, #12, plus `notifications/cancelled` (open finding #7 of the 2026-08-27 review) and optional DNS-rebinding protection (#9, via `allowedHosts` / `allowedOrigins`).
* Issue #11 (dead 2-persona code) is deleted with the old transport.
* Pros: spec behavior maintained upstream; less code to test; easier move to the next spec revision when the SDK ships it.
* Cons: one larger change; new runtime dependency; must confirm the SDK's stateless mode against UC MCP Service.
* Effort (estimate; driver: adapter for 39 tools is mechanical because handlers keep their signature): adapter 3-4 h, identity/OBO wiring 1-2 h, tests 3-4 h, deploy and live validation 1-2 h — **8-12 h**.

### Recommendation

Option B. Nothing in Option A has started, every open gap is in the hand-rolled layer, and the SDK is compatible with the AppKit 0.89 dependency set. Selecting Option B supersedes the implementation sketches (not the issue list or the tests) of the 2026-08-25 plan; record the decision in its Decisions section and in `PROJECT_MEMORY.md`.

## 3. Session mode per path (applies to both options)

| Path | Main client | Mode |
| --- | --- | --- |
| `/mcp/architect`, `/mcp/reviewer`, `/mcp/worker`, `/mcp/dispatcher` | UC MCP Service via AI Gateway (stateless, no `initialize`) | **Stateless**: no `Mcp-Session-Id`, every POST self-contained. Option B: `sessionIdGenerator: undefined`, `enableJsonResponse: false` (SSE when the client accepts it). |
| `/mcp` (full, 39 tools) | Internal / direct clients (SDK client, AI Playground direct, future React SPA) | **Stateful**: `initialize` required, `Mcp-Session-Id` header, GET SSE stream for notifications |

The spec allows a server not to assign a session ID; stateless persona paths are compliant. Item 1.2's rejection rule applies only to the stateful `/mcp` path. Verify this assumption in Phase 0 before relying on it.

## 4. Execution plan

### Phase 0 — Prerequisites (blocking)

1. Merge `mg-genie-appkit-0.89-upgrade` (AppKit 0.89.0, regenerated `package-lock.json`).
2. Restore dev: Lakebase branches `production` / `development` are `ARCHIVED`, `production` is unprotected, app `mcp-hi-genie-orchestrator-dev` is `UNAVAILABLE` (deployments of 2026-10-06 failed) and still points at the deprecated `brainstorming-hi-genie-orchestrator` source path. Redeploy from this repo; post-deploy job `468754756167374` green.
3. Capture one real UC MCP Service request per persona (method sequence, headers incl. `Accept`, `Mcp-Session-Id`, `Origin`, `MCP-Protocol-Version`) from OTel logs. Confirms or refutes the stateless assumption in section 3.
4. Owner decision: Option A or B.

### Phase 1 — Protocol correctness (branch `mg-genie-mcp-transport-p1`)

Issues #1, #2, #3, #4, #12, plus 2026-08-27 open findings #3 (`isSingleToolCall` definition) and #4 (handler context object).

* Option A: items 1.1-1.5 of the accepted plan, with 1.2 limited to the stateful `/mcp` path.
* Option B: add `@modelcontextprotocol/sdk` (exact version), build `createSdkTransport({ registry, basePath, mode })` in `server/mcp/transport.ts`, mount in `index.ts`, delete the hand-rolled session store.

Exit: `transport.test.ts` P1 rows pass; handshake against stateful `/mcp`; a stateless `tools/list` on each persona path returns the expected count.

### Phase 2 — Streaming and progress (branch `mg-genie-mcp-transport-p2`)

Issues #5, #6, #7. Option B: SSE responses and `notifications/progress` come from the transport; add an optional `onProgress` to the handler context and adopt it in `orchestrate_plan` first. Wire the dormant notification facade (`sendSessionNotification`) to the stateful `/mcp` server only.

### Phase 3 — Hardening (branch `mg-genie-mcp-transport-p3`, can run in parallel with Phase 2)

Issues #8, #9, #10, #11. Option B: enable `enableDnsRebindingProtection` with `allowedOrigins` / `allowedHosts` set to the workspace and app hosts (explicit values from bundle variables, since the SDK matches exact strings), and confirm a missing Origin (server-to-server) is accepted; #8 (415) and #10 (405 with `Allow: GET, POST, DELETE`) are built into the SDK transport (verified in `webStandardStreamableHttp.js` of 1.32.2); #11 is removed with the old code.

## 5. Verification gates (every phase)

| Gate | Pass condition |
| --- | --- |
| Unit | New `server/mcp/transport.test.ts` with the 12 rows of the 2026-08-25 test matrix, plus: stateless `tools/list` without session on each persona path returns 200; `_caller_identity` present in every listed schema and stripped before the handler |
| Regression | `vitest run` no worse than the current baseline (7 failed / 120 passed of 127 on AppKit 0.89.0; failures pre-exist: 5 DB-backed integration timeouts, `mcp-catalog` "5 categories", dispatch `CREATE_NEXT`) |
| Types / build | `tsc -b` for server, client and test configs exit 0; `tsdown` server build ok |
| Tool counts | architect 14, reviewer 14, worker 17, dispatcher 16, full 39 (each persona stays under the UC MCP Service 20-tool limit) |
| Live | Post-deploy job `468754756167374` green; AI Playground multi-tool workflow; `created_by` in Lakebase is the calling user, not the SPN |
| Integration | `tests/mcp.spec.ts`: initialize, initialized (202), tools/list, streamed tools/call, DELETE, dead session gives 400 (stateful `/mcp`) |

## 6. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| UC MCP Service is stateless and item 1.2 breaks it | High | Stateless mode on persona paths (section 3); Phase 0 capture |
| `_caller_identity` lost in the SDK adapter | High (identity, RLS attribution) | Keep injection/stripping in our `ListTools` / `CallTool` handlers; unit test both |
| SDK update changes defaults | Medium | Pin exact version; review release notes on bump |
| SSE through the Apps auth sidecar / AI Gateway | Medium | JSON fallback when `Accept` lacks `text/event-stream`; verify live in Phase 2 |
| Dev environment not recovered | Blocks live gates | Phase 0 item 2 |

## 7. Out of scope

2026-07-28 spec items (stateless-only operation, `_meta` identity, `Mcp-Method` headers, `server/discover`, list caching, MRTR, extensions) remain in `2026-08-20_mcp-protocol-versioning-strategy.md`.

## 8. Decisions

| ID | Decision | Status |
| --- | --- | --- |
| D-T-1 | Target spec stays `2025-11-25` (latest in stable SDK 1.32.2) | Proposed |
| D-T-2 | Option A vs Option B | Open — owner |
| D-T-3 | Persona paths stateless, `/mcp` stateful | Proposed — confirm with Phase 0 capture |
