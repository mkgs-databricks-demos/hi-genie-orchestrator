# Session: WS-B — Core Decomposition & DAG Builder

**Date:** 2026-08-15  
**Orchestration:** `orch-2026-08-14-self-build`  
**Workstream:** `ws-b` (Core Decomposition & DAG Builder)  
**Status:** COMPLETE  

---

## Summary

Executed workstream ws-b of the self-build orchestration. Produced two core skill modules that form the orchestrator's planning brain: the decomposition engine (parsing user input into candidate workstreams) and the DAG builder (wiring candidates into a validated, schedulable plan.json).

## Problems Encountered

- `editAsset` with full workspace path as `id` failed on a freshly-created file ("request was invalid"). Root cause: the file was too new / empty for path-based editing.
- **Resolution:** Switched to numeric asset ID (`2363651208879809`) which worked immediately.

## Changes Made

### Files Created

| File | Lines | Purpose |
| --- | --- | --- |
| `skill/core/decomposition.md` | ~380 | Input classification, deliverable extraction, sizing, confidence scoring |
| `skill/core/dag-builder.md` | ~480 | Dependency inference, cycle detection, isolation validation, plan.json generation |

### State Transitions

- `orchestration/state/workstream-ws-b-status.md`: NOT_STARTED → IN_PROGRESS → COMPLETE
- Notes for downstream populated with full artifact inventory and capability summary

## Key Decisions

1. **Decomposition uses a 5-type classification system** — Architecture docs, PRDs, Codebases, Conversation threads, Pre-built DAGs. Decision tree classifies by primary structure.

2. **Confidence scoring drives user interaction** — High = no confirmation, Medium = present for confirmation, Low = MUST confirm. Maximum 3 iteration rounds.

3. **DAG builder uses Kahn's algorithm** for topological sort / cycle detection — chosen for clarity and because it naturally produces level assignments for parallelism.

4. **Three dependency types defined** — `status_complete` (hard block), `table_exists` (artifact-gated, decoupled), `soft` (best-effort). This matches the state machine's gate_conditions.

5. **Isolation validation is strict** — Parallel pairs must have disjoint file_scope AND output_artifacts. Conflicts resolve via: add edge > split artifact > merge workstreams.

6. **Plan.json has 12 pre-output validation rules** — Emission is blocked if any fail. No partial plan output.

7. **WS-FINAL is always injected** — Depends on ALL, produces summary, verifies gates. Type: `final`.

## Files Modified

- `skill/core/decomposition.md` (created)
- `skill/core/dag-builder.md` (created)
- `orchestration/state/workstream-ws-b-status.md` (status updates + downstream notes)

## Cross-References

- `decomposition.md` outputs feed into `dag-builder.md`
- `dag-builder.md` outputs (plan.json) consumed by `core/prompt-synthesis` and `tracking/lakebase-schema`
- Both modules reference `core/state-machine` for state transition rules
- Plan.json schema matches the structure in `plan.json` at project root
