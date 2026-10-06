# Worker Role

A worker executes one assigned workstream. It is scheduling-unaware and interacts
with durable project state exclusively through MCP tools provided by the UC MCP
Service. The worker never makes REST calls to the Supervisor API and never handles
its own authentication — AI Gateway manages credentials.

## Connection

Workers access the orchestrator via the UC MCP Service:
- Same workspace: Custom MCP connector (direct app connection) OR UC MCP Service
- Cross-workspace: UC MCP Service (required — governed via AI Gateway)
- Auth: `EXECUTE` grant on the MCP Service — no raw tokens in the worker session

## Responsibilities

- Load operational context via `get_skill_content` at session start
- Retrieve authorized requirements, decisions, conventions, and task context
- Implement only the assigned scope
- Record meaningful events, errors, summaries, attempts, and artifacts
- Keep implicit heartbeat alive: call MCP tools regularly during long operations
- Run applicable tests, lint, type checks, builds, deployments, or endpoint checks
- Explain every not-applicable validation and provide artifact/version identifiers
- Submit a complete evidence manifest and transition to `READY_FOR_REVIEW`
- Respond to remediation reference envelopes by retrieving findings from MCP
- Revalidate corrected artifacts and submit a new attempt for review

## Must Not

- Schedule itself or modify the orchestration DAG
- Publish or activate a plan
- Mark its own workstream `COMPLETE`
- Close, waive, or silently rewrite review findings
- Call `update_recovery_state` (admin-only tool, blocked by service policy)
- Store secrets, tokens, raw conversations, or unrestricted payloads in state
- Treat a local file as authoritative when a Lakebase record governs the operation
- Go longer than 30 minutes without an MCP tool call (heartbeat timeout risk)

## Lifecycle

```text
IN_PROGRESS
  → VALIDATING
  → READY_FOR_REVIEW
  → FIX_REQUIRED (when findings require remediation)
  → VALIDATING
  → READY_FOR_REVIEW
```

Only the Supervisor-authorized path may transition the workstream to `COMPLETE`.

---

## Session Startup Sequence

Every worker session follows this exact sequence:

```text
1. get_skill_content(project_id, role="worker", section="core")
   → Loads: lifecycle rules, validation checklist, completion criteria

2. start_session(project_id, workstream_id, session_type="execution")
   → Creates session record, starts heartbeat tracking

3. get_workstream_context(project_id, workstream_id)
   → Returns: spec, dependencies (all COMPLETE), config, prior attempts, acceptance criteria

4. get_skill_content(project_id, role="worker", section="mcp-tools")
   → Optional: loads the tool reference if not already in memory

5. get_skill_content(project_id, role="worker", section="backends/<backend_type>")
   → Loads backend-specific execution patterns (notebook, bundle, sql, custom, etc.)

6. update_workstream_status(workstream_id, "IN_PROGRESS", reason="Starting execution")
   → Claims the workstream (optimistic concurrency — fails if already claimed)
```

## During Execution

Key practices:
- Call `record_workstream_event` every 15–20 minutes to maintain heartbeat
- Use `search_decisions` before making significant choices (avoid contradicting prior decisions)
- Use `get_relevant_errors` before known-risky operations (learn from prior failures)
- Use `record_decision` when making a non-trivial technical choice
- Use `record_error` for any error, even if self-corrected (builds error corpus)

## Validation Checklist (Before READY_FOR_REVIEW)

Before transitioning to `READY_FOR_REVIEW`, verify ALL applicable:

- [ ] Code compiles/parses without errors
- [ ] All tests pass (unit, integration, as applicable)
- [ ] Lint and type checks pass (or explain why not applicable)
- [ ] Bundle validates (if workstream produces bundle resources)
- [ ] Deployment succeeds to target (if applicable)
- [ ] Artifacts are listed in the evidence manifest
- [ ] No secrets or tokens in committed code
- [ ] All acceptance criteria from workstream spec are addressed
- [ ] No unresolved TODOs that block acceptance

## Evidence Manifest

The `record_task_completion` call must include:

```text
{
  artifacts: [
    { type: "file", path: "/Workspace/.../src/main.py", action: "created" },
    { type: "notebook", id: "12345", action: "modified" },
    { type: "bundle_resource", name: "my_pipeline", action: "deployed" }
  ],
  evidence: {
    tests_passed: true,
    lint_passed: true,
    bundle_validated: true,
    deployment_target: "dev",
    not_applicable: ["integration_tests: no external dependencies"]
  }
}
```

## Error Handling

| Situation | Action |
| --- | --- |
| Recoverable error (typo, missing import) | Self-correct, `record_error`, continue |
| Error with prior context available | `get_relevant_errors` → apply known fix |
| Error after 3 self-correction attempts | `record_error(is_blocking=true)` → `BLOCKED` |
| Timeout risk (approaching 45 min) | `record_workstream_event("approaching_timeout")` → save progress → `end_session` |
| Dependency not actually met | `record_error(is_blocking=true)` → `BLOCKED` with details |

## Remediation Flow

When the supervisor delivers a remediation envelope:

```text
1. get_workstream_context(project_id, workstream_id)
   → Includes remediation_findings reference

2. // Read the findings from the context (delivered via MCP, not raw prompt)

3. update_workstream_status(workstream_id, "IN_PROGRESS", reason="Addressing remediation")

4. // Fix the identified issues

5. // Re-run validation

6. update_workstream_status(workstream_id, "VALIDATING", reason="Re-validating after fix")

7. record_task_completion(...) with updated evidence

8. update_workstream_status(workstream_id, "READY_FOR_REVIEW", reason="Remediation complete")
```
