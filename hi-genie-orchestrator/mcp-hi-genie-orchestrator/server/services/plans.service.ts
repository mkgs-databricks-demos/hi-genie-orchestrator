/**
 * Plan Service — Business Logic Layer
 *
 * Extracted from server/api/routes/plans.ts. Called by both:
 *   - REST routes (plans.ts) — maps ServiceResult to HTTP responses
 *   - MCP tool handlers (server/mcp/tools/plans.ts) — maps to tool output
 *
 * All functions accept a Pool + userId (identity for RLS) + typed input.
 * Returns ServiceResult<T> — never throws for business-logic failures.
 *
 * RLS pattern: BEGIN → set_config('app.user_identity', userId, true) → DML → COMMIT/ROLLBACK
 */

import { randomUUID, createHash } from 'crypto';
import type { Pool } from 'pg';
import { withToolSpan, withDbSpan } from '../telemetry/index.js';
import { type ServiceResult, success, notFound, conflict, badRequest } from './types.js';

// ── Input Types ─────────────────────────────────────────────────────────────────

export interface CreatePlanInput {
  project_id: string;
  name: string;
  description?: string;
  source_ref?: Record<string, unknown>;
}

export interface PublishPlanInput {
  content: Record<string, unknown>;
  workstream_count: number;
}

export interface OrchestratePlanInput {
  plan_snapshot_id?: string;
  priority?: number;
}

// ── Output Types ────────────────────────────────────────────────────────────────

export interface PlanRow {
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

export interface PlanSnapshotRow {
  plan_snapshot_id: string;
  plan_id: string;
  version: number;
  content_hash: string;
  content?: Record<string, unknown>;
  workstream_count: number;
  created_by: string;
  created_at: string;
}

export interface CreatePlanResult {
  plan: PlanRow;
}

export interface GetPlanResult {
  plan: PlanRow;
  snapshots: PlanSnapshotRow[];
}

export interface PublishPlanResult {
  snapshot: PlanSnapshotRow;
  idempotent: boolean;
  message?: string;
}

export interface OrchestratePlanResult {
  orchestration: Record<string, unknown>;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

export function computeContentHash(content: unknown): string {
  const serialized = JSON.stringify(content, Object.keys(content as object).sort());
  return createHash('sha256').update(serialized).digest('hex');
}

// ── Service Functions ──────────────────────────────────────────────────────────

/**
 * Create a new plan in a project.
 */
export async function createPlan(
  pool: Pool,
  userId: string,
  input: CreatePlanInput,
): Promise<ServiceResult<CreatePlanResult>> {
  return withToolSpan('service.plans.create', async () => {
    const { project_id, name, description, source_ref } = input;
    const plan_id = randomUUID();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);

      const result = await withDbSpan('dispatch.plans.insert', async () => {
        return client.query(
          `INSERT INTO dispatch.plans
             (plan_id, project_id, name, description, source_ref, created_by)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           RETURNING plan_id, project_id, name, description, source_ref,
                     current_snapshot_id, created_by, created_at, updated_at`,
          [plan_id, project_id, name, description ?? null, JSON.stringify(source_ref ?? {}), userId],
        );
      });

      await client.query('COMMIT');
      return success<CreatePlanResult>({ plan: result.rows[0] }, 201);
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      // Handle FK violation: project_id not found in dispatch.projects
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23503') {
        const detail = 'detail' in err ? (err as { detail: string }).detail : '';
        return badRequest(
          `Invalid project_id: "${project_id}" does not exist. Create the project first.`,
          { constraint: 'fk_plans_project_id', pg_detail: detail },
        );
      }
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Retrieve a plan with all its snapshots.
 */
export async function getPlan(
  pool: Pool,
  planId: string,
): Promise<ServiceResult<GetPlanResult>> {
  return withToolSpan('service.plans.get', async () => {
    const planResult = await withDbSpan('dispatch.plans.select', async () => {
      return pool.query(
        `SELECT plan_id, project_id, name, description, source_ref,
                current_snapshot_id, created_by, created_at, updated_at
         FROM dispatch.plans WHERE plan_id = $1`,
        [planId],
      );
    });

    if (planResult.rows.length === 0) {
      return notFound('Plan not found');
    }

    const snapshotsResult = await withDbSpan('dispatch.plan_snapshots.select', async () => {
      return pool.query(
        `SELECT plan_snapshot_id, plan_id, version, content_hash,
                content, workstream_count, created_by, created_at
         FROM dispatch.plan_snapshots
         WHERE plan_id = $1 ORDER BY version DESC`,
        [planId],
      );
    });

    return success<GetPlanResult>({
      plan: planResult.rows[0],
      snapshots: snapshotsResult.rows,
    });
  });
}

/**
 * Publish an immutable plan snapshot. Idempotent by content hash.
 */
export async function publishPlan(
  pool: Pool,
  userId: string,
  planId: string,
  input: PublishPlanInput,
): Promise<ServiceResult<PublishPlanResult>> {
  return withToolSpan('service.plans.publish', async () => {
    const { content, workstream_count } = input;
    const content_hash = computeContentHash(content);
    const plan_snapshot_id = randomUUID();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);

      // Verify plan exists
      const planCheck = await withDbSpan('dispatch.plans.lock', async () => {
        return client.query(
          `SELECT plan_id FROM dispatch.plans WHERE plan_id = $1 FOR UPDATE`,
          [planId],
        );
      });

      if (planCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFound('Plan not found');
      }

      // Idempotent: check for duplicate content hash
      const dupeCheck = await withDbSpan('dispatch.plan_snapshots.dupe_check', async () => {
        return client.query(
          `SELECT plan_snapshot_id, version, content_hash, created_at
           FROM dispatch.plan_snapshots
           WHERE plan_id = $1 AND content_hash = $2`,
          [planId, content_hash],
        );
      });

      if (dupeCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return success<PublishPlanResult>({
          snapshot: dupeCheck.rows[0],
          idempotent: true,
          message: 'Content already published with identical hash',
        });
      }

      // Determine next version
      const versionResult = await withDbSpan('dispatch.plan_snapshots.max_version', async () => {
        return client.query(
          `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
           FROM dispatch.plan_snapshots WHERE plan_id = $1`,
          [planId],
        );
      });
      const nextVersion: number = versionResult.rows[0].next_version;

      // Insert immutable snapshot
      const snapshotResult = await withDbSpan('dispatch.plan_snapshots.insert', async () => {
        return client.query(
          `INSERT INTO dispatch.plan_snapshots
             (plan_snapshot_id, plan_id, version, content_hash, content, workstream_count, created_by)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
           RETURNING plan_snapshot_id, plan_id, version, content_hash,
                     workstream_count, created_by, created_at`,
          [plan_snapshot_id, planId, nextVersion, content_hash, JSON.stringify(content), workstream_count, userId],
        );
      });

      // Update plan's current_snapshot_id
      await withDbSpan('dispatch.plans.update_current', async () => {
        return client.query(
          `UPDATE dispatch.plans
           SET current_snapshot_id = $1, updated_at = now()
           WHERE plan_id = $2`,
          [plan_snapshot_id, planId],
        );
      });

      await client.query('COMMIT');
      return success<PublishPlanResult>({ snapshot: snapshotResult.rows[0], idempotent: false }, 201);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Create an orchestration from a published plan snapshot.
 */
export async function orchestratePlan(
  pool: Pool,
  userId: string,
  planId: string,
  input: OrchestratePlanInput,
): Promise<ServiceResult<OrchestratePlanResult>> {
  return withToolSpan('service.plans.orchestrate', async () => {
    const { plan_snapshot_id: requestedSnapshotId, priority = 50 } = input;
    const orchestration_id = randomUUID();
    const correlation_id = randomUUID();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);

      // Verify plan exists and get current_snapshot_id + project_id
      const planResult = await withDbSpan('dispatch.plans.select_for_orchestrate', async () => {
        return client.query(
          `SELECT plan_id, project_id, current_snapshot_id
           FROM dispatch.plans WHERE plan_id = $1 FOR UPDATE`,
          [planId],
        );
      });

      if (planResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFound('Plan not found');
      }

      const plan = planResult.rows[0];
      const snapshotId = requestedSnapshotId ?? plan.current_snapshot_id;

      if (!snapshotId) {
        await client.query('ROLLBACK');
        return conflict(
          'Plan has no published snapshot. Publish a snapshot first or provide plan_snapshot_id.',
          'NO_SNAPSHOT',
        );
      }

      // Verify snapshot exists and belongs to this plan
      const snapCheck = await withDbSpan('dispatch.plan_snapshots.verify_for_orchestrate', async () => {
        return client.query(
          `SELECT plan_snapshot_id FROM dispatch.plan_snapshots
           WHERE plan_snapshot_id = $1 AND plan_id = $2`,
          [snapshotId, planId],
        );
      });

      if (snapCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFound('Plan snapshot not found for this plan');
      }

      // Insert orchestration
      const result = await withDbSpan('dispatch.orchestrations.insert', async () => {
        return client.query(
          `INSERT INTO dispatch.orchestrations
             (orchestration_id, project_id, plan_id, plan_snapshot_id,
              status, priority, correlation_id, created_by)
           VALUES ($1, $2, $3, $4, 'PENDING', $5, $6, $7)
           RETURNING orchestration_id, project_id, plan_id, plan_snapshot_id,
                     status, priority, correlation_id, configuration_version,
                     created_by, created_at, updated_at`,
          [orchestration_id, plan.project_id, planId, snapshotId, priority, correlation_id, userId],
        );
      });

      await client.query('COMMIT');
      return success<OrchestratePlanResult>({ orchestration: result.rows[0] }, 201);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}
