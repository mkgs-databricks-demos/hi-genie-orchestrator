# Session: DAG Validation and Corrections

**Date:** 2026-08-17  
**Duration:** ~20 min  
**Stage:** Pre-provisioning review (between Quick Start Step 2 and Step 3)

## Objective

Validate the orchestration plan.json, DAG structure, and state files against
the updated workstream-orchestrator skill before beginning autonomous execution.

## Problems Found

1. **`critical_path_min` was incorrect (270 vs actual 300)**  
   Root cause: arithmetic error in original plan generation. The declared
   critical path `[ws-0, ws-a, ws-b, ws-d, ws-e, ws-final]` sums to
   45+45+60+60+60+30 = 300.

2. **`estimated_total_min: 405` matched neither sequential nor parallel total**  
   Root cause: ambiguous metric without clear semantics. Sequential sum = 465;
   parallel duration = 300. Neither matches 405.

3. **`ws-0` had empty `gate_conditions: []`**  
   Root cause: foundation workstreams have no upstream dependencies, but the
   dag-builder pre-output checklist requires ≥1 gate per workstream.

4. **`max_retries: 2` was conservative for a complex app build**  
   Decision: increase to 5 across all workstreams per user request.

## Changes Made

| File | Change |
| --- | --- |
| `orchestration/plan.json` | `critical_path_min`: 270 → 300 |
| `orchestration/plan.json` | Replaced `estimated_total_min: 405` with `sequential_total_min: 465` + `parallel_duration_min: 300` |
| `orchestration/plan.json` | Added `orchestration_active` gate to ws-0 |
| `orchestration/plan.json` | All 9 workstreams: `max_retries` → 5 |
| `orchestration/state/workstream-ws-0-status.md` | `max_retries`: 2 → 5 |
| `orchestration/state/workstream-ws-a-status.md` | `max_retries`: 2 → 5 |
| `orchestration/state/workstream-ws-b-status.md` | `max_retries`: 2 → 5 |
| `orchestration/state/workstream-ws-c-status.md` | `max_retries`: 2 → 5 |
| `orchestration/state/workstream-ws-d-status.md` | `max_retries`: 2 → 5 |
| `orchestration/state/workstream-ws-e-status.md` | `max_retries`: 2 → 5 |
| `orchestration/state/workstream-ws-f-status.md` | `max_retries`: 2 → 5 |
| `orchestration/state/workstream-ws-g-status.md` | `max_retries`: 2 → 5 |
| `orchestration/state/workstream-ws-final-status.md` | `max_retries`: 1 → 5 |

## Decisions

- Use two explicit duration metrics (`sequential_total_min`, `parallel_duration_min`)
  instead of one ambiguous `estimated_total_min`.
- Foundation workstreams use an `orchestration_active` gate type to satisfy
  the schema rule without fabricating a dependency.
- All workstreams get 5 retries to accommodate the complexity of a full
  TypeScript App build with Lakebase, MCP, and AppKit integration.

## Validation Summary

Passed all dag-builder pre-output checks after corrections:
- ✅ Acyclic DAG (Kahn's sort valid)
- ✅ All `depends_on` references resolve
- ✅ ws-final depends on all others
- ✅ File scope isolation (no parallel overlap)
- ✅ Valid execution backends
- ✅ Duration sizing within 15–90 min bounds
- ✅ Every workstream has ≥1 gate_condition
- ✅ orchestration_id matches pattern
- ✅ State files match plan.json (depends_on, max_retries)

## Next Steps

- Read `OPEN_QUESTIONS.md` for any implementation decisions needed before provisioning
- Execute provisioning protocol (Quick Start Step 3): create state directory ✓,
  instantiate orchestration-status ✓, synthesize WS-INIT prompt, schedule
  WS-INIT, activate
- Monitor ws-e (Event Dispatch) closely — most complex workstream on critical path

## Commit

```
fix: correct DAG metadata, add ws-0 gate, increase max_retries to 5
```

Pushed to `mg-genie-hi-genie-r1`.
