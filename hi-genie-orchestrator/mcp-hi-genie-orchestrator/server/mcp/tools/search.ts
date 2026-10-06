/**
 * Search and Operational Tools
 *
 * Structured search, task history, execution summaries, health checks,
 * and schema version reporting. All results are bounded, authorization-
 * filtered, and paginated where applicable.
 *
 * Tools:
 *   - search_context
 *   - get_task_history
 *   - get_execution_summary
 *   - get_health
 *   - get_schema_version
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, uuid, text, timestamp, integer, jsonb } from 'drizzle-orm/pg-core';
import { eq, and, desc, ilike, or, sql, gte } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { McpToolDefinition, McpToolHandler, McpSession } from '../transport.js';

// ── Drizzle Schema Definitions ─────────────────────────────────────────────
// Aligned with migration 001 (dispatch) + migration 002 (state)

const stateSchema = pgSchema('state');
const dispatchSchema = pgSchema('dispatch');

const decisions = stateSchema.table('decisions', {
  decision_id: uuid('decision_id').primaryKey(),
  project_id: uuid('project_id').notNull(),
  workstream_id: uuid('workstream_id'),
  session_id: uuid('session_id'),
  title: text('title').notNull(),
  context: text('context').notNull(),
  decision: text('decision').notNull(),
  rationale: text('rationale'),
  alternatives_considered: jsonb('alternatives_considered'),
  implications: jsonb('implications'),
  tags: jsonb('tags'),
  idempotency_key: text('idempotency_key').notNull(),
  correlation_id: uuid('correlation_id').notNull(),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

const errors = stateSchema.table('errors', {
  error_id: uuid('error_id').primaryKey(),
  project_id: uuid('project_id').notNull(),
  workstream_id: uuid('workstream_id'),
  session_id: uuid('session_id'),
  error_class: text('error_class').notNull(),
  error_code: text('error_code'),
  message: text('message').notNull(),
  stack_trace: text('stack_trace'),
  context: jsonb('context'),
  resolution: text('resolution'),
  is_blocking: text('is_blocking').notNull(),
  idempotency_key: text('idempotency_key').notNull(),
  correlation_id: uuid('correlation_id').notNull(),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

const events = stateSchema.table('events', {
  event_id: uuid('event_id').primaryKey(),
  project_id: uuid('project_id').notNull(),
  workstream_id: uuid('workstream_id'),
  session_id: uuid('session_id'),
  event_type: text('event_type').notNull(),
  payload: jsonb('payload'),
  correlation_id: uuid('correlation_id').notNull(),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

const taskAttempts = stateSchema.table('task_attempts', {
  task_attempt_id: uuid('task_attempt_id').primaryKey(),
  project_id: uuid('project_id').notNull(),
  workstream_id: uuid('workstream_id').notNull(),
  task_key: text('task_key').notNull(),
  attempt_number: integer('attempt_number').notNull(),
  status: text('status').notNull(),
  output_ref: jsonb('output_ref'),
  error_message: text('error_message'),
  duration_ms: integer('duration_ms'),
  idempotency_key: text('idempotency_key').notNull(),
  correlation_id: uuid('correlation_id').notNull(),
  created_by: text('created_by').notNull(),
  started_at: timestamp('started_at', { withTimezone: true }).notNull(),
  ended_at: timestamp('ended_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

const taskCompletions = stateSchema.table('task_completions', {
  task_completion_id: uuid('task_completion_id').primaryKey(),
  project_id: uuid('project_id').notNull(),
  workstream_id: uuid('workstream_id').notNull(),
  task_key: text('task_key').notNull(),
  final_status: text('final_status').notNull(),
  summary: text('summary').notNull(),
  artifacts_ref: jsonb('artifacts_ref'),
  total_attempts: integer('total_attempts').notNull(),
  idempotency_key: text('idempotency_key').notNull(),
  correlation_id: uuid('correlation_id').notNull(),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

const workstreams = dispatchSchema.table('workstreams', {
  workstream_id: uuid('workstream_id').primaryKey(),
  project_id: uuid('project_id').notNull(),
  orchestration_id: uuid('orchestration_id').notNull(),
  workstream_key: text('workstream_key').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
});

const executions = dispatchSchema.table('executions', {
  execution_id: uuid('execution_id').primaryKey(),
  workstream_id: uuid('workstream_id').notNull(),
  project_id: uuid('project_id').notNull(),
  attempt_number: integer('attempt_number').notNull(),
  status: text('status').notNull(),
  worker_identity: text('worker_identity').notNull(),
  correlation_id: uuid('correlation_id').notNull(),
  started_at: timestamp('started_at', { withTimezone: true }).notNull(),
  ended_at: timestamp('ended_at', { withTimezone: true }),
  outcome_summary: text('outcome_summary'),
  error_class: text('error_class'),
  error_summary: text('error_summary'),
  artifacts_ref: jsonb('artifacts_ref'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(limit?: number): number {
  const l = limit ?? DEFAULT_LIMIT;
  return Math.min(Math.max(1, l), MAX_LIMIT);
}

// ── Tool Definitions ────────────────────────────────────────────────────────

export const searchToolDefinitions: McpToolDefinition[] = [
  {
    name: 'search_context',
    description: 'Structured search across decisions, errors, and events within a project. Supports keyword matching, type filtering, date ranges, and pagination. Results are bounded and RLS-filtered.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        query: { type: 'string', description: 'Search keyword (matched against titles, messages, event types)' },
        record_types: {
          type: 'array',
          items: { type: 'string', enum: ['decisions', 'errors', 'events'] },
          description: 'Record types to search (default: all)',
        },
        workstream_id: { type: 'string', format: 'uuid', description: 'Optional workstream filter' },
        since: { type: 'string', format: 'date-time', description: 'Only return records after this timestamp (ISO 8601)' },
        limit: { type: 'number', description: 'Max results per type (1-100, default 20)' },
      },
      required: ['project_id', 'query'],
    },
  },
  {
    name: 'get_task_history',
    description: 'Retrieve the full attempt and completion history for a task within a workstream. Ordered chronologically, bounded.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        workstream_id: { type: 'string', format: 'uuid', description: 'Workstream UUID' },
        task_key: { type: 'string', description: 'Task identifier' },
        limit: { type: 'number', description: 'Max results (1-100, default 20)' },
      },
      required: ['project_id', 'workstream_id', 'task_key'],
    },
  },
  {
    name: 'get_execution_summary',
    description: 'Retrieve execution statistics and metrics for a project or workstream. Includes counts by status, average durations, and recent execution details.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        workstream_id: { type: 'string', format: 'uuid', description: 'Optional workstream filter' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'get_health',
    description: 'Service health check. Returns connectivity status, active session count, and basic operational metrics. No project scope required.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_schema_version',
    description: 'Return the current database schema version from migration history. Useful for compatibility checks between client SDK and server.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ── Tool Handlers ───────────────────────────────────────────────────────────

const searchContext: McpToolHandler = async (params, session, pool) => {
  const {
    project_id, query, record_types, workstream_id, since, limit,
  } = params as {
    project_id: string;
    query: string;
    record_types?: string[];
    workstream_id?: string;
    since?: string;
    limit?: number;
  };

  const db = drizzle(pool);
  const boundedLimit = clampLimit(limit);
  const types = record_types ?? ['decisions', 'errors', 'events'];
  const results: Record<string, unknown[]> = {};

  if (types.includes('decisions')) {
    const conditions = [
      eq(decisions.project_id, project_id),
      or(
        ilike(decisions.title, `%${query}%`),
        ilike(decisions.context, `%${query}%`),
        ilike(decisions.decision, `%${query}%`),
      )!,
    ];
    if (workstream_id) conditions.push(eq(decisions.workstream_id, workstream_id));
    if (since) conditions.push(gte(decisions.created_at, new Date(since)));

    results.decisions = await db
      .select()
      .from(decisions)
      .where(and(...conditions))
      .orderBy(desc(decisions.created_at))
      .limit(boundedLimit);
  }

  if (types.includes('errors')) {
    const conditions = [
      eq(errors.project_id, project_id),
      ilike(errors.message, `%${query}%`),
    ];
    if (workstream_id) conditions.push(eq(errors.workstream_id, workstream_id));
    if (since) conditions.push(gte(errors.created_at, new Date(since)));

    results.errors = await db
      .select()
      .from(errors)
      .where(and(...conditions))
      .orderBy(desc(errors.created_at))
      .limit(boundedLimit);
  }

  if (types.includes('events')) {
    const conditions = [
      eq(events.project_id, project_id),
      or(
        ilike(events.event_type, `%${query}%`),
        sql`${events.payload}::text ILIKE ${'%' + query + '%'}`,
      )!,
    ];
    if (workstream_id) conditions.push(eq(events.workstream_id, workstream_id));
    if (since) conditions.push(gte(events.created_at, new Date(since)));

    results.events = await db
      .select()
      .from(events)
      .where(and(...conditions))
      .orderBy(desc(events.created_at))
      .limit(boundedLimit);
  }

  return {
    query,
    results,
    limit: boundedLimit,
  };
};

const getTaskHistory: McpToolHandler = async (params, session, pool) => {
  const { project_id, workstream_id, task_key, limit } = params as {
    project_id: string;
    workstream_id: string;
    task_key: string;
    limit?: number;
  };

  const db = drizzle(pool);

  // Get attempts
  const attempts = await db
    .select()
    .from(taskAttempts)
    .where(and(
      eq(taskAttempts.project_id, project_id),
      eq(taskAttempts.workstream_id, workstream_id),
      eq(taskAttempts.task_key, task_key),
    ))
    .orderBy(desc(taskAttempts.attempt_number))
    .limit(clampLimit(limit));

  // Get completions
  const completions = await db
    .select()
    .from(taskCompletions)
    .where(and(
      eq(taskCompletions.project_id, project_id),
      eq(taskCompletions.workstream_id, workstream_id),
      eq(taskCompletions.task_key, task_key),
    ))
    .orderBy(desc(taskCompletions.created_at))
    .limit(5);

  return {
    task_key,
    workstream_id,
    attempts,
    completions,
    total_attempts: attempts.length,
  };
};

const getExecutionSummary: McpToolHandler = async (params, session, pool) => {
  const { project_id, workstream_id } = params as {
    project_id: string;
    workstream_id?: string;
  };

  const db = drizzle(pool);

  // Execution status counts
  const execConditions = [eq(executions.project_id, project_id)];
  if (workstream_id) execConditions.push(eq(executions.workstream_id, workstream_id));

  const statusCounts = await db
    .select({
      status: executions.status,
      count: sql<number>`count(*)::int`,
    })
    .from(executions)
    .where(and(...execConditions))
    .groupBy(executions.status);

  // Workstream status distribution
  const wsConditions = [eq(workstreams.project_id, project_id)];
  const workstreamCounts = await db
    .select({
      status: workstreams.status,
      count: sql<number>`count(*)::int`,
    })
    .from(workstreams)
    .where(and(...wsConditions))
    .groupBy(workstreams.status);

  // Recent executions
  const recentExecs = await db
    .select()
    .from(executions)
    .where(and(...execConditions))
    .orderBy(desc(executions.created_at))
    .limit(10);

  return {
    project_id,
    workstream_id: workstream_id ?? null,
    execution_status_counts: statusCounts,
    workstream_status_counts: workstreamCounts,
    recent_executions: recentExecs,
  };
};

const getHealth: McpToolHandler = async (_params, _session, pool) => {
  const startTime = Date.now();

  // Check database connectivity
  let dbHealthy = false;
  let dbLatencyMs = 0;
  try {
    const client = await pool.connect();
    try {
      const t0 = Date.now();
      await client.query('SELECT 1');
      dbLatencyMs = Date.now() - t0;
      dbHealthy = true;
    } finally {
      client.release();
    }
  } catch {
    dbHealthy = false;
  }

  return {
    status: dbHealthy ? 'healthy' : 'degraded',
    service: 'hi-genie-orchestrator',
    version: '1.0.0',
    checks: {
      database: {
        status: dbHealthy ? 'ok' : 'error',
        latency_ms: dbLatencyMs,
      },
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    },
    timestamp: new Date().toISOString(),
    response_time_ms: Date.now() - startTime,
  };
};

const getSchemaVersion: McpToolHandler = async (_params, _session, pool) => {
  const client = await pool.connect();
  try {
    // Read from the migration history table created by ws-b
    const result = await client.query(
      `SELECT version, name, applied_at
       FROM state._migration_history
       ORDER BY version DESC
       LIMIT 1`,
    );

    if (result.rows.length === 0) {
      return {
        schema_version: 0,
        migration_name: null,
        applied_at: null,
        message: 'No migrations applied',
      };
    }

    const latest = result.rows[0];
    return {
      schema_version: latest.version,
      migration_name: latest.name,
      applied_at: latest.applied_at,
    };
  } catch (err) {
    // If migration history table doesn't exist yet
    return {
      schema_version: -1,
      error: 'Migration history table not found',
      message: 'Migrations may not have been applied yet',
    };
  } finally {
    client.release();
  }
};

// ── Registry ────────────────────────────────────────────────────────────────

export const searchToolHandlers = new Map<string, McpToolHandler>([
  ['search_context', searchContext],
  ['get_task_history', getTaskHistory],
  ['get_execution_summary', getExecutionSummary],
  ['get_health', getHealth],
  ['get_schema_version', getSchemaVersion],
]);
