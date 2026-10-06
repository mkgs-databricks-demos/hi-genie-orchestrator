---
name: plan-approval
description: Present a generated plan to the human for review, handle approval/rejection/revision cycles, and publish the approved snapshot for orchestration.
---

# plan-approval — human-in-the-loop plan gate

Every plan must pass through human approval before orchestration begins.
This is a non-negotiable governance gate.

## Procedure
1. After the architect produces a plan, present it to the human in a
   structured format:
   - Project name and scope
   - Workstream table: key | title | depends_on | execution_tier
   - Dependency graph (text DAG visualization)
   - Estimated complexity per workstream
   - Total workstream count and critical path length

2. Ask the human for one of:
   - **Approve** — proceed to orchestration
   - **Revise** — specific changes needed (add/remove/modify workstreams)
   - **Reject** — start over with different scope

3. On **Approve**:
   - Dispatch `architect` to `publish_plan_snapshot` (freezes the plan).
   - Record the snapshot_id.
   - Proceed to `dependency-dispatch` with the approved snapshot.

4. On **Revise**:
   - Dispatch `architect` with the revision instructions.
   - Architect updates the plan via `update_plan`.
   - Loop back to step 1 with the revised plan.

5. On **Reject**:
   - Ask the human for new scope/direction.
   - Dispatch `architect` to create a new plan from scratch.
   - Loop back to step 1.

## Notes
- Never skip the approval gate. Even "obvious" plans need human sign-off
  because they commit real resources.
- The snapshot is immutable once published — revisions require a new version.
- Present the dependency graph visually when possible:
  ```
  ws-catalog ──┬── ws-dlt-pipeline ──── ws-genie-space
               └── ws-gold-tables ─────────┘
  ```
- If the plan has > 8 workstreams, suggest breaking it into phases with
  separate orchestrations.
- Record the approval decision (with timestamp and rationale) via the
  architect's `record_decision` tool for audit purposes.
