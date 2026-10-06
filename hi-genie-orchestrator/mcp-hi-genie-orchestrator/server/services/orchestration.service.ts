/**
 * Orchestration Service — Business Logic Layer
 *
 * Extracted from server/api/routes/workstreams.ts. Called by both:
 *   - REST routes (workstreams.ts) — maps ServiceResult to HTTP responses
 *   - MCP tool handlers (server/mcp/tools/orchestration.ts) — maps to tool output
 *
 * Covers: materialize, list, dispatch, retry, pause, unpause.
 */

import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { withToolSpan, withDbSpan } from '../telemetry/index.js';
import { type ServiceResult, success, notFound, conflict, badRequest } from './types.js';

// ── Valid Status Transitions (re-exported for both routes and MCP) ──────────

export const DISPATCH_FROM = ['NOT_STARTED', 'RETRYING'] as const;
export const RETRY_FROM = ['BLOCKED'] as const;
export const PAUSE_FROM = ['NOT_STARTED', 'IN_PROGRESS', 'RETRYING'] as const;
export const UNPAUSE_FROM = ['BLOCKED'] as const;

// ── Input Types ─────────────────────────────────────────────────────────────────

export interface MaterializeInput {
  plan_snapshot_id: string;
  priority?: number;
  correlation_id?: string;
  configuration_version?: string;
}

export interface DispatchInput {
  worker_identity?: string;
  correlation_id?: string;
}

export interface RetryInput {
  reason: string;
  correlation_id?: string;
}

export interface PauseInput {
  reason?: string;
}

// ── Output Types ────────────────────────────────────────────────────────────────

export interface MaterializeResult {
  orchestration_id: string;
  workstreams_materialized: number;
  workstreams: Array<{ workstream_id: string; workstream_key: string; status: string }>;
  correlation_id: string;
}

export interface ListWorkstreamsResult {
  workstreams: Record<string, unknown>[];
}

export interface DispatchResult {
  execution_id: string;
  workstream_id: string;
  status: string;
  attempt_number: number;
  correlation_id: string;
}

export interface WorkstreamStatusResult {
  workstream_id: string;
  status: string;
  correlation_id: string;
}

// ── Service Functions ──────────────────────────────────────────────────────────

/**
 * Materialize workstreams from a plan snapshot into an orchestration.
 */
export async function materializeWorkstreams(
  pool: Pool,
  userId: string,
  orchId: string,
  input: MaterializeInput,
): Promise<ServiceResult<MaterializeResult>> {
  return withToolSpan('service.orchestration.materialize', async () => {
    const { plan_snapshot_id, priority = 50, correlation_id, configuration_version = '1.0.0' } = input;
    const corr_id = correlation_id ?? randomUUID();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);

      // Verify orchestration exists and lock
      const orchResult = await withDbSpan('dispatch.orchestrations.lock', async () => {
        return client.query(
          `SELECT orchestration_id, project_id, plan_id, status
           FROM dispatch.orchestrations
           WHERE orchestration_id = $1 FOR UPDATE`,
          [orchId],
        );
      });

      if (orchResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFound('Orchestration not found');
      }

      const orch = orchResult.rows[0];
      if (orch.status !== 'PENDING') {
        await client.query('ROLLBACK');
        return conflict(`Orchestration status is ${orch.status}, expected PENDING`);
      }

      // Verify snapshot exists and belongs to the plan
      const snapResult = await withDbSpan('dispatch.plan_snapshots.verify', async () => {
        return client.query(
          `SELECT plan_snapshot_id, content, workstream_count
           FROM dispatch.plan_snapshots
           WHERE plan_snapshot_id = $1 AND plan_id = $2`,
          [plan_snapshot_id, orch.plan_id],
        );
      });

      if (snapResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFound('Plan snapshot not found for this plan');
      }

      const snapshot = snapResult.rows[0];
      const planContent = snapshot.content;
      const workstreams: Array<{
        workstream_key: string;
        name?: string;
        title?: string;
        execution_tier: number;
        depends_on: string[];
        config: Record<string, unknown>;
        max_retries?: number;
        priority?: number;
      }> = planContent.workstreams ?? [];

      // Materialize each workstream
      const materialized = [];
      for (const ws of workstreams) {
        const workstream_id = randomUUID();
        const idempotency_key = `${orchId}:${ws.workstream_key}`;

        const insertResult = await withDbSpan('dispatch.workstreams.insert', async () => {
          return client.query(
            `INSERT INTO dispatch.workstreams
               (workstream_id, orchestration_id, project_id, workstream_key, name,
                execution_tier, depends_on, config, max_retries, priority,
                idempotency_key, correlation_id, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13)
             ON CONFLICT (project_id, idempotency_key) DO NOTHING
             RETURNING workstream_id, workstream_key, status`,
            [
              workstream_id, orchId, orch.project_id, ws.workstream_key, ws.name ?? ws.title ?? ws.workstream_key,
              ws.execution_tier ?? 0, JSON.stringify(ws.depends_on ?? []),
              JSON.stringify(ws.config ?? {}), ws.max_retries ?? 3,
              ws.priority ?? priority, idempotency_key, corr_id, userId,
            ],
          );
        });

        if (insertResult.rows.length > 0) {
          materialized.push(insertResult.rows[0]);
        }
      }

      // Update orchestration status and snapshot reference
      await withDbSpan('dispatch.orchestrations.activate', async () => {
        return client.query(
          `UPDATE dispatch.orchestrations
           SET status = 'RUNNING', plan_snapshot_id = $1,
               configuration_version = $2, started_at = now(), updated_at = now()
           WHERE orchestration_id = $3`,
          [plan_snapshot_id, configuration_version, orchId],
        );
      });

      await client.query('COMMIT');
      return success<MaterializeResult>({
        orchestration_id: orchId,
        workstreams_materialized: materialized.length,
        workstreams: materialized,
        correlation_id: corr_id,
      }, 201);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * List workstreams for an orchestration.
 */
export async function listWorkstreams(
  pool: Pool,
  orchId: string,
): Promise<ServiceResult<ListWorkstreamsResult>> {
  return withToolSpan('service.orchestration.list', async () => {
    const result = await withDbSpan('dispatch.workstreams.select_by_orch', async () => {
      return pool.query(
        `SELECT workstream_id, orchestration_id, project_id, workstream_key,
                name, status, execution_tier, depends_on, config,
                attempt_count, max_retries, assigned_to, priority,
                correlation_id, created_at, updated_at, started_at, completed_at
         FROM dispatch.workstreams
         WHERE orchestration_id = $1
         ORDER BY execution_tier ASC, priority DESC`,
        [orchId],
      );
    });

    return success<ListWorkstreamsResult>({ workstreams: result.rows });
  });
}

/**
 * Dispatch a workstream for execution.
 */
export async function dispatchWorkstream(
  pool: Pool,
  userId: string,
  orchId: string,
  wsKey: string,
  input: DispatchInput,
): Promise<ServiceResult<DispatchResult>> {
  return withToolSpan('service.orchestration.dispatch', async () => {
    const { correlation_id } = input;
    const corr_id = correlation_id ?? randomUUID();
    const worker_identity = input.worker_identity ?? userId;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);

      // Lock workstream and validate status
      const wsResult = await withDbSpan('dispatch.workstreams.lock', async () => {
        return client.query(
          `SELECT workstream_id, orchestration_id, project_id, status, attempt_count, max_retries
           FROM dispatch.workstreams
           WHERE orchestration_id = $1 AND workstream_key = $2 FOR UPDATE`,
          [orchId, wsKey],
        );
      });

      if (wsResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFound('Workstream not found');
      }

      const ws = wsResult.rows[0];
      if (!DISPATCH_FROM.includes(ws.status as typeof DISPATCH_FROM[number])) {
        await client.query('ROLLBACK');
        return conflict(`Cannot dispatch from status ${ws.status}`);
      }

      // Dependency gate: verify all upstream workstreams are COMPLETE
      const depsResult = await withDbSpan('dispatch.workstreams.check_deps', async () => {
        return client.query(
          `SELECT w.workstream_key, w.status
           FROM dispatch.workstreams w
           WHERE w.orchestration_id = $1
             AND w.workstream_key = ANY(
               SELECT jsonb_array_elements_text(ws2.depends_on)
               FROM dispatch.workstreams ws2
               WHERE ws2.workstream_id = $2
             )`,
          [orchId, ws.workstream_id],
        );
      });

      const unmetDeps = depsResult.rows.filter(
        (dep: { workstream_key: string; status: string }) => dep.status !== 'COMPLETE',
      );
      if (unmetDeps.length > 0) {
        await client.query('ROLLBACK');
        const summary = unmetDeps
          .map((d: { workstream_key: string; status: string }) => `${d.workstream_key}=${d.status}`)
          .join(', ');
        return badRequest(
          `Cannot dispatch: upstream dependencies not COMPLETE: [${summary}]`,
          { unmet_dependencies: unmetDeps },
        );
      }

      const nextAttempt = ws.attempt_count + 1;
      const execution_id = randomUUID();

      // Create execution record
      await withDbSpan('dispatch.executions.insert', async () => {
        return client.query(
          `INSERT INTO dispatch.executions
             (execution_id, workstream_id, project_id, attempt_number,
              status, worker_identity, correlation_id)
           VALUES ($1, $2, $3, $4, 'RUNNING', $5, $6)`,
          [execution_id, ws.workstream_id, ws.project_id, nextAttempt, worker_identity, corr_id],
        );
      });

      // Update workstream status
      await withDbSpan('dispatch.workstreams.update_status', async () => {
        return client.query(
          `UPDATE dispatch.workstreams
           SET status = 'IN_PROGRESS', attempt_count = $1,
               assigned_to = $2, started_at = COALESCE(started_at, now()),
               updated_at = now(), correlation_id = $3
           WHERE workstream_id = $4`,
          [nextAttempt, worker_identity, corr_id, ws.workstream_id],
        );
      });

      await client.query('COMMIT');
      return success<DispatchResult>({
        execution_id,
        workstream_id: ws.workstream_id,
        status: 'IN_PROGRESS',
        attempt_number: nextAttempt,
        correlation_id: corr_id,
      }, 201);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Retry a blocked workstream.
 */
export async function retryWorkstream(
  pool: Pool,
  userId: string,
  orchId: string,
  wsKey: string,
  input: RetryInput,
): Promise<ServiceResult<WorkstreamStatusResult>> {
  return withToolSpan('service.orchestration.retry', async () => {
    const { reason, correlation_id } = input;
    const corr_id = correlation_id ?? randomUUID();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);

      const wsResult = await withDbSpan('dispatch.workstreams.lock_for_retry', async () => {
        return client.query(
          `SELECT workstream_id, status
           FROM dispatch.workstreams
           WHERE orchestration_id = $1 AND workstream_key = $2 FOR UPDATE`,
          [orchId, wsKey],
        );
      });

      if (wsResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFound('Workstream not found');
      }

      const ws = wsResult.rows[0];
      if (!RETRY_FROM.includes(ws.status as typeof RETRY_FROM[number])) {
        await client.query('ROLLBACK');
        return conflict(`Cannot retry from status ${ws.status}`);
      }

      await withDbSpan('dispatch.workstreams.set_retrying', async () => {
        return client.query(
          `UPDATE dispatch.workstreams
           SET status = 'RETRYING', correlation_id = $1, updated_at = now()
           WHERE workstream_id = $2`,
          [corr_id, ws.workstream_id],
        );
      });

      await client.query('COMMIT');
      return success<WorkstreamStatusResult>({
        workstream_id: ws.workstream_id,
        status: 'RETRYING',
        correlation_id: corr_id,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Pause a workstream.
 */
export async function pauseWorkstream(
  pool: Pool,
  userId: string,
  orchId: string,
  wsKey: string,
  input: PauseInput,
): Promise<ServiceResult<WorkstreamStatusResult>> {
  return withToolSpan('service.orchestration.pause', async () => {
    const corr_id = randomUUID();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);

      const wsResult = await withDbSpan('dispatch.workstreams.lock_for_pause', async () => {
        return client.query(
          `SELECT workstream_id, status
           FROM dispatch.workstreams
           WHERE orchestration_id = $1 AND workstream_key = $2 FOR UPDATE`,
          [orchId, wsKey],
        );
      });

      if (wsResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFound('Workstream not found');
      }

      const ws = wsResult.rows[0];
      if (!PAUSE_FROM.includes(ws.status as typeof PAUSE_FROM[number])) {
        await client.query('ROLLBACK');
        return conflict(`Cannot pause from status ${ws.status}`);
      }

      await withDbSpan('dispatch.workstreams.set_blocked', async () => {
        return client.query(
          `UPDATE dispatch.workstreams
           SET status = 'BLOCKED', correlation_id = $1, updated_at = now()
           WHERE workstream_id = $2`,
          [corr_id, ws.workstream_id],
        );
      });

      await client.query('COMMIT');
      return success<WorkstreamStatusResult>({
        workstream_id: ws.workstream_id,
        status: 'BLOCKED',
        correlation_id: corr_id,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Unpause (resume) a blocked workstream.
 */
export async function unpauseWorkstream(
  pool: Pool,
  userId: string,
  orchId: string,
  wsKey: string,
): Promise<ServiceResult<WorkstreamStatusResult>> {
  return withToolSpan('service.orchestration.unpause', async () => {
    const corr_id = randomUUID();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);

      const wsResult = await withDbSpan('dispatch.workstreams.lock_for_unpause', async () => {
        return client.query(
          `SELECT workstream_id, status
           FROM dispatch.workstreams
           WHERE orchestration_id = $1 AND workstream_key = $2 FOR UPDATE`,
          [orchId, wsKey],
        );
      });

      if (wsResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFound('Workstream not found');
      }

      const ws = wsResult.rows[0];
      if (!UNPAUSE_FROM.includes(ws.status as typeof UNPAUSE_FROM[number])) {
        await client.query('ROLLBACK');
        return conflict(`Cannot unpause from status ${ws.status}`);
      }

      await withDbSpan('dispatch.workstreams.set_not_started', async () => {
        return client.query(
          `UPDATE dispatch.workstreams
           SET status = 'NOT_STARTED', correlation_id = $1, updated_at = now()
           WHERE workstream_id = $2`,
          [corr_id, ws.workstream_id],
        );
      });

      await client.query('COMMIT');
      return success<WorkstreamStatusResult>({
        workstream_id: ws.workstream_id,
        status: 'NOT_STARTED',
        correlation_id: corr_id,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}
