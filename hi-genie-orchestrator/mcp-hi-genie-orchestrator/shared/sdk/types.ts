/**
 * Hi Genie Orchestrator SDK — Type Definitions
 *
 * Derived from the OpenAPI 3.1 spec (server/api/openapi.ts).
 * These types mirror the Zod schemas used in route handlers.
 *
 * Zero external dependencies — pure TypeScript interfaces.
 *
 * CONTRACT LINK:
 *   Source of truth: GET {baseUrl}/api/docs/openapi.json
 *   Server schemas:  server/api/routes/*.ts (Zod definitions)
 *   Python sibling:  hi-genie-sdk/src/hi_genie/client.py (Pydantic models)
 *
 *   When routes or schemas change, update this file FIRST (it derives
 *   directly from server Zod), then reconcile the Python SDK Pydantic models.
 */

// ───────────────────────────────────────────────────────────────────────────
// Shared
// ───────────────────────────────────────────────────────────────────────────

export interface ErrorResponse {
  error: string;
  message?: string;
  details?: Record<string, unknown>;
}

// ───────────────────────────────────────────────────────────────────────────
// Plans
// ───────────────────────────────────────────────────────────────────────────

export interface Plan {
  plan_id: string;
  project_id: string;
  name: string;
  description: string | null;
  source_ref: Record<string, unknown> | null;
  current_snapshot_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PlanSnapshot {
  plan_snapshot_id: string;
  plan_id: string;
  version: number;
  content_hash: string;
  content: Record<string, unknown>;
  workstream_count: number;
  created_by: string;
  created_at: string;
}

export interface Orchestration {
  orchestration_id: string;
  project_id: string;
  plan_id: string;
  plan_snapshot_id: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED' | 'CANCELLED';
  priority: number;
  correlation_id: string;
  configuration_version: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreatePlanRequest {
  project_id: string;
  name: string;
  description?: string;
  source_ref?: Record<string, unknown>;
}

export interface PublishPlanRequest {
  content: Record<string, unknown>;
  workstream_count: number;
}

export interface OrchestratePlanRequest {
  plan_snapshot_id?: string;
  priority?: number;
}

export interface CreatePlanResponse {
  plan: Plan;
}

export interface GetPlanResponse {
  plan: Plan;
  snapshots: PlanSnapshot[];
}

export interface PublishPlanResponse {
  snapshot: PlanSnapshot;
  idempotent: boolean;
  message?: string;
}

export interface OrchestratePlanResponse {
  orchestration: Orchestration;
}

// ───────────────────────────────────────────────────────────────────────────
// Workstreams
// ───────────────────────────────────────────────────────────────────────────

export type WorkstreamStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'VALIDATING'
  | 'READY_FOR_REVIEW'
  | 'COMPLETE'
  | 'BLOCKED'
  | 'RETRYING'
  | 'CANCELLED';

export interface Workstream {
  workstream_id: string;
  orchestration_id: string;
  project_id: string;
  workstream_key: string;
  name: string;
  status: WorkstreamStatus;
  execution_tier: number;
  depends_on: string[];
  config: Record<string, unknown>;
  attempt_count: number;
  max_retries: number;
  assigned_to: string | null;
  priority: number;
  correlation_id: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface MaterializeRequest {
  plan_snapshot_id: string;
  priority?: number;
  correlation_id?: string;
  configuration_version?: string;
}

export interface DispatchRequest {
  /** Optional — defaults to authenticated caller identity (x-forwarded-user) */
  worker_identity?: string;
  correlation_id?: string;
}

export interface RetryRequest {
  reason: string;
  correlation_id?: string;
}

export interface PauseRequest {
  reason?: string;
}

export interface MaterializeResponse {
  orchestration_id: string;
  workstreams_materialized: number;
  workstreams: Workstream[];
  correlation_id: string;
}

export interface ListWorkstreamsResponse {
  workstreams: Workstream[];
}

export interface DispatchResponse {
  execution_id: string;
  workstream_id: string;
  workstream_key: string;
  attempt_number: number;
  status: string;
  correlation_id: string;
}

export interface RetryResponse {
  workstream_id: string;
  workstream_key: string;
  status: 'RETRYING';
  reason: string;
  correlation_id: string;
}

export interface PauseResponse {
  workstream: { workstream_id: string; workstream_key: string; status: string };
  reason: string | null;
}

export interface UnpauseResponse {
  workstream: { workstream_id: string; workstream_key: string; status: string };
}

// ───────────────────────────────────────────────────────────────────────────
// Reviews
// ───────────────────────────────────────────────────────────────────────────

export type ReviewOutcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
export type FindingSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export interface ReviewTask {
  review_task_id: string;
  workstream_id: string;
  orchestration_id: string;
  project_id: string;
  execution_id: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  reviewer_identity: string | null;
  checks_performed: string[] | null;
  artifact_refs: string[] | null;
  test_results: TestResult[] | null;
  findings: Finding[] | null;
  outcome: ReviewOutcome | null;
  outcome_reason: string | null;
  correlation_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface Finding {
  category: string;
  severity: FindingSeverity;
  description: string;
  remediation_hint?: string;
  artifact_ref?: string;
}

export interface TestResult {
  test_name: string;
  passed: boolean;
  message?: string;
  artifact_ref?: string;
}

export interface CreateReviewRequest {
  review_task_id: string;
  workstream_id: string;
  orchestration_id: string;
  project_id: string;
  execution_id: string;
  correlation_id?: string;
}

export interface RemediationRequest {
  findings: Finding[];
  test_results?: TestResult[];
  checks_performed?: string[];
  correlation_id?: string;
}

export interface ApproveRequest {
  outcome: ReviewOutcome;
  outcome_reason: string;
  checks_performed?: string[];
  artifact_refs?: string[];
  correlation_id?: string;
}

export interface CreateReviewResponse {
  review_task: ReviewTask;
  idempotent: boolean;
}

export interface GetReviewResponse {
  review_task: ReviewTask;
}

export interface RemediationResponse {
  review_task_id: string;
  status: 'IN_PROGRESS';
  findings_count: number;
  correlation_id: string;
}

export interface ApproveResponse {
  review_task_id: string;
  status: string;
  outcome: ReviewOutcome;
  outcome_reason: string;
  workstream_id: string;
  workstream_status: string;
  correlation_id: string;
}

// ───────────────────────────────────────────────────────────────────────────
// MCP Tool Catalog
// ───────────────────────────────────────────────────────────────────────────

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCatalogResponse {
  tools: McpToolDefinition[];
  count: number;
  categories: Record<string, string[]>;
  mcp_endpoint: string;
  protocol_version: string;
  transport: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Health
// ───────────────────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  timestamp: string;
  modules: {
    migrations: boolean;
    telemetry: boolean;
    memory: boolean;
    dispatch: boolean;
    mcp: boolean;
    api: boolean;
  };
}

// ───────────────────────────────────────────────────────────────────────────
// SDK Configuration
// ───────────────────────────────────────────────────────────────────────────

export interface OrchestratorClientConfig {
  /** Base URL of the orchestrator app (e.g. https://mcp-hi-genie-orchestrator-dev-....databricksapps.com) */
  baseUrl: string;
  /** OAuth bearer token (from SPN client_credentials flow) */
  token: string;
  /** Optional request timeout in ms (default: 30000) */
  timeout?: number;
  /** Optional custom fetch implementation */
  fetch?: typeof globalThis.fetch;
}
