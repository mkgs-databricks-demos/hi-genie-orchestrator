/**
 * MCP Tools — Orchestration & Workstream Lifecycle (Dispatcher Persona)
 *
 * Tools for orchestrating plans into running workstreams, dispatching work
 * to agents, and managing workstream lifecycle (retry, pause, unpause).
 *
 * Persona: dispatcher
 * Tools:
 *   - orchestrate_plan        — Create orchestration from published snapshot
 *   - materialize_workstreams — Expand snapshot workstreams into dispatch table
 *   - list_workstreams        — List workstreams for an orchestration
 *   - dispatch_workstream     — Assign workstream to a worker
 *   - retry_workstream        — Move blocked workstream to RETRYING
 *   - pause_workstream        — Pause an active workstream
 *   - unpause_workstream      — Resume a paused workstream
 */

import type { Pool } from 'pg';
import type { McpToolDefinition, McpToolHandler } from '../transport.js';
import {
  materializeWorkstreams,
  listWorkstreams,
  dispatchWorkstream,
  retryWorkstream,
  pauseWorkstream,
  unpauseWorkstream,
} from '../../services/orchestration.service.js';
import { orchestratePlan } from '../../services/plans.service.js';
import type { ServiceResult } from '../../services/types.js';

// ── Helper: unwrap ServiceResult or throw ────────────────────────────────────

function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.ok) {
    throw new Error(`[${result.error}] ${result.message}`);
  }
  return result.data;
}

// ── Tool Definitions ────────────────────────────────────────────────────────

export const orchestrationToolDefinitions: McpToolDefinition[] = [
  {
    name: 'orchestrate_plan',
    description: 'Create an orchestration from a published plan snapshot. Defaults to current snapshot if plan_snapshot_id is omitted. Returns the new PENDING orchestration record.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', format: 'uuid', description: 'Plan UUID to orchestrate' },
        plan_snapshot_id: { type: 'string', format: 'uuid', description: 'Optional: specific snapshot to orchestrate (defaults to plan\'s current_snapshot_id)' },
        priority: { type: 'number', description: 'Orchestration priority (0-100, default 50)' },
      },
      required: ['plan_id'],
    },
  },
  {
    name: 'materialize_workstreams',
    description: 'Expand a PENDING orchestration\'s snapshot into individual workstream records. Transitions orchestration to RUNNING. Idempotent per workstream_key.',
    inputSchema: {
      type: 'object',
      properties: {
        orchestration_id: { type: 'string', format: 'uuid', description: 'Orchestration UUID (must be in PENDING status)' },
        plan_snapshot_id: { type: 'string', format: 'uuid', description: 'Snapshot UUID to materialize from' },
        priority: { type: 'number', description: 'Default priority for workstreams (0-100, default 50)' },
        correlation_id: { type: 'string', format: 'uuid', description: 'Optional correlation ID for tracing' },
        configuration_version: { type: 'string', description: 'Configuration version tag (default "1.0.0")' },
      },
      required: ['orchestration_id', 'plan_snapshot_id'],
    },
  },
  {
    name: 'list_workstreams',
    description: 'List all workstreams for an orchestration, ordered by execution_tier ASC then priority DESC. Returns full workstream records including status, assigned_to, and timing.',
    inputSchema: {
      type: 'object',
      properties: {
        orchestration_id: { type: 'string', format: 'uuid', description: 'Orchestration UUID' },
      },
      required: ['orchestration_id'],
    },
  },
  {
    name: 'dispatch_workstream',
    description: 'Assign a NOT_STARTED or RETRYING workstream to a worker for execution. Creates an execution record and increments the attempt counter.',
    inputSchema: {
      type: 'object',
      properties: {
        orchestration_id: { type: 'string', format: 'uuid', description: 'Orchestration UUID' },
        workstream_key: { type: 'string', description: 'Workstream key within the orchestration' },
        worker_identity: { type: 'string', description: 'Optional: explicit worker identity (defaults to caller)' },
        correlation_id: { type: 'string', format: 'uuid', description: 'Optional correlation ID' },
      },
      required: ['orchestration_id', 'workstream_key'],
    },
  },
  {
    name: 'retry_workstream',
    description: 'Move a BLOCKED workstream to RETRYING status so it can be re-dispatched. Requires a reason.',
    inputSchema: {
      type: 'object',
      properties: {
        orchestration_id: { type: 'string', format: 'uuid', description: 'Orchestration UUID' },
        workstream_key: { type: 'string', description: 'Workstream key' },
        reason: { type: 'string', description: 'Reason for retry (1-1000 chars)' },
        correlation_id: { type: 'string', format: 'uuid', description: 'Optional correlation ID' },
      },
      required: ['orchestration_id', 'workstream_key', 'reason'],
    },
  },
  {
    name: 'pause_workstream',
    description: 'Pause an active workstream (NOT_STARTED, IN_PROGRESS, or RETRYING → BLOCKED with paused=true).',
    inputSchema: {
      type: 'object',
      properties: {
        orchestration_id: { type: 'string', format: 'uuid', description: 'Orchestration UUID' },
        workstream_key: { type: 'string', description: 'Workstream key' },
        reason: { type: 'string', description: 'Optional pause reason' },
      },
      required: ['orchestration_id', 'workstream_key'],
    },
  },
  {
    name: 'unpause_workstream',
    description: 'Resume a paused (BLOCKED) workstream back to NOT_STARTED so it can be dispatched again.',
    inputSchema: {
      type: 'object',
      properties: {
        orchestration_id: { type: 'string', format: 'uuid', description: 'Orchestration UUID' },
        workstream_key: { type: 'string', description: 'Workstream key' },
      },
      required: ['orchestration_id', 'workstream_key'],
    },
  },
];

// ── Tool Handlers ───────────────────────────────────────────────────────────

const handleOrchestratePlan: McpToolHandler = async (params, session, pool) => {
  const { plan_id, plan_snapshot_id, priority } = params as {
    plan_id: string;
    plan_snapshot_id?: string;
    priority?: number;
  };

  return unwrap(await orchestratePlan(pool, session.userId, plan_id, {
    plan_snapshot_id,
    priority: priority ?? 50,
  }));
};

const handleMaterializeWorkstreams: McpToolHandler = async (params, session, pool) => {
  const { orchestration_id, plan_snapshot_id, priority, correlation_id, configuration_version } = params as {
    orchestration_id: string;
    plan_snapshot_id: string;
    priority?: number;
    correlation_id?: string;
    configuration_version?: string;
  };

  return unwrap(await materializeWorkstreams(pool, session.userId, orchestration_id, {
    plan_snapshot_id,
    priority: priority ?? 50,
    correlation_id,
    configuration_version: configuration_version ?? '1.0.0',
  }));
};

const handleListWorkstreams: McpToolHandler = async (params, _session, pool) => {
  const { orchestration_id } = params as { orchestration_id: string };
  return unwrap(await listWorkstreams(pool, orchestration_id));
};

const handleDispatchWorkstream: McpToolHandler = async (params, session, pool) => {
  const { orchestration_id, workstream_key, worker_identity, correlation_id } = params as {
    orchestration_id: string;
    workstream_key: string;
    worker_identity?: string;
    correlation_id?: string;
  };

  return unwrap(await dispatchWorkstream(pool, session.userId, orchestration_id, workstream_key, {
    worker_identity,
    correlation_id,
  }));
};

const handleRetryWorkstream: McpToolHandler = async (params, session, pool) => {
  const { orchestration_id, workstream_key, reason, correlation_id } = params as {
    orchestration_id: string;
    workstream_key: string;
    reason: string;
    correlation_id?: string;
  };

  return unwrap(await retryWorkstream(pool, session.userId, orchestration_id, workstream_key, {
    reason,
    correlation_id,
  }));
};

const handlePauseWorkstream: McpToolHandler = async (params, session, pool) => {
  const { orchestration_id, workstream_key, reason } = params as {
    orchestration_id: string;
    workstream_key: string;
    reason?: string;
  };

  return unwrap(await pauseWorkstream(pool, session.userId, orchestration_id, workstream_key, { reason }));
};

const handleUnpauseWorkstream: McpToolHandler = async (params, session, pool) => {
  const { orchestration_id, workstream_key } = params as {
    orchestration_id: string;
    workstream_key: string;
  };

  return unwrap(await unpauseWorkstream(pool, session.userId, orchestration_id, workstream_key));
};

// ── Registry ────────────────────────────────────────────────────────────────

export const orchestrationToolHandlers = new Map<string, McpToolHandler>([
  ['orchestrate_plan', handleOrchestratePlan],
  ['materialize_workstreams', handleMaterializeWorkstreams],
  ['list_workstreams', handleListWorkstreams],
  ['dispatch_workstream', handleDispatchWorkstream],
  ['retry_workstream', handleRetryWorkstream],
  ['pause_workstream', handlePauseWorkstream],
  ['unpause_workstream', handleUnpauseWorkstream],
]);
