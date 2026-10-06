# Supervisor / Dispatcher Role

The Supervisor owns the control plane. It converts accepted planning records into
immutable plan snapshots, materializes workstreams, evaluates the priority tree,
and spawns workers via scheduled tasks. The Supervisor is harness-agnostic — it
can run as a Genie Code scheduled task, Omnigent, Claude CLI, or any process
that speaks REST to the Supervisor API.

## Responsibilities

- Validate requirements, features, decisions, release items, and workstream dependencies
- Resolve blocking open questions before publication
- Publish immutable plan snapshots with content hashes
- Materialize dispatch records from a published snapshot
- Evaluate the WS-INIT tick (stateless priority-tree) to determine next actions
- Spawn workers: create Genie Code scheduled tasks with transport-agnostic bootstrap prompts
- Track execution: record `automation_id`, `automation_url`, `worker_prompt_hash`, `skill_version`
- Detect stuck workers via `heartbeat_at` vs `timeout_threshold_min`
- Detect `READY_FOR_REVIEW` and create or resume review tasks
- Deliver remediation reference envelopes to the originating or remediation workstream
- Mark `COMPLETE` only after required findings are verified and evidence is current
- Keep an audit trail for decisions, configuration changes, reviews, and state transitions

## Must Not

- Expose dispatch controls through the Workstream MCP
- Treat mutable planning drafts as runtime authority
- Allow workers to schedule themselves or mark their own work complete
- Duplicate full review findings in prompts when Lakebase references are available
- Change active plan snapshots in place
- Hardcode transport or auth details in worker bootstrap prompts (those are harness concerns)

## Authorization

Supervisor routes require M2M OAuth2 (client_credentials) with the dedicated SPN.
Configuration administration requires the approved configuration-admin role.
Human approval remains required for policy exceptions, destructive actions,
security/permission changes, scope changes, waivers, and terminal recovery.

---

## SDK Setup

The dispatcher loads skill content via REST, not MCP:

```python
from hi_genie import HiGenieClient, M2MAuthProvider

auth = M2MAuthProvider(
    workspace_host="https://fevm-hls-fde.cloud.databricks.com",
    client_id=dbutils.secrets.get("hi_genie_credentials", "client_id_hi_genie_prod"),
    client_secret=dbutils.secrets.get("hi_genie_credentials", "client_secret_hi_genie_prod"),
)

async with HiGenieClient(
    base_url="https://mcp-hi-genie-orchestrator-prod-7474657291520070.aws.databricksapps.com",
    auth=auth,
) as client:
    # Load dispatcher instructions
    skill = await client.get_skill_content(
        project_id="proj-123",
        role="supervisor",
        section="core",
    )
```

## Tick Loop (WS-INIT Evaluation)

The dispatcher runs this evaluation on each tick (hourly safety net + manual trigger):

```text
1. Call list_workstreams(orchestration_id) → current status of all workstreams
2. Evaluate priority tree:
   a. Find workstreams where ALL dependencies are COMPLETE
   b. Filter to status == NOT_STARTED (eligible for dispatch)
   c. Sort by priority (lower number = higher priority)
3. For each dispatchable workstream:
   a. Synthesize bootstrap prompt (see examples/bootstrap-templates.md)
   b. Compute worker_prompt_hash = SHA-256(bootstrap_prompt)
   c. Create Genie Code scheduled task (fire-once semantics)
   d. Record execution: automation_id, automation_url, prompt_hash, skill_version
   e. Call dispatch_workstream(orchestration_id, workstream_key)
4. For each stuck workstream (heartbeat_at > timeout_threshold_min):
   a. If attempts < max_retries: mark RETRYING, create new task with error context
   b. If attempts >= max_retries: mark BLOCKED, surface to human
5. For each READY_FOR_REVIEW workstream:
   a. Create review task if not already exists
   b. Create reviewer scheduled task with review bootstrap prompt
6. For each review that PASSED:
   a. Mark workstream COMPLETE (supervisor authority)
```

## Worker Spawning

The dispatcher creates a Genie Code scheduled task for each worker:

```text
scheduleAgentTool({
  title: "Hi Genie Worker: ws-claims-etl",
  instructions: "<bootstrap prompt from examples/bootstrap-templates.md>",
  cronExpression: "0 0 */1 * * ?"  // hourly safety net, manual Run Now for immediacy
})
```

After confirming execution (worker calls MCP tools), the dispatcher pauses the
task to prevent re-fires. Workers confirm they are running by calling MCP tools,
which also emit implicit heartbeats the Supervisor uses to detect stuck sessions.

## Execution Tracking (Lakebase)

When dispatching a worker, the supervisor records:

| Field | Value | Purpose |
| --- | --- | --- |
| `automation_id` | From scheduleAgentTool response | Physical task ID for pause/cancel |
| `automation_url` | From scheduleAgentTool response URL | Human intervention link |
| `worker_prompt_hash` | SHA-256 of the full bootstrap prompt | Reproducibility/audit |
| `skill_version` | Version from `get_skill_content` at dispatch time | Track which instructions worker received |
| `heartbeat_at` | Updated on each MCP tool call by the worker | Implicit liveness signal |
| `timeout_threshold_min` | From workstream config (default: 45) | When to consider worker dead |
| `last_known_phase` | From `update_workstream_status` calls | Quick status without full query |
| `dispatched_at` | Timestamp when task was created | Duration tracking |

## Review Routing

When a workstream reaches `READY_FOR_REVIEW`:

1. Supervisor creates a review record via `POST /reviews`
2. Synthesizes a reviewer bootstrap prompt referencing the workstream's evidence
3. Creates a reviewer scheduled task (or notifies a human reviewer)
4. The reviewer independently evaluates via MCP (read-only + `record_workstream_event`)
5. On PASS: Supervisor marks `COMPLETE`
6. On FAIL: Supervisor delivers remediation envelope to the original workstream
   (or creates a new remediation workstream if ownership/scope requires it)
