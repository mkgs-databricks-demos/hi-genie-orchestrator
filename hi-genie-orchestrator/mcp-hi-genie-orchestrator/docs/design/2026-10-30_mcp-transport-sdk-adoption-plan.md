# MCP Transport — Execution Plan and SDK Adoption (target 2026-07-28, dual-era)

**Date:** 2026-10-30 (revised the same day after D-T-1)  
**Status:** Accepted — D-T-1 (target the latest spec, 2026-07-28) and D-T-2 (official SDK) decided by the owner on 2026-10-30; D-T-3 resolved by D-T-1 (all paths stateless)  
**Scope:** `server/mcp/transport.ts`, `server/mcp/index.ts`, new `server/mcp/transport.test.ts`, `tests/mcp.spec.ts`  
**Companion:** `docs/design/2026-10-30_mcp-apps-adoption-research.md` (MCP Apps on top of this transport)  
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
2. **Spec target re-checked (corrected after D-T-1):** the first draft read only the v1 package. `@modelcontextprotocol/sdk` 1.32.2 is the v1 maintenance line and stops at `2025-11-25`. The **2026-07-28 spec is the current stable MCP release** (published 2026-07-28), and the TypeScript SDK **v2** implements it as split packages: `@modelcontextprotocol/server` / `client` / `core` **2.4.0**, `@modelcontextprotocol/node` 2.1.2, `@modelcontextprotocol/express` 2.0.2 (checked on npm 2026-10-30). v2 serves both protocol eras from one endpoint (section 2a).
3. **Conflict with UC MCP Service behavior:** the 2026-08-24 identity investigation found that the AI Gateway / UC MCP Service path is **stateless — it does not send `initialize`**. Item 1.2 of the accepted plan (reject any non-`initialize` request without a session with HTTP 400) would break every UC MCP Service call on the persona paths. This must be resolved before Phase 1 ships (see section 4).
4. **Dependency baseline:** branch `mg-genie-appkit-0.89-upgrade` moves AppKit to 0.89.0 (zod 4.3.6, single copy). `@modelcontextprotocol/server` 2.4.0 depends on `zod ^4.2.0` and requires Node >= 20, both compatible, so adopting it adds no second zod.

## 2. Options

### Option A — Patch the hand-rolled transport (accepted plan as written)

Implement items 1.1-3.4 of the 2026-08-25 plan inside `transport.ts`.

* Pros: smallest diff per change; no new dependency; keeps `_caller_identity` injection exactly where it is.
* Cons: we own every spec rule and its tests; cancellation (`notifications/cancelled`), resumability and future spec revisions stay manual.
* Effort (from the accepted plan): P1 2-3 h, P2 4-6 h, P3 1-2 h, tests 3-4 h — **10-15 h**.

### Option B — Adopt the official SDK transport (selected)

Replace the HTTP/session layer with the official SDK and the **low-level** `Server` class (not `McpServer`), keeping our tool registry. After D-T-1 the package is the v2 `@modelcontextprotocol/server` (section 2a), not v1 `@modelcontextprotocol/sdk`; the bullets below were written against v1 and still hold except where section 2a says otherwise.

* Use `Server.setRequestHandler('tools/list', ...)` and `'tools/call'` (v2 takes the method string; v1 took `ListToolsRequestSchema` / `CallToolRequestSchema`) so the existing `McpToolRegistry` (raw JSON Schema `inputSchema`, see `transport.ts:132-140`) is reused unchanged. `McpServer.registerTool` would require rewriting all 39 schemas as zod shapes — not needed.
* One `Server` + transport factory per persona path (`/mcp`, `/mcp/architect`, `/mcp/reviewer`, `/mcp/worker`, `/mcp/dispatcher`) — this gives issue #3 (session isolation) by construction.
* Keep in our code: `_caller_identity` injection in `tools/list` and extraction/stripping in `tools/call` (`transport.ts:269-300` injection, `transport.ts:343-350` override and strip), OBO user extraction, `withIdentity` / RLS session variables, persona registries in `index.ts`.
* SDK covers: issues #1, #2, #4, #5, #6, #7, #8, #10, #12, plus `notifications/cancelled` (open finding #7 of the 2026-08-27 review). Optional Origin/Host rejection (#9) exists as separate v2 middlewares (`originValidation`, `hostHeaderValidation`) but stays unmounted per 2026-08-25 Decision 2 (log-only).
* Issue #11 (dead 2-persona code) is deleted with the old transport.
* Pros: spec behavior maintained upstream; less code to test; easier move to the next spec revision when the SDK ships it.
* Cons: one larger change; new runtime dependency; must confirm the SDK's stateless mode against UC MCP Service.
* Effort (estimate; driver: adapter for 39 tools is mechanical because handlers keep their signature): adapter 3-4 h, identity/OBO wiring 1-2 h, tests 3-4 h, deploy and live validation 1-2 h — **8-12 h**.

### 2a. Target 2026-07-28 with SDK v2, dual-era (D-T-1, accepted 2026-10-30)

The owner chose the latest spec. Verified in the published v2 packages (2026-10-30):

* `createMcpHandler(factory, { legacy: 'stateless' })` from `@modelcontextprotocol/server` serves **2026-07-28** requests (per-request `_meta` envelope, `server/discover`, `subscriptions/listen`) and answers **2025-era** requests through a stateless fallback: a fresh instance per request, the v1 `sessionIdGenerator: undefined` idiom, GET/DELETE answered 405. `legacy` defaults to `'stateless'`; `'reject'` would make the endpoint modern-only.
* The factory is `(ctx: McpRequestContext) => McpServer | Server`, so the low-level `Server` of D-T-2 still fits. `ctx.era` (`'legacy' | 'modern'`) and `ctx.authInfo` are available per request, which is where the OBO user and `_caller_identity` handling plug in.
* Express mounting: `toNodeHandler()` from `@modelcontextprotocol/node` (or `createMcpExpressApp` from `@modelcontextprotocol/express`, peer `express ^4.18 || ^5`). `originValidation` / `hostHeaderValidation` are separate middlewares, so the log-only Origin rule (2026-08-25 Decision 2) stays easy: do not mount the rejecting ones.
* `responseMode: 'auto'` (default) returns JSON and upgrades to SSE only when the handler emits progress before the result; this is issues #5/#6 for free.
* Why stateless legacy is safe: UC MCP Service sends no `initialize` (2026-08-24 identity investigation), and Semantic Ground Truth already runs SDK v1 stateless (`sessionIdGenerator: undefined`, `ground-truth-app/server/mcp/index.ts:56-57`) behind a Unity Gateway MCP service in the same workspace (`fevm-hls-fde`), including MCP Apps rendering in Genie One.

Consequences for the earlier decisions:

* **D-T-3 resolved:** every path is stateless, including `/mcp`. 2026-07-28 removes protocol sessions and `Mcp-Session-Id`; the legacy leg is stateless too. The stateful `/mcp` row in section 3 is withdrawn. Issues #1-#4 and #12 (session lifecycle) disappear rather than being fixed.
* **2026-08-25 Decision 1 (GET SSE facade) replaced:** server-to-client notifications move to `subscriptions/listen` streams. The facade becomes a thin wrapper over the handler's `notify` / `ServerEventBus` (in-process `InMemoryServerEventBus` is fine for one app instance; still dormant until dispatch push).
* **2026-08-25 Decision 3 (`Last-Event-ID` deferred) made moot:** 2026-07-28 removes SSE resumability; a broken stream is retried as a new request. No `eventStore`.
* **2026-08-25 Decision 2 (Origin log-only) unchanged.**
* **`transport-v26.ts` and the A/B deployable variants** of `2026-08-20_mcp-protocol-versioning-strategy.md` are no longer needed: one deployment serves both eras.
* **Unknown to confirm in Phase 0:** which era Databricks clients send (UC MCP Service, AI Playground, Genie One). Not documented; the dual-era handler works either way, but `server/discover` and modern `_meta` paths can only be live-tested if one of them speaks 2026-07-28. Otherwise test modern with the v2 `@modelcontextprotocol/client`.

### Decision: Option B (accepted 2026-10-30)

The owner selected Option B. Reasons: nothing in Option A had started, every open gap is in the hand-rolled layer, and the SDK is compatible with the AppKit 0.89 dependency set.

What this changes in the 2026-08-25 plan:

* **Superseded:** its implementation sketches (sections 1.1-3.4: hand-written session store, `getOrCreateSession` rework, `handleToolCallStreaming`, manual 405/415 handling).
* **Still authoritative:** the issue inventory (#1-#12), the test matrix and the integration flow.
* **Carried over unchanged:** its accepted Decisions 1-3:
  * Decision 1 (GET SSE facade, dormant): ~~stays, calling `Server.notification()` of the stateful `/mcp` server~~ replaced after D-T-1 by `subscriptions/listen` + handler `notify` (section 2a).
  * Decision 2 (Origin log-only): do **not** mount the SDK's rejecting Origin / Host validation; keep a log-only Origin check in our middleware in front of the SDK handler.
  * Decision 3 (`Last-Event-ID` deferred to R2): moot after D-T-1; 2026-07-28 removes resumability.

Recorded in the 2026-08-25 plan (Decision 4) and in `PROJECT_MEMORY.md` (Architecture Decision 15).

## 3. Session mode per path (revised after D-T-1)

| Path | Main client | Mode |
| --- | --- | --- |
| `/mcp/architect`, `/mcp/reviewer`, `/mcp/worker`, `/mcp/dispatcher` | UC MCP Service via AI Gateway (no `initialize`) | One `createMcpHandler(factory, { legacy: 'stateless' })` per path: modern 2026-07-28 + stateless 2025 fallback |
| `/mcp` (full, 39 tools) | Direct clients (SDK client, AI Playground direct, future React SPA) | Same handler type. ~~Stateful with `Mcp-Session-Id`~~ withdrawn: 2026-07-28 has no sessions. |

Item 1.2 of the 2026-08-25 plan (reject requests without a session) is dropped entirely. Cross-call state, if ever needed, uses explicit server-minted handles passed as tool arguments (the 2026-07-28 rule); today's tools already pass `workstream_key` / `plan_id` this way.

## 4. Execution plan

### Phase 0 — Prerequisites (blocking)

1. Merge `mg-genie-appkit-0.89-upgrade` (AppKit 0.89.0, regenerated `package-lock.json`).
2. Restore dev: Lakebase branches `production` / `development` are `ARCHIVED`, `production` is unprotected, app `mcp-hi-genie-orchestrator-dev` is `UNAVAILABLE` (deployments of 2026-10-06 failed) and still points at the deprecated `brainstorming-hi-genie-orchestrator` source path. Redeploy from this repo; post-deploy job `468754756167374` green.
3. Capture one real UC MCP Service request per persona (method sequence, headers incl. `Accept`, `Mcp-Session-Id`, `Origin`, `MCP-Protocol-Version`, and whether the body carries a 2026-07-28 `_meta` envelope) from OTel logs. Tells us which era each Databricks client speaks (section 2a).
4. ~~Owner decision: Option A or B.~~ Done 2026-10-30: Option B (D-T-2).

### Phase 1 — Protocol correctness (branch `mg-genie-mcp-transport-p1`)

Issues #1, #2, #3, #4, #12, plus 2026-08-27 open findings #3 (`isSingleToolCall` definition) and #4 (handler context object).

* ~~Option A: items 1.1-1.5 of the accepted plan, with 1.2 limited to the stateful `/mcp` path.~~ Not selected.
* Option B (selected): add `@modelcontextprotocol/server` and `@modelcontextprotocol/node` (exact versions, 2.4.0 / 2.1.2 at time of writing), build `createPersonaHandler({ registry, basePath })` in `server/mcp/transport.ts` returning `createMcpHandler(factory, { legacy: 'stateless' })` with a low-level `Server` factory, mount with `toNodeHandler()` in `index.ts`, delete the hand-rolled session store.

Exit: `transport.test.ts` P1 rows pass; on every path, a 2025-era `tools/list` without `initialize` and a 2026-07-28 `server/discover` + `tools/list` (v2 client) both return the expected tool count.

### Phase 2 — Streaming and progress (branch `mg-genie-mcp-transport-p2`)

Issues #5, #6, #7. SSE responses and `notifications/progress` come from the handler (`responseMode: 'auto'`); add an optional `onProgress` to the handler context and adopt it in `orchestrate_plan` first. Issue #7 (dead GET stream) is replaced by `subscriptions/listen`: wire the dormant notification facade to the handler's `notify`, with no producers until dispatch push.

### Phase 3 — Hardening (branch `mg-genie-mcp-transport-p3`, can run in parallel with Phase 2)

Issues #8, #9, #10, #11. #8 (415) and #10 (405) are built into the SDK (verified for v1 in `webStandardStreamableHttp.js` of 1.32.2; the v2 legacy leg documents 405 for GET/DELETE; re-verify v2 status codes in the unit tests). #9: log-only Origin middleware per 2026-08-25 Decision 2 (SDK rejection left off; if enforcement is ever adopted, note the SDK matches `allowedOrigins` as exact strings and accepts a missing Origin). #11 is removed with the old code.

## 5. Verification gates (every phase)

| Gate | Pass condition |
| --- | --- |
| Unit | New `server/mcp/transport.test.ts`: the 2026-08-25 matrix rows that still apply (#5-#11; session rows #1-#4, #12 replaced by "no `Mcp-Session-Id` is ever sent"), plus per path: 2025-era `tools/list` without `initialize` returns 200; 2026-07-28 `server/discover` lists both supported versions; unsupported version gives `UnsupportedProtocolVersionError`; `_caller_identity` present in every listed schema and stripped before the handler, in both eras |
| Regression | `vitest run` no worse than the current baseline (7 failed / 120 passed of 127 on AppKit 0.89.0; failures pre-exist: 5 DB-backed integration timeouts, `mcp-catalog` "5 categories", dispatch `CREATE_NEXT`) |
| Types / build | `tsc -b` for server, client and test configs exit 0; `tsdown` server build ok |
| Tool counts | architect 14, reviewer 14, worker 17, dispatcher 16, full 39 (each persona stays under the UC MCP Service 20-tool limit) |
| Live | Post-deploy job `468754756167374` green; AI Playground multi-tool workflow; `created_by` in Lakebase is the calling user, not the SPN |
| Integration | `tests/mcp.spec.ts` with the v2 `@modelcontextprotocol/client`: modern discover, tools/list, streamed tools/call with progress; legacy initialize/initialized (202) still accepted and answered statelessly; GET/DELETE give 405 |

## 6. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| UC MCP Service is stateless and item 1.2 breaks it | High → Low | Item 1.2 dropped; all paths stateless (section 3) |
| SDK v2 is new (2.0 line since 2026-09; 2.4.0 on 2026-10-23) | Medium | Pin exact versions; dual-era tests in both directions; Semantic Ground Truth migration (it is on v1 1.32.1 + ext-apps 1.7.5) can share findings |
| No Databricks client speaks 2026-07-28 yet | Low | Legacy leg covers today's traffic; modern path tested with the v2 client |
| `_caller_identity` lost in the SDK adapter | High (identity, RLS attribution) | Keep injection/stripping in our `ListTools` / `CallTool` handlers; unit test both |
| SDK update changes defaults | Medium | Pin exact version; review release notes on bump |
| SSE through the Apps auth sidecar / AI Gateway | Medium | JSON fallback when `Accept` lacks `text/event-stream`; verify live in Phase 2 |
| Dev environment not recovered | Blocks live gates | Phase 0 item 2 |

## 7. Out of scope

~~2026-07-28 spec items remain in `2026-08-20_mcp-protocol-versioning-strategy.md`.~~ After D-T-1, core 2026-07-28 behavior is in scope via the SDK. Still out of scope: moving `_caller_identity` from a tool argument to `_meta` (keep the argument until a Databricks client sends identity in `_meta`), the `io.modelcontextprotocol/tasks` extension, and list caching hints. MCP Apps (`io.modelcontextprotocol/ui`) is planned separately in `2026-10-30_mcp-apps-adoption-research.md`.

## 8. Decisions

| ID | Decision | Status |
| --- | --- | --- |
| D-T-1 | Target the latest spec, **2026-07-28**, while still serving 2025-era clients (dual-era `createMcpHandler`, `legacy: 'stateless'`) | **Accepted 2026-10-30 (owner)** |
| D-T-2 | Option B: official SDK + low-level `Server`, existing tool registry kept; package is v2 `@modelcontextprotocol/server` (+ `@modelcontextprotocol/node`) after D-T-1 | **Accepted 2026-10-30 (owner)** |
| D-T-3 | ~~Persona paths stateless, `/mcp` stateful~~ All paths stateless | Resolved by D-T-1 |
