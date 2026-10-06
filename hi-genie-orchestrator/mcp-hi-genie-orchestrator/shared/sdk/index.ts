/**
 * Hi Genie Orchestrator SDK — Barrel Export
 *
 * Public API surface for the typed client SDK.
 *
 * Usage:
 *   import { OrchestratorClient, OrchestratorApiError } from '../shared/sdk';
 *   // or publish as @hi-genie/sdk for external consumers
 */

// Client
export { OrchestratorClient, OrchestratorApiError } from './client.js';
export { PlansClient, WorkstreamsClient, ReviewsClient, McpClient } from './client.js';

// Types
export type {
  OrchestratorClientConfig,
  ErrorResponse,
  // Plans
  Plan,
  PlanSnapshot,
  Orchestration,
  CreatePlanRequest,
  CreatePlanResponse,
  GetPlanResponse,
  PublishPlanRequest,
  PublishPlanResponse,
  OrchestratePlanRequest,
  OrchestratePlanResponse,
  // Workstreams
  WorkstreamStatus,
  Workstream,
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
  ReviewOutcome,
  FindingSeverity,
  ReviewTask,
  Finding,
  TestResult,
  CreateReviewRequest,
  CreateReviewResponse,
  GetReviewResponse,
  RemediationRequest,
  RemediationResponse,
  ApproveRequest,
  ApproveResponse,
  // MCP
  McpToolDefinition,
  McpToolCatalogResponse,
  // Health
  HealthResponse,
} from './types.js';
