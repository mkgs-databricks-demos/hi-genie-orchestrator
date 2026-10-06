# Supervisor API Routes

REST API at `/api/v1` for trusted dispatcher workflows. Used by the Python SDK
(`hi-genie-sdk`), TypeScript SDK (`shared/sdk/`), or direct HTTP from any harness.

Auth: M2M OAuth2 Bearer token via `POST {workspace}/oidc/v1/token` (client_credentials).

## Plan Operations

| Method | Route | SDK Method | Purpose |
| --- | --- | --- | --- |
| POST | `/plans` | `create_plan(request)` | Ingest a new plan |
| GET | `/plans/:planId` | `get_plan(plan_id)` | Retrieve plan with snapshots |
| POST | `/plans/:planId/publish` | `publish_plan(plan_id, request)` | Create immutable snapshot |
| POST | `/plans/:planId/orchestrate` | `orchestrate(plan_id, request?)` | Create orchestration from plan |

## Workstream Operations

| Method | Route | SDK Method | Purpose |
| --- | --- | --- | --- |
| POST | `/orchestrations/:orchId/materialize` | `materialize(orchestration_id, request)` | Materialize workstreams from snapshot |
| GET | `/orchestrations/:orchId/workstreams` | `list_workstreams(orchestration_id)` | List workstreams for an orchestration |
| POST | `/orchestrations/:orchId/workstreams/:wsKey/dispatch` | `dispatch_workstream(orch_id, ws_key, request?)` | Trigger workstream execution |
| POST | `/orchestrations/:orchId/workstreams/:wsKey/retry` | `retry_workstream(orch_id, ws_key, request)` | Retry a failed workstream |
| POST | `/orchestrations/:orchId/workstreams/:wsKey/pause` | `pause_workstream(orch_id, ws_key, request?)` | Pause a workstream |
| POST | `/orchestrations/:orchId/workstreams/:wsKey/unpause` | `unpause_workstream(orch_id, ws_key)` | Unpause a workstream |

## Review Operations

| Method | Route | SDK Method | Purpose |
| --- | --- | --- | --- |
| POST | `/reviews` | `create_review(request)` | Create review task (idempotent) |
| GET | `/reviews/:reviewId` | `get_review(review_id)` | Retrieve review task |
| POST | `/reviews/:reviewId/remediation` | `deliver_remediation(review_id, request)` | Deliver remediation findings |
| POST | `/reviews/:reviewId/approve` | `approve_review(review_id, request)` | Supervisor completion approval |

## Skill Operations

| Method | Route | SDK Method | Purpose |
| --- | --- | --- | --- |
| GET | `/skills/content` | `get_skill_content(project_id, role, section)` | Load versioned skill content (REST equivalent of MCP tool) |
| POST | `/skills/publish` | `publish_skill_version(request)` | Publish skill content from source to Lakebase |
| GET | `/skills/versions` | `list_skill_versions(project_id?)` | List published skill versions |

## WS-INIT Evaluation

| Method | Route | SDK Method | Purpose |
| --- | --- | --- | --- |
| (client-side) | — | `ws_init_tick(orchestration_id)` | Stateless priority-tree evaluation |

The tick evaluation is performed client-side by the Python SDK: it calls
`list_workstreams()`, evaluates dependencies and status, and returns a
deterministic action list. The dispatcher then executes those actions.

## Execution Tracking

When the dispatcher creates a Genie Code scheduled task for a worker, it records:

| Field | Source | Purpose |
| --- | --- | --- |
| `automation_id` | scheduleAgentTool response | Link to the physical scheduled task |
| `automation_url` | Response URL | Manual intervention link |
| `worker_prompt_hash` | SHA-256 of bootstrap prompt | Reproducibility |
| `skill_version` | Current skill version at dispatch time | Audit trail |
| `heartbeat_at` | Updated on each MCP tool call | Liveness detection |
| `timeout_threshold_min` | From workstream config (default: 45) | Stuck detection |

## SDKs

| SDK | Location | Runtime | Auth |
| --- | --- | --- | --- |
| Python (`hi-genie-sdk`) | `hi-genie-orchestrator/hi-genie-sdk/` | Databricks compute (notebooks, Jobs, scheduled tasks) | `M2MAuthProvider` |
| TypeScript (`shared/sdk`) | `mcp-hi-genie-orchestrator/shared/sdk/` | Node.js, browser, Supervisor Agents | Bearer token in config |

Contract source of truth: `GET {app_base_url}/api/docs/openapi.json`
