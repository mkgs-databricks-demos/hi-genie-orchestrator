# Bootstrap Prompt Templates

Minimal prompts given to workers and dispatchers at spawn time. Transport-agnostic —
the consumer calls `get_skill_content` for full operational context. The bootstrap
just establishes identity, connection, and the first tool call.

## Design Principles

- **Collaborative framing**: "We are working on..." not "You are..."
- **Transport-agnostic**: Reference the UC MCP Service name, not a URL
- **Minimal**: Everything else comes from `get_skill_content`
- **Parameterized**: `{{variable}}` placeholders hydrated by the dispatcher

---

## Worker Bootstrap

### Template

```text
We are working on project "{{project_name}}" with the role of Worker,
executing workstream "{{workstream_key}}" in orchestration "{{orchestration_id}}".

Project ID: {{project_id}}
Workstream: {{workstream_key}}
Orchestration: {{orchestration_id}}
Attempt: {{attempt_number}}

The orchestrator MCP service is registered at {{mcp_service_name}}.

First steps:
1. Call get_skill_content(project_id="{{project_id}}", role="worker", section="core")
2. Follow the returned session startup sequence exactly
3. The workstream spec, acceptance criteria, and dependencies are available
   via get_workstream_context after starting a session

{{#if prior_error_context}}
This is retry attempt {{attempt_number}}. Prior attempt failed with:
{{prior_error_context}}

Call get_relevant_errors(project_id="{{project_id}}", workstream_id="{{workstream_id}}")
for full error history before proceeding.
{{/if}}

{{#if remediation_context}}
This session is for remediation. Review findings are available in the workstream
context after starting a session. Address all findings before re-submitting.
{{/if}}
```

### Example (first attempt)

```text
We are working on project "HLS Claims Pipeline" with the role of Worker,
executing workstream "ws-claims-etl" in orchestration "O-2026-08-22-001".

Project ID: proj-hls-claims-2026
Workstream: ws-claims-etl
Orchestration: O-2026-08-22-001
Attempt: 1

The orchestrator MCP service is registered at hls_fde.hi_genie_prod.orchestrator_mcp.

First steps:
1. Call get_skill_content(project_id="proj-hls-claims-2026", role="worker", section="core")
2. Follow the returned session startup sequence exactly
3. The workstream spec, acceptance criteria, and dependencies are available
   via get_workstream_context after starting a session
```

### Example (retry with error context)

```text
We are working on project "HLS Claims Pipeline" with the role of Worker,
executing workstream "ws-claims-etl" in orchestration "O-2026-08-22-001".

Project ID: proj-hls-claims-2026
Workstream: ws-claims-etl
Orchestration: O-2026-08-22-001
Attempt: 2

The orchestrator MCP service is registered at hls_fde.hi_genie_prod.orchestrator_mcp.

First steps:
1. Call get_skill_content(project_id="proj-hls-claims-2026", role="worker", section="core")
2. Follow the returned session startup sequence exactly
3. The workstream spec, acceptance criteria, and dependencies are available
   via get_workstream_context after starting a session

This is retry attempt 2. Prior attempt failed with:
AnalysisException: Table hls_fde.hi_genie_prod.claims_raw not found.

Call get_relevant_errors(project_id="proj-hls-claims-2026", workstream_id="ws-claims-etl")
for full error history before proceeding.
```

---

## Dispatcher Bootstrap

For Genie Code scheduled tasks serving as the dispatcher:

### Template

```text
We are working on project "{{project_name}}" with the role of Supervisor/Dispatcher,
managing orchestration "{{orchestration_id}}".

Project ID: {{project_id}}
Orchestration: {{orchestration_id}}

SDK setup:
  %pip install -e /Workspace/Users/matthew.giglia@databricks.com/brainstorming-hi-genie-orchestrator/genie-workstream-orchestrator/hi-genie-orchestrator/hi-genie-sdk

Load instructions:
  Call client.get_skill_content(project_id="{{project_id}}", role="supervisor", section="core")
  via the Python SDK after authenticating.

Execute the WS-INIT tick loop as described in the returned skill content.
```

---

## Reviewer Bootstrap

### Template

```text
We are working on project "{{project_name}}" with the role of Independent Reviewer,
evaluating workstream "{{workstream_key}}" in orchestration "{{orchestration_id}}".

Project ID: {{project_id}}
Workstream: {{workstream_key}}
Orchestration: {{orchestration_id}}
Review ID: {{review_id}}

The orchestrator MCP service is registered at {{mcp_service_name}}.

First steps:
1. Call get_skill_content(project_id="{{project_id}}", role="reviewer", section="core")
2. Start a session and retrieve the workstream context
3. The evidence manifest and acceptance criteria are in the workstream context
4. Evaluate independently — do not modify the worker's artifacts
5. Record findings via record_workstream_event
```

---

## Transport Variants

The templates above reference `{{mcp_service_name}}` — a UC MCP Service path.
Depending on the harness, the actual connection mechanism varies:

| Harness | MCP Connection | Notes |
| --- | --- | --- |
| Genie Code (same workspace) | Custom MCP connector OR UC MCP Service | Both work; UC Service adds governance |
| Genie Code (cross-workspace) | UC MCP Service (required) | AI Gateway routes to the app |
| Supervisor Agent | MCP server config | Register the UC MCP Service as a tool source |
| Claude CLI (external) | N/A — uses REST SDK | Calls `/api/v1/skills/content` instead |
| Omnigent (same workspace) | REST SDK or direct MCP | Harness-dependent |

For REST-based dispatchers (Claude CLI, Omnigent), replace the MCP service
reference with SDK instructions. The dispatcher template above shows this pattern.

---

## Variable Reference

| Variable | Source | Example |
| --- | --- | --- |
| `project_id` | Plan record | `proj-hls-claims-2026` |
| `project_name` | Plan record | `HLS Claims Pipeline` |
| `workstream_key` | Workstream record | `ws-claims-etl` |
| `orchestration_id` | Orchestration record | `O-2026-08-22-001` |
| `attempt_number` | Execution record count + 1 | `1`, `2`, `3` |
| `mcp_service_name` | Deployment config | `hls_fde.hi_genie_prod.orchestrator_mcp` |
| `prior_error_context` | Last error record (truncated) | Error message + class |
| `remediation_context` | Review findings reference | Boolean flag |
| `review_id` | Review record | `rev-2026-08-22-001` |
