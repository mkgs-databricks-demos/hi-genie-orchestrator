"""Hi Genie SDK — Typed async client for the Supervisor API.

Provides:
  - Pydantic request/response models for all /api/v1 endpoints
  - HiGenieClient with httpx async transport
  - M2MAuthProvider for OAuth2 client_credentials token exchange
  - WS-INIT evaluation method for priority-tree dispatch

All methods are fully typed and raise HiGenieError on non-2xx responses.

Contract source of truth:
  The OpenAPI spec is the authoritative API contract. Fetch it live at:
    GET {app_base_url}/api/docs/openapi.json
  The TypeScript SDK (mcp-hi-genie-orchestrator/shared/sdk/) derives its
  types directly from the server's Zod schemas. This Python SDK's Pydantic
  models must stay aligned with that spec — reconcile after any route changes.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional, Protocol

import httpx
from pydantic import BaseModel, Field


# ─────────────────────────────────────────────────────────────────────────
# Exceptions
# ─────────────────────────────────────────────────────────────────────────


class HiGenieError(Exception):
    """Raised when the Supervisor API returns a non-2xx response."""

    def __init__(self, status_code: int, error: str, message: str, details: Any = None):
        self.status_code = status_code
        self.error = error
        self.message = message
        self.details = details
        super().__init__(f"[{status_code}] {error}: {message}")


# ─────────────────────────────────────────────────────────────────────────
# Auth Provider
# ─────────────────────────────────────────────────────────────────────────


class AuthProvider(Protocol):
    """Protocol for auth token providers."""

    async def get_token(self) -> str:
        """Return a valid access token for the Supervisor API."""
        ...


class M2MAuthProvider:
    """Machine-to-Machine auth provider for the Orchestrator API.

    Uses the OAuth2 client_credentials flow against the Databricks
    workspace OIDC endpoint to acquire a Bearer token. This is the
    same auth mechanism used by both the Supervisor API (/api/v1)
    and the MCP endpoint (/mcp) — the App's auth sidecar validates
    the token and sets x-forwarded-user for identity.

    Args:
        workspace_host: Databricks workspace URL (e.g. https://fevm-hls-fde.cloud.databricks.com)
        client_id: SPN OAuth2 client_id (from secret scope)
        client_secret: SPN OAuth2 client_secret (from secret scope)
        token: Optional pre-acquired Bearer token (skips token exchange)
    """

    def __init__(
        self,
        workspace_host: Optional[str] = None,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        token: Optional[str] = None,
    ):
        self._workspace_host = workspace_host
        self._client_id = client_id
        self._client_secret = client_secret
        self._token = token

    async def get_token(self) -> str:
        """Acquire a Bearer token via client_credentials grant.

        POST {workspace_host}/oidc/v1/token
        grant_type=client_credentials&client_id=...&client_secret=...&scope=all-apis
        """
        if self._token:
            return self._token

        if not all([self._workspace_host, self._client_id, self._client_secret]):
            raise HiGenieError(
                status_code=401,
                error="AUTH_CONFIG_ERROR",
                message=(
                    "M2MAuthProvider requires workspace_host, client_id, and "
                    "client_secret — or provide a pre-acquired token directly."
                ),
            )

        token_url = f"{self._workspace_host.rstrip('/')}/oidc/v1/token"

        async with httpx.AsyncClient() as client:
            response = await client.post(
                token_url,
                data={
                    "grant_type": "client_credentials",
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "scope": "all-apis",
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )

            if response.status_code != 200:
                raise HiGenieError(
                    status_code=response.status_code,
                    error="TOKEN_EXCHANGE_FAILED",
                    message=f"OAuth2 token exchange failed: {response.text}",
                )

            data = response.json()
            self._token = data["access_token"]
            return self._token


# ─────────────────────────────────────────────────────────────────────────
# Request Models
# ─────────────────────────────────────────────────────────────────────────


class CreatePlanRequest(BaseModel):
    """Request body for POST /api/v1/plans."""

    project_id: str = Field(..., description="UUID of the project")
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    source_ref: Optional[dict[str, Any]] = None


class PublishPlanRequest(BaseModel):
    """Request body for POST /api/v1/plans/:planId/publish."""

    content: dict[str, Any] = Field(..., description="Plan content to snapshot")
    workstream_count: int = Field(..., ge=0)


class MaterializeRequest(BaseModel):
    """Request body for POST /api/v1/orchestrations/:orchId/materialize."""

    plan_snapshot_id: str = Field(..., description="UUID of the plan snapshot")
    priority: int = Field(default=50, ge=0, le=100)
    correlation_id: Optional[str] = None
    configuration_version: str = "1.0.0"


class OrchestratePlanRequest(BaseModel):
    """Request body for POST /api/v1/plans/:planId/orchestrate."""

    plan_snapshot_id: Optional[str] = Field(default=None, description="Snapshot to orchestrate (defaults to current)")
    priority: int = Field(default=50, ge=0, le=100)


class DispatchRequest(BaseModel):
    """Request body for POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/dispatch."""

    worker_identity: Optional[str] = Field(default=None, min_length=1, description="Optional — defaults to authenticated caller identity")
    correlation_id: Optional[str] = None


class RetryRequest(BaseModel):
    """Request body for POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/retry."""

    reason: str = Field(..., min_length=1, max_length=1000)
    correlation_id: Optional[str] = None


class PauseRequest(BaseModel):
    """Request body for POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/pause."""

    reason: Optional[str] = Field(default=None, max_length=1000)


class Finding(BaseModel):
    """A single review finding."""

    category: str = Field(..., min_length=1)
    severity: str = Field(..., pattern="^(INFO|WARNING|ERROR|CRITICAL)$")
    description: str = Field(..., min_length=1)
    remediation_hint: Optional[str] = None
    artifact_ref: Optional[str] = None


class TestResult(BaseModel):
    """A single test result in a review."""

    test_name: str = Field(..., min_length=1)
    passed: bool
    message: Optional[str] = None
    artifact_ref: Optional[str] = None


class CreateReviewRequest(BaseModel):
    """Request body for POST /api/v1/reviews."""

    review_task_id: str = Field(..., description="UUID for idempotent creation")
    workstream_id: str
    orchestration_id: str
    project_id: str
    execution_id: str
    correlation_id: Optional[str] = None


class RemediationRequest(BaseModel):
    """Request body for POST /api/v1/reviews/:reviewId/remediation."""

    findings: list[Finding]
    test_results: Optional[list[TestResult]] = None
    checks_performed: Optional[list[str]] = None
    correlation_id: Optional[str] = None


class ApproveRequest(BaseModel):
    """Request body for POST /api/v1/reviews/:reviewId/approve."""

    outcome: str = Field(..., pattern="^(PASS|FAIL|INCONCLUSIVE)$")
    outcome_reason: str = Field(..., min_length=1, max_length=2000)
    checks_performed: Optional[list[str]] = None
    artifact_refs: Optional[list[str]] = None
    correlation_id: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────
# Response Models
# ─────────────────────────────────────────────────────────────────────────


class Plan(BaseModel):
    """Plan response model."""

    plan_id: str
    project_id: str
    name: str
    description: Optional[str] = None
    source_ref: Optional[dict[str, Any]] = None
    current_snapshot_id: Optional[str] = None
    created_by: str
    created_at: datetime
    updated_at: datetime


class PlanSnapshot(BaseModel):
    """Plan snapshot response model."""

    plan_snapshot_id: str
    plan_id: str
    version: int
    content_hash: str
    content: Optional[dict[str, Any]] = None
    workstream_count: int
    created_by: str
    created_at: datetime


class Workstream(BaseModel):
    """Workstream response model."""

    workstream_id: str
    orchestration_id: str
    project_id: str
    workstream_key: str
    name: str
    status: str
    execution_tier: int
    depends_on: list[str] = Field(default_factory=list)
    config: dict[str, Any] = Field(default_factory=dict)
    attempt_count: int = 0
    max_retries: int = 3
    assigned_to: Optional[str] = None
    priority: int = 50
    correlation_id: str
    created_at: datetime
    updated_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None


class Orchestration(BaseModel):
    """Orchestration response model."""

    orchestration_id: str
    project_id: str
    plan_id: str
    plan_snapshot_id: str
    status: str
    priority: int
    correlation_id: str
    configuration_version: str
    created_by: str
    created_at: datetime
    updated_at: datetime


class Execution(BaseModel):
    """Execution response model."""

    execution_id: str
    workstream_id: str
    workstream_key: str
    attempt_number: int
    status: str
    correlation_id: str


class ReviewTask(BaseModel):
    """Review task response model."""

    review_task_id: str
    workstream_id: str
    orchestration_id: str
    project_id: str
    execution_id: str
    status: str
    reviewer_identity: Optional[str] = None
    checks_performed: Optional[list[str]] = None
    artifact_refs: Optional[list[str]] = None
    test_results: Optional[list[dict[str, Any]]] = None
    findings: Optional[list[dict[str, Any]]] = None
    outcome: Optional[str] = None
    outcome_reason: Optional[str] = None
    correlation_id: str
    created_by: str
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None


# ─────────────────────────────────────────────────────────────────────────
# WS-INIT Response
# ─────────────────────────────────────────────────────────────────────────


class WSInitAction(BaseModel):
    """A single action from WS-INIT priority-tree evaluation."""

    action: str = Field(..., description="Action type: dispatch | retry | pause | review | skip")
    workstream_key: str
    reason: str
    priority: int
    metadata: Optional[dict[str, Any]] = None


class WSInitResult(BaseModel):
    """Result of a WS-INIT tick evaluation."""

    orchestration_id: str
    tick_id: str
    actions: list[WSInitAction]
    evaluated_at: datetime
    workstreams_evaluated: int


# ─────────────────────────────────────────────────────────────────────────
# Client
# ─────────────────────────────────────────────────────────────────────────


class HiGenieClient:
    """Typed async client for the Hi Genie Orchestrator Supervisor API.

    This SDK is used by the dispatcher (Genie Code scheduled tasks, notebooks,
    Databricks Jobs) to drive the orchestration lifecycle via /api/v1.
    Workers (Genie Code sessions) connect directly to /mcp via MCP protocol.

    Supports context manager usage:
        async with HiGenieClient(base_url="...") as client:
            ...

    Auth:
        - Provide an M2MAuthProvider for OAuth2 client_credentials token management
        - Or pass a static token directly (e.g., from dbutils.secrets)

    Full lifecycle:
        plan = await client.create_plan(CreatePlanRequest(...))
        snapshot = await client.publish_plan(plan.plan_id, PublishPlanRequest(...))
        orch = await client.orchestrate(plan.plan_id)
        await client.materialize(orch.orchestration_id, MaterializeRequest(...))
        workstreams = await client.list_workstreams(orch.orchestration_id)
        exec = await client.dispatch_workstream(orch.orchestration_id, "ws-a")
    """

    def __init__(
        self,
        base_url: str,
        auth: Optional[AuthProvider] = None,
        token: Optional[str] = None,
        timeout: float = 30.0,
    ):
        self._base_url = base_url.rstrip("/")
        self._auth = auth
        self._token = token
        self._timeout = timeout
        self._client: Optional[httpx.AsyncClient] = None

    async def __aenter__(self) -> "HiGenieClient":
        self._client = httpx.AsyncClient(
            base_url=f"{self._base_url}/api/v1",
            timeout=self._timeout,
        )
        return self

    async def __aexit__(self, *args: Any) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            raise RuntimeError("Client not initialized. Use 'async with HiGenieClient(...)' context.")
        return self._client

    async def _get_headers(self) -> dict[str, str]:
        """Build auth headers."""
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._auth:
            token = await self._auth.get_token()
            headers["Authorization"] = f"Bearer {token}"
        elif self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return headers

    async def _request(
        self, method: str, path: str, json_data: Optional[dict[str, Any]] = None
    ) -> dict[str, Any]:
        """Make an authenticated request and handle errors."""
        headers = await self._get_headers()
        response = await self.client.request(
            method, path, headers=headers, json=json_data
        )
        if response.status_code >= 400:
            body = response.json()
            raise HiGenieError(
                status_code=response.status_code,
                error=body.get("error", "UNKNOWN"),
                message=body.get("message", response.text),
                details=body.get("details"),
            )
        return response.json()

    # ─── Plan Operations ─────────────────────────────────────────────────────

    async def create_plan(self, request: CreatePlanRequest) -> Plan:
        """Ingest a new plan. POST /api/v1/plans."""
        data = await self._request("POST", "/plans", request.model_dump(exclude_none=True))
        return Plan.model_validate(data["plan"])

    async def get_plan(self, plan_id: str) -> tuple[Plan, list[PlanSnapshot]]:
        """Retrieve plan with snapshots. GET /api/v1/plans/:planId."""
        data = await self._request("GET", f"/plans/{plan_id}")
        plan = Plan.model_validate(data["plan"])
        snapshots = [PlanSnapshot.model_validate(s) for s in data.get("snapshots", [])]
        return plan, snapshots

    async def publish_plan(self, plan_id: str, request: PublishPlanRequest) -> PlanSnapshot:
        """Create an immutable snapshot. POST /api/v1/plans/:planId/publish."""
        data = await self._request(
            "POST", f"/plans/{plan_id}/publish", request.model_dump()
        )
        return PlanSnapshot.model_validate(data["snapshot"])

    async def orchestrate(
        self, plan_id: str, request: Optional[OrchestratePlanRequest] = None
    ) -> Orchestration:
        """Create an orchestration from a plan. POST /api/v1/plans/:planId/orchestrate."""
        body = (request or OrchestratePlanRequest()).model_dump(exclude_none=True)
        data = await self._request("POST", f"/plans/{plan_id}/orchestrate", body)
        return Orchestration.model_validate(data["orchestration"])

    # ─── Workstream Operations ────────────────────────────────────────────────

    async def materialize(
        self, orchestration_id: str, request: MaterializeRequest
    ) -> dict[str, Any]:
        """Materialize workstreams from plan snapshot. POST /api/v1/orchestrations/:orchId/materialize."""
        return await self._request(
            "POST",
            f"/orchestrations/{orchestration_id}/materialize",
            request.model_dump(exclude_none=True),
        )

    async def list_workstreams(self, orchestration_id: str) -> list[Workstream]:
        """List workstreams for an orchestration. GET /api/v1/orchestrations/:orchId/workstreams."""
        data = await self._request("GET", f"/orchestrations/{orchestration_id}/workstreams")
        return [Workstream.model_validate(w) for w in data["workstreams"]]

    async def dispatch_workstream(
        self, orchestration_id: str, workstream_key: str, request: Optional[DispatchRequest] = None
    ) -> Execution:
        """Trigger workstream execution. POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/dispatch."""
        body = (request or DispatchRequest()).model_dump(exclude_none=True)
        data = await self._request(
            "POST",
            f"/orchestrations/{orchestration_id}/workstreams/{workstream_key}/dispatch",
            body,
        )
        return Execution.model_validate(data)

    async def retry_workstream(
        self, orchestration_id: str, workstream_key: str, request: RetryRequest
    ) -> dict[str, Any]:
        """Retry a failed workstream. POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/retry."""
        return await self._request(
            "POST",
            f"/orchestrations/{orchestration_id}/workstreams/{workstream_key}/retry",
            request.model_dump(exclude_none=True),
        )

    async def pause_workstream(
        self, orchestration_id: str, workstream_key: str, request: Optional[PauseRequest] = None
    ) -> dict[str, Any]:
        """Pause a workstream. POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/pause."""
        body = (request or PauseRequest()).model_dump(exclude_none=True)
        return await self._request(
            "POST",
            f"/orchestrations/{orchestration_id}/workstreams/{workstream_key}/pause",
            body,
        )

    async def unpause_workstream(
        self, orchestration_id: str, workstream_key: str
    ) -> dict[str, Any]:
        """Unpause a workstream. POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/unpause."""
        return await self._request(
            "POST",
            f"/orchestrations/{orchestration_id}/workstreams/{workstream_key}/unpause",
            {},
        )

    # ─── Review Operations ────────────────────────────────────────────────────

    async def create_review(self, request: CreateReviewRequest) -> ReviewTask:
        """Create a review task (idempotent). POST /api/v1/reviews."""
        data = await self._request("POST", "/reviews", request.model_dump(exclude_none=True))
        return ReviewTask.model_validate(data["review_task"])

    async def get_review(self, review_id: str) -> ReviewTask:
        """Retrieve a review task. GET /api/v1/reviews/:reviewId."""
        data = await self._request("GET", f"/reviews/{review_id}")
        return ReviewTask.model_validate(data["review_task"])

    async def deliver_remediation(
        self, review_id: str, request: RemediationRequest
    ) -> dict[str, Any]:
        """Deliver remediation envelope. POST /api/v1/reviews/:reviewId/remediation."""
        return await self._request(
            "POST",
            f"/reviews/{review_id}/remediation",
            request.model_dump(exclude_none=True),
        )

    async def approve_review(
        self, review_id: str, request: ApproveRequest
    ) -> dict[str, Any]:
        """Supervisor-only completion approval. POST /api/v1/reviews/:reviewId/approve."""
        return await self._request(
            "POST",
            f"/reviews/{review_id}/approve",
            request.model_dump(exclude_none=True),
        )

    # ─── WS-INIT Evaluation ───────────────────────────────────────────────────

    async def ws_init_tick(self, orchestration_id: str) -> WSInitResult:
        """Evaluate the priority tree and get next actions.

        The WS-INIT tick reads current orchestration state and produces
        a deterministic action list based on the priority tree:
          - Dependency resolution
          - Retry eligibility
          - Review readiness
          - Dispatch ordering by tier and priority

        This is a stateless evaluation — it does not mutate state.
        The caller (dispatch engine) applies the returned actions.
        """
        workstreams = await self.list_workstreams(orchestration_id)
        tick_id = str(uuid.uuid4())
        actions: list[WSInitAction] = []

        # Build dependency lookup
        ws_by_key = {ws.workstream_key: ws for ws in workstreams}
        completed_keys = {ws.workstream_key for ws in workstreams if ws.status == "COMPLETE"}

        for ws in sorted(workstreams, key=lambda w: (w.execution_tier, -w.priority)):
            if ws.status == "COMPLETE" or ws.status == "CANCELLED":
                continue

            # Check dependencies satisfied
            deps_met = all(dep in completed_keys for dep in ws.depends_on)

            if ws.status == "NOT_STARTED" and deps_met:
                actions.append(WSInitAction(
                    action="dispatch",
                    workstream_key=ws.workstream_key,
                    reason="Dependencies satisfied, ready for dispatch",
                    priority=ws.priority,
                ))
            elif ws.status == "RETRYING" and deps_met:
                if ws.attempt_count < ws.max_retries:
                    actions.append(WSInitAction(
                        action="retry",
                        workstream_key=ws.workstream_key,
                        reason=f"Retry eligible (attempt {ws.attempt_count}/{ws.max_retries})",
                        priority=ws.priority,
                    ))
            elif ws.status == "READY_FOR_REVIEW":
                actions.append(WSInitAction(
                    action="review",
                    workstream_key=ws.workstream_key,
                    reason="Ready for supervisor review",
                    priority=ws.priority + 10,  # Review tasks get priority boost
                ))
            elif ws.status == "BLOCKED":
                actions.append(WSInitAction(
                    action="skip",
                    workstream_key=ws.workstream_key,
                    reason="Blocked, awaiting manual intervention or unpause",
                    priority=0,
                ))
            elif not deps_met:
                unmet = [d for d in ws.depends_on if d not in completed_keys]
                actions.append(WSInitAction(
                    action="skip",
                    workstream_key=ws.workstream_key,
                    reason=f"Waiting on dependencies: {', '.join(unmet)}",
                    priority=0,
                ))

        return WSInitResult(
            orchestration_id=orchestration_id,
            tick_id=tick_id,
            actions=actions,
            evaluated_at=datetime.utcnow(),
            workstreams_evaluated=len(workstreams),
        )
