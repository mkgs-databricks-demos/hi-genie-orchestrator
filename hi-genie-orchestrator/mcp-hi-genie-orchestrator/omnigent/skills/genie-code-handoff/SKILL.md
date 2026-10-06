---
name: genie-code-handoff
description: Translate a dispatched workstream into a Genie Code scheduled task — worker authors the prompt, orchestrator schedules it, Genie Code executes and records progress via worker MCP tools.
---

# genie-code-handoff — workstream → scheduled task

The execution model: Omnigent orchestrates, Genie Code executes. This skill
defines the handoff boundary.

## Architecture

```
Omnigent (hi_genie orchestrator)
  │
  ├── 1. dispatcher: dispatch_workstream → marks IN_PROGRESS
  │
  ├── 2. worker: retrieves context → authors Genie Code prompt
  │
  ├── 3. orchestrator: schedules the prompt as a Genie Code task
  │         (via scheduleAgentTool or equivalent)
  │
  └── 4. Genie Code (async, external):
          - Reads the prompt
          - Executes Databricks operations
          - Calls worker MCP tools to record progress
          - Completes or fails
```

## Procedure

1. After `dispatcher` successfully dispatches a workstream:
   `sys_session_send(agent="worker", title="author-<ws_key>",
   args={purpose: "implement", input: "Author a Genie Code execution
   prompt for workstream <ws_key> in orchestration <orch_id>.
   Retrieve full context and produce a self-contained prompt."})`

2. Collect the authored prompt via `sys_read_inbox`.

3. Validate the prompt contains all required sections:
   - [ ] Objective (from workstream description)
   - [ ] Acceptance criteria (checkable conditions)
   - [ ] Context (project, dependencies, decisions)
   - [ ] Implementation steps (concrete Databricks ops)
   - [ ] Progress recording instructions (MCP tool calls)
   - [ ] Error handling
   - [ ] Verification steps

4. Schedule the prompt as a Genie Code task. The scheduling mechanism
   depends on deployment:
   - **Omnigent on Databricks (managed)**: Use the platform's task API
   - **Self-managed**: Call the Databricks scheduled task API
   - **AI Playground testing**: Send the prompt to an active pane

5. Monitor for completion:
   - Poll `get_workstream_context` periodically (or wait for webhook)
   - Check if Genie Code has called `end_session`
   - Verify session status is COMPLETED

6. On completion: proceed to `cross-persona-review`.
   On failure: check attempt count, retry or escalate per `escalation` skill.

## Prompt Quality Checklist

The worker must produce prompts where Genie Code can succeed WITHOUT:
- Asking follow-up questions (prompt must be unambiguous)
- Having prior conversation context (fully self-contained)
- Knowing about the broader project (relevant context included)
- Guessing IDs or names (all identifiers explicit)

## MCP Tool Flow (what Genie Code does)

```
Genie Code receives prompt
  │
  ├── start_session(workstream_id, session_type="execution")
  │
  ├── For each step:
  │   ├── record_task_attempt(task_key, status="STARTED")
  │   ├── [DO THE WORK: CREATE CATALOG, DEPLOY PIPELINE, etc.]
  │   └── record_task_completion(task_key, status="SUCCEEDED"|"FAILED")
  │
  ├── record_decision(...) for any key choices made
  │
  └── end_session(summary, status="COMPLETED"|"FAILED")
```

## Retry Behavior

When Genie Code reports FAILED:
1. Worker retrieves task_history to understand what failed
2. Worker authors a REVISED prompt that:
   - Acknowledges the previous attempt
   - Skips already-completed steps
   - Addresses the specific failure
   - May use a different approach
3. Orchestrator re-schedules with the revised prompt

## Notes
- The worker is a PROMPT AUTHOR, not an executor. It never calls
  start_session or record_task_attempt itself.
- Genie Code is stateless between scheduled tasks — every prompt must be
  fully self-contained.
- The orchestrator monitors progress by polling workstream state, not by
  watching Genie Code's execution.
- Multiple workstreams can have concurrent Genie Code tasks running
  (parallel execution at the scheduled task level).
- If a workstream's acceptance criteria are ambiguous, the worker should
  ask the orchestrator (which escalates to the human) BEFORE authoring
  the prompt.
