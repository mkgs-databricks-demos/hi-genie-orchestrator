# Session: MCP Transport Protocol Compliance Audit

**Date:** 2026-08-25  
**Branch:** `mg-genie-r2-mcp-consolidation`  
**Duration:** ~45 min  

---

## Summary

Researched latest MCP protocol versions (web search), then performed a full
compliance audit of `server/mcp/transport.ts` against the 2025-11-25 Streamable
HTTP specification. Identified 10 gaps (3 critical, 3 high, 4 low) and produced
a phased remediation plan with implementation sketches and testing strategy.

---

## Problems Identified

| # | Issue | Severity |
| --- | --- | --- |
| 1 | Wrong notification method name (`initialized` vs `notifications/initialized`) | Critical |
| 2 | No initialization enforcement — requests accepted before `initialize` | Critical |
| 3 | Session store global — shared across persona transports | High |
| 4 | `Mcp-Session-Id` returned on non-initialize responses before session exists | High |
| 5 | No SSE streaming on POST for long-running `tools/call` | High |
| 6 | No `_meta.progressToken` support | Medium |
| 7 | GET SSE stream never emits actual MCP events (dead letter) | Medium |
| 8 | No `Content-Type: application/json` validation on POST | Low |
| 9 | No `Origin` header validation (DNS rebinding) | Low |
| 10 | Missing `Allow` header on 405 | Low |
| 11 | Dead 2-persona code (`WORKER_TOOLS`/`SUPERVISOR_TOOLS`) — superseded by 4-persona index.ts | Low |

---

## Root Causes

- **Initial implementation targeted broad protocol shape** (POST/GET/DELETE,
  JSON-RPC 2.0, session header) but did not address the strict lifecycle
  requirements (initialize-first, notification method naming convention).
- **POST SSE streaming** was deferred during R1 because tool latency was
  acceptable (<5s). Becomes relevant for `orchestrate_plan` which coordinates
  multiple workstreams.
- **Persona evolution** left dead code — the 2-persona split in transport.ts was
  superseded by the 4-persona `buildIncludeRegistry` approach in index.ts.

---

## Changes Made

| File | Action |
| --- | --- |
| `docs/design/2026-08-25_transport-2025-11-25-compliance-plan.md` | **Created** — full 3-phase remediation plan (protocol correctness, streaming/progress, hardening) |
| `docs/design/INDEX.md` | **Updated** — added new design doc entry |

---

## Decisions

1. **Scope to 2025-11-25 only.** The 2026-07-28 stateless spec is addressed by
   the existing versioning strategy doc (`transport-v26.ts`). This plan fixes
   the current deployed transport.
2. **Three open decisions deferred to review:**
   - GET SSE: implement helper now (dormant) or defer?
   - Origin validation: strict allowlist or log-only?
   - `Last-Event-ID` resumability: now or R2?
3. **Phase 1 is blocking** — protocol correctness issues can cause handshake
   failures with UC MCP Service clients and AI Playground.

---

## Context: MCP Spec Landscape (as of 2026-08-25)

| Version | Released | Key Theme |
| --- | --- | --- |
| 2025-06-18 | Jun 2025 | Structured output, elicitation, Streamable HTTP |
| 2025-11-25 | Nov 2025 | OIDC discovery, incremental consent, URL elicitation |
| 2026-07-28 | Jul 2026 | **Stateless** — no sessions, MRTR, header routing, cacheable lists |

The 2026-07-28 spec is a major break: removes `initialize`/`initialized`,
removes `Mcp-Session-Id`, introduces Multi Round-Trip Requests (MRTR). Our
versioning strategy (A/B dual apps) handles the migration path.

---

## Files Modified

- `docs/design/2026-08-25_transport-2025-11-25-compliance-plan.md` (new)
- `docs/design/INDEX.md` (updated)

---

## Next Steps

1. Review the 3 open decisions in the plan
2. Implement Phase 1 (protocol correctness) — estimated 2-3 hours
3. Write `server/mcp/transport.test.ts` unit tests in parallel
4. Deploy and validate handshake with AI Playground
