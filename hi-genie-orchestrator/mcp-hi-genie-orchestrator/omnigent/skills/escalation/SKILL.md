---
name: escalation
description: Handle workstream failures, blocked states, and situations that exceed automated resolution — escalate to the human with structured context and recommended actions.
---

# escalation — failure handling and human escalation

Not everything can be automated. This skill defines when and how to escalate
to the human, and what to do with blocked workstreams.

## When to Escalate

Escalate IMMEDIATELY when:
- A workstream has failed 3 consecutive attempts (max_retries exhausted)
- Cross-persona review has looped 3 times without resolving blocking findings
- A dependency deadlock is detected (circular or impossible-to-satisfy deps)
- The worker reports an external blocker (permissions, missing resources,
  environment issues that require human action)
- Costs or duration exceed the plan's stated bounds

## Procedure
1. Gather full context before escalating:
   - Dispatch `dispatcher`: get_workstream_context + get_execution_summary
   - Dispatch `worker`: get_task_history (all attempts)
   - Dispatch `reviewer`: latest review findings (if applicable)

2. Synthesize a structured escalation report:
   ```
   ## Escalation: <workstream_key>

   **Status**: BLOCKED (attempt 3/3)
   **Root cause**: <specific failure reason from task history>
   **What was tried**: <summary of each attempt's approach>
   **Blocking dependency**: <if applicable>

   ### Recommended actions (pick one):
   1. <specific human action that would unblock>
   2. <alternative approach requiring scope change>
   3. Skip this workstream (downstream impact: <list affected workstreams>)
   ```

3. Present to the human and WAIT for their decision. Do not retry
   automatically after escalation.

4. On human response:
   - If they provide a fix/instruction: dispatch `worker` with the new
     approach, then resume normal flow.
   - If they say skip: dispatch `dispatcher` to mark workstream SKIPPED,
     then check if downstream workstreams can still proceed.
   - If they say abort: dispatch `dispatcher` to pause the orchestration.

## Automatic Recovery (before escalation)

Before escalating, attempt automated recovery:
1. **First failure**: Retry with the same approach (transient error check).
2. **Second failure**: Retry with `sys_advise_models` picking a DIFFERENT,
   stronger model for the worker.
3. **Third failure**: Escalate — automated recovery is exhausted.

For `BLOCKED` workstreams (paused, not failed):
- Dispatch `dispatcher` with `retry_workstream` to reset to NOT_STARTED.
- Then re-dispatch worker.
- If it blocks again on the same issue, escalate.

## Notes
- Never silently swallow errors. Every failure must either be recovered
  automatically or escalated.
- The escalation report is the human's decision surface — make it
  actionable, not a wall of logs.
- Include downstream impact: "If we skip ws-gold-tables, ws-genie-space
  cannot proceed (depends_on: [ws-gold-tables])."
- Record the escalation event via `record_decision` for audit trail.
