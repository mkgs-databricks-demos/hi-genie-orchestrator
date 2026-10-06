---
name: dependency-dispatch
description: Dispatch workstreams respecting the dependency DAG — fan out parallel-safe workstreams to workers simultaneously, gate on upstream completion, and advance the orchestration wave by wave.
---

# dependency-dispatch — DAG-aware parallel execution

Use when multiple workstreams are ready and their dependency graph allows
parallel execution. The server enforces dependency gates, but the orchestrator
should plan dispatch waves proactively.

## Procedure
1. Get the current orchestration state:
   `sys_session_send(agent="dispatcher", title="list-workstreams",
   args={purpose: "orchestrate", input: "list_workstreams for orchestration
   <id>. Report status of each workstream, its depends_on, and execution_tier."})`.
   Collect via `sys_read_inbox`.

2. Identify the ready wave — workstreams where:
   - Status is `NOT_STARTED` or `GATED`
   - ALL `depends_on` workstreams are `COMPLETE`
   - Same `execution_tier` (or lowest tier with ready work)

3. For each workstream in the ready wave, dispatch in parallel:
   a. `sys_session_send(agent="dispatcher", title="dispatch-<ws_key>",
      args={purpose: "orchestrate", input: "dispatch_workstream for
      <workstream_key> in orchestration <id>."})` — this triggers the
      server-side dependency gate validation.
   b. On successful dispatch, immediately:
      `sys_session_send(agent="worker", title="<ws_key>",
      args={purpose: "implement", model: "<advised_model>", input: "<full
      workstream specification + acceptance criteria>"})`.

   Emit ALL dispatch + worker calls for the wave in THIS turn. Do not
   serialize what can be parallel.

4. End your turn AFTER all dispatches are in flight. Do not poll.

5. When workers complete (via `sys_read_inbox`), send each through
   `cross-persona-review`.

6. After review passes and workstream is marked COMPLETE:
   - Check if new workstreams are now unblocked (their deps are now COMPLETE).
   - If yes, loop to step 2 for the next wave.
   - If no more workstreams remain, the orchestration is COMPLETE.

## Wave Example

```
Tier 0: ws-catalog (depends_on: [])           → Wave 1 (dispatch immediately)
Tier 1: ws-dlt-pipeline (depends_on: [ws-catalog])  ┐
        ws-gold-tables (depends_on: [ws-catalog])    ├→ Wave 2 (after ws-catalog COMPLETE)
Tier 2: ws-genie-space (depends_on: [ws-gold-tables]) → Wave 3
```

## Execution Model

After dispatch, execution follows the `genie-code-handoff` pattern:
1. Worker authors the Genie Code prompt (retrieves context, crafts instructions)
2. Orchestrator schedules the prompt as a Genie Code task
3. Genie Code executes asynchronously, calling worker MCP tools for state
4. Orchestrator monitors via `get_workstream_context` polling

This means "dispatch + execute" is NOT synchronous. After dispatching a wave
and handing off to Genie Code, the orchestrator waits for inbox notifications
or polls state — it does NOT block.

## Notes
- The server's dependency gate (`dispatch_workstream`) will reject premature
  dispatch with `400 BAD_REQUEST` listing unmet deps. Trust the gate — if
  dispatch succeeds, the workstream was genuinely ready.
- The dispatch tick (every 60s) also auto-advances workstreams with zero unmet
  deps. The orchestrator's proactive dispatch is faster but not the only path.
- Respect the model routing: use `sys_advise_models` before each wave to pick
  optimal models per workstream complexity.
- If a worker fails (workstream → BLOCKED), check if retry is warranted:
  dispatch `dispatcher` with `retry_workstream`, then re-dispatch `worker`.
- Never dispatch more workers than available concurrency allows. If the
  platform has a dispatch cap, send waves within the cap.
- Workstreams in the same wave MUST be parallel-safe (no shared state
  dependencies beyond what `depends_on` declares).
