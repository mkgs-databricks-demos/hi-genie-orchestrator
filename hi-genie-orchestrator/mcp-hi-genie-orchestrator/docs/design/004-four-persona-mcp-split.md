# Design Decision 004: Four-Persona MCP Service Split

**Date:** 2026-08-24
**Status:** Accepted
**Validated:** 2026-08-24T13:47Z — OTel + live MCP tools/list confirmed (13/14/17/16/39)
**Constraint:** UC MCP Service max = 20 tools per service

---

## Context

The initial 2-path split (worker: 25, supervisor: 24) exceeded the UC MCP Service
limit of 20 tools. We need a tighter split into 4 personas, each under 20 tools.

## Decision

Split into 4 persona-specific MCP services:

| Persona | Path | Tools | Role |
| --- | --- | --- | --- |
| Architect | /mcp/architect | 13 | Plans, skills, design decisions |
| Reviewer | /mcp/reviewer | 14 | Quality gates, review lifecycle |
| Worker | /mcp/worker | 17 | Task execution, recording, sessions |
| Dispatcher | /mcp/dispatcher | 16 | Orchestration, workstream lifecycle |

Legacy /mcp (39 tools) retained as internal transport only -- NOT registered as UC MCP Service.

## Tool Assignments

### Architect (13 tools)

Plans lifecycle + skill authoring + architecture decisions.

- create_plan
- get_plan
- publish_plan
- get_skill_content
- update_skill
- record_decision
- list_projects
- get_project_context
- get_workstream_context
- search_decisions
- get_recent_session_summaries
- get_health
- get_schema_version

### Reviewer (14 tools)

Review lifecycle + broad read access for quality assessment.

- create_review
- get_review
- deliver_remediation
- approve_review
- list_projects
- get_project_context
- get_workstream_context
- search_decisions
- get_recent_session_summaries
- get_relevant_errors
- get_task_history
- get_execution_summary
- get_health
- get_schema_version

### Worker (17 tools)

Task execution, artifact recording, session management.

- record_decision
- record_session_summary
- record_error
- record_workstream_event
- record_task_attempt
- record_task_completion
- start_session
- end_session
- update_recovery_state
- search_context
- get_session_context
- get_skill_content
- get_project_context
- get_workstream_context
- get_relevant_errors
- get_task_history
- get_schema_version

### Dispatcher (16 tools)

Orchestration, workstream/task state, execution monitoring.

- orchestrate_plan
- materialize_workstreams
- list_workstreams
- dispatch_workstream
- retry_workstream
- pause_workstream
- unpause_workstream
- update_workstream_status
- update_task_status
- list_projects
- get_project_context
- get_workstream_context
- get_task_history
- get_execution_summary
- get_health
- get_schema_version

## Design Principles

1. **Least privilege**: Each persona sees only tools it needs
2. **Read vs write split**: Workers consume skills (get_skill_content); only architect writes them (update_skill)
3. **Session ownership**: Workers own their session lifecycle (start/end/recovery)
4. **Lifecycle ownership**: Dispatcher owns workstream/task state transitions
5. **Shared reads are selective**: Not all 10 context tools on every persona -- only what's needed
6. **record_decision on two personas**: Architect (design decisions) + Worker (implementation decisions)

## Infrastructure

| Resource | Naming Pattern |
| --- | --- |
| Connections | hi_genie_{persona}_mcp_conn[_dev] |
| Services | hi_genie_{persona}[_dev] |
| Transport paths | /mcp/{persona} |
| Legacy (internal) | /mcp (no UC service registration) |

## Consequences

- Legacy UC MCP Service removed (exceeds 20-tool limit)
- 4 UC connections, 4 UC services registered
- ASK-gate policy attached to all 4 services
- Direct /mcp path remains for app-to-app calls and testing
- Future: sub-persona splits (e.g. architect-planner vs architect-author) possible if tool counts grow
