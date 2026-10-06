/**
 * MCP Tools — Review Lifecycle (Reviewer Persona)
 *
 * Tools for creating review tasks, delivering remediation findings,
 * and approving/rejecting reviews (which controls workstream completion).
 *
 * Persona: reviewer
 * Tools:
 *   - create_review        — Create a review task for a workstream execution
 *   - get_review           — Retrieve review task by ID
 *   - deliver_remediation  — Submit findings/test results to a review
 *   - approve_review       — Final approval/rejection (gates workstream completion)
 *
 * ASK gate: approve_review triggers human confirmation for USER callers.
 */

import type { Pool } from 'pg';
import type { McpToolDefinition, McpToolHandler } from '../transport.js';
import {
  createReview,
  getReview,
  deliverRemediation,
  approveReview,
  type Finding,
  type TestResult,
} from '../../services/reviews.service.js';
import type { ServiceResult } from '../../services/types.js';

// ── Helper: unwrap ServiceResult or throw ────────────────────────────────────

function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.ok) {
    throw new Error(`[${result.error}] ${result.message}`);
  }
  return result.data;
}

// ── Tool Definitions ────────────────────────────────────────────────────────

export const reviewToolDefinitions: McpToolDefinition[] = [
  {
    name: 'create_review',
    description: 'Create a review task for a workstream execution. Idempotent on review_task_id — returns existing if already created.',
    inputSchema: {
      type: 'object',
      properties: {
        review_task_id: { type: 'string', format: 'uuid', description: 'Unique review task ID (caller-generated for idempotency)' },
        workstream_id: { type: 'string', format: 'uuid', description: 'Workstream being reviewed' },
        orchestration_id: { type: 'string', format: 'uuid', description: 'Parent orchestration' },
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        execution_id: { type: 'string', format: 'uuid', description: 'Execution attempt being reviewed' },
        correlation_id: { type: 'string', format: 'uuid', description: 'Optional correlation ID' },
      },
      required: ['review_task_id', 'workstream_id', 'orchestration_id', 'project_id', 'execution_id'],
    },
  },
  {
    name: 'get_review',
    description: 'Retrieve a review task by ID. Returns full review state including findings, outcome, and timing.',
    inputSchema: {
      type: 'object',
      properties: {
        review_task_id: { type: 'string', format: 'uuid', description: 'Review task UUID' },
      },
      required: ['review_task_id'],
    },
  },
  {
    name: 'deliver_remediation',
    description: 'Submit remediation findings, test results, and checks to a review task. Transitions review to IN_PROGRESS. Cannot modify APPROVED or CANCELLED reviews.',
    inputSchema: {
      type: 'object',
      properties: {
        review_task_id: { type: 'string', format: 'uuid', description: 'Review task UUID' },
        findings: {
          type: 'array',
          items: { type: 'object' },
          description: 'Array of finding objects with severity, description, location, etc.',
        },
        test_results: {
          type: 'array',
          items: { type: 'object' },
          description: 'Optional array of test result objects',
        },
        checks_performed: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of check names/descriptions performed',
        },
        correlation_id: { type: 'string', format: 'uuid', description: 'Optional correlation ID' },
      },
      required: ['review_task_id', 'findings'],
    },
  },
  {
    name: 'approve_review',
    description: 'Issue final review outcome (PASS/FAIL/INCONCLUSIVE). PASS → workstream COMPLETE; FAIL → workstream RETRYING. Cannot modify APPROVED or CANCELLED reviews. ASK gate: human callers will be prompted for confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        review_task_id: { type: 'string', format: 'uuid', description: 'Review task UUID' },
        outcome: { type: 'string', enum: ['PASS', 'FAIL', 'INCONCLUSIVE'], description: 'Review outcome' },
        outcome_reason: { type: 'string', description: 'Explanation for the outcome decision' },
        checks_performed: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of checks performed during review',
        },
        artifact_refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional references to review artifacts (URLs, paths)',
        },
        correlation_id: { type: 'string', format: 'uuid', description: 'Optional correlation ID' },
      },
      required: ['review_task_id', 'outcome', 'outcome_reason'],
    },
  },
];

// ── Tool Handlers ───────────────────────────────────────────────────────────

const handleCreateReview: McpToolHandler = async (params, session, pool) => {
  const { review_task_id, workstream_id, orchestration_id, project_id, execution_id, correlation_id } = params as {
    review_task_id: string;
    workstream_id: string;
    orchestration_id: string;
    project_id: string;
    execution_id: string;
    correlation_id?: string;
  };

  return unwrap(await createReview(pool, session.userId, {
    review_task_id, workstream_id, orchestration_id, project_id, execution_id, correlation_id,
  }));
};

const handleGetReview: McpToolHandler = async (params, _session, pool) => {
  const { review_task_id } = params as { review_task_id: string };
  return unwrap(await getReview(pool, review_task_id));
};

const handleDeliverRemediation: McpToolHandler = async (params, session, pool) => {
  const { review_task_id, findings, test_results, checks_performed, correlation_id } = params as {
    review_task_id: string;
    findings: Finding[];
    test_results?: TestResult[];
    checks_performed?: string[];
    correlation_id?: string;
  };

  return unwrap(await deliverRemediation(pool, session.userId, review_task_id, {
    findings, test_results, checks_performed, correlation_id,
  }));
};

const handleApproveReview: McpToolHandler = async (params, session, pool) => {
  const { review_task_id, outcome, outcome_reason, checks_performed, artifact_refs, correlation_id } = params as {
    review_task_id: string;
    outcome: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    outcome_reason: string;
    checks_performed?: string[];
    artifact_refs?: string[];
    correlation_id?: string;
  };

  return unwrap(await approveReview(pool, session.userId, review_task_id, {
    outcome, outcome_reason, checks_performed, artifact_refs, correlation_id,
  }));
};

// ── Registry ────────────────────────────────────────────────────────────────

export const reviewToolHandlers = new Map<string, McpToolHandler>([
  ['create_review', handleCreateReview],
  ['get_review', handleGetReview],
  ['deliver_remediation', handleDeliverRemediation],
  ['approve_review', handleApproveReview],
]);
