# Workstream MCP Tool Catalog

25 tools served at `/mcp` via Streamable HTTP (JSON-RPC 2.0). Accessed by workers
and reviewers through the UC MCP Service (`hls_fde.hi_genie_prod.orchestrator_mcp`),
governed by AI Gateway service policies.

## Tool Groups

### Context Retrieval (7 tools) — Read-only

Retrieve project, workstream, session, and decision context. All queries are
bounded, RLS-enforced via `project_id` scope.

| Tool | Purpose | Key Inputs |
| --- | --- | --- |
| `list_projects` | Discover accessible projects | (none — scoped to caller identity) |
| `get_project_context` | Full project context: requirements, decisions, conventions | `project_id` |
| `get_workstream_context` | Workstream-specific: spec, deps, config, prior attempts | `project_id`, `workstream_id` |
| `search_decisions` | Find decisions by topic or keyword | `project_id`, `query`, `workstream_id?` |
| `get_recent_session_summaries` | Last N session summaries for a project/workstream | `project_id`, `workstream_id?`, `limit?` |
| `get_relevant_errors` | Errors matching a class/code pattern | `project_id`, `error_class?`, `workstream_id?` |
| `get_session_context` | Full context for a specific session | `project_id`, `session_id` |

### Append-First Records (6 tools) — Write-once, immutable

Create immutable records. All use `(project_id, idempotency_key)` unique constraint
for retry-safe writes. Records are never overwritten after creation.

| Tool | Purpose | Key Inputs |
| --- | --- | --- |
| `record_decision` | Record a decision with rationale and alternatives | `project_id`, `title`, `context`, `decision`, `rationale` |
| `record_session_summary` | Record session summary with outcomes | `project_id`, `session_id`, `summary`, `outcomes` |
| `record_error` | Record an error with class, code, resolution | `project_id`, `error_class`, `message`, `is_blocking` |
| `record_workstream_event` | Record a lifecycle event on a workstream | `project_id`, `workstream_id`, `event_type`, `details` |
| `record_task_attempt` | Record a task execution attempt with status | `project_id`, `workstream_id`, `attempt_number`, `status` |
| `record_task_completion` | Record final completion with evidence manifest | `project_id`, `workstream_id`, `artifacts`, `evidence` |

### Mutable State (5 tools) — Optimistic concurrency

Update bounded, auditable state using version columns. Each update records
the acting user, timestamp, and reason. Historical events preserved.

| Tool | Purpose | Key Inputs |
| --- | --- | --- |
| `start_session` | Start a new session (creates state record) | `project_id`, `workstream_id?`, `session_type` |
| `end_session` | End a session with summary | `session_id`, `summary`, `outcomes` |
| `update_workstream_status` | Transition workstream status with evidence | `workstream_id`, `status`, `reason`, `evidence?` |
| `update_task_status` | Update task-level status within a workstream | `workstream_id`, `task_key`, `status`, `details` |
| `update_recovery_state` | Update recovery/diagnostic state (admin) | `workstream_id`, `recovery_data` |

### Search & Operational (5 tools) — Read-only

Structured search, task history, health checks, and schema reporting.

| Tool | Purpose | Key Inputs |
| --- | --- | --- |
| `search_context` | Full-text search across all project records | `project_id`, `query`, `record_types?` |
| `get_task_history` | Execution history for a workstream | `project_id`, `workstream_id` |
| `get_execution_summary` | Summary across all workstreams in an orchestration | `orchestration_id` |
| `get_health` | App and database health check | (none) |
| `get_schema_version` | Current Lakebase schema migration version | (none) |

### Skill Content (1 tool) — Read-only, versioned

Load versioned, project-specific skill content. Composable — call multiple
times to load different sections on demand.

| Tool | Purpose | Key Inputs |
| --- | --- | --- |
| `get_skill_content` | Load a skill section for this project/role | `project_id`, `role`, `section`, `orchestration_id?` |

Returns:
- `content` — Skill markdown for the requested section
- `version` — Skill version pinned to this orchestration
- `section_path` — Canonical path within the skill
- `available_sections` — What else can be loaded (discovery hint)

---

## Role Access Matrix (AI Gateway Service Policies)

| Tool | Worker | Reviewer | Supervisor |
| --- | --- | --- | --- |
| **Context Retrieval** | | | |
| `list_projects` | ✓ | ✓ | ✓ |
| `get_project_context` | ✓ | ✓ | ✓ |
| `get_workstream_context` | ✓ | ✓ | ✓ |
| `search_decisions` | ✓ | ✓ | ✓ |
| `get_recent_session_summaries` | ✓ | ✓ | ✓ |
| `get_relevant_errors` | ✓ | ✓ | ✓ |
| `get_session_context` | ✓ | ✓ | ✓ |
| **Records** | | | |
| `record_decision` | ✓ | — | ✓ |
| `record_session_summary` | ✓ | — | ✓ |
| `record_error` | ✓ | — | ✓ |
| `record_workstream_event` | ✓ | ✓ | ✓ |
| `record_task_attempt` | ✓ | — | ✓ |
| `record_task_completion` | ✓ | — | ✓ |
| **State** | | | |
| `start_session` | ✓ | ✓ | ✓ |
| `end_session` | ✓ | ✓ | ✓ |
| `update_workstream_status` | ✓ | — | ✓ |
| `update_task_status` | ✓ | — | ✓ |
| `update_recovery_state` | — | — | ✓ |
| **Search** | | | |
| `search_context` | ✓ | ✓ | ✓ |
| `get_task_history` | ✓ | ✓ | ✓ |
| `get_execution_summary` | ✓ | ✓ | ✓ |
| `get_health` | ✓ | ✓ | ✓ |
| `get_schema_version` | — | — | ✓ |
| **Skill** | | | |
| `get_skill_content` | ✓ | ✓ | ✓ |

---

## Lifecycle-to-Tool Mapping (Worker)

Which tools to call at each phase of worker execution:

### Phase 1: Session Start

```text
get_skill_content(project_id, role="worker", section="core")
start_session(project_id, workstream_id, session_type="execution")
get_workstream_context(project_id, workstream_id)
get_project_context(project_id)  // if cross-cutting context needed
```

### Phase 2: Execution

```text
search_decisions(project_id, query="<relevant topic>")  // as needed
get_relevant_errors(project_id, workstream_id)           // check prior failures
record_task_attempt(project_id, workstream_id, attempt_number, status="in_progress")
record_decision(...)                                     // if significant choice made
record_error(...)                                        // if non-fatal error encountered
record_workstream_event(project_id, workstream_id, "progress", details)
```

### Phase 3: Validation

```text
update_workstream_status(workstream_id, "VALIDATING", reason="Starting validation")
record_task_attempt(project_id, workstream_id, attempt_number, status="validating")
// Run tests, lint, type checks, builds, etc.
// Record each validation result
record_workstream_event(project_id, workstream_id, "validation_result", details)
```

### Phase 4: Completion Handoff

```text
record_task_completion(project_id, workstream_id, artifacts=[...], evidence={...})
update_workstream_status(workstream_id, "READY_FOR_REVIEW", reason="...", evidence={...})
end_session(session_id, summary="...", outcomes=[...])
```

### Phase: Error / Blocked

```text
record_error(project_id, error_class, message, is_blocking="true")
update_workstream_status(workstream_id, "BLOCKED", reason="<description>")
end_session(session_id, summary="Blocked: <reason>", outcomes=[...])
```

---

## Implicit Heartbeat

Every MCP tool call updates a `last_tool_call_at` timestamp on the execution
record. The dispatcher uses this to detect stuck workers:

- If `last_tool_call_at` is older than `timeout_threshold_minutes` (default: 45)
  and status is `IN_PROGRESS`, the workstream is considered stuck.
- The dispatcher may mark it `RETRYING` or `BLOCKED` depending on attempt count.

Workers do not need to send explicit heartbeats — their normal MCP tool usage
serves this purpose. Long-running operations should call `record_workstream_event`
periodically to keep the heartbeat alive.
