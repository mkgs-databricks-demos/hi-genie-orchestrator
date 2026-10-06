# Session: 2026-08-14 — Self-Build plan.json & WS-INIT Lifecycle Control

## Summary

Generated the dogfood `plan.json` for the orchestrator to build itself, then
made a significant architectural decision: WS-INIT owns all task lifecycle
control (workers never self-pause). Updated 5 documents for consistency.

## Work Done

### 1. Self-Build plan.json (Dogfood)

Created `plan.json` conforming to `plan-schema.md` — 6 workstreams, 10 output
files, using the orchestrator's own schema to define the plan that builds
the orchestrator.

**DAG:**
```
ws-a (state machine) ─┬─► ws-c (prompt synthesis) ─► ws-final
                      ├─► ws-d (backends)          ─►
                      └─► ws-e (tracking)          ─►
ws-b (decomp + DAG)  ─────► ws-c                   ─►
```

**Design choices:**
- `execution_backend: custom` (all workstreams produce skill markdown)
- `state.mode: file` (no Lakebase for the build itself)
- `git.enabled: true` (branch prefix: `mg-genie-orchestrator-build`)
- No bundles (skill files, not deployable infra)

### 2. Scheduled Tasks API Investigation

Researched the `alerts-internal` REST API for monitoring scheduled tasks:
- `scheduled-insights-list` — enumerate tasks by user ID
- `scheduled-insights/<id>` — inspect (schedule, paused, etag)
- `scheduled-insights-history/<id>` — run history (fire times, completion)
- PATCH with etag — pause/resume/edit/delete

### 3. Architectural Decision: WS-INIT Owns Task Lifecycle

**Decision:** Workers NEVER self-pause. WS-INIT is the sole controller of
all scheduled task lifecycles — create, confirm fire, pause, monitor, retry, cleanup.

**Rationale:**
- Simpler worker prompts (zero scheduling API knowledge)
- Single point of control (no race conditions)
- Better failure detection (WS-INIT catches crashed workers via API)
- Trivial retry (just unpause the task; worker re-fires fresh)

### 4. Documents Updated (5 files)

| File | Changes |
| --- | --- |
| `architecture/ws-init-protocol.md` | Added "Scheduled Task API Monitoring" section, "Task Lifecycle Control" section, new Priority 3 (RECOVER_SILENT_FAILURE), Priority 4 (PAUSE_RUNNING_WORKER), `task_paused` state field, 10-priority decision tree |
| `architecture/scheduling-contract.md` | Replaced "Self-Pause Mechanism" with "WS-INIT Lifecycle Control", rewrote task lifecycle timeline, simplified cron strategy (all workers `*/3 min`), replaced prompt injection section |
| `architecture/execution-protocol.md` | Removed self-pause from Phase 2 Claim, added "Note: No Self-Pause", updated atomicity explanation |
| `templates/worker-prompt-template.md` | Replaced self-pause block with state guard, removed all alerts-internal API instructions |
| `templates/ws-init-template.md` | Expanded decision tree to 10 priorities, added PAUSE_RUNNING_WORKER + RECOVER_SILENT_FAILURE action sections, removed self-pause injection from CREATE_NEXT, added defensive cleanup to SELF_COMPLETE |

## Key Design Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | Workers are scheduling-unaware | Simplicity; single point of control; better failure detection |
| 2 | WS-INIT pauses workers after confirming FIRED_RUNNING | Fire-once semantics without worker cooperation |
| 3 | RECOVER_SILENT_FAILURE at Priority 3 (high) | Dead workers block the DAG; fast detection is critical |
| 4 | PAUSE_RUNNING_WORKER at Priority 4 | Time-sensitive (prevents double-fire); outranks new work creation |
| 5 | IN_PROGRESS state check as backup guard | Covers the 3-6 min window before WS-INIT pauses the task |
| 6 | API monitoring is supplementary (graceful degradation) | API failures never block orchestration; state layer is primary |

## Files Created

- `plan.json` (new)

## Files Modified

- `PROJECT_MEMORY.md` (status update, directory structure, DAG visualization)
- `architecture/ws-init-protocol.md` (API monitoring, lifecycle control)
- `architecture/scheduling-contract.md` (WS-INIT lifecycle control)
- `architecture/execution-protocol.md` (remove self-pause)
- `templates/worker-prompt-template.md` (remove self-pause)
- `templates/ws-init-template.md` (new priorities + actions)
- `plan.json` (context doc purposes)

## Next Steps

1. Commit all changes to a feature branch
2. Start building ws-a (Core State Machine module) — or synthesize
   the WS-INIT prompt and actually launch the self-build orchestration
3. Resolve open design decisions from INDEX.md (interactive vs one-shot
   decomposition, shared vs per-orchestration Lakebase project, etc.)
