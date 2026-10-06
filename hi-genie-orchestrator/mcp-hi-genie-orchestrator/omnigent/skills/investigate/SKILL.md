---
name: investigate
description: Delegate read-only investigation of project state, workstream health, execution history, or decision rationale to persona sub-agents; synthesize only from their structured reports.
---

# investigate — delegated read-only exploration

Use for any read-only task: health diagnostics, execution analysis, decision
audit, dependency graph exploration, or answering questions about project
state.

## Procedure
1. Decompose the question into one or more bounded investigation tasks.
   Prefer two independent lenses for ambiguous or high-stakes questions.

2. Dispatch each task to the appropriate persona:
   - **Project/plan questions** → `architect`:
     `sys_session_send(agent="architect", title="explore-<slug>",
     args={purpose: "plan", input: "<question + exact scope>"})`
   - **Execution/state questions** → `dispatcher`:
     `sys_session_send(agent="dispatcher", title="explore-<slug>",
     args={purpose: "orchestrate", input: "<question + exact scope>"})`
   - **Task history/session questions** → `worker`:
     `sys_session_send(agent="worker", title="explore-<slug>",
     args={purpose: "implement", input: "EXPLORE ONLY: <question>.
     Read state, report findings, edit nothing."})`

   Use task-based titles like `explore-ws-catalog-health` or
   `explore-dep-graph`, never raw persona names. Emit dispatch calls in
   THIS turn.

3. End your turn AFTER dispatches are in flight.

4. Collect completion reports with `sys_read_inbox`. Synthesize only from
   those reports. Use `sys_session_get_history` only to debug empty results.

5. If reports conflict or are incomplete, dispatch a follow-up exploration
   to a DIFFERENT persona or with a DIFFERENT model for a second opinion.

6. If investigation uncovers required changes, switch to
   `dependency-dispatch` / `cross-persona-review`: dispatch the fix through
   the normal orchestration flow.

## Common Investigation Patterns

### Health check
```
Dispatch dispatcher: "get_health + get_schema_version + get_execution_summary
for project <id>. Report service status, schema version, and execution metrics."
```

### Dependency analysis
```
Dispatch dispatcher: "list_workstreams for orchestration <id>. For each
workstream, report: key, status, depends_on, and whether all deps are COMPLETE.
Identify the critical path and any blocked workstreams."
```

### Decision audit
```
Dispatch worker: "search_decisions for project <id>. Report all recorded
architectural decisions with their rationale, context, and alternatives
considered."
```

### Failure analysis
```
Dispatch dispatcher: "get_workstream_context for <ws_key>. Report status
history, attempt count, last error, and whether retry is warranted."
Dispatch worker: "get_task_history for <ws_key>. Report each attempt's
outcome, duration, and failure details."
```

## Notes
- The orchestrator may use the `orchestrator_mcp` tools directly for quick
  health/status checks. Use delegated investigation only for substantive
  questions that need persona-specific tool access.
- Keep task scopes narrow. Broad questions should be split into parallel
  subtasks dispatched to different personas.
- Never answer the human's substantive question from your own direct tool
  calls alone. Always ground in sub-agent reports for anything beyond
  simple status lookups.
