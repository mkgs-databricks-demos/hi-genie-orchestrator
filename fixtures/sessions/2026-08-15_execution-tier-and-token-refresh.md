# Session: Execution Tier & Token Refresh Verification

**Date:** 2026-08-15T04:30:00Z  
**Branch:** `mg-genie-plan-json-ws-init-lifecycle`  
**Commits:** 6 (this session)

---

## Problems Addressed

1. **OAuth token expiry for long LISTEN sessions** — Will the Dispatcher App's persistent Lakebase connection die after the 1-hour token expires?
2. **Missed notifications during reconnect** — If the connection drops, how do we guarantee no signals are lost?
3. **No observability for the dispatch pipeline** — Catch-up events, reconnect frequency, and tier distribution had no metrics.
4. **No execution_tier in plan schema** — WS-INIT couldn't differentiate between job-backed, inline, or Genie-scheduled dispatch.
5. **ws-init-template still assumed single dispatch path** — Always created a Genie scheduled task regardless of workstream characteristics.

---

## Root Causes / Findings

### Token Refresh (Non-Issue)

Postgres authenticates at **connection establishment only**. Once the LISTEN connection is open:
- Token expiry is irrelevant (no per-query re-auth)
- `idle_session_timeout = 0` (connection never idle-killed)
- TCP keepalives (60s idle → probe 10s × 6) detect dead connections in ~120s
- Token rotation does NOT invalidate existing connections

**Conclusion:** The Dispatcher App needs a **reconnect loop**, not a token refresh cycle.

### Missed Notifications

`pg_notify` does NOT queue for disconnected listeners. Signals fired during the reconnect window (2–120s) are lost from NOTIFY's perspective.

**Solution:** `completion_signals.dispatched = FALSE` provides durable catch-up. After every reconnect, query for undispatched signals before re-entering LISTEN.

### Concurrency Safety

`FOR UPDATE SKIP LOCKED` verified: two concurrent Dispatchers racing on the same signal → exactly one wins. Enables multi-instance HA without double-dispatch.

---

## Changes Made

### `architecture/automated-kick-mechanism.md`
- Added "Token Refresh / Session Lifetime" section with test results table
- Added `ResilientListener` reconnect pattern (exponential backoff)
- Added "Missed-Notification Catch-Up Query" section (full design)
  - Catch-up SQL (cross-orch + scoped variants)
  - Dispatcher reconnect flow (7-step sequence)
  - Concurrency safety proof
  - Edge case table (5 scenarios)
  - `ResilientListener.catch_up()` implementation
- Updated open questions (Q6 answered, Q9 added)

### `skill/tracking/observability.md`
- Added "Catch-Up & Dispatcher Metrics" section:
  - Signal Pipeline metrics (5 metrics)
  - Catch-Up metrics (5 metrics)
  - Reconnect metrics (5 metrics)
  - Tier Distribution metrics (4 metrics)
  - 4 dashboard-ready SQL queries
  - 5 alerting conditions with severity/detection/action
  - Verified baselines table (7 measurements)
- Updated cross-references

### `templates/plan-schema.md`
- Added `ExecutionTier` type definition (`tier`, `job_id`, `notebook_path`, `timeout_seconds`, `requires_genie_tools`)
- Added tier reference table (4 tiers: latency, tooling, use-case)
- Added selection heuristic (decision tree)
- Updated complete example (all 5 workstreams show execution_tier)
- Added 2 semantic validation rules (tier_1 vs genie_tools conflict, tier_0 duration cap)
- Added 2 warnings (tier_1 without job_id, genie_tools conflict)
- Schema version bumped to 1.1.0

### `templates/ws-init-template.md`
- IDENTITY: added Dispatcher Job ID and Lakebase endpoint
- STATE RECONSTRUCTION: added run_id tracking, execution_tier per workstream
- Priority 3 (Silent Failure): tier_1 checks Jobs API lifecycle state
- Priority 4 (Pause): scoped to tier_2/3 only
- Priority 7 (Ready to Launch): mentions tier-aware dispatch
- ACTION: CREATE_NEXT Step 3: rewritten as 4-tier dispatch (inline / job / genie+kick / genie+cron)
- Step 4: records execution_tier_used for fallback tracking
- VARIABLE REFERENCE: added 2 new variables

### `PROJECT_MEMORY.md`
- Tech stack: added pg_notify + Dispatcher App line
- Directory structure: added automated-kick-mechanism.md
- Lessons learned: added #5 (token refresh), #6 (SKIP LOCKED), #7 (tier dispatch)
- Phase status updated
- Completed items: 10 new entries (automated kick mechanism section)
- Next items: replaced stale TODOs with Dispatcher prototype, scale-to-zero, HA, E2E test

---

## Key Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | Token refresh unnecessary | Postgres auth is connection-level. Reconnect with fresh token is sufficient. |
| 2 | Catch-up query runs BEFORE re-LISTEN | Guarantees no notification is missed during the outage window. |
| 3 | FOR UPDATE SKIP LOCKED for claim | Enables concurrent Dispatcher instances without double-dispatch. |
| 4 | execution_tier is optional (default tier_3) | Backward-compatible. Existing plans work unchanged. |
| 5 | Schema version → 1.1.0 (not 2.0.0) | New field is additive. No breaking changes to existing plans. |
| 6 | tier_1 + requires_genie_tools = validation error | Jobs API workers cannot access Genie tools. Catch conflicts at plan validation. |
| 7 | tier_0 capped at estimated_duration ≤ 5 min | Inline execution blocks WS-INIT's tick. Must be trivial. |

---

## Verified Test Results

| Test | Result |
| --- | --- |
| Token TTL | 60 min (fresh per `generate_database_credential` call) |
| Token caching | NOT cached — each call returns a new JWT |
| Connection survival after token rotation | PASS — old connection unaffected |
| idle_session_timeout | 0 (disabled — connection lives forever) |
| TCP keepalives | 60s idle → probe 10s × 6 |
| NOTIFY after 5s idle | Delivered ✓ |
| NOTIFY after 30s sustained session | Delivered ✓ |
| Simulated disconnect + reconnect | 2s recovery (backoff + token gen + LISTEN) |
| FOR UPDATE SKIP LOCKED (2 concurrent dispatchers) | Exactly-one-wins ✓ |
| Catch-up query (4 pending signals) | All claimed + dispatched atomically ✓ |
| Second catch-up (same signals) | 0 rows (exactly-once) ✓ |

---

## Files Modified

| File | Lines Changed | Type |
| --- | --- | --- |
| `architecture/automated-kick-mechanism.md` | +180 | Token refresh results, catch-up design |
| `skill/tracking/observability.md` | +160 | Catch-up & Dispatcher metrics section |
| `templates/plan-schema.md` | +120 | ExecutionTier definition, examples, validation |
| `templates/ws-init-template.md` | +100 | Tier-aware dispatch in CREATE_NEXT |
| `PROJECT_MEMORY.md` | +30 | Status update |
| `fixtures/sessions/INDEX.md` | +1 | This session entry |
| `fixtures/sessions/2026-08-15_execution-tier-and-token-refresh.md` | +130 | This file |

---

## Open Items (Remaining)

- [ ] Prototype Dispatcher App (Pattern A: LISTEN → jobs.run_now)
- [ ] Test scale-to-zero wake + reconnect timing
- [ ] Design HA with multiple Dispatcher App instances
- [ ] End-to-end test on real project
- [ ] Delete orphaned file at wrong path (`/genie-workstream-orchestrator/fixtures/sessions/`)
