# Session: WS-A — Core State Machine

**Date:** 2026-08-15  
**Orchestration:** `orch-2026-08-14-self-build`  
**Workstream:** `ws-a` (Core State Machine)  
**Status:** COMPLETE  

---

## Summary

Executed workstream ws-a of the self-build orchestration. Produced the foundational state machine module that defines the vocabulary ALL other modules depend on: the 7-state enum, valid transitions, guard conditions, timeout rules, retry semantics, and the three downstream contracts (backend, tracking, prompt synthesis).

## Problems Encountered

- `editAsset` with full workspace path as `id` failed on a freshly-created empty file ("Failed to read current content: The request was invalid").
- **Resolution:** Switched to numeric asset ID (`2363651208879808`) for the write operation, which succeeded immediately. Same issue previously documented in ws-b session.

- `skill/core/` directory did not exist.
- **Resolution:** Created via `createAsset` (type: directory) before file creation.

## Changes Made

### Files Created

| File | Lines | Purpose |
| --- | --- | --- |
| `skill/core/state-machine.md` | ~355 | 7-state enum, transitions, guards, timeouts, retry semantics, orchestration states, claim protocol, contracts |

### Directories Created

| Path | Purpose |
| --- | --- |
| `skill/core/` | Container for all core skill modules |

### State Transitions

- `orchestration/state/workstream-ws-a-status.md`: NOT_STARTED → IN_PROGRESS → COMPLETE
- Notes for downstream populated with full artifact inventory and contract summary

## Key Decisions

1. **7-state enum** — NOT_STARTED, GATED, IN_PROGRESS, VALIDATING, COMPLETE, BLOCKED, RETRYING. GATED is transient (same-transaction as claim, no separate trigger).

2. **Atomicity via editAsset old_text matching** — Compare-and-swap semantics on files. If `old_text` not found (another instance claimed), edit returns `changed: false` → exit. No database needed.

3. **attempt_count never resets** — Tracks total attempts across BLOCKED resets. Provides full retry history without a separate log.

4. **max_retries defaults to 3** — Overridable per workstream spec. Strategy escalation: standard → doc search → minimal execution → BLOCKED.

5. **Timeout detection via elapsed-time checks** — No wall-clock timers. Workstreams check elapsed time before each major operation. Graceful shutdown at >55 min.

6. **Three downstream contracts specified** — Backend (which states to set), Tracking (event schema), Prompt Synthesis (decision points to embed). Each is self-contained and actionable.

7. **10 invariants codified** — Enforceable rules that hold across all states (COMPLETE terminal, BLOCKED human-only, etc.).

## Files Modified

- `skill/core/state-machine.md` (created)
- `orchestration/state/workstream-ws-a-status.md` (status updates + downstream notes)

## Cross-References

- `state-machine.md` consumed by: `core/prompt-synthesis`, `backends/*`, `tracking/*`
- Backend Contract defines which states backends set vs never set (used by ws-d backend modules)
- Tracking Contract defines event schema (used by ws-e tracking modules)
- Prompt Synthesis Contract defines decision points (used by ws-c prompt synthesis)
- Claim Protocol + Guard Conditions directly implemented in every generated worker prompt

## Orchestration Progress

At session end, all skill modules are complete:

| Workstream | Status |
| --- | --- |
| ws-a (Core State Machine) | COMPLETE |
| ws-b (Core Decomposition & DAG Builder) | COMPLETE |
| ws-c (Core Prompt Synthesis) | COMPLETE |
| ws-d (Backend Modules) | COMPLETE |
| ws-e (Tracking Modules) | COMPLETE |
| ws-final (Integration Verification) | IN_PROGRESS |
