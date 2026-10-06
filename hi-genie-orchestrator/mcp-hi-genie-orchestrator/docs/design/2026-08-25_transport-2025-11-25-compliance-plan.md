# MCP Transport 2025-11-25 Streamable HTTP — Compliance Remediation Plan

**Date:** 2026-08-25  
**Status:** Accepted — decisions recorded, ready for implementation  
**Scope:** `server/mcp/transport.ts`, `server/mcp/index.ts`  
**Spec reference:** [MCP 2025-11-25 Streamable HTTP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/)  
**Relates to:** `docs/design/2026-08-20_mcp-protocol-versioning-strategy.md`

---

## Executive Summary

The current `transport.ts` implements the broad shape of MCP Streamable HTTP
(POST/GET/DELETE, `Mcp-Session-Id`, JSON-RPC 2.0) but deviates from the
2025-11-25 specification in 12 areas. This plan addresses all gaps in priority
order, grouped into three phases:

| Phase | Focus | Issues Addressed | Risk if Skipped |
| --- | --- | --- | --- |
| **P1 — Protocol Correctness** | Session lifecycle, method routing | #1, #2, #3, #4, #12 | Handshake failures with UC MCP Service clients |
| **P2 — Streaming & Progress** | POST SSE, progress tokens, GET events | #5, #6, #7 | Timeouts on long tools, dead SSE endpoint |
| **P3 — Hardening & Cleanup** | Validation, security, dead code | #8, #9, #10, #11 | Minor spec deviations, tech debt |

---

## Issue Inventory

| # | Issue | Severity | File | Lines |
| --- | --- | --- | --- | --- |
| 1 | Wrong notification method name (`initialized` vs `notifications/initialized`) | Critical | transport.ts | 432–434 |
| 2 | No initialization enforcement — requests accepted before `initialize` | Critical | transport.ts | 187–210, 406–468 |
| 3 | Session store is global — shared across persona transports | High | transport.ts | 173 |
| 4 | `Mcp-Session-Id` returned on non-initialize responses before session exists | High | transport.ts | 460 |
| 5 | No SSE streaming on POST for long-running `tools/call` | High | transport.ts | 393–468 |
| 6 | No `_meta.progressToken` support | Medium | transport.ts | 316–365 |
| 7 | GET SSE stream never emits actual MCP events (dead letter) | Medium | transport.ts | 471–504 |
| 8 | No `Content-Type: application/json` validation on POST | Low | transport.ts | 393 |
| 9 | No `Origin` header validation (DNS rebinding) | Low | transport.ts | 393 |
| 10 | Missing `Allow` header on 405 | Low | transport.ts | 547 |
| 11 | Dead 2-persona code (`WORKER_TOOLS`/`SUPERVISOR_TOOLS` in transport.ts) | Low | transport.ts | 66–130 |
| 12 | `handleInitialize` returns `sessionId` in result body | Low | transport.ts | 258–265 |

---

## Phase 1 — Protocol Correctness (Critical)

**Goal:** Pass the MCP handshake with any spec-compliant client (UC MCP Service,
AI Playground, TypeScript SDK `StreamableHTTPClientTransport`).

### 1.1 Fix notification method name

**Problem:** The switch case matches `'initialized'` but the 2025-11-25 spec
sends `notifications/initialized` as the method name.

**Fix:**
```typescript
// Before
case 'initialized':
  continue;

// After
case 'notifications/initialized':
  session.initialized = true;
  continue;
```

**Also accept** the bare `'initialized'` for backward compatibility with older
clients (TypeScript SDK < 1.5 sent bare form):
```typescript
case 'notifications/initialized':
case 'initialized':
  session.initialized = true;
  continue;
```

**Test:** Send `{"jsonrpc":"2.0","method":"notifications/initialized"}` — must
return 202 (no response body) and mark session initialized.

---

### 1.2 Enforce initialization lifecycle

**Problem:** `getOrCreateSession()` creates sessions for any request. The spec
requires that:
1. Only `initialize` may create a new session
2. All other methods MUST be rejected with HTTP 400 if no valid session exists
3. After `initialize` responds, the client MUST send `notifications/initialized`
   before calling other methods (SHOULD, not MUST — we'll be lenient here)
4. `initialize` MUST NOT be batched with other requests — it must be the sole
   request in a POST body (spec §Lifecycle: "The client MUST send initialize as
   the first request", and JSON-RPC 2.0 semantics require that a batch shares a
   single auth/session context — which doesn't exist yet during `initialize`)

**Fix:** Restructure session lookup in `handlePost` with explicit batch
validation for `initialize`:

```typescript
async function handlePost(req: Request, res: Response): Promise<void> {
  const userId = extractUserId(req);
  const sessionId = req.headers[SESSION_HEADER] as string | undefined;
  const body = req.body;

  // ... parse validation ...

  const requests = Array.isArray(body) ? body : [body];
  const hasInitialize = requests.some(r => r.method === 'initialize');

  // ── Batch-initialize guard ──────────────────────────────────────────────
  // The spec requires `initialize` to be the sole request in a POST.
  // Batching it with other methods is invalid because:
  //   (a) The session doesn't exist yet — other methods can't execute.
  //   (b) Processing order in a batch is undefined — we can't guarantee
  //       initialize runs first.
  //   (c) The TypeScript SDK and AI Playground never batch initialize.
  // Reject early with a clear error rather than silently creating a session
  // and failing the companion requests with confusing partial results.
  if (hasInitialize && requests.length > 1) {
    res.status(400).json(
      makeErrorResponse(null, RPC_INVALID_REQUEST,
        'Bad Request: initialize must not be batched with other requests.'),
    );
    return;
  }

  let session: McpSession;

  if (hasInitialize) {
    // initialize creates a fresh session (ignore stale session ID)
    session = createNewSession(userId);
  } else if (sessionId && sessions.has(sessionId)) {
    session = sessions.get(sessionId)!;
    session.lastActiveAt = new Date();
  } else {
    // No valid session and not an initialize → reject
    res.status(400).json(
      makeErrorResponse(null, RPC_INVALID_REQUEST,
        'Bad Request: Missing or invalid Mcp-Session-Id. Call initialize first.'),
    );
    return;
  }

  // ... process requests ...
}
```

**Edge case — `notifications/initialized` batched with `initialize`:**
Some clients (e.g., TypeScript SDK ≤ 1.4) sent `initialize` +
`notifications/initialized` in a single POST as an optimization. This is also
rejected by the guard above. If we discover a client that does this in
production, the guard can be relaxed to:
```typescript
if (hasInitialize && requests.some(r =>
  r.method !== 'initialize' && r.method !== 'notifications/initialized' && r.method !== 'initialized'
)) { ... }
```
But start strict — the spec is unambiguous here, and UC MCP Service doesn't
batch.

**Tests:**
- Send `tools/list` without prior `initialize` → expect 400.
- Send batch `[initialize, tools/list]` → expect 400 with
  "must not be batched" message.
- Send solo `initialize` → expect 200 with session.

---

### 1.3 Scope sessions per transport instance

**Problem:** The `sessions` Map is module-global. A session created on
`/mcp/architect` can be reused on `/mcp/worker`, breaking persona isolation.

**Fix:** Move the session store into the closure returned by
`createMcpTransport()` so each persona path has its own session namespace.
Expand the factory return type to expose a bound notification handle (consumed
by Phase 2.3):

```typescript
export interface McpTransportHandle {
  mcpMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  basePath: string;
  /**
   * Send a server-initiated notification to a session's GET SSE stream.
   * Bound to this transport instance's session store.
   * Returns false if session not found or stream closed.
   */
  sendNotification: (sessionId: string, method: string, params: Record<string, unknown>) => boolean;
}

export function createMcpTransport(options: McpTransportOptions): McpTransportHandle {
  const { pool, toolRegistry, basePath = '/mcp' } = options;

  // Per-transport session store (not module-global)
  const sessions = new Map<string, McpSession>();

  // ... handlers use this local map ...

  function sendNotification(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): boolean {
    const session = sessions.get(sessionId);
    if (!session?.sseResponse || session.sseResponse.writableEnded) return false;
    const event = { jsonrpc: '2.0' as const, method, params };
    session.sseResponse.write(`data: ${JSON.stringify(event)}\n\n`);
    return true;
  }

  return { mcpMiddleware, basePath, sendNotification };
}
```

Remove the module-level `sessions` Map and `cleanExpiredSessions` — move them
inside the factory.

**Dependency note:** Phase 2.3 (`sendSessionNotification` facade in `index.ts`)
consumes the `sendNotification` handle returned here. These two changes must
ship together or 2.3 must follow 1.3.

**Test:** Create session on `/mcp/architect`, use that session ID on
`/mcp/worker` → expect 400.

---

### 1.4 Correct `Mcp-Session-Id` response behavior

**Problem:** The spec says:
- `Mcp-Session-Id` is returned in the `initialize` response
- Subsequent responses echo the same session ID
- Responses to requests without a valid session should NOT include the header

Current code always sets it (line 460), including for error responses.

**Fix:** Only set the header when a valid session is in scope:

```typescript
// Only set session header after successful session resolution
if (session) {
  res.setHeader(SESSION_HEADER, session.id);
}
```

---

### 1.5 Remove `sessionId` from `initialize` result body

**Problem:** Line 264 returns `sessionId: session.id` inside the JSON-RPC
result object of the `initialize` response. The 2025-11-25 spec communicates
the session ID exclusively via the `Mcp-Session-Id` response header (§Transport,
"The server MAY assign a session ID by including it in the Mcp-Session-Id
response header"). Returning it in the body is non-standard and could confuse
clients that parse the result strictly.

**Fix:** Remove `sessionId` from the `handleInitialize` return value:

```typescript
function handleInitialize(
  requestId: string | number | null,
  _params: Record<string, unknown>,
  session: McpSession,
): JsonRpcResponse {
  return makeSuccessResponse(requestId, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: SERVER_INFO,
    // sessionId removed — communicated via Mcp-Session-Id header (set in 1.4)
  });
}
```

**Risk:** Low. No known client reads `sessionId` from the body — UC MCP Service
and AI Playground both read the header. The TypeScript SDK `StreamableHTTPClientTransport`
extracts it from `response.headers.get("mcp-session-id")`.

**Test:** `initialize` response body must NOT contain a `sessionId` field;
`Mcp-Session-Id` header must still be present.

---

## Phase 2 — Streaming & Progress (High/Medium)

**Goal:** Support long-running tool calls without client timeouts. Enable the
GET SSE channel for server-initiated notifications.

### 2.1 POST SSE streaming for `tools/call`

**Problem:** The 2025-11-25 spec allows the server to respond to POST requests
with `Content-Type: text/event-stream` (instead of `application/json`) when:
1. The client sends `Accept: application/json, text/event-stream`
2. The tool execution is expected to be long-running

This lets the server send progress events during execution, then the final
JSON-RPC response as the last SSE event.

**Design:**

```typescript
async function handlePost(req: Request, res: Response): Promise<void> {
  const acceptsSSE = (req.headers.accept ?? '').includes('text/event-stream');

  // For tools/call when client accepts SSE:
  if (acceptsSSE && isSingleToolCall(requests)) {
    return handleToolCallStreaming(requests[0], session, res);
  }

  // Otherwise: standard JSON response
  // ...
}

async function handleToolCallStreaming(
  request: JsonRpcRequest,
  session: McpSession,
  res: Response,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    [SESSION_HEADER]: session.id,
  });

  // Optional: emit progress events during execution
  // data: {"jsonrpc":"2.0","method":"notifications/progress",...}

  const response = await handleToolsCall(...);

  // Final result as last SSE event
  res.write(`data: ${JSON.stringify(response)}\n\n`);
  res.end();
}
```

**Scope decision:** Start with "always stream single tool calls when client
accepts SSE" — simpler than per-tool opt-in. Batch requests always return JSON.

**Test:** POST `tools/call` with `Accept: application/json, text/event-stream`
→ response Content-Type is `text/event-stream`, last event is JSON-RPC result.

---

### 2.2 Progress token support

**Problem:** The spec defines `_meta.progressToken` in tool call params. When
present, the server SHOULD emit `notifications/progress` events during execution.

**Design:** Extend `McpToolHandler` signature with an optional progress callback:

```typescript
export type ProgressCallback = (progress: number, total?: number) => void;

export type McpToolHandler = (
  params: Record<string, unknown>,
  session: McpSession,
  pool: Pool,
  onProgress?: ProgressCallback,
) => Promise<unknown>;
```

In `handleToolCallStreaming`, if `params._meta?.progressToken` exists, wire up
the callback to emit SSE progress events:

```typescript
const progressToken = params._meta?.progressToken;
const onProgress: ProgressCallback | undefined = progressToken
  ? (progress, total) => {
      const notification = {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken, progress, total },
      };
      res.write(`data: ${JSON.stringify(notification)}\n\n`);
    }
  : undefined;

const result = await handler(cleanArgs, effectiveSession, pool, onProgress);
```

**Incremental:** Tool handlers are NOT required to call `onProgress` — it's
opt-in per handler. Phase 2 only wires the plumbing; individual tools can adopt
later (e.g., `orchestrate_plan` which coordinates multiple workstreams).

---

### 2.3 Make GET SSE stream functional

**Problem:** `session.sseResponse` is stored but nothing ever writes to it. The
GET endpoint is effectively dead.

**Constraint (from 1.3):** Sessions are now closure-scoped per transport
instance. A module-level `sendSessionNotification()` export that references a
global `sessions` Map no longer works. External modules need a single entry
point that resolves the correct transport instance for a given session ID.

**Design:** The per-transport `sendNotification` handle (returned by
`createMcpTransport()` per 1.3) is the primitive. `index.ts` builds a unified
facade that tries each transport's handle:

```typescript
// index.ts — unified notification dispatcher

import type { McpTransportHandle } from './transport.js';

/** All active transport handles, populated during setupMcpRoutes(). */
const transportHandles: McpTransportHandle[] = [];

/**
 * Send a server-initiated notification to a session across any persona transport.
 *
 * Tries each transport's bound sendNotification until one succeeds (session IDs
 * are UUIDs — globally unique, so at most one transport owns a given session).
 *
 * @returns true if the notification was delivered, false if session not found
 *          or SSE stream closed on all transports.
 */
export function sendSessionNotification(
  sessionId: string,
  method: string,
  params: Record<string, unknown>,
): boolean {
  for (const handle of transportHandles) {
    if (handle.sendNotification(sessionId, method, params)) return true;
  }
  return false;
}

export async function setupMcpRoutes(appkit: AppKitInstance): Promise<void> {
  // ... build registries ...

  const full = createMcpTransport({ pool, toolRegistry: fullRegistry, basePath: '/mcp' });
  const architect = createMcpTransport({ pool, toolRegistry: architectRegistry, basePath: '/mcp/architect' });
  const reviewer = createMcpTransport({ pool, toolRegistry: reviewerRegistry, basePath: '/mcp/reviewer' });
  const worker = createMcpTransport({ pool, toolRegistry: workerRegistry, basePath: '/mcp/worker' });
  const dispatcher = createMcpTransport({ pool, toolRegistry: dispatcherRegistry, basePath: '/mcp/dispatcher' });

  // Register handles for the notification facade
  transportHandles.length = 0; // idempotent on re-init
  transportHandles.push(full, architect, reviewer, worker, dispatcher);

  // ... mount middleware ...
}
```

**Why fan-out is cheap:** Session IDs are UUIDs — at most one transport owns a
given ID. The loop short-circuits on first hit. With 5 transports and a Map
lookup per attempt, worst case is 5 Map.has() calls (~nanoseconds).

**Use cases:**
- `notifications/tools/list_changed` — when tools are dynamically enabled
- Custom notifications for workstream state changes (internal extension)

**Alternative (defer):** If no server-initiated notifications are needed in R1,
mark the GET handler as returning 501 Not Implemented and document it. The
2025-11-25 spec says the GET endpoint is OPTIONAL — servers MAY support it.

**Recommendation:** Implement the facade now (dormant). Defer active use until
dispatch engine needs push. Add `// TODO: wire dispatch events` at call sites.
Return the GET endpoint as-is (functional but dormant) rather than 501.

---

## Phase 3 — Hardening & Cleanup (Low)

**Goal:** Defense-in-depth, spec pedantry, and tech debt removal.

### 3.1 Validate `Content-Type` on POST

```typescript
if (!req.is('application/json')) {
  res.status(415).json(
    makeErrorResponse(null, RPC_PARSE_ERROR,
      'Unsupported Media Type: expected application/json'),
  );
  return;
}
```

**Note:** Express `req.is()` handles charset variants
(`application/json; charset=utf-8`).

---

### 3.2 Origin header validation

The spec recommends checking Origin to prevent DNS rebinding. Since this server
runs behind the Databricks Apps auth sidecar (all traffic is authenticated),
the risk is lower, but we should still validate:

```typescript
const ALLOWED_ORIGINS = new Set([
  // Databricks workspace origins
  // UC MCP Service internal (no Origin header)
  undefined,
]);

function validateOrigin(req: Request, res: Response): boolean {
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    res.status(403).json({ error: 'Forbidden: invalid origin' });
    return false;
  }
  return true;
}
```

**Pragmatic approach:** In the Databricks Apps environment, UC MCP Service
traffic arrives without an Origin header (server-to-server). Only reject
requests with an Origin that doesn't match the workspace domain pattern
(`*.cloud.databricks.com`, `*.azuredatabricks.net`, etc.). Log unknown origins
for observability.

---

### 3.3 `Allow` header on 405

```typescript
default:
  res.setHeader('Allow', 'GET, POST, DELETE');
  res.status(405).json({ error: 'Method not allowed' });
```

Trivial one-liner.

---

### 3.4 Remove dead 2-persona code from `transport.ts`

**Lines to remove:** 55–130 (the old `Persona` type, `WORKER_TOOLS`,
`SUPERVISOR_TOOLS`, `PERSONA_TOOLS` map).

Also remove the `persona?: Persona` field from `McpTransportOptions` and the
`allowedTools` logic that references it — the 4-persona split in `index.ts`
already handles filtering by passing a pre-filtered `McpToolRegistry` to each
transport instance.

**Before removing:** Verify no other file imports `Persona` type. Search:
```bash
grep -r "Persona" server/mcp/
```

---

## Implementation Order & Dependencies

```
Phase 1 (protocol correctness) — no external dependencies
  1.1  Fix notification method name          (standalone, 5 min)
  1.2  Enforce initialization lifecycle      (depends on 1.1)
  1.3  Scope sessions per transport          (standalone, can parallel 1.2)
       └─ Expands factory return type to McpTransportHandle
  1.4  Correct Mcp-Session-Id behavior       (depends on 1.2)
  1.5  Remove sessionId from init body       (standalone, 5 min)

Phase 2 (streaming) — depends on P1 completion
  2.1  POST SSE streaming                    (standalone)
  2.2  Progress token plumbing               (depends on 2.1)
  2.3  GET SSE notification facade           (depends on 1.3 — consumes
       └─ sendNotification handles)            McpTransportHandle.sendNotification)

Phase 3 (hardening) — independent of P2, can parallel
  3.1  Content-Type validation               (standalone, 5 min)
  3.2  Origin validation                     (standalone)
  3.3  Allow header on 405                   (standalone, 2 min)
  3.4  Remove dead code                      (standalone, 10 min)
       └─ Also removes old allowedTools param logic (now unused)
```

---

## Testing Strategy

### Unit tests (`server/mcp/transport.test.ts` — new file)

| Test | Phase | Validates |
| --- | --- | --- |
| `initialize` returns session ID + protocol version | P1 | 1.4 |
| `notifications/initialized` accepted, 202 returned | P1 | 1.1 |
| `tools/list` before `initialize` → 400 | P1 | 1.2 |
| Batch `[initialize, tools/list]` → 400 "must not be batched" | P1 | 1.2 |
| Solo `initialize` in array `[initialize]` → 200 (valid) | P1 | 1.2 |
| Session from `/architect` rejected on `/worker` | P1 | 1.3 |
| `initialize` result body has no `sessionId` field; header present | P1 | 1.5 |
| POST with `Accept: text/event-stream` → SSE response | P2 | 2.1 |
| Progress events emitted when `progressToken` present | P2 | 2.2 |
| `sendSessionNotification` writes to GET stream | P2 | 2.3 |
| POST without `Content-Type: application/json` → 415 | P3 | 3.1 |
| Unknown HTTP method → 405 with `Allow` header | P3 | 3.3 |

### Integration test (extend `tests/smoke.spec.ts` or new `tests/mcp.spec.ts`)

Full handshake flow:
1. POST `initialize` → 200, session ID in header
2. POST `notifications/initialized` → 202
3. POST `tools/list` → 200, tools array
4. POST `tools/call` with `Accept: text/event-stream` → SSE stream, result
5. DELETE with session ID → 200
6. POST `tools/list` with dead session → 400

---

## Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| UC MCP Service sends bare `initialized` (not `notifications/initialized`) | Accept both forms (1.1) |
| Existing clients break on initialization enforcement | Return clear error message with instructions; log for observability |
| Client batches `initialize` + `notifications/initialized` together | Start strict (reject); relax guard if logs show a real client doing this (1.2 escape hatch documented) |
| SSE streaming adds complexity to error handling | Wrap in try/catch, send error as final SSE event before `res.end()` |
| Session scoping breaks the internal `/mcp` full endpoint | Internal path gets its own session store (same fix applies uniformly) |
| Progress callbacks add latency even when unused | Callback is `undefined` when no `progressToken` — zero overhead path |

---

## Out of Scope (Addressed by Versioning Strategy)

These items belong to the `2026-07-28` transport (`transport-v26.ts`) per
`docs/design/2026-08-20_mcp-protocol-versioning-strategy.md`:

- Removal of sessions / stateless operation
- `_meta` per-request identity and capabilities
- `Mcp-Method` / `Mcp-Name` routing headers
- `server/discover` RPC
- List caching (`ttlMs`, `cacheScope`)
- Multi Round-Trip Requests (MRTR)
- Extensions framework

---

## Estimated Effort

| Phase | Effort | Blocking? |
| --- | --- | --- |
| P1 | 2–3 hours | Yes — protocol correctness |
| P2 | 4–6 hours | Soft — improves reliability |
| P3 | 1–2 hours | No — polish |
| Tests | 3–4 hours | Parallel with implementation |
| **Total** | **10–15 hours** | |

---

## Decisions (Accepted 2026-08-25)

### 1. Phase 2.3 (GET SSE): Implement facade now, dormant

**Decision:** Implement the two-layer notification architecture now:
1. Per-transport `sendNotification` bound to closure-scoped sessions (in
   `McpTransportHandle`, returned by `createMcpTransport()` — ships with 1.3)
2. Unified `sendSessionNotification()` facade in `index.ts` that fans out
   across all transport handles (ships with 2.3)

GET endpoint remains functional but dormant (no active event producers until
dispatch push).

**Rationale:**
- Skeleton is 80% complete (keepalive, `sseResponse` stored). Bound helper is
  ~10 LOC per transport; facade is ~10 LOC in `index.ts`.
- Closure-scoped sessions (1.3) require the notification handle to be returned
  from the factory — a module-level export can no longer reference a global Map.
  The facade in `index.ts` resolves this by trying each handle (UUID uniqueness
  guarantees at-most-one hit; fan-out is 5× Map.has() — nanoseconds).
- Dispatch engine's `ActionExecutor` callback pattern is ready to wire — but
  only if the SSE plumbing exists when that work starts.
- UC MCP Service and AI Playground do NOT open GET SSE streams (stateless POST).
  Only consumers are future React SPA and supervisor live loop (R2 scenarios).
- Decoupling plumbing (now) from consumers (later) avoids touching transport.ts
  under pressure during dispatch-push implementation.
- Mark GET handler JSDoc as "dormant but functional" for clarity.

### 2. Phase 3.2 (Origin): Log-only (observability mode)

**Decision:** Log unexpected Origins at `warn` level; do NOT reject. Graduate to
enforcement only if logs show abuse.

**Rationale:**
- Auth sidecar is the real enforcement boundary — unauthenticated requests never
  reach Express (302 redirect).
- UC MCP Service traffic is server-to-server with **no Origin header**. A strict
  allowlist that rejects missing Origin would break the primary consumer.
- AI Playground sends `Origin: https://<workspace>.cloud.databricks.com`. A
  strict allowlist needs all possible workspace domains (multi-region, Azure/AWS/
  GCP patterns) — fragile and maintenance-heavy.
- DNS rebinding requires attacker code execution in victim's browser AND ability
  to resolve hostname to app's private IP AND a valid Databricks auth token.
  Implausible given the sidecar.
- Implementation: log to `hi_genie_otel_logs` via `console.warn`; set up alert
  threshold if unexpected origins spike.

```typescript
const origin = req.headers.origin;
if (origin && !isExpectedOrigin(origin)) {
  console.warn(`[mcp/transport] Unexpected origin: ${origin}, user=${userId}`);
}
```

### 3. `Last-Event-ID` resumability: Defer to R2

**Decision:** Do NOT implement now. Add when first active SSE consumer deploys.

**Rationale:**
- Resumability requires monotonic event IDs, a replay buffer (ring or DB-backed),
  and `Last-Event-ID` header parsing on GET reconnect — meaningful complexity.
- GET SSE currently emits zero events. Decision 1 adds the helper but no active
  producers. Building replay infrastructure for a dormant stream is waste.
- 2025-11-25 spec says servers MAY support resumability — it is not a MUST.
- When dispatch push deploys (R2), event shape and frequency will inform buffer
  sizing. Designing now without throughput data would be guesswork.
- **Gate for R2:** First PR that adds an active SSE producer MUST include
  `Last-Event-ID` support in the same changeset.

### Summary

| Decision | Choice | Effort | Revisit Gate |
| --- | --- | --- | --- |
| GET SSE notification | Two-layer: bound handle (1.3) + facade (2.3), dormant | 45 min | — |
| Origin validation | Log-only | 20 min | Logs show unexpected traffic |
| `Last-Event-ID` | Defer to R2 | 0 now | First active SSE consumer deployed |

---

## Appendix: Spec References

- [Streamable HTTP Transport](https://spec.modelcontextprotocol.io/specification/2025-11-25/basic/transports/#streamable-http)
- [Session Lifecycle](https://spec.modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle/)
- [Progress Notifications](https://spec.modelcontextprotocol.io/specification/2025-11-25/server/utilities/progress/)
- [Tool Results](https://spec.modelcontextprotocol.io/specification/2025-11-25/server/tools/)
