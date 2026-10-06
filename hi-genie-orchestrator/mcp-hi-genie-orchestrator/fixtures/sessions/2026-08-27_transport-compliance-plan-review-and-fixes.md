# Session: Transport Compliance Plan Review & Fixes

**Date:** 2026-08-27  
**Branch:** `mg-genie-r2-mcp-consolidation`  
**Commit:** `0328316`  
**Duration:** ~30 min

---

## Problems Addressed

### 1. `sendSessionNotification` vs closure-scoped sessions (P1.3 ↔ P2.3 conflict)

**Root cause:** Phase 1.3 moves the `sessions` Map into the `createMcpTransport()` closure for persona isolation. Phase 2.3's original design exported a module-level `sendSessionNotification()` that referenced the global `sessions` Map — which no longer exists after 1.3.

**Resolution:** Two-layer notification architecture:
- **Layer 1 (transport.ts):** Factory return type expanded to `McpTransportHandle` with a bound `sendNotification` method closed over the instance's local session store.
- **Layer 2 (index.ts):** Unified `sendSessionNotification()` facade that fans out across all 5 transport handles. UUID uniqueness guarantees at-most-one hit; worst case is 5× `Map.has()` (~nanoseconds).

### 2. Batch-initialize edge case (P1.2 gap)

**Root cause:** The original P1.2 code used `requests.some(r => r.method === 'initialize')` to allow session creation, but didn't address batches like `[initialize, tools/list]`. The spec requires `initialize` to be the sole request in a POST — batching is invalid because (a) no session exists for sibling methods, (b) batch processing order is undefined.

**Resolution:** Added explicit batch-initialize guard that rejects any POST containing `initialize` alongside other methods with a 400 error. Documented an escape hatch for the edge case where older SDKs batch `initialize` + `notifications/initialized` (start strict, relax if logs show real-world occurrence).

---

## Changes Made

| File | Change |
| --- | --- |
| `docs/design/2026-08-25_transport-2025-11-25-compliance-plan.md` | Rewrote P1.3 (McpTransportHandle interface + bound sendNotification), rewrote P2.3 (fan-out facade in index.ts), added batch-initialize guard to P1.2, updated dependency graph (2.3 → 1.3), added 2 unit test rows, added risk row, updated Decision #1 summary |

---

## Decisions

1. **Start strict on batch-initialize** — reject all batches containing `initialize`. Relax only if production logs show a real client doing this. UC MCP Service and AI Playground never batch.
2. **Fan-out over separate lookup** — chose O(5) `Map.has()` fan-out over a shared session registry because it preserves closure isolation (the core goal of P1.3) with negligible performance cost.
3. **`McpTransportHandle` as formal interface** — future-proofs for additional per-transport methods (e.g., `getSessionCount()` for health checks) without expanding the facade.

---

## Review Findings (from initial plan audit)

Identified 7 gaps in the compliance plan; 2 addressed this session, 5 documented for future:

| # | Finding | Status |
| --- | --- | --- |
| 1 | Issue #11 cleanup scope underestimated (dead `allowedTools` param) | Noted in dependency graph |
| 2 | Batch-initialize edge case | **Fixed** |
| 3 | Phase 2.1 `isSingleToolCall` predicate undefined | Open |
| 4 | Phase 2.2 handler signature change (consider context object) | Open |
| 5 | sendSessionNotification + closure conflict | **Fixed** |
| 6 | `handleInitialize` returns `sessionId` in body (spec says header only) | Open |
| 7 | Missing `notifications/cancelled` handling | Open (defer to R2) |

---

## Files Modified

- `docs/design/2026-08-25_transport-2025-11-25-compliance-plan.md` — 151 insertions, 29 deletions

---

## Next Steps

- Implement Phase 1 (protocol correctness): 1.1 → 1.2 → 1.3 → 1.4
- Address remaining open findings (#3, #4, #6) before starting Phase 2
