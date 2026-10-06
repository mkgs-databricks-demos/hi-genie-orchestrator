/**
 * Review Service — Business Logic Layer
 *
 * Extracted from server/api/routes/reviews.ts. Called by both:
 *   - REST routes (reviews.ts) — maps ServiceResult to HTTP responses
 *   - MCP tool handlers (server/mcp/tools/reviews.ts) — maps to tool output
 *
 * Covers: createReview, getReview, deliverRemediation, approveReview.
 */

import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { withToolSpan, withDbSpan } from '../telemetry/index.js';
import { type ServiceResult, success, notFound, conflict } from './types.js';

// ── Input Types ─────────────────────────────────────────────────────────────────

export interface CreateReviewInput {
  review_task_id: string;
  workstream_id: string;
  orchestration_id: string;
  project_id: string;
  execution_id: string;
  correlation_id?: string;
}

export interface Finding {
  category: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  description: string;
  remediation_hint?: string;
  artifact_ref?: string;
}

export interface TestResult {
  test_name: string;
  passed: boolean;
  message?: string;
  artifact_ref?: string;
}

export interface DeliverRemediationInput {
  findings: Finding[];
  test_results?: TestResult[];
  checks_performed?: string[];
  correlation_id?: string;
}

export interface ApproveReviewInput {
  outcome: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  outcome_reason: string;
  checks_performed?: string[];
  artifact_refs?: string[];
  correlation_id?: string;
}

// ── Output Types ────────────────────────────────────────────────────────────────

export interface CreateReviewResult {
  review_task: Record<string, unknown>;
  idempotent: boolean;
}

export interface GetReviewResult {
  review_task: Record<string, unknown>;
}

export interface DeliverRemediationResult {
  review_task_id: string;
  status: string;
  findings_count: number;
  correlation_id: string;
}

export interface ApproveReviewResult {
  review_task_id: string;
  status: string;
  outcome: string;
  outcome_reason: string;
  workstream_id: string;
  workstream_status: string;
  correlation_id: string;
}

// ── Service Functions ──────────────────────────────────────────────────────────

/**
 * Create a review task (idempotent by review_task_id PK).
 */
export async function createReview(
  pool: Pool,
  userId: string,
  input: CreateReviewInput,
): Promise<ServiceResult<CreateReviewResult>> {
  return withToolSpan('service.reviews.create', async () => {
    const { review_task_id, workstream_id, orchestration_id, project_id, execution_id, correlation_id } = input;
    const corr_id = correlation_id ?? randomUUID();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);

      const result = await withDbSpan('dispatch.review_tasks.upsert', async () => {
        return client.query(
          `INSERT INTO dispatch.review_tasks
             (review_task_id, workstream_id, orchestration_id, project_id,
              execution_id, correlation_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (review_task_id) DO NOTHING
           RETURNING review_task_id, workstream_id, orchestration_id,
                     project_id, execution_id, status, created_at`,
          [review_task_id, workstream_id, orchestration_id, project_id, execution_id, corr_id, userId],
        );
      });

      if (result.rows.length === 0) {
        // Already exists — idempotent return
        const existing = await withDbSpan('dispatch.review_tasks.get_existing', async () => {
          return client.query(
            `SELECT review_task_id, workstream_id, orchestration_id,
                    project_id, execution_id, status, created_at
             FROM dispatch.review_tasks WHERE review_task_id = $1`,
            [review_task_id],
          );
        });

        await client.query('COMMIT');
        return success<CreateReviewResult>({ review_task: existing.rows[0], idempotent: true });
      }

      await client.query('COMMIT');
      return success<CreateReviewResult>({ review_task: result.rows[0], idempotent: false }, 201);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Retrieve a review task by ID.
 */
export async function getReview(
  pool: Pool,
  reviewId: string,
): Promise<ServiceResult<GetReviewResult>> {
  return withToolSpan('service.reviews.get', async () => {
    const result = await withDbSpan('dispatch.review_tasks.select', async () => {
      return pool.query(
        `SELECT review_task_id, workstream_id, orchestration_id, project_id,
                execution_id, status, reviewer_identity, checks_performed,
                artifact_refs, test_results, findings, outcome, outcome_reason,
                correlation_id, created_by, created_at, updated_at, completed_at
         FROM dispatch.review_tasks WHERE review_task_id = $1`,
        [reviewId],
      );
    });

    if (result.rows.length === 0) {
      return notFound('Review task not found');
    }

    return success<GetReviewResult>({ review_task: result.rows[0] });
  });
}

/**
 * Deliver remediation findings to a review task.
 */
export async function deliverRemediation(
  pool: Pool,
  userId: string,
  reviewId: string,
  input: DeliverRemediationInput,
): Promise<ServiceResult<DeliverRemediationResult>> {
  return withToolSpan('service.reviews.remediation', async () => {
    const { findings, test_results, checks_performed, correlation_id } = input;
    const corr_id = correlation_id ?? randomUUID();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);

      // Lock review task
      const reviewResult = await withDbSpan('dispatch.review_tasks.lock', async () => {
        return client.query(
          `SELECT review_task_id, status, workstream_id
           FROM dispatch.review_tasks
           WHERE review_task_id = $1 FOR UPDATE`,
          [reviewId],
        );
      });

      if (reviewResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFound('Review task not found');
      }

      const review = reviewResult.rows[0];
      if (review.status === 'APPROVED' || review.status === 'CANCELLED') {
        await client.query('ROLLBACK');
        return conflict(
          `Review task is ${review.status} and cannot accept remediation`,
          'IMMUTABLE',
        );
      }

      // Update with remediation data
      await withDbSpan('dispatch.review_tasks.deliver_remediation', async () => {
        return client.query(
          `UPDATE dispatch.review_tasks
           SET status = 'IN_PROGRESS',
               reviewer_identity = $1,
               findings = $2::jsonb,
               test_results = COALESCE($3::jsonb, test_results),
               checks_performed = COALESCE($4::jsonb, checks_performed),
               correlation_id = $5,
               updated_at = now()
           WHERE review_task_id = $6`,
          [
            userId,
            JSON.stringify(findings),
            test_results ? JSON.stringify(test_results) : null,
            checks_performed ? JSON.stringify(checks_performed) : null,
            corr_id,
            reviewId,
          ],
        );
      });

      await client.query('COMMIT');
      return success<DeliverRemediationResult>({
        review_task_id: reviewId,
        status: 'IN_PROGRESS',
        findings_count: findings.length,
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
 * Approve or reject a review task (immutable after).
 * On PASS: transitions workstream to COMPLETE.
 * On FAIL: transitions workstream to RETRYING.
 */
export async function approveReview(
  pool: Pool,
  userId: string,
  reviewId: string,
  input: ApproveReviewInput,
): Promise<ServiceResult<ApproveReviewResult>> {
  return withToolSpan('service.reviews.approve', async () => {
    const { outcome, outcome_reason, checks_performed, artifact_refs, correlation_id } = input;
    const corr_id = correlation_id ?? randomUUID();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);

      // Lock review task
      const reviewResult = await withDbSpan('dispatch.review_tasks.lock_for_approval', async () => {
        return client.query(
          `SELECT review_task_id, status, workstream_id
           FROM dispatch.review_tasks
           WHERE review_task_id = $1 FOR UPDATE`,
          [reviewId],
        );
      });

      if (reviewResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFound('Review task not found');
      }

      const review = reviewResult.rows[0];

      // Immutability guard
      if (review.status === 'APPROVED' || review.status === 'CANCELLED') {
        await client.query('ROLLBACK');
        return conflict(`Review task is already ${review.status}`, 'IMMUTABLE');
      }

      // Must be IN_PROGRESS or PENDING to approve
      if (review.status !== 'IN_PROGRESS' && review.status !== 'PENDING') {
        await client.query('ROLLBACK');
        return conflict(`Cannot approve from status ${review.status}`);
      }

      const newReviewStatus = outcome === 'PASS' ? 'APPROVED' : 'REJECTED';

      // Update review task (immutable after this)
      await withDbSpan('dispatch.review_tasks.approve', async () => {
        return client.query(
          `UPDATE dispatch.review_tasks
           SET status = $1,
               outcome = $2,
               outcome_reason = $3,
               reviewer_identity = $4,
               checks_performed = COALESCE($5::jsonb, checks_performed),
               artifact_refs = COALESCE($6::jsonb, artifact_refs),
               correlation_id = $7,
               completed_at = now(),
               updated_at = now()
           WHERE review_task_id = $8`,
          [
            newReviewStatus,
            outcome,
            outcome_reason,
            userId,
            checks_performed ? JSON.stringify(checks_performed) : null,
            artifact_refs ? JSON.stringify(artifact_refs) : null,
            corr_id,
            reviewId,
          ],
        );
      });

      // Cascade to workstream status
      if (outcome === 'PASS') {
        await withDbSpan('dispatch.workstreams.complete', async () => {
          return client.query(
            `UPDATE dispatch.workstreams
             SET status = 'COMPLETE', completed_at = now(), updated_at = now()
             WHERE workstream_id = $1`,
            [review.workstream_id],
          );
        });
      } else if (outcome === 'FAIL') {
        await withDbSpan('dispatch.workstreams.reject_to_retry', async () => {
          return client.query(
            `UPDATE dispatch.workstreams
             SET status = 'RETRYING', updated_at = now()
             WHERE workstream_id = $1 AND status != 'COMPLETE'`,
            [review.workstream_id],
          );
        });
      }

      await client.query('COMMIT');
      return success<ApproveReviewResult>({
        review_task_id: reviewId,
        status: newReviewStatus,
        outcome,
        outcome_reason,
        workstream_id: review.workstream_id,
        workstream_status: outcome === 'PASS' ? 'COMPLETE' : 'RETRYING',
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
