# MCP Apps — What hi-genie-orchestrator Needs to Start Using Them

**Date:** 2026-10-30  
**Status:** Research complete — proposal; decisions D-A-1..D-A-4 open for the owner  
**Depends on:** `docs/design/2026-10-30_mcp-transport-sdk-adoption-plan.md` (D-T-1: target 2026-07-28 with SDK v2; D-T-2: low-level `Server`)  
**Reference implementation:** Semantic Ground Truth (`semanticGroundTruth/ground-truth-app/server/mcp/`, design `semanticGroundTruth/docs/design/L300-17_mcp_app_review_card.md`)

---

## 1. What MCP Apps is

MCP Apps is the MCP extension `io.modelcontextprotocol/ui` (SEP-1865). A server publishes an HTML view as a `ui://` resource and links a tool to it. A host that supports the extension renders the view in a sandboxed iframe next to the tool result, and the view talks to the host over JSON-RPC 2.0 on `postMessage` (it can call the server's tools through the host).

* Spec status: extension spec **Stable `2026-01-26`**; a `draft` track also exists ([MCP Apps](https://apps.extensions.modelcontextprotocol.io/), [ext-apps spec 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)).
* It is an extension, not core protocol, so it works on both the 2025-11-25 and 2026-07-28 eras. In 2026-07-28 the client capabilities (including `extensions`) travel in each request's `_meta` instead of `initialize`.
* Text fallback is part of the design: every tool still returns `content[].text`, so hosts without MCP Apps lose nothing.

## 2. Server-side requirements

| # | Requirement | hi-genie today |
| --- | --- | --- |
| R1 | Declare the `resources` capability and handle `resources/list` and `resources/read` | **Missing.** `server/mcp/` has no resource handlers |
| R2 | Publish each view as a `ui://<server>/<view>` resource with MIME type `text/html;profile=mcp-app` (`RESOURCE_MIME_TYPE`) | Missing |
| R3 | Link tools to views with `_meta.ui.resourceUri` in the `tools/list` entry (the flat `_meta["ui/resourceUri"]` form is deprecated) | `McpToolRegistry` entries have no `_meta`; needs an optional field the `tools/list` handler passes through |
| R4 | One self-contained HTML document per view (JS + CSS inline), using `App` + `PostMessageTransport` from `@modelcontextprotocol/ext-apps` | No view build. The client build is `rolldown-vite` 7.1.14; add a second single-file build |
| R5 | Optional resource `_meta.ui.csp` / `permissions` / `prefersBorder` | The host's default restrictive CSP is enough if the view calls no external origins |
| R6 | Tool results stay useful as text (markdown in `content[].text`); `structuredContent` feeds the view | Tools already return text; add `structuredContent` to adopted tools |
| R7 | (Spec recommendation) check the client's `io.modelcontextprotocol/ui` capability before advertising UI tools | Not possible on the stateless 2025 leg (UC MCP Service sends no `initialize`); see D-A-3 |

## 3. Packages and compatibility

| Package | Version (npm, checked 2026-10-30) | Notes |
| --- | --- | --- |
| `@modelcontextprotocol/ext-apps` | **2.0.4** (2026-10-27) | Peers: `@modelcontextprotocol/core` and `client` `^2.0.0`, `server` `^2.0.0` (optional), `zod ^4.2.0`, React 17-19 (optional). Fits the SDK v2 target of D-T-1 and AppKit 0.89 (zod 4.3.6, React 19.2.4). |
| `@modelcontextprotocol/ext-apps` | 1.7.5 (2026-07-23) | v1 line, pairs with `@modelcontextprotocol/sdk` 1.x. Semantic Ground Truth runs this. **Not usable here** once the transport moves to SDK v2. |

Server helpers in 2.0.4 (`@modelcontextprotocol/ext-apps/server`): `registerAppTool(server, ...)`, `registerAppResource(server, ...)`, `getUiCapability(clientCapabilities)`, `EXTENSION_ID = "io.modelcontextprotocol/ui"`. Both register helpers take `Pick<McpServer, "registerTool" | "registerResource">`, so they **do not work with the low-level `Server`** chosen in D-T-2. Options in D-A-2.

## 4. Databricks host support (evidence)

| Host | Renders MCP Apps? | Evidence |
| --- | --- | --- |
| **Genie One** on `fevm-hls-fde` | **Yes** | Semantic Ground Truth verified on 2026-10-30: `review_get_next` rendered the interactive card, and an approve from the card reached the server (`votes.source = mcp`). MCP Apps preview enabled on the workspace (owner, 2026-10-24). Path: Unity Gateway MCP service with `include_tool_selectors` → app `/mcp` (host matrix in `L300-17_mcp_app_review_card.md`). |
| Genie Code | Likely no iframe | Same doc: agent context, uses the text fallback |
| AI Playground | Unknown | Not documented; test in M1 |
| Claude, VS Code, basic-host | Yes | ext-apps README (via the L300-17 matrix) |

hi-genie deploys to the **same workspace** (`fevm-hls-fde`, `databricks.yml` targets) with the same topology: one MCP connection plus per-persona UC MCP Services with `include_tool_selectors` (Architecture Decision 12). So the Genie One path that works for Semantic Ground Truth should work here, including `resources/read` through a selector-filtered MCP service (selectors filter tools; Ground Truth's resource reached Genie One). Public Databricks docs do not mention MCP Apps, so treat it as a workspace preview.

Semantic Ground Truth runs SDK **v1** stateless (`sessionIdGenerator: undefined`, `ground-truth-app/server/mcp/index.ts:56-57`) and registers its UI resource unconditionally (`server.ts:41-54`). Its L300-17 doc names the v2 packages `@modelcontextprotocol/sdk-core` / `sdk-server`; those do not exist on npm (404). The real names are `@modelcontextprotocol/core` / `server` / `client`. Worth a note in that repo before it plans a v2 move.

## 5. Constraints specific to hi-genie

* **20-tool limit per UC MCP Service.** Views are resources and do not count. Any tool a view calls must be a real tool in the persona's selector list, so it does count. Current counts: architect 14, reviewer 14, worker 17, dispatcher 16. Reuse existing tools (for example `approve_review`) instead of adding view-only tools.
* **Identity.** A tool call made from the view goes host → UC MCP Service → app, the same OBO path as a model-initiated call. `_caller_identity` is overridden server-side (`transport.ts:343-350`), so a view cannot spoof it. Keep that rule in the SDK v2 adapter.
* **Statelessness.** 2026-07-28 and the legacy stateless leg keep no session. View state must be explicit (`review_id`, `plan_id` in tool arguments), which matches how tools work today.
* **Brand.** Views use the Databricks brand tokens (Lava 600 `#FF3621`, Navy 800 `#1B3139`, DM Sans / DM Mono) and follow the host theme (light/dark), as Ground Truth does.

## 6. Candidate first views

| Candidate | Persona | Existing tools | Why |
| --- | --- | --- | --- |
| **Review card** (recommended first) | reviewer | `get_review` → view; actions via `approve_review` | Closest analog to the proven Ground Truth card; no new tools |
| Plan preview / DAG before publish | architect | `get_plan` → view; action via `publish_plan` | Human gate before publishing; higher value, larger view (graph layout) |
| Orchestration status board | dispatcher | `list_workstreams`, `get_execution_summary` | Read-only; gains live updates from `subscriptions/listen` once dispatch push exists |

## 7. Implementation plan

Prerequisite: Phase 0 and Phase 1 of the 2026-10-30 transport plan (SDK v2 handler deployed and green). MCP Apps on the current hand-rolled transport is possible but would be rewritten in Phase 1, so it is not recommended.

**M1 — Resource plumbing + review card** (estimate 6-9 h; driver: Ground Truth's view build and card can be adapted rather than designed from scratch)

1. Add `@modelcontextprotocol/ext-apps` 2.0.4 (exact) and `vite-plugin-singlefile`.
2. Registry: optional `meta?: { ui?: { resourceUri: string } }` per tool; the `tools/list` handler copies it to `_meta`.
3. Low-level `Server`: declare the `resources` capability; `resources/list` and `resources/read` handlers serve a static map `ui://hi-genie/<view>` → HTML string with MIME `RESOURCE_MIME_TYPE`.
4. View build: `server/mcp/views/<view>/` (TS entry using `App` + `PostMessageTransport`) built to one HTML file and emitted as a generated TS module (Ground Truth pattern: `reviewCardApp.generated.ts`), target < 100 KB.
5. `get_review` returns `structuredContent` plus the existing markdown; its `_meta.ui.resourceUri` is `ui://hi-genie/review-card`.
6. Tests: unit (`resources/read` MIME and content; `_meta` only on linked tools; `_caller_identity` still overridden on view-originated calls), a view unit test (renders from a fixture result), both protocol eras.
7. Live: Genie One on `fevm-hls-fde` through the reviewer MCP service; an approve from the card records the reviewer as `created_by`; record the AI Playground result either way.

**M2 — Plan preview** (estimate 6-10 h). **M3 — Status board** (after dispatch push).

## 8. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| MCP Apps is an undocumented workspace preview in Databricks | Medium | Text fallback; verify per host |
| ext-apps 2.x is recent (2.0.0 on 2026-09-08) | Medium | Pin exact; follow its release notes |
| Hosts that ignore capabilities still receive `_meta.ui` | Low | Allowed by the spec; text fallback; same as Ground Truth |
| View bundle size / CSP | Low | Single file, no external origins, size check in tests |

## 9. Decisions (proposed)

| ID | Decision | Status |
| --- | --- | --- |
| D-A-1 | First MCP App is the reviewer **review card** (`get_review` → view, `approve_review` action) | Proposed |
| D-A-2 | Keep the low-level `Server` (D-T-2) and wire `_meta.ui` + `resources/*` by hand; use ext-apps only for the view runtime, constants and types. Alternative: switch the factory to `McpServer` with `fromJsonSchema` to use `registerAppTool` / `registerAppResource` | Proposed |
| D-A-3 | Advertise UI links unconditionally (no capability gate) with a mandatory text fallback, as Ground Truth does; use `getUiCapability` only when a request carries capabilities (modern era) | Proposed |
| D-A-4 | MCP Apps work starts after transport Phase 1 (SDK v2) is deployed, not on the hand-rolled transport | Proposed |
