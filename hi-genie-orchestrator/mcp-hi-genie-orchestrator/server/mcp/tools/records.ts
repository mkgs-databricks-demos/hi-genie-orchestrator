/**
 * Append-First Record Tools
 *
 * Immutable record creation tools. All records use idempotency keys via
 * (project_id, idempotency_key) unique constraint for retry-safe writes.
 * Records are never overwritten after creation.
 *
 * Tools:
 *   - record_decision
 *   - record_session_summary
 *   - record_error
 *   - record_workstream_event
 *   - record_task_attempt
 *   - record_task_completion
 */

import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, uuid, text, timestamp, integer, jsonb } from 'drizzle-orm/pg-core';
import { eq, and, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { McpToolDefinition, McpToolHandler, McpSession } from '../transport.js';
import { withIdentity, idempotentInsertWithIdentity } from './identity.js';

// ── Drizzle Schema Definitions (state schema) ─────────────────────────────
// Aligned with migration 002 DDL

const stateSchema = pgSchema('state');

const decisions = stateSchema.table('decisions', {
  decision_id: uuid('decision_id').primaryKey(),
  project_id: uuid('project_id').notNull(),
  workstream_id: uuid('workstream_id').notNull(),
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

const workstreamEvents = stateSchema.table('workstream_events', {
  workstream_event_id: uuid('workstream_event_id').primaryKey(),
  project_id: uuid('project_id').notNull(),
  workstream_id: uuid('workstream_id').notNull(),
  session_id: uuid('session_id'),
  event_type: text('event_type').notNull(),
  previous_value: text('previous_value'),
  new_value: text('new_value'),
  metadata: jsonb('metadata'),
  correlation_id: uuid('correlation_id').notNull(),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

const taskAttempts = stateSchema.table('task_attempts', {
  task_attempt_id: uuid('task_attempt_id').primaryKey(),
  project_id: uuid('project_id').notNull(),
  workstream_id: uuid('workstream_id').notNull(),
  session_id: uuid('session_id'),
  task_key: text('task_key').notNull(),
  attempt_number: integer('attempt_number').notNull(),
  status: text('status').notNull(),
  input_ref: jsonb('input_ref'),
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
  session_id: uuid('session_id'),
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

const sessions = stateSchema.table('sessions', {
  session_id: uuid('session_id').primaryKey(),
  project_id: uuid('project_id').notNull(),
  workstream_id: uuid('workstream_id'),
  user_id: text('user_id').notNull(),
  status: text('status').notNull(),
  metadata: jsonb('metadata'),
  correlation_id: uuid('correlation_id').notNull(),
  version: integer('version').notNull().default(1),
  started_at: timestamp('started_at', { withTimezone: true }).notNull(),
  ended_at: timestamp('ended_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
});

// ── Idempotent Insert Helper ────────────────────────────────────────────────

// Legacy idempotentInsert removed — replaced by idempotentInsertWithIdentity (./identity.ts)
// which wraps the operation in a transaction with set_config('app.user_identity') for RLS.

// ── Tool Definitions ────────────────────────────────────────────────────────

export const recordToolDefinitions: McpToolDefinition[] = [
  {
    name: 'record_decision',
    description: 'Record an architecture or requirements decision. Immutable after creation. Uses idempotency key for retry-safe writes.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        workstream_id: { type: 'string', format: 'uuid', description: 'Workstream UUID this decision belongs to' },
        session_id: { type: 'string', format: 'uuid', description: 'Optional session reference' },
        idempotency_key: { type: 'string', description: 'Unique key for retry-safe write' },
        title: { type: 'string', description: 'Decision title' },
        context: { type: 'string', description: 'Context and background for the decision' },
        decision: { type: 'string', description: 'The decision itself (what was decided)' },
        rationale: { type: 'string', description: 'Reasoning behind the decision' },
        alternatives_considered: { type: 'array', items: { type: 'object' }, description: 'Alternatives that were evaluated' },
        implications: { type: 'array', items: { type: 'object' }, description: 'Downstream implications of this decision' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Categorization tags' },
      },
      required: ['project_id', 'workstream_id', 'idempotency_key', 'title', 'context', 'decision'],
    },
  },
  {
    name: 'record_session_summary',
    description: 'Record or update the summary for an existing session. Appends a session-summary event and updates the session record.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        session_id: { type: 'string', format: 'uuid', description: 'Session to summarize' },
        idempotency_key: { type: 'string', description: 'Unique key for retry-safe write' },
        summary: { type: 'string', description: 'Session summary text' },
        metadata: { type: 'object', description: 'Optional structured metadata' },
      },
      required: ['project_id', 'session_id', 'idempotency_key', 'summary'],
    },
  },
  {
    name: 'record_error',
    description: 'Record an error, blocker, or exception. Immutable after creation. Includes error class, blocking status, optional stack trace and context.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        workstream_id: { type: 'string', format: 'uuid', description: 'Optional workstream scope' },
        session_id: { type: 'string', format: 'uuid', description: 'Optional session reference' },
        idempotency_key: { type: 'string', description: 'Unique key for retry-safe write' },
        error_class: { type: 'string', description: 'Error classification (e.g., runtime, validation, dependency)' },
        error_code: { type: 'string', description: 'Optional machine-readable error code' },
        message: { type: 'string', description: 'Error message' },
        stack_trace: { type: 'string', description: 'Optional stack trace' },
        context: { type: 'object', description: 'Optional error context' },
        is_blocking: { type: 'boolean', description: 'Whether this error blocks workstream progress' },
      },
      required: ['project_id', 'idempotency_key', 'error_class', 'message', 'is_blocking'],
    },
  },
  {
    name: 'record_workstream_event',
    description: 'Record a workstream lifecycle event (status change, milestone, dependency resolution, etc.). Append-only, no idempotency constraint.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        workstream_id: { type: 'string', format: 'uuid', description: 'Workstream UUID' },
        session_id: { type: 'string', format: 'uuid', description: 'Optional session reference' },
        event_type: { type: 'string', description: 'Event type (e.g., status_changed, milestone_reached, dependency_resolved)' },
        previous_value: { type: 'string', description: 'Previous state/value (for transitions)' },
        new_value: { type: 'string', description: 'New state/value (for transitions)' },
        metadata: { type: 'object', description: 'Optional structured event metadata' },
      },
      required: ['project_id', 'workstream_id', 'event_type'],
    },
  },
  {
    name: 'record_task_attempt',
    description: 'Record a task execution attempt. Includes attempt number, status, timing, and optional error details. Immutable after creation.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        workstream_id: { type: 'string', format: 'uuid', description: 'Workstream UUID' },
        session_id: { type: 'string', format: 'uuid', description: 'Optional session reference' },
        idempotency_key: { type: 'string', description: 'Unique key for retry-safe write' },
        task_key: { type: 'string', description: 'Task identifier within the workstream' },
        attempt_number: { type: 'number', description: 'Attempt number (1-based)' },
        status: { type: 'string', enum: ['STARTED', 'SUCCEEDED', 'FAILED', 'RETRYABLE_FAILURE'], description: 'Attempt status' },
        started_at: { type: 'string', format: 'date-time', description: 'Attempt start time (ISO 8601)' },
        ended_at: { type: 'string', format: 'date-time', description: 'Optional end time' },
        error_message: { type: 'string', description: 'Error message if failed' },
        output_ref: { type: 'object', description: 'Optional structured output reference (URIs, keys)' },
        duration_ms: { type: 'number', description: 'Attempt duration in milliseconds' },
      },
      required: ['project_id', 'workstream_id', 'idempotency_key', 'task_key', 'attempt_number', 'status', 'started_at'],
    },
  },
  {
    name: 'record_task_completion',
    description: 'Record final task completion with outcome, summary, and artifacts. Represents the authoritative completion state. Immutable after creation.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        workstream_id: { type: 'string', format: 'uuid', description: 'Workstream UUID' },
        session_id: { type: 'string', format: 'uuid', description: 'Optional session reference' },
        idempotency_key: { type: 'string', description: 'Unique key for retry-safe write' },
        task_key: { type: 'string', description: 'Task identifier within the workstream' },
        final_status: { type: 'string', enum: ['SUCCEEDED', 'FAILED', 'SKIPPED'], description: 'Task completion outcome' },
        summary: { type: 'string', description: 'Completion summary' },
        artifacts_ref: { type: 'object', description: 'Optional artifact references (file paths, URIs, etc.)' },
        total_attempts: { type: 'number', description: 'Total number of attempts made' },
      },
      required: ['project_id', 'workstream_id', 'idempotency_key', 'task_key', 'final_status', 'summary'],
    },
  },
];

// ── Enum Validation (defense in depth — mirrors inputSchema enum arrays) ────

const VALID_TASK_ATTEMPT_STATUSES = ['STARTED', 'SUCCEEDED', 'FAILED', 'RETRYABLE_FAILURE'] as const;
const VALID_TASK_COMPLETION_STATUSES = ['SUCCEEDED', 'FAILED', 'SKIPPED'] as const;

function validateEnum(value: string, validValues: readonly string[], fieldName: string, toolName: string): void {
  if (!validValues.includes(value)) {
    throw new Error(
      `Invalid ${fieldName} "${value}" for ${toolName}: must be one of ${validValues.join(', ')}`,
    );
  }
}

// ── Tool Handlers ───────────────────────────────────────────────────────────

const recordDecision: McpToolHandler = async (params, session, pool) => {
  const {
    project_id, workstream_id, session_id, idempotency_key,
    title, context, decision, rationale, alternatives_considered, implications, tags,
  } = params as {
    project_id: string;
    workstream_id: string;
    session_id?: string;
    idempotency_key: string;
    title: string;
    context: string;
    decision: string;
    rationale?: string;
    alternatives_considered?: unknown[];
    implications?: unknown[];
    tags?: string[];
  };

  const id = randomUUID();
  const correlationId = randomUUID();
  const now = new Date().toISOString();

  const result = await idempotentInsertWithIdentity(
    pool, session.userId, 'state', 'decisions', 'decision_id',
    ['decision_id', 'project_id', 'workstream_id', 'session_id', 'title', 'context', 'decision', 'rationale', 'alternatives_considered', 'implications', 'tags', 'idempotency_key', 'correlation_id', 'created_by', 'created_at'],
    [id, project_id, workstream_id, session_id ?? null, title, context, decision, rationale ?? null, JSON.stringify(alternatives_considered ?? []), JSON.stringify(implications ?? []), JSON.stringify(tags ?? []), idempotency_key, correlationId, session.userId, now],
    project_id,
    idempotency_key,
  );

  return { ...result, idempotency_key };
};

const recordSessionSummary: McpToolHandler = async (params, session, pool) => {
  const { project_id, session_id, summary, metadata } = params as {
    project_id: string;
    session_id: string;
    summary: string;
    metadata?: Record<string, unknown>;
  };

  // state.sessions has no summary column. Record as an event instead.
  // Wrapped in withIdentity to set app.user_identity for RLS on state.events.
  return withIdentity(pool, session.userId, async (client) => {
    const eventId = randomUUID();
    const correlationId = randomUUID();
    const now = new Date().toISOString();

    await client.query(
      `INSERT INTO state.events (event_id, project_id, session_id, event_type, payload, correlation_id, created_by, created_at)
       VALUES ($1, $2, $3, 'session_summary', $4, $5, $6, $7)`,
      [eventId, project_id, session_id, JSON.stringify({ summary, metadata }), correlationId, session.userId, now],
    );

    // Store summary in session metadata via version-bumped update
    const updateResult = await client.query(
      `UPDATE state.sessions
       SET metadata = jsonb_set(COALESCE(metadata, '{}'), '{summary}', to_jsonb($1::text)), updated_at = $2, version = version + 1
       WHERE session_id = $3 AND project_id = $4`,
      [summary, now, session_id, project_id],
    );

    return {
      recorded: true,
      session_id,
      session_updated: (updateResult.rowCount ?? 0) > 0,
    };
  });
};

const recordError: McpToolHandler = async (params, session, pool) => {
  const {
    project_id, workstream_id, session_id, idempotency_key,
    error_class, error_code, message, stack_trace, context, is_blocking,
  } = params as {
    project_id: string;
    workstream_id?: string;
    session_id?: string;
    idempotency_key: string;
    error_class: string;
    error_code?: string;
    message: string;
    stack_trace?: string;
    context?: Record<string, unknown>;
    is_blocking?: boolean;
  };

  const id = randomUUID();
  const correlationId = randomUUID();
  const now = new Date().toISOString();

  const result = await idempotentInsertWithIdentity(
    pool, session.userId, 'state', 'errors', 'error_id',
    ['error_id', 'project_id', 'workstream_id', 'session_id', 'error_class', 'error_code', 'message', 'stack_trace', 'context', 'is_blocking', 'idempotency_key', 'correlation_id', 'created_by', 'created_at'],
    [id, project_id, workstream_id ?? null, session_id ?? null, error_class, error_code ?? null, message, stack_trace ?? null, context ? JSON.stringify(context) : '{}', is_blocking ? 'true' : 'false', idempotency_key, correlationId, session.userId, now],
    project_id,
    idempotency_key,
  );

  return { ...result, idempotency_key };
};

const recordWorkstreamEvent: McpToolHandler = async (params, session, pool) => {
  const {
    project_id, workstream_id, session_id,
    event_type, previous_value, new_value, metadata,
  } = params as {
    project_id: string;
    workstream_id: string;
    session_id?: string;
    event_type: string;
    previous_value?: string;
    new_value?: string;
    metadata?: Record<string, unknown>;
  };

  // state.workstream_events has NO idempotency_key or unique constraint—simple append-only insert.
  // Wrapped in withIdentity to set app.user_identity for RLS on state.workstream_events.
  const id = randomUUID();
  const correlationId = randomUUID();
  const now = new Date().toISOString();

  return withIdentity(pool, session.userId, async (client) => {
    await client.query(
      `INSERT INTO state.workstream_events
         (workstream_event_id, project_id, workstream_id, session_id, event_type, previous_value, new_value, metadata, correlation_id, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, project_id, workstream_id, session_id ?? null, event_type, previous_value ?? null, new_value ?? null, metadata ? JSON.stringify(metadata) : '{}', correlationId, session.userId, now],
    );
    return { created: true, id, event_type };
  });
};

const recordTaskAttempt: McpToolHandler = async (params, session, pool) => {
  const {
    project_id, workstream_id, session_id, idempotency_key,
    task_key, attempt_number, status, started_at, ended_at,
    error_message, output_ref, duration_ms,
  } = params as {
    project_id: string;
    workstream_id: string;
    session_id?: string;
    idempotency_key: string;
    task_key: string;
    attempt_number: number;
    status: string;
    started_at: string;
    ended_at?: string;
    error_message?: string;
    output_ref?: Record<string, unknown>;
    duration_ms?: number;
  };

  // Defense in depth: validate enum before INSERT (prevents raw Postgres CHECK constraint errors)
  validateEnum(status, VALID_TASK_ATTEMPT_STATUSES, 'status', 'record_task_attempt');

  const id = randomUUID();
  const correlationId = randomUUID();
  const now = new Date().toISOString();

  const result = await idempotentInsertWithIdentity(
    pool, session.userId, 'state', 'task_attempts', 'task_attempt_id',
    ['task_attempt_id', 'project_id', 'workstream_id', 'session_id', 'task_key', 'attempt_number', 'status', 'input_ref', 'output_ref', 'error_message', 'duration_ms', 'idempotency_key', 'correlation_id', 'created_by', 'started_at', 'ended_at', 'created_at'],
    [id, project_id, workstream_id, session_id ?? null, task_key, attempt_number, status, '{}', output_ref ? JSON.stringify(output_ref) : '{}', error_message ?? null, duration_ms ?? null, idempotency_key, correlationId, session.userId, started_at, ended_at ?? null, now],
    project_id,
    idempotency_key,
  );

  return { ...result, idempotency_key };
};

const recordTaskCompletion: McpToolHandler = async (params, session, pool) => {
  const {
    project_id, workstream_id, session_id, idempotency_key,
    task_key, final_status, summary, artifacts_ref, total_attempts,
  } = params as {
    project_id: string;
    workstream_id: string;
    session_id?: string;
    idempotency_key: string;
    task_key: string;
    final_status: string;
    summary: string;
    artifacts_ref?: unknown[];
    total_attempts?: number;
  };

  // Defense in depth: validate enum before INSERT (prevents raw Postgres CHECK constraint errors)
  validateEnum(final_status, VALID_TASK_COMPLETION_STATUSES, 'final_status', 'record_task_completion');

  const id = randomUUID();
  const correlationId = randomUUID();
  const now = new Date().toISOString();

  const result = await idempotentInsertWithIdentity(
    pool, session.userId, 'state', 'task_completions', 'task_completion_id',
    ['task_completion_id', 'project_id', 'workstream_id', 'session_id', 'task_key', 'final_status', 'summary', 'artifacts_ref', 'total_attempts', 'idempotency_key', 'correlation_id', 'created_by', 'created_at'],
    [id, project_id, workstream_id, session_id ?? null, task_key, final_status, summary, JSON.stringify(artifacts_ref ?? []), total_attempts ?? 1, idempotency_key, correlationId, session.userId, now],
    project_id,
    idempotency_key,
  );

  return { ...result, idempotency_key };
};

// ── Registry ────────────────────────────────────────────────────────────────

export const recordToolHandlers = new Map<string, McpToolHandler>([
  ['record_decision', recordDecision],
  ['record_session_summary', recordSessionSummary],
  ['record_error', recordError],
  ['record_workstream_event', recordWorkstreamEvent],
  ['record_task_attempt', recordTaskAttempt],
  ['record_task_completion', recordTaskCompletion],
]);
