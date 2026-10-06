/**
 * MCP Tools — Plan Lifecycle (Architect Persona)
 *
 * Tools for creating, retrieving, and publishing immutable plan snapshots.
 * These are the architect's primary interface for plan management.
 *
 * Persona: architect
 * Tools:
 *   - create_plan     — Create a new plan in a project
 *   - get_plan        — Retrieve plan with all snapshots
 *   - publish_plan    — Publish immutable snapshot (content-hash idempotent)
 */

import type { Pool } from 'pg';
import type { McpToolDefinition, McpToolHandler } from '../transport.js';
import {
  createPlan,
  getPlan,
  publishPlan,
} from '../../services/plans.service.js';
import type { ServiceResult } from '../../services/types.js';

// ── Helper: unwrap ServiceResult or throw ────────────────────────────────────

function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.ok) {
    throw new Error(`[${result.error}] ${result.message}`);
  }
  return result.data;
}

// ── Tool Definitions ────────────────────────────────────────────────────────

export const planToolDefinitions: McpToolDefinition[] = [
  {
    name: 'create_plan',
    description: 'Create a new plan within a project. Returns the created plan record. Requires architect persona for service principals.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID to create the plan in' },
        name: { type: 'string', description: 'Human-readable plan name (1-255 chars)' },
        description: { type: 'string', description: 'Optional plan description' },
        source_ref: { type: 'object', description: 'Optional source reference metadata (e.g., git commit, ticket URL)' },
      },
      required: ['project_id', 'name'],
    },
  },
  {
    name: 'get_plan',
    description: 'Retrieve a plan by ID including all published snapshots (newest first). Returns plan metadata and snapshot history.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', format: 'uuid', description: 'Plan UUID to retrieve' },
      },
      required: ['plan_id'],
    },
  },
  {
    name: 'publish_plan',
    description: 'Publish an immutable plan snapshot with content hash deduplication. If identical content was already published, returns the existing snapshot (idempotent). Requires architect persona for service principals. ASK gate: human callers will be prompted for confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', format: 'uuid', description: 'Plan UUID to publish a snapshot for' },
        content: { type: 'object', description: 'Plan content object (workstreams array, configuration, etc.)' },
        workstream_count: { type: 'number', description: 'Number of workstreams in the content (for validation/display)' },
      },
      required: ['plan_id', 'content', 'workstream_count'],
    },
  },
];

// ── Tool Handlers ───────────────────────────────────────────────────────────

const handleCreatePlan: McpToolHandler = async (params, session, pool) => {
  const { project_id, name, description, source_ref } = params as {
    project_id: string;
    name: string;
    description?: string;
    source_ref?: Record<string, unknown>;
  };

  return unwrap(await createPlan(pool, session.userId, { project_id, name, description, source_ref }));
};

const handleGetPlan: McpToolHandler = async (params, _session, pool) => {
  const { plan_id } = params as { plan_id: string };
  return unwrap(await getPlan(pool, plan_id));
};

const handlePublishPlan: McpToolHandler = async (params, session, pool) => {
  const { plan_id, content, workstream_count } = params as {
    plan_id: string;
    content: Record<string, unknown>;
    workstream_count: number;
  };

  return unwrap(await publishPlan(pool, session.userId, plan_id, { content, workstream_count }));
};

// ── Registry ────────────────────────────────────────────────────────────────

export const planToolHandlers = new Map<string, McpToolHandler>([
  ['create_plan', handleCreatePlan],
  ['get_plan', handleGetPlan],
  ['publish_plan', handlePublishPlan],
]);
