/**
 * Supervisor API — Review Routes
 *
 * Implements versioned /api/v1/reviews endpoints:
 *   - POST /api/v1/reviews                       → Create review task (idempotent)
 *   - GET  /api/v1/reviews/:reviewId              → Retrieve review task
 *   - POST /api/v1/reviews/:reviewId/remediation  → Deliver remediation envelope
 *   - POST /api/v1/reviews/:reviewId/approve      → Supervisor-only completion approval
 *
 * Architecture:
 *   - Decision 21: Review-gated completion (workers cannot self-complete)
 *   - Decision 25: Lakebase-referenced remediation prompts
 *   - COMPLETE is supervisor-owned state; immutable after approval
 *   - Idempotent review creation via review_task_id PK
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { withToolSpan, withDbSpan } from '../../telemetry/index.js';
import { getUserIdentity } from './plans.js';

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

export const CreateReviewSchema = z.object({
  review_task_id: z.string().uuid(),
  workstream_id: z.string().uuid(),
  orchestration_id: z.string().uuid(),
  project_id: z.string().uuid(),
  execution_id: z.string().uuid(),
  correlation_id: z.string().uuid().optional(),
});

export const RemediationSchema = z.object({
  findings: z.array(z.object({
    category: z.string().min(1),
    severity: z.enum(['INFO', 'WARNING', 'ERROR', 'CRITICAL']),
    description: z.string().min(1),
    remediation_hint: z.string().optional(),
    artifact_ref: z.string().optional(),
  })),
  test_results: z.array(z.object({
    test_name: z.string().min(1),
    passed: z.boolean(),
    message: z.string().optional(),
    artifact_ref: z.string().optional(),
  })).optional(),
  checks_performed: z.array(z.string()).optional(),
  correlation_id: z.string().uuid().optional(),
});

export const ApproveSchema = z.object({
  outcome: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']),
  outcome_reason: z.string().min(1).max(2000),
  checks_performed: z.array(z.string()).optional(),
  artifact_refs: z.array(z.string()).optional(),
  correlation_id: z.string().uuid().optional(),
});

// ─── Route Factory ───────────────────────────────────────────────────────────

export function createReviewRoutes(pool: Pool): Router {
  const router = Router();

  // ── POST /api/v1/reviews — Create review task (idempotent) ─────────────
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    await withToolSpan('api.reviews.create', async () => {
      const parsed = CreateReviewSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
        return;
      }

      const { review_task_id, workstream_id, orchestration_id, project_id, execution_id, correlation_id } = parsed.data;
      const created_by = getUserIdentity(req);
      const corr_id = correlation_id ?? randomUUID();

      // Phase 3b (migration 006): explicit transaction so `set_config` runs on
      // the same connection as the INSERT below, satisfying the RLS insert
      // policy on dispatch.review_tasks (checks created_by).
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.user_identity', $1, true)`, [created_by]);

        const result = await withDbSpan('dispatch.review_tasks.upsert', async () => {
          return client.query(
            `INSERT INTO dispatch.review_tasks
               (review_task_id, workstream_id, orchestration_id, project_id,
                execution_id, correlation_id, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (review_task_id) DO NOTHING
             RETURNING review_task_id, workstream_id, orchestration_id,
                       project_id, execution_id, status, created_at`,
            [review_task_id, workstream_id, orchestration_id, project_id, execution_id, corr_id, created_by],
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
          res.status(200).json({
            review_task: existing.rows[0],
            idempotent: true,
          });
          return;
        }

        await client.query('COMMIT');
        res.status(201).json({
          review_task: result.rows[0],
          idempotent: false,
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    });
  });

  // ── GET /api/v1/reviews/:reviewId — Retrieve review task ────────────────
  router.get('/:reviewId', async (req: Request, res: Response): Promise<void> => {
    await withToolSpan('api.reviews.get', async () => {
      const { reviewId } = req.params;

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
        res.status(404).json({ error: 'NOT_FOUND', message: 'Review task not found' });
        return;
      }

      res.status(200).json({ review_task: result.rows[0] });
    });
  });

  // ── POST /api/v1/reviews/:reviewId/remediation — Deliver envelope ──────
  router.post('/:reviewId/remediation', async (req: Request, res: Response): Promise<void> => {
    await withToolSpan('api.reviews.remediation', async () => {
      const { reviewId } = req.params;
      const parsed = RemediationSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
        return;
      }

      const { findings, test_results, checks_performed, correlation_id } = parsed.data;
      const reviewer_identity = getUserIdentity(req);
      const corr_id = correlation_id ?? randomUUID();

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Phase 3b (migration 006): identity context for the RLS update policy
        // on dispatch.review_tasks, which checks that the row's new
        // reviewer_identity (set below) matches the caller's own identity.
        await client.query(`SELECT set_config('app.user_identity', $1, true)`, [reviewer_identity]);

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
          res.status(404).json({ error: 'NOT_FOUND', message: 'Review task not found' });
          return;
        }

        const review = reviewResult.rows[0];
        if (review.status === 'APPROVED' || review.status === 'CANCELLED') {
          await client.query('ROLLBACK');
          res.status(409).json({
            error: 'IMMUTABLE',
            message: `Review task is ${review.status} and cannot accept remediation`,
          });
          return;
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
              reviewer_identity,
              JSON.stringify(findings),
              test_results ? JSON.stringify(test_results) : null,
              checks_performed ? JSON.stringify(checks_performed) : null,
              corr_id,
              reviewId,
            ],
          );
        });

        await client.query('COMMIT');

        res.status(200).json({
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
  });

  // ── POST /api/v1/reviews/:reviewId/approve — Completion approval (immutable) ─
  router.post('/:reviewId/approve', async (req: Request, res: Response): Promise<void> => {
    await withToolSpan('api.reviews.approve', async () => {
      const { reviewId } = req.params;
      const parsed = ApproveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
        return;
      }

      const { outcome, outcome_reason, checks_performed, artifact_refs, correlation_id } = parsed.data;
      const reviewer_identity = getUserIdentity(req);
      const corr_id = correlation_id ?? randomUUID();

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Phase 3b (migration 006): identity context for the RLS update policy
        // on dispatch.review_tasks (checks reviewer_identity, set below, against
        // the caller's own identity).
        await client.query(`SELECT set_config('app.user_identity', $1, true)`, [reviewer_identity]);

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
          res.status(404).json({ error: 'NOT_FOUND', message: 'Review task not found' });
          return;
        }

        const review = reviewResult.rows[0];

        // Immutability guard: already approved/cancelled cannot be re-approved
        if (review.status === 'APPROVED' || review.status === 'CANCELLED') {
          await client.query('ROLLBACK');
          res.status(409).json({
            error: 'IMMUTABLE',
            message: `Review task is already ${review.status}`,
          });
          return;
        }

        // Must be IN_PROGRESS (remediation delivered) to approve
        if (review.status !== 'IN_PROGRESS' && review.status !== 'PENDING') {
          await client.query('ROLLBACK');
          res.status(409).json({
            error: 'INVALID_STATE',
            message: `Cannot approve from status ${review.status}`,
          });
          return;
        }

        // Determine new review status based on outcome
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
              reviewer_identity,
              checks_performed ? JSON.stringify(checks_performed) : null,
              artifact_refs ? JSON.stringify(artifact_refs) : null,
              corr_id,
              reviewId,
            ],
          );
        });

        // If PASS: transition workstream to COMPLETE (supervisor-owned)
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
          // Transition workstream to RETRYING for remediation re-attempt
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

        res.status(200).json({
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
  });

  return router;
}
