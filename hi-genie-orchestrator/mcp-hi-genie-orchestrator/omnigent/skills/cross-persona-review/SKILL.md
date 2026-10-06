---
name: cross-persona-review
description: Verify a completed workstream with an INDEPENDENT, different-vendor reviewer sub-agent; turn blocking findings into fix-tasks dispatched back to the worker, and loop until acceptance criteria are met.
---

# cross-persona-review — independent workstream verification

The worker never signs off on its own work — a different-vendor reviewer does,
and review produces a structured findings report the orchestrator acts on.

## Procedure
1. Confirm the workstream is ready for review:
   - Dispatch `dispatcher` with `list_workstreams` to verify the target
     workstream status is `COMPLETE` or `IN_REVIEW`.
   - Dispatch `dispatcher` with `get_workstream_context` to retrieve the
     workstream's acceptance criteria, task history, and decisions.

2. Run deterministic gates first — dispatch `worker` to verify any automated
   checks pass (e.g., table exists, pipeline healthy, permissions set). If
   red, re-dispatch `worker` to fix. Don't involve the reviewer yet.

3. Dispatch `reviewer` as an INDEPENDENT verifier:
   `sys_session_send(agent="reviewer", title="review-<workstream_key>",
   args={purpose: "review", input: "<workstream context> + <acceptance
   criteria> + <task history>. Review ONLY against acceptance criteria.
   Report blocking / non-blocking / suggestions with evidence."})`.

   **Cross-vendor rule**: The reviewer's model MUST differ from the worker's.
   Use `sys_advise_models` to pick a different vendor:
   - Worker used Claude → reviewer gets GPT or Gemini
   - Worker used GPT → reviewer gets Claude or Gemini
   - Worker used Gemini → reviewer gets Claude or GPT

   Emit the dispatch in THIS turn — never end a turn having only announced
   the review without a tool call.

4. The reviewer SURFACES issues via `submit_review`; it does not fix them.
   Collect the structured report with `sys_read_inbox`.

5. For each **blocking** finding:
   - Dispatch `worker` with the specific remediation task, referencing the
     finding_id and workstream_key.
   - Worker fixes, records task_completion(SUCCEEDED).
   - Loop back to step 1 (re-review after fix).

6. When all gates pass AND zero blocking findings:
   - Dispatch `dispatcher` with `update_workstream_status` → COMPLETE.
   - Record the review verdict in the project context.
   - Report success to the human.

7. If acceptance criteria can't be satisfied after 3 review loops, escalate
   to the human with:
   - Specific unresolved blocking findings
   - What was attempted
   - Recommended path forward

## Notes
- Cross-persona review requires the reviewer to use a DIFFERENT model vendor
  than the worker. If only one vendor is available (e.g., only Claude
  configured), you CANNOT run independent cross-vendor review. Say so and
  pull in the human.
- Give the reviewer ONLY the workstream context + acceptance criteria +
  observable outputs. Never share the worker's internal reasoning or session
  transcript — independence is the point.
- Non-blocking findings become follow-up tasks for future iterations; they
  don't block the COMPLETE transition.
- The reviewer never mutates state — it uses read-only MCP tools exclusively.
