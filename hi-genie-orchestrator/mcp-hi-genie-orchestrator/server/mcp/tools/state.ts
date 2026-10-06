/**
 * Mutable State Tools
 *
 * Tools that update bounded, auditable state using optimistic concurrency
 * (version column). Each update records the acting user, timestamp, and
 * reason. Historical state-change events are never overwritten.
 *
 * Tools:
 *   - update_workstream_status
 *   - update_task_status
 *   - update_recovery_state
 *   - start_session
 *   - end_session
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { McpToolDefinition, McpToolHandler, McpSession } from '../transport.js';
import { withIdentity } from './identity.js';

// ── Optimistic Concurrency Helper ─────────────────────────────────────────
// Only for tables that actually have a `version` column (state.sessions, state.recovery_state).
// dispatch.workstreams and dispatch.executions use FOR UPDATE row-locking instead.

interface OptimisticUpdateOptions {
  pool: Pool;
  userId: string;
  schema: string;
  table: string;
  pkColumn: string;
  pkValue: string;
  projectId: string;
  expectedVersion: number;
  updates: Record<string, unknown>;
}

async function optimisticUpdate(opts: OptimisticUpdateOptions): Promise<{
  updated: boolean;
  new_version: number;
  conflict?: boolean;
}> {
  const { pool, userId, schema, table, pkColumn, pkValue, projectId, expectedVersion, updates } = opts;

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  for (const [col, val] of Object.entries(updates)) {
    setClauses.push(`${col} = $${paramIdx}`);
    values.push(val);
    paramIdx++;
  }

  // Increment version and set updated_at
  const newVersion = expectedVersion + 1;
  setClauses.push(`version = $${paramIdx}`);
  values.push(newVersion);
  paramIdx++;

  setClauses.push(`updated_at = $${paramIdx}`);
  values.push(new Date().toISOString());
  paramIdx++;

  // WHERE clause uses real PK column name
  values.push(pkValue, projectId, expectedVersion);

  const query = `
    UPDATE ${schema}.${table}
    SET ${setClauses.join(', ')}
    WHERE ${pkColumn} = $${paramIdx} AND project_id = $${paramIdx + 1} AND version = $${paramIdx + 2}
    RETURNING version
  `;

  // Wrap in transaction with set_config for RLS enforcement on mutable tables
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);
    const result = await client.query(query, values);
    await client.query('COMMIT');
    if (result.rowCount === 0) {
      return { updated: false, new_version: expectedVersion, conflict: true };
    }
    return { updated: true, new_version: newVersion };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Tool Definitions ────────────────────────────────────────────────────────

export const stateToolDefinitions: McpToolDefinition[] = [
  {
    name: 'update_workstream_status',
    description: 'Update a workstream\'s status with row-level locking. Valid transitions are validated server-side. Records an audit event in state.workstream_events.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        workstream_id: { type: 'string', format: 'uuid', description: 'Workstream UUID' },
        status: { type: 'string', enum: ['NOT_STARTED', 'IN_PROGRESS', 'VALIDATING', 'READY_FOR_REVIEW', 'RETRYING', 'BLOCKED'], description: 'Target workstream status (COMPLETE and CANCELLED are supervisor-only)' },
        reason: { type: 'string', description: 'Reason for status change' },
      },
      required: ['project_id', 'workstream_id', 'status', 'reason'],
    },
  },
  {
    name: 'update_task_status',
    description: 'Update a task\'s execution status within a workstream. Uses row-level locking (FOR UPDATE). Records the transition as an immutable event.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        execution_id: { type: 'string', format: 'uuid', description: 'Execution UUID' },
        status: { type: 'string', enum: ['RUNNING', 'SUCCEEDED', 'FAILED', 'RETRYABLE_FAILURE', 'EXPIRED', 'CANCELLED'], description: 'Execution status' },
        reason: { type: 'string', description: 'Reason for status change' },
      },
      required: ['project_id', 'execution_id', 'status', 'reason'],
    },
  },
  {
    name: 'update_recovery_state',
    description: 'Atomically replace the recovery state JSON blob for a workstream. Uses optimistic concurrency (version column). Pass the full desired state_data object.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        workstream_id: { type: 'string', format: 'uuid', description: 'Workstream UUID' },
        expected_version: { type: 'number', description: 'Expected current version' },
        state_data: { type: 'object', description: 'Full recovery state object (replaces existing state_data)' },
      },
      required: ['project_id', 'workstream_id', 'expected_version', 'state_data'],
    },
  },
  {
    name: 'start_session',
    description: 'Create and activate a new session for the authenticated user within a project/workstream. Returns the session ID and initial version.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        workstream_id: { type: 'string', format: 'uuid', description: 'Optional workstream scope' },
        metadata: { type: 'object', description: 'Optional session metadata (client info, context)' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'end_session',
    description: 'Close an active session. Sets status to \'ended\', records end timestamp. Uses optimistic concurrency on the session version.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', format: 'uuid', description: 'Project UUID' },
        session_id: { type: 'string', format: 'uuid', description: 'Session UUID to end' },
        expected_version: { type: 'number', description: 'Expected current version' },
      },
      required: ['project_id', 'session_id', 'expected_version'],
    },
  },
];

// ── Enum Validation (defense in depth — mirrors inputSchema enum arrays) ────

const VALID_WORKSTREAM_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'VALIDATING', 'READY_FOR_REVIEW', 'RETRYING', 'BLOCKED'] as const;
const VALID_TASK_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'RETRYABLE_FAILURE', 'EXPIRED', 'CANCELLED'] as const;

function validateEnum(value: string, validValues: readonly string[], fieldName: string, toolName: string): void {
  if (!validValues.includes(value)) {
    throw new Error(
      `Invalid ${fieldName} "${value}" for ${toolName}: must be one of ${validValues.join(', ')}`,
    );
  }
}

// ── Valid Status Transitions (MCP-accessible) ────────────────────────────────
// IMPORTANT: COMPLETE is NOT reachable from this tool.
// Decision 21: Review-gated completion — only the Supervisor API
// (/api/v1/reviews/:reviewId/approve with outcome=PASS) can transition
// a workstream to COMPLETE. This prevents workers from self-completing
// without independent review and supervisor approval.
// CANCELLED is also supervisor-only (via direct DB or future cancel endpoint).
const VALID_WORKSTREAM_TRANSITIONS: Record<string, string[]> = {
  NOT_STARTED: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED'],
  IN_PROGRESS: ['VALIDATING', 'BLOCKED', 'RETRYING', 'CANCELLED'],
  VALIDATING: ['READY_FOR_REVIEW', 'RETRYING', 'BLOCKED', 'CANCELLED'],
  READY_FOR_REVIEW: ['RETRYING', 'BLOCKED', 'CANCELLED'],
  RETRYING: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED'],
  BLOCKED: ['RETRYING', 'IN_PROGRESS', 'CANCELLED'],
  // Terminal states — no transitions out
  COMPLETE: [],
  CANCELLED: [],
};

function isValidWorkstreamTransition(from: string, to: string): boolean {
  return VALID_WORKSTREAM_TRANSITIONS[from]?.includes(to) ?? false;
}

// ── Tool Handlers ───────────────────────────────────────────────────────────

const updateWorkstreamStatus: McpToolHandler = async (params, session, pool) => {
  const { project_id, workstream_id, status, reason } = params as {
    project_id: string;
    workstream_id: string;
    status: string;
    reason: string;
  };

  // Defense in depth: validate enum before DB operation
  validateEnum(status, VALID_WORKSTREAM_STATUSES, 'status', 'update_workstream_status');

  // Use FOR UPDATE row-locking (dispatch.workstreams has no version column)
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_identity', $1, true)`, [session.userId]);

    const current = await client.query(
      'SELECT status FROM dispatch.workstreams WHERE workstream_id = $1 AND project_id = $2 FOR UPDATE',
      [workstream_id, project_id],
    );

    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error(`Workstream not found: ${workstream_id}`);
    }

    const currentStatus = current.rows[0].status;
    if (!isValidWorkstreamTransition(currentStatus, status)) {
      await client.query('ROLLBACK');
      throw new Error(
        `Invalid transition: ${currentStatus} \u2192 ${status}. ` +
        `Valid transitions from ${currentStatus}: ${VALID_WORKSTREAM_TRANSITIONS[currentStatus]?.join(', ') ?? 'none'}`,
      );
    }

    // Dependency enforcement: cannot start work until all upstream workstreams are COMPLETE
    if (status === 'IN_PROGRESS' && (currentStatus === 'NOT_STARTED' || currentStatus === 'BLOCKED')) {
      const depsResult = await client.query(
        `SELECT depends_on FROM dispatch.workstreams WHERE workstream_id = $1`,
        [workstream_id],
      );
      const dependsOn: string[] = depsResult.rows[0]?.depends_on ?? [];

      if (dependsOn.length > 0) {
        const blockers = await client.query(
          `SELECT workstream_key, status FROM dispatch.workstreams
           WHERE project_id = $1 AND workstream_key = ANY($2::text[]) AND status != 'COMPLETE'`,
          [project_id, dependsOn],
        );

        if (blockers.rows.length > 0) {
          await client.query('ROLLBACK');
          const blockerNames = blockers.rows.map((r: { workstream_key: string; status: string }) => `${r.workstream_key} (${r.status})`).join(', ');
          throw new Error(
            `Cannot start: upstream dependencies not complete: ${blockerNames}`,
          );
        }
      }
    }

    await client.query(
      `UPDATE dispatch.workstreams SET status = $1, updated_at = NOW() WHERE workstream_id = $2 AND project_id = $3`,
      [status, workstream_id, project_id],
    );

    // Record the event (immutable audit trail in workstream_events)
    await client.query(
      `INSERT INTO state.workstream_events
         (workstream_event_id, project_id, workstream_id, event_type, previous_value, new_value, metadata, correlation_id, created_by, created_at)
       VALUES ($1, $2, $3, 'status_changed', $4, $5, $6, $7, $8, NOW())`,
      [
        randomUUID(), project_id, workstream_id,
        currentStatus, status,
        JSON.stringify({ reason }),
        randomUUID(), session.userId,
      ],
    );

    await client.query('COMMIT');
    return { updated: true, workstream_id, previous_status: currentStatus, status };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

const updateTaskStatus: McpToolHandler = async (params, session, pool) => {
  const { project_id, execution_id, status, reason } = params as {
    project_id: string;
    execution_id: string;
    status: string;
    reason: string;
  };

  // Defense in depth: validate enum before DB operation
  validateEnum(status, VALID_TASK_STATUSES, 'status', 'update_task_status');

  // Use FOR UPDATE row-locking (dispatch.executions has no version column)
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_identity', $1, true)`, [session.userId]);

    const current = await client.query(
      'SELECT status, workstream_id FROM dispatch.executions WHERE execution_id = $1 AND project_id = $2 FOR UPDATE',
      [execution_id, project_id],
    );

    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error(`Execution not found: ${execution_id}`);
    }

    const previousStatus = current.rows[0].status;
    const workstreamId = current.rows[0].workstream_id;

    // Update execution status (and ended_at if terminal)
    const isTerminal = ['SUCCEEDED', 'FAILED', 'RETRYABLE_FAILURE', 'EXPIRED', 'CANCELLED'].includes(status);
    if (isTerminal) {
      await client.query(
        `UPDATE dispatch.executions SET status = $1, ended_at = NOW() WHERE execution_id = $2`,
        [status, execution_id],
      );
    } else {
      await client.query(
        `UPDATE dispatch.executions SET status = $1 WHERE execution_id = $2`,
        [status, execution_id],
      );
    }

    // Record audit event in state.events
    await client.query(
      `INSERT INTO state.events
         (event_id, project_id, workstream_id, event_type, payload, correlation_id, created_by, created_at)
       VALUES ($1, $2, $3, 'execution_status_changed', $4, $5, $6, NOW())`,
      [
        randomUUID(), project_id, workstreamId,
        JSON.stringify({ execution_id, from: previousStatus, to: status, reason }),
        randomUUID(), session.userId,
      ],
    );

    await client.query('COMMIT');
    return { updated: true, execution_id, previous_status: previousStatus, status };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

const updateRecoveryState: McpToolHandler = async (params, session, pool) => {
  const {
    project_id, workstream_id, expected_version, state_data,
  } = params as {
    project_id: string;
    workstream_id: string;
    expected_version: number;
    state_data: Record<string, unknown>;
  };

  if (!state_data || Object.keys(state_data).length === 0) {
    throw new Error('state_data must be a non-empty object');
  }

  // state.recovery_state has version column, PK is recovery_id, but we look up by workstream_id
  // Use withIdentity to set RLS context (recovery_state has UPDATE policy)
  return withIdentity(pool, session.userId, async (client) => {
    const result = await client.query(
      `UPDATE state.recovery_state
       SET state_data = $1, version = $2, updated_at = NOW()
       WHERE workstream_id = $3 AND project_id = $4 AND version = $5
       RETURNING version`,
      [JSON.stringify(state_data), expected_version + 1, workstream_id, project_id, expected_version],
    );

    if (result.rowCount === 0) {
      return { updated: false, new_version: expected_version, conflict: true, workstream_id };
    }
    return { updated: true, new_version: expected_version + 1, workstream_id };
  });
};

const startSession: McpToolHandler = async (params, session, pool) => {
  const { project_id, workstream_id, metadata } = params as {
    project_id: string;
    workstream_id?: string;
    metadata?: Record<string, unknown>;
  };

  const sessionId = randomUUID();
  const correlationId = randomUUID();
  const now = new Date().toISOString();

  // withIdentity sets RLS context (state.sessions has INSERT policy)
  await withIdentity(pool, session.userId, async (client) => {
    await client.query(
      `INSERT INTO state.sessions (session_id, project_id, workstream_id, user_id, status, metadata, correlation_id, version, started_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6, 1, $7, $7, $7)`,
      [
        sessionId, project_id, workstream_id ?? null,
        session.userId,
        metadata ? JSON.stringify(metadata) : '{}',
        correlationId, now,
      ],
    );
  });

  return {
    session_id: sessionId,
    project_id,
    workstream_id: workstream_id ?? null,
    user_id: session.userId,
    status: 'ACTIVE',
    version: 1,
    started_at: now,
  };
};

const endSession: McpToolHandler = async (params, session, pool) => {
  const { project_id, session_id, expected_version } = params as {
    project_id: string;
    session_id: string;
    expected_version: number;
  };

  // KI-19 fix: Pre-flight status guard — idempotent no-op if already ENDED
  // withIdentity required: SELECT RLS policy on state.sessions checks app.user_identity
  const preflight = await withIdentity(pool, session.userId, async (client) => {
    const current = await client.query(
      `SELECT status, ended_at, version FROM state.sessions WHERE session_id = $1 AND project_id = $2`,
      [session_id, project_id],
    );

    if (current.rowCount === 0) {
      throw new Error(`Session ${session_id} not found in project ${project_id}`);
    }

    return current.rows[0] as { status: string; ended_at: string | null; version: number };
  });

  if (preflight.status === 'ENDED') {
    // Already ended — return idempotent no-op
    return {
      updated: false,
      session_id,
      status: 'ENDED',
      ended_at: preflight.ended_at,
      version: preflight.version,
      already_ended: true,
    };
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = {
    status: 'ENDED',
    ended_at: now,
  };

  const result = await optimisticUpdate({
    pool,
    userId: session.userId,
    schema: 'state',
    table: 'sessions',
    pkColumn: 'session_id',
    pkValue: session_id,
    projectId: project_id,
    expectedVersion: expected_version,
    updates,
  });

  if (result.conflict) {
    throw new Error(
      `Concurrency conflict on session ${session_id}: expected version ${expected_version}`,
    );
  }

  return { ...result, session_id, status: 'ENDED', ended_at: now };
};

// ── Registry ────────────────────────────────────────────────────────────────

export const stateToolHandlers = new Map<string, McpToolHandler>([
  ['update_workstream_status', updateWorkstreamStatus],
  ['update_task_status', updateTaskStatus],
  ['update_recovery_state', updateRecoveryState],
  ['start_session', startSession],
  ['end_session', endSession],
]);
