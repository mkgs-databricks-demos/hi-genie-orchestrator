/**
 * Context Retrieval Tools
 *
 * Read-only tools for retrieving project, workstream, session, and decision
 * context. All queries are bounded, RLS-enforced via project_id scope, and
 * use Drizzle ORM.
 *
 * Tools:
 *   - list_projects
 *   - get_project_context
 *   - get_workstream_context
 *   - search_decisions
 *   - get_recent_session_summaries
 *   - get_relevant_errors
 *   - get_session_context
 */

import { z } from 'zod';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, uuid, text, timestamp, integer, jsonb } from 'drizzle-orm/pg-core';
import { eq, and, desc, ilike, or, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { McpToolDefinition, McpToolHandler, McpSession } from '../transport.js';

// ── Drizzle Schema Definitions ─────────────────────────────────────────────
// Aligned with real DDL: migration 001 (dispatch schema) + migration 002 (state schema)

const stateSchema = pgSchema('state');
const dispatchSchema = pgSchema('dispatch');

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

const workstreams = dispatchSchema.table('workstreams', {
  workstream_id: uuid('workstream_id').primaryKey(),
  orchestration_id: uuid('orchestration_id').notNull(),
  project_id: uuid('project_id').notNull(),
  workstream_key: text('workstream_key').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  execution_tier: integer('execution_tier').notNull(),
  depends_on: jsonb('depends_on'),
  config: jsonb('config'),
  attempt_count: integer('attempt_count').notNull(),
  max_retries: integer('max_retries').notNull(),
  assigned_to: text('assigned_to'),
  priority: integer('priority').notNull(),
  idempotency_key: text('idempotency_key').notNull(),
  correlation_id: uuid('correlation_id').notNull(),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  started_at: timestamp('started_at', { withTimezone: true }),
  completed_at: timestamp('completed_at', { withTimezone: true }),
});

const orchestrations = dispatchSchema.table('orchestrations', {
  orchestration_id: uuid('orchestration_id').primaryKey(),
  project_id: uuid('project_id').notNull(),
  plan_id: uuid('plan_id').notNull(),
  plan_snapshot_id: uuid('plan_snapshot_id').notNull(),
  status: text('status').notNull(),
  priority: integer('priority').notNull(),
  correlation_id: uuid('correlation_id').notNull(),
  configuration_version: text('configuration_version').notNull(),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  started_at: timestamp('started_at', { withTimezone: true }),
  completed_at: timestamp('completed_at', { withTimezone: true }),
});

const plans = dispatchSchema.table('plans', {
  plan_id: uuid('plan_id').primaryKey(),
  project_id: uuid('project_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  source_ref: jsonb('source_ref'),
  current_snapshot_id: uuid('current_snapshot_id'),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
});

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(limit?: number): number {
  const l = limit ?? DEFAULT_LIMIT;
  return Math.min(Math.max(1, l), MAX_LIMIT);
}

// ── Tool Definitions ────────────────────────────────────────────────────────

export const contextToolDefinitions: McpToolDefinition[] = [
  {
    name: 'list_projects',
    description: 'Discover available projects by listing distinct project IDs from the system. Returns project UUIDs with associated plan names and workstream counts. Use this to find valid project_id values for other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (1-50, default 10)' },
      },
      required: [],
    },
  },
  {
    name: 'get_project_context',
    description: 'Retrieve project-level context including active orchestrations, workstream counts, and summary statistics. Returns bounded metadata for the authorized project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'get_workstream_context',
    description: 'Retrieve workstream details including status, dependencies, execution tier, recent events, and session history for a specific workstream.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        workstream_id: { type: 'string', format: 'uuid', description: 'Workstream UUID' },
      },
      required: ['project_id', 'workstream_id'],
    },
  },
  {
    name: 'search_decisions',
    description: 'Search architecture and requirements decisions by keyword. Returns bounded, paginated results scoped to the authorized project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        query: { type: 'string', description: 'Search keyword for title, context, or decision text' },
        workstream_id: { type: 'string', format: 'uuid', description: 'Optional workstream filter' },
        limit: { type: 'number', description: 'Max results (1-100, default 20)' },
        offset: { type: 'number', description: 'Pagination offset (default 0)' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'get_recent_session_summaries',
    description: 'Retrieve recent session summaries for a project or workstream. Ordered by most recent, bounded, and authorization-filtered.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        workstream_id: { type: 'string', format: 'uuid', description: 'Optional workstream filter' },
        limit: { type: 'number', description: 'Max results (1-100, default 20)' },
        offset: { type: 'number', description: 'Pagination offset (default 0)' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'get_relevant_errors',
    description: 'Retrieve recent errors and blockers for a project or workstream. Includes error type, severity, resolution status, and context. Bounded and scoped.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        workstream_id: { type: 'string', format: 'uuid', description: 'Optional workstream filter' },
        severity: { type: 'string', description: 'Filter by severity (critical, error, warning)' },
        unresolved_only: { type: 'boolean', description: 'Only return unresolved errors (default true)' },
        limit: { type: 'number', description: 'Max results (1-100, default 20)' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'get_session_context',
    description: 'Retrieve full context for a specific session including decisions made, errors encountered, events recorded, and current status.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        session_id: { type: 'string', format: 'uuid', description: 'Session UUID' },
      },
      required: ['project_id', 'session_id'],
    },
  },
];

// ── Tool Handlers ───────────────────────────────────────────────────────────

const listProjects: McpToolHandler = async (params, session, pool) => {
  const limit = Math.min(Math.max(1, (params as any).limit ?? 10), 50);
  const db = drizzle(pool);

  // Discover projects from plans table (has name field)
  const projectsFromPlans = await db
    .select({
      project_id: plans.project_id,
      plan_name: plans.name,
      plan_id: plans.plan_id,
      created_at: plans.created_at,
    })
    .from(plans)
    .orderBy(desc(plans.updated_at))
    .limit(limit);

  // Get workstream counts per project
  const wsCounts = await db
    .select({
      project_id: workstreams.project_id,
      count: sql<number>`count(*)::int`,
    })
    .from(workstreams)
    .groupBy(workstreams.project_id);

  const wsCountMap = new Map(wsCounts.map(r => [r.project_id, r.count]));

  // Deduplicate by project_id, attach workstream count
  const seen = new Set<string>();
  const projects = projectsFromPlans
    .filter(p => {
      if (seen.has(p.project_id)) return false;
      seen.add(p.project_id);
      return true;
    })
    .map(p => ({
      project_id: p.project_id,
      plan_name: p.plan_name,
      plan_id: p.plan_id,
      workstream_count: wsCountMap.get(p.project_id) ?? 0,
      created_at: p.created_at,
    }));

  return { projects, total: projects.length };
};

const getProjectContext: McpToolHandler = async (params, session, pool) => {
  const { project_id } = params as { project_id: string };
  const db = drizzle(pool);

  // Get orchestrations for project
  const orchResults = await db
    .select()
    .from(orchestrations)
    .where(eq(orchestrations.project_id, project_id))
    .limit(10);

  // Get workstream counts by status
  const wsResults = await db
    .select({
      status: workstreams.status,
      count: sql<number>`count(*)::int`,
    })
    .from(workstreams)
    .where(eq(workstreams.project_id, project_id))
    .groupBy(workstreams.status);

  // Get active session count
  const sessionCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sessions)
    .where(and(
      eq(sessions.project_id, project_id),
      eq(sessions.status, 'active'),
    ));

  return {
    project_id,
    orchestrations: orchResults,
    workstream_summary: wsResults,
    active_sessions: sessionCount[0]?.count ?? 0,
  };
};

const getWorkstreamContext: McpToolHandler = async (params, session, pool) => {
  const { project_id, workstream_id } = params as {
    project_id: string;
    workstream_id: string;
  };
  const db = drizzle(pool);

  // Get workstream details
  const [ws] = await db
    .select()
    .from(workstreams)
    .where(and(
      eq(workstreams.project_id, project_id),
      eq(workstreams.workstream_id, workstream_id),
    ))
    .limit(1);

  if (!ws) {
    throw new Error(`Workstream not found: ${workstream_id}`);
  }

  // Recent events for this workstream
  const recentEvents = await db
    .select()
    .from(events)
    .where(and(
      eq(events.project_id, project_id),
      eq(events.workstream_id, workstream_id),
    ))
    .orderBy(desc(events.created_at))
    .limit(10);

  // Recent sessions for this workstream
  const recentSessions = await db
    .select({
      session_id: sessions.session_id,
      status: sessions.status,
      started_at: sessions.started_at,
      ended_at: sessions.ended_at,
      user_id: sessions.user_id,
    })
    .from(sessions)
    .where(and(
      eq(sessions.project_id, project_id),
      eq(sessions.workstream_id, workstream_id),
    ))
    .orderBy(desc(sessions.started_at))
    .limit(5);

  return {
    workstream: ws,
    recent_events: recentEvents,
    recent_sessions: recentSessions,
  };
};

const searchDecisions: McpToolHandler = async (params, session, pool) => {
  const {
    project_id,
    query,
    workstream_id,
    limit,
    offset,
  } = params as {
    project_id: string;
    query?: string;
    workstream_id?: string;
    limit?: number;
    offset?: number;
  };
  const db = drizzle(pool);

  const conditions = [eq(decisions.project_id, project_id)];

  if (query) {
    conditions.push(
      or(
        ilike(decisions.title, `%${query}%`),
        ilike(decisions.context, `%${query}%`),
        ilike(decisions.decision, `%${query}%`),
      )!,
    );
  }

  if (workstream_id) {
    conditions.push(eq(decisions.workstream_id, workstream_id));
  }

  const results = await db
    .select()
    .from(decisions)
    .where(and(...conditions))
    .orderBy(desc(decisions.created_at))
    .limit(clampLimit(limit))
    .offset(offset ?? 0);

  return {
    decisions: results,
    count: results.length,
    limit: clampLimit(limit),
    offset: offset ?? 0,
  };
};

const getRecentSessionSummaries: McpToolHandler = async (params, session, pool) => {
  const { project_id, workstream_id, limit, offset } = params as {
    project_id: string;
    workstream_id?: string;
    limit?: number;
    offset?: number;
  };
  const db = drizzle(pool);

  const conditions = [eq(sessions.project_id, project_id)];
  if (workstream_id) {
    conditions.push(eq(sessions.workstream_id, workstream_id));
  }

  const results = await db
    .select({
      session_id: sessions.session_id,
      workstream_id: sessions.workstream_id,
      user_id: sessions.user_id,
      status: sessions.status,
      started_at: sessions.started_at,
      ended_at: sessions.ended_at,
      metadata: sessions.metadata,
    })
    .from(sessions)
    .where(and(...conditions))
    .orderBy(desc(sessions.started_at))
    .limit(clampLimit(limit))
    .offset(offset ?? 0);

  return {
    sessions: results,
    count: results.length,
    limit: clampLimit(limit),
    offset: offset ?? 0,
  };
};

const getRelevantErrors: McpToolHandler = async (params, session, pool) => {
  const {
    project_id,
    workstream_id,
    severity,
    unresolved_only = true,
    limit,
  } = params as {
    project_id: string;
    workstream_id?: string;
    severity?: string;
    unresolved_only?: boolean;
    limit?: number;
  };
  const db = drizzle(pool);

  const conditions = [eq(errors.project_id, project_id)];

  if (workstream_id) {
    conditions.push(eq(errors.workstream_id, workstream_id));
  }
  if (severity) {
    conditions.push(eq(errors.is_blocking, severity === 'critical' ? 'true' : 'false'));
  }
  if (unresolved_only) {
    conditions.push(sql`${errors.resolution} IS NULL`);
  }

  const results = await db
    .select()
    .from(errors)
    .where(and(...conditions))
    .orderBy(desc(errors.created_at))
    .limit(clampLimit(limit));

  return {
    errors: results,
    count: results.length,
  };
};

const getSessionContext: McpToolHandler = async (params, session, pool) => {
  const { project_id, session_id } = params as {
    project_id: string;
    session_id: string;
  };
  const db = drizzle(pool);

  // Get session
  const [sessionRecord] = await db
    .select()
    .from(sessions)
    .where(and(
      eq(sessions.project_id, project_id),
      eq(sessions.session_id, session_id),
    ))
    .limit(1);

  if (!sessionRecord) {
    throw new Error(`Session not found: ${session_id}`);
  }

  // Decisions from this session
  const sessionDecisions = await db
    .select()
    .from(decisions)
    .where(and(
      eq(decisions.project_id, project_id),
      eq(decisions.session_id, session_id),
    ))
    .orderBy(desc(decisions.created_at))
    .limit(50);

  // Errors from this session
  const sessionErrors = await db
    .select()
    .from(errors)
    .where(and(
      eq(errors.project_id, project_id),
      eq(errors.session_id, session_id),
    ))
    .orderBy(desc(errors.created_at))
    .limit(50);

  // Events from this session
  const sessionEvents = await db
    .select()
    .from(events)
    .where(and(
      eq(events.project_id, project_id),
      eq(events.session_id, session_id),
    ))
    .orderBy(desc(events.created_at))
    .limit(50);

  return {
    session: sessionRecord,
    decisions: sessionDecisions,
    errors: sessionErrors,
    events: sessionEvents,
  };
};

// ── Registry ────────────────────────────────────────────────────────────────

export const contextToolHandlers = new Map<string, McpToolHandler>([
  ['list_projects', listProjects],
  ['get_project_context', getProjectContext],
  ['get_workstream_context', getWorkstreamContext],
  ['search_decisions', searchDecisions],
  ['get_recent_session_summaries', getRecentSessionSummaries],
  ['get_relevant_errors', getRelevantErrors],
  ['get_session_context', getSessionContext],
]);
