"""Hi Genie SDK — Typed Python client for the Hi Genie Orchestrator Supervisor API.

Provides:
  - HiGenieClient: Async client wrapping all /api/v1 endpoints
  - Pydantic models for request/response types
  - M2MAuthProvider for OAuth2 client_credentials token exchange
  - WS-INIT evaluation method for priority-tree dispatch

Usage:
  from hi_genie import HiGenieClient, M2MAuthProvider

  auth = M2MAuthProvider(
      workspace_host="https://fevm-hls-fde.cloud.databricks.com",
      client_id="...",
      client_secret="...",
  )

  async with HiGenieClient(base_url="https://app-url", auth=auth) as client:
      plan = await client.create_plan(CreatePlanRequest(project_id="...", name="..."))
      snapshot = await client.publish_plan(plan.plan_id, PublishPlanRequest(...))
      orch = await client.orchestrate(plan.plan_id)
      await client.dispatch_workstream(orch.orchestration_id, "ws-a")
"""

__version__ = "0.2.0"

from hi_genie.client import (
    HiGenieClient,
    # Request models
    CreatePlanRequest,
    PublishPlanRequest,
    OrchestratePlanRequest,
    MaterializeRequest,
    DispatchRequest,
    RetryRequest,
    PauseRequest,
    CreateReviewRequest,
    RemediationRequest,
    ApproveRequest,
    # Response models
    Plan,
    PlanSnapshot,
    Orchestration,
    Workstream,
    Execution,
    ReviewTask,
    # WS-INIT
    WSInitAction,
    WSInitResult,
    # Auth
    M2MAuthProvider,
    # Errors
    HiGenieError,
)

__all__ = [
    "__version__",
    "HiGenieClient",
    # Request models
    "CreatePlanRequest",
    "PublishPlanRequest",
    "OrchestratePlanRequest",
    "MaterializeRequest",
    "DispatchRequest",
    "RetryRequest",
    "PauseRequest",
    "CreateReviewRequest",
    "RemediationRequest",
    "ApproveRequest",
    # Response models
    "Plan",
    "PlanSnapshot",
    "Orchestration",
    "Workstream",
    "Execution",
    "ReviewTask",
    # WS-INIT
    "WSInitAction",
    "WSInitResult",
    # Auth
    "M2MAuthProvider",
    # Errors
    "HiGenieError",
]
