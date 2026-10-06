/**
 * Hi Genie Orchestrator SDK — Typed HTTP Client (TypeScript)
 *
 * Zero-dependency typed client for the Supervisor API (/api/v1).
 * Uses native fetch (Node 18+ / browser). All methods return typed
 * responses matching the OpenAPI spec.
 *
 * This SDK is used by:
 *   - Agent harnesses (TypeScript-based dispatchers, Supervisor Agents)
 *   - React UI (manual dispatch/pause/approve from the admin dashboard)
 *   - Any non-Python consumer driving the orchestration lifecycle
 *
 * Workers (Genie Code sessions) do NOT use this SDK — they connect
 * directly to /mcp via the MCP protocol (Streamable HTTP / JSON-RPC 2.0).
 *
 * Contract source of truth:
 *   The OpenAPI spec at GET {baseUrl}/api/docs/openapi.json is the
 *   authoritative API contract. types.ts is derived from the server's
 *   Zod schemas via that spec. The Python SDK (hi-genie-sdk/) must stay
 *   aligned with the same contract — reconcile after any route changes.
 *
 * Auth:
 *   Both the Supervisor API (/api/v1) and MCP endpoint (/mcp) use the
 *   same OAuth2 auth: a Bearer token from the workspace's client_credentials
 *   grant (POST {workspace}/oidc/v1/token). The App auth sidecar validates
 *   the token and sets x-forwarded-user for identity.
 *
 * Usage:
 *   import { OrchestratorClient } from '@hi-genie/sdk';
 *
 *   const client = new OrchestratorClient({
 *     baseUrl: 'https://mcp-hi-genie-orchestrator-dev-7474657291520070.aws.databricksapps.com',
 *     token: '<m2m_oauth_token>',
 *   });
 *
 *   const { plan } = await client.plans.create({ project_id: '...', name: 'My Plan' });
 *   const { orchestration } = await client.plans.orchestrate(plan.plan_id, {});
 *   const { workstreams } = await client.workstreams.list(orchestration.orchestration_id);
 */

import type {
  OrchestratorClientConfig,
  // Plans
  CreatePlanRequest,
  CreatePlanResponse,
  GetPlanResponse,
  PublishPlanRequest,
  PublishPlanResponse,
  OrchestratePlanRequest,
  OrchestratePlanResponse,
  // Workstreams
  MaterializeRequest,
  MaterializeResponse,
  ListWorkstreamsResponse,
  DispatchRequest,
  DispatchResponse,
  RetryRequest,
  RetryResponse,
  PauseRequest,
  PauseResponse,
  UnpauseResponse,
  // Reviews
  CreateReviewRequest,
  CreateReviewResponse,
  GetReviewResponse,
  RemediationRequest,
  RemediationResponse,
  ApproveRequest,
  ApproveResponse,
  // MCP
  McpToolCatalogResponse,
  // Health
  HealthResponse,
  ErrorResponse,
} from './types.js';

// ── SDK Error ─────────────────────────────────────────────────────────────────

export class OrchestratorApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ErrorResponse,
    public readonly url: string,
  ) {
    super(`[${status}] ${body.error}: ${body.message ?? 'Unknown error'}`);
    this.name = 'OrchestratorApiError';
  }
}

// ── HTTP Transport ────────────────────────────────────────────────────────────

class HttpTransport {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeout: number;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config: OrchestratorClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
    this.timeout = config.timeout ?? 30_000;
    this.fetchFn = config.fetch ?? globalThis.fetch;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchFn(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new OrchestratorApiError(response.status, data as ErrorResponse, url);
      }

      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
}

// ── Plans Sub-Client ─────────────────────────────────────────────────────────

export class PlansClient {
  constructor(private readonly http: HttpTransport) {}

  /** POST /api/v1/plans — Ingest a new plan */
  create(req: CreatePlanRequest): Promise<CreatePlanResponse> {
    return this.http.post('/api/v1/plans', req);
  }

  /** GET /api/v1/plans/:planId — Retrieve plan with snapshots */
  get(planId: string): Promise<GetPlanResponse> {
    return this.http.get(`/api/v1/plans/${planId}`);
  }

  /** POST /api/v1/plans/:planId/publish — Create immutable snapshot */
  publish(planId: string, req: PublishPlanRequest): Promise<PublishPlanResponse> {
    return this.http.post(`/api/v1/plans/${planId}/publish`, req);
  }

  /** POST /api/v1/plans/:planId/orchestrate — Create orchestration */
  orchestrate(planId: string, req?: OrchestratePlanRequest): Promise<OrchestratePlanResponse> {
    return this.http.post(`/api/v1/plans/${planId}/orchestrate`, req ?? {});
  }
}

// ── Workstreams Sub-Client ────────────────────────────────────────────────────

export class WorkstreamsClient {
  constructor(private readonly http: HttpTransport) {}

  /** POST /api/v1/orchestrations/:orchId/materialize — Materialize workstreams from snapshot */
  materialize(orchId: string, req: MaterializeRequest): Promise<MaterializeResponse> {
    return this.http.post(`/api/v1/orchestrations/${orchId}/materialize`, req);
  }

  /** GET /api/v1/orchestrations/:orchId/workstreams — List workstreams */
  list(orchId: string): Promise<ListWorkstreamsResponse> {
    return this.http.get(`/api/v1/orchestrations/${orchId}/workstreams`);
  }

  /** POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/dispatch — Trigger execution */
  dispatch(orchId: string, wsKey: string, req: DispatchRequest): Promise<DispatchResponse> {
    return this.http.post(`/api/v1/orchestrations/${orchId}/workstreams/${wsKey}/dispatch`, req);
  }

  /** POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/retry — Retry blocked workstream */
  retry(orchId: string, wsKey: string, req: RetryRequest): Promise<RetryResponse> {
    return this.http.post(`/api/v1/orchestrations/${orchId}/workstreams/${wsKey}/retry`, req);
  }

  /** POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/pause — Pause workstream */
  pause(orchId: string, wsKey: string, req?: PauseRequest): Promise<PauseResponse> {
    return this.http.post(`/api/v1/orchestrations/${orchId}/workstreams/${wsKey}/pause`, req ?? {});
  }

  /** POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/unpause — Resume workstream */
  unpause(orchId: string, wsKey: string): Promise<UnpauseResponse> {
    return this.http.post(`/api/v1/orchestrations/${orchId}/workstreams/${wsKey}/unpause`);
  }
}

// ── Reviews Sub-Client ────────────────────────────────────────────────────────

export class ReviewsClient {
  constructor(private readonly http: HttpTransport) {}

  /** POST /api/v1/reviews — Create review task (idempotent) */
  create(req: CreateReviewRequest): Promise<CreateReviewResponse> {
    return this.http.post('/api/v1/reviews', req);
  }

  /** GET /api/v1/reviews/:reviewId — Retrieve review task */
  get(reviewId: string): Promise<GetReviewResponse> {
    return this.http.get(`/api/v1/reviews/${reviewId}`);
  }

  /** POST /api/v1/reviews/:reviewId/remediation — Deliver findings */
  deliverRemediation(reviewId: string, req: RemediationRequest): Promise<RemediationResponse> {
    return this.http.post(`/api/v1/reviews/${reviewId}/remediation`, req);
  }

  /** POST /api/v1/reviews/:reviewId/approve — Supervisor completion approval */
  approve(reviewId: string, req: ApproveRequest): Promise<ApproveResponse> {
    return this.http.post(`/api/v1/reviews/${reviewId}/approve`, req);
  }
}

// ── MCP Sub-Client ────────────────────────────────────────────────────────────

export class McpClient {
  constructor(private readonly http: HttpTransport) {}

  /** GET /api/v1/mcp/tools — List all registered MCP tools */
  listTools(): Promise<McpToolCatalogResponse> {
    return this.http.get('/api/v1/mcp/tools');
  }
}

// ── Main Client ───────────────────────────────────────────────────────────────

/**
 * Typed client for the Hi Genie Orchestrator Supervisor API.
 *
 * ```ts
 * const client = new OrchestratorClient({
 *   baseUrl: 'https://mcp-hi-genie-orchestrator-dev-...databricksapps.com',
 *   token: await getOAuthToken(),
 * });
 *
 * // Full lifecycle:
 * const { plan } = await client.plans.create({ project_id, name: 'Sprint 42' });
 * const { snapshot } = await client.plans.publish(plan.plan_id, { content, workstream_count: 3 });
 * const { orchestration } = await client.plans.orchestrate(plan.plan_id, {});
 * const { workstreams } = await client.workstreams.list(orchestration.orchestration_id);
 * ```
 */
export class OrchestratorClient {
  public readonly plans: PlansClient;
  public readonly workstreams: WorkstreamsClient;
  public readonly reviews: ReviewsClient;
  public readonly mcp: McpClient;

  private readonly http: HttpTransport;

  constructor(config: OrchestratorClientConfig) {
    this.http = new HttpTransport(config);
    this.plans = new PlansClient(this.http);
    this.workstreams = new WorkstreamsClient(this.http);
    this.reviews = new ReviewsClient(this.http);
    this.mcp = new McpClient(this.http);
  }

  /** GET /api/health — Service health check */
  health(): Promise<HealthResponse> {
    return this.http.get('/api/health');
  }

  /** GET /api/docs/openapi.json — Fetch the raw OpenAPI spec */
  getOpenApiSpec(): Promise<Record<string, unknown>> {
    return this.http.get('/api/docs/openapi.json');
  }
}
