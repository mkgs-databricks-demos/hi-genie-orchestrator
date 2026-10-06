---
workstream_key: ws-d
name: Supervisor API and Python SDK
status: COMPLETE
depends_on: [ws-b]
scheduled_task_id: 7728144736f34280a948106c22a32130
task_paused: false
attempt_count: 1
max_retries: 5
started_at: "2026-08-17T23:45:00Z"
completed_at: "2026-08-17T23:55:00Z"
error_message: null
prior_error: null
last_attempt_at: "2026-08-17T23:45:00Z"
---

# Workstream ws-d: Supervisor API and Python SDK

## Scope

Implement `/api/v1` routes in `server/api/`:
- Plan ingestion, validation, immutable publication (content hashes)
- Workstream materialization from plan snapshots
- Dispatch, retry, pause/unpause controls
- Review task creation (idempotent review_task_id)
- Remediation envelope delivery
- Completion approval (supervisor-only, immutable)

Python SDK in `hi-genie-sdk/`:
- `pyproject.toml` (pip-installable)
- Typed request/response models (Pydantic)
- WS-INIT client (priority-tree evaluation)
- Auth helpers (OBO token forwarding)

## Notes for Downstream Sessions

### Files Created

All paths relative to `hi-genie-orchestrator/`:

**Server API module** (`mcp-hi-genie-orchestrator/server/api/`):
- `index.ts` — Barrel export. Registers all route sub-routers on `/api/v1`. Exports `setupApiRoutes(appkit)` for `server.ts` integration. JSON body parsing, error handler.
- `routes/plans.ts` — Plan lifecycle: POST create, GET retrieve with snapshots, POST publish (immutable snapshot with SHA-256 content hash). Idempotent publish via content_hash uniqueness.
- `routes/workstreams.ts` — Workstream operations: POST materialize (from plan snapshot into dispatch.workstreams), GET list by orchestration, POST dispatch/retry/pause/unpause with status transition guards.
- `routes/reviews.ts` — Review lifecycle: POST create (idempotent by review_task_id PK), GET retrieve, POST remediation (deliver findings envelope), POST approve (supervisor-only, immutable after APPROVED/CANCELLED, transitions workstream to COMPLETE on PASS).

**Python SDK** (`hi-genie-sdk/`):
- `pyproject.toml` — Hatchling-based pip-installable package. Deps: httpx, pydantic>=2.0.
- `src/hi_genie/__init__.py` — Package init exporting HiGenieClient and all Pydantic models.
- `src/hi_genie/client.py` — Full typed async client with: request/response Pydantic models, OBOAuthProvider (Databricks SDK integration), HiGenieClient (httpx async, context manager), WS-INIT tick evaluation (stateless priority-tree).

### Key API Routes

| Method | Path | Purpose |
| --- | --- | --- |
| POST | /api/v1/plans | Ingest plan |
| GET | /api/v1/plans/:planId | Retrieve plan + snapshots |
| POST | /api/v1/plans/:planId/publish | Immutable snapshot (content hash) |
| POST | /api/v1/orchestrations/:orchId/materialize | Materialize workstreams from snapshot |
| GET | /api/v1/orchestrations/:orchId/workstreams | List workstreams |
| POST | /api/v1/workstreams/:wsKey/dispatch | Trigger execution |
| POST | /api/v1/workstreams/:wsKey/retry | Retry from BLOCKED |
| POST | /api/v1/workstreams/:wsKey/pause | Pause to BLOCKED |
| POST | /api/v1/workstreams/:wsKey/unpause | Resume to RETRYING |
| POST | /api/v1/reviews | Create review task (idempotent) |
| GET | /api/v1/reviews/:reviewId | Retrieve review |
| POST | /api/v1/reviews/:reviewId/remediation | Deliver remediation envelope |
| POST | /api/v1/reviews/:reviewId/approve | Completion approval (immutable) |

### Python SDK Usage

```python
from hi_genie import HiGenieClient, OBOAuthProvider, CreatePlanRequest, PublishPlanRequest

async with HiGenieClient(
    base_url="https://app-url",
    auth=OBOAuthProvider(workspace_host="https://workspace.cloud.databricks.com"),
) as client:
    plan = await client.create_plan(CreatePlanRequest(project_id="...", name="Release 1"))
    snapshot = await client.publish_plan(plan.plan_id, PublishPlanRequest(content={...}, workstream_count=9))
    result = await client.ws_init_tick(orchestration_id="...")
    for action in result.actions:
        if action.action == "dispatch":
            await client.dispatch_workstream(action.workstream_key, DispatchRequest(worker_identity="genie-worker"))
```

### Integration Notes for ws-e (Event Dispatch)

- **Uncomment in server.ts:** `import { setupApiRoutes } from './api/index';` and `await setupApiRoutes(appkit);` (line 24/70).
- **Pool access:** Routes use `appkit.lakebase.pool` — same pool instance as migrations and MCP.
- **Telemetry:** All route handlers wrapped with `withToolSpan` and `withDbSpan` from `../telemetry/index.js`.
- **Status transitions:** Dispatch engine should call `/workstreams/:wsKey/dispatch` after WS-INIT evaluation; completion flow is: worker writes READY_FOR_REVIEW → review creation → remediation → approve.
- **LISTEN/NOTIFY integration:** ws-e should emit Lakebase notifications after workstream status changes (status UPDATE triggers in dispatch.workstreams). The API routes already commit the state changes; ws-e adds the notification layer.
- **Idempotency:** Plan publish uses content_hash; review creation uses review_task_id PK; workstream materialization uses (project_id, idempotency_key). All safe for retry.
