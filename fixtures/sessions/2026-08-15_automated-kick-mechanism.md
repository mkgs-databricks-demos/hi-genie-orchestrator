# Session: Automated Kick Mechanism Design + pg_notify Verification

**Date:** 2026-08-15T03:21–03:55 UTC  
**Scope:** Eliminate "Run now" human dependency for worker task activation  
**Outcome:** Design complete + pg_notify verified on Lakebase (<18ms/signal)

---

## Problems Addressed

1. **Activation gap:** Workers created by WS-INIT require a human "Run now" click or wait up to 60 min for hourly cron
2. **No programmatic Run Now:** The `/execute` endpoint is CSRF-protected (browser-only)
3. **WS-INIT cadence:** Platform enforces minimum 1-hour cron for all scheduled tasks

## Root Causes

- Databricks scheduled tasks have no API for imperative execution
- Hourly minimum cron interval is platform-enforced (not a tool-level restriction)
- Workers needing Genie Code tools cannot be replaced with Jobs (different execution context)

## Approach: Tiered Kick Strategy

Designed a 4-tier execution model that matches worker requirements to the fastest substrate:

| Tier | Mechanism | Latency | Genie Tools? |
| --- | --- | --- | --- |
| 0 — Inline | WS-INIT executes directly | 0s | Yes |
| 1 — Job-Backed | `jobs.run_now()` via SDK | <30s | No |
| 2 — Genie + Human Kick | Current model | ~0s (click) | Yes |
| 3 — Genie + Cron Only | Unattended fallback | 0–60 min | Yes |

## Key Innovation: Lakebase LISTEN/NOTIFY (Pattern A)

Instead of Delta table triggers, workers signal completion via Postgres INSERT, which fires `pg_notify()` via a PL/pgSQL trigger. A lightweight Dispatcher App listens and calls `jobs.run_now()` immediately.

**Total activation chain:** Worker commit → pg_notify → App receives → jobs.run_now → Dispatcher starts ≈ **30-45 seconds**

## Verification Tests

### Canary Test: Recursive Scheduling
- Created child scheduled task from parent context via `scheduleAgentTool`
- Child executed (wrote `CHILD_EXECUTED: true` to file)
- SDK list endpoint shows all 10 user tasks with full metadata
- **PASS:** Recursive scheduling works

### pg_notify E2E Test
- **Target:** `dev-matthew-giglia-lakeloom` / `databricks_postgres`
- **Created:** table, PL/pgSQL function, AFTER INSERT trigger
- **Tested:** 3 INSERTs (2×COMPLETE, 1×FAILED) with LISTEN connection
- **Results:** 53ms total round-trip, <18ms per notification
- **All Postgres features verified:** CREATE FUNCTION, CREATE TRIGGER, pg_notify, LISTEN, json_build_object
- **PASS:** Pattern A is production-viable

## Decisions Made

| Decision | Rationale |
| --- | --- |
| Lakebase NOTIFY over Delta tableUpdate trigger | Already have state layer in Lakebase; sub-20ms vs ~60s latency |
| Dispatcher App (Pattern A) over polling (Pattern C) | True event-driven; zero CPU when idle; familiar pattern (lakeLoom, scAuditor) |
| BIGSERIAL for completion_signals PK (not UUID) | Event ordering matters for replay; monotonic IDs enable gap detection |
| `signal_type` enum includes FAILED/RETRY_REQUESTED | Enables event-driven retry without polling |
| Hybrid WS-INIT (Dispatcher Job + Genie task) | Dispatcher handles fast path; Genie handles reasoning/retries |

## Files Modified

| File | Change |
| --- | --- |
| `architecture/automated-kick-mechanism.md` | **NEW** — Full design doc (~500 lines): tiered strategy, 3 Lakebase patterns, Dispatcher App impl, timing comparison, verified test results |
| `skill/tracking/lakebase-schema.md` | Added `completion_signals` table DDL, `notify_completion_signal()` function, trigger, indexes, deployment order (steps 9-10), constraints row, cross-references |
| `orchestration/child-worker-result.md` | **NEW** — Canary test artifact (`CHILD_EXECUTED: true`) |
| `PROJECT_MEMORY.md` | Updated tech stack, lessons learned, directory structure (12 arch files), next items |
| `fixtures/sessions/INDEX.md` | Added this session entry |

## Open Items for Next Session

1. Prototype Dispatcher App (minimal: LISTEN loop + `jobs.run_now()`)
2. Test scale-to-zero wake latency for App LISTEN connection
3. Test OAuth token refresh during long-lived LISTEN sessions
4. Implement `FOR UPDATE SKIP LOCKED` claim pattern in Dispatcher notebook
5. Add `execution_tier` field to `plan-schema.md` template
