/**
 * Supervisor API — Plan Routes
 *
 * Implements versioned /api/v1/plans endpoints:
 *   - POST /api/v1/plans         → Ingest a new plan
 *   - GET  /api/v1/plans/:planId → Retrieve plan with snapshots
 *   - POST /api/v1/plans/:planId/publish → Create immutable snapshot with content hash
 *   - POST /api/v1/plans/:planId/orchestrate → Create orchestration from snapshot
 *
 * Routes handle: input validation (Zod), identity extraction, response mapping.
 * Business logic lives in server/services/plans.service.ts.
 *
 * Architecture:
 *   - Decision 2: Append-first write model
 *   - Decision 7: Lakebase dispatch schema ownership
 *   - Decision 21: Immutable plan snapshots for review-gated lifecycle
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { ServiceResult } from '../../services/types.js';
import {
  createPlan as createPlanService,
  getPlan as getPlanService,
  publishPlan as publishPlanService,
  orchestratePlan as orchestratePlanService,
} from '../../services/plans.service.js';

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

export const CreatePlanSchema = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  source_ref: z.record(z.string(), z.unknown()).optional(),
});

export const PublishPlanSchema = z.object({
  content: z.record(z.string(), z.unknown()),
  workstream_count: z.number().int().min(0),
});

export const OrchestratePlanSchema = z.object({
  plan_snapshot_id: z.string().uuid().optional(), // Defaults to current_snapshot_id
  priority: z.number().int().min(0).max(100).default(50),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Re-export computeContentHash for backward compatibility
export { computeContentHash } from '../../services/plans.service.js';

function sendResult<T>(res: Response, result: ServiceResult<T>): void {
  if (!result.ok) {
    res.status(result.status).json({ error: result.error, message: result.message, details: result.details });
    return;
  }
  res.status(result.status).json(result.data);
}

/**
 * Reads the verified Databricks identity attached by the
 * `requireVerifiedIdentity` middleware (see ../middleware/identity.ts),
 * which runs on every /api/v1 request before any route handler.
 *
 * Fails closed: throws rather than falling back to a shared identity if
 * called on a request that somehow bypassed that middleware. This should
 * never happen in production — the middleware is mounted on all of
 * /api/v1 — but a route added without going through setupApiRoutes could
 * hit this, and failing loudly is safer than attributing the write to
 * a shared 'system' account.
 */
export function getUserIdentity(req: Request): string {
  const identity = req.verifiedIdentity;
  if (!identity) {
    throw new Error(
      'UNVERIFIED_IDENTITY: getUserIdentity was called on a request that did not pass through requireVerifiedIdentity middleware.',
    );
  }
  return identity;
}

// ─── Route Factory ───────────────────────────────────────────────────────────

export function createPlanRoutes(pool: Pool): Router {
  const router = Router();

  // ── POST /api/v1/plans — Ingest plan ────────────────────────────────────
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const parsed = CreatePlanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      return;
    }
    sendResult(res, await createPlanService(pool, getUserIdentity(req), parsed.data));
  });

  // ── GET /api/v1/plans/:planId — Retrieve plan with snapshots ────────────
  router.get('/:planId', async (req: Request, res: Response): Promise<void> => {
    sendResult(res, await getPlanService(pool, req.params.planId as string));
  });

  // ── POST /api/v1/plans/:planId/publish — Create immutable snapshot ──────
  router.post('/:planId/publish', async (req: Request, res: Response): Promise<void> => {
    const parsed = PublishPlanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      return;
    }
    sendResult(res, await publishPlanService(pool, getUserIdentity(req), req.params.planId as string, parsed.data));
  });

  // ── POST /api/v1/plans/:planId/orchestrate — Create orchestration ────
  router.post('/:planId/orchestrate', async (req: Request, res: Response): Promise<void> => {
    const parsed = OrchestratePlanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      return;
    }
    sendResult(res, await orchestratePlanService(pool, getUserIdentity(req), req.params.planId as string, parsed.data));
  });

  return router;
}
