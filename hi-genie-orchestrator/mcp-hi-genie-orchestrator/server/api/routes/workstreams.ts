/**
 * Supervisor API — Workstream Routes
 *
 * Implements versioned /api/v1 workstream endpoints:
 *   - POST /api/v1/orchestrations/:orchId/materialize              → Materialize workstreams from snapshot
 *   - GET  /api/v1/orchestrations/:orchId/workstreams              → List workstreams for orchestration
 *   - POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/dispatch → Trigger workstream execution
 *   - POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/retry    → Retry failed workstream
 *   - POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/pause    → Pause workstream
 *   - POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/unpause  → Unpause workstream
 *
 * Architecture:
 *   - Decision 2: Optimistic concurrency via version column
 *   - Decision 7: dispatch schema ownership
 *   - Decision 22: Dispatcher event triggering
 *   - Idempotency via (project_id, idempotency_key) constraint
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { ServiceResult } from '../../services/types.js';
import {
  materializeWorkstreams as materializeService,
  listWorkstreams as listService,
  dispatchWorkstream as dispatchService,
  retryWorkstream as retryService,
  pauseWorkstream as pauseService,
  unpauseWorkstream as unpauseService,
} from '../../services/orchestration.service.js';
import { getUserIdentity } from './plans.js';

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

export const MaterializeSchema = z.object({
  plan_snapshot_id: z.string().uuid(),
  priority: z.number().int().min(0).max(100).optional().default(50),
  correlation_id: z.string().uuid().optional(),
  configuration_version: z.string().optional().default('1.0.0'),
});

export const DispatchSchema = z.object({
  // worker_identity is now optional: if omitted, defaults to the authenticated
  // caller's identity (from x-forwarded-user header). The RLS INSERT policy on
  // dispatch.executions enforces worker_identity = app.user_identity anyway,
  // so an explicit value that differs from the caller would be rejected with 403.
  worker_identity: z.string().min(1).optional(),
  correlation_id: z.string().uuid().optional(),
});

export const RetrySchema = z.object({
  reason: z.string().min(1).max(1000),
  correlation_id: z.string().uuid().optional(),
});

export const PauseSchema = z.object({
  reason: z.string().min(1).max(1000).optional(),
});

// ─── Valid Status Transitions ────────────────────────────────────────────────

// Re-export status transitions from service for backward compatibility
export { DISPATCH_FROM, RETRY_FROM, PAUSE_FROM, UNPAUSE_FROM } from '../../services/orchestration.service.js';

function sendResult<T>(res: Response, result: ServiceResult<T>): void {
  if (!result.ok) {
    res.status(result.status).json({ error: result.error, message: result.message, details: result.details });
    return;
  }
  res.status(result.status).json(result.data);
}

// ─── Route Factory ───────────────────────────────────────────────────────────

export function createWorkstreamRoutes(pool: Pool): Router {
  const router = Router();

  // ── POST /api/v1/orchestrations/:orchId/materialize ───────────────────
  router.post('/orchestrations/:orchId/materialize', async (req: Request, res: Response): Promise<void> => {
    const parsed = MaterializeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      return;
    }
    sendResult(res, await materializeService(pool, getUserIdentity(req), req.params.orchId as string, parsed.data));
  });

  // ── GET /api/v1/orchestrations/:orchId/workstreams ─────────────────────
  router.get('/orchestrations/:orchId/workstreams', async (req: Request, res: Response): Promise<void> => {
    sendResult(res, await listService(pool, req.params.orchId as string));
  });

  // ── POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/dispatch ────
  router.post('/orchestrations/:orchId/workstreams/:wsKey/dispatch', async (req: Request, res: Response): Promise<void> => {
    const parsed = DispatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      return;
    }
    sendResult(res, await dispatchService(pool, getUserIdentity(req), req.params.orchId as string, req.params.wsKey as string, parsed.data));
  });

  // ── POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/retry ───────
  router.post('/orchestrations/:orchId/workstreams/:wsKey/retry', async (req: Request, res: Response): Promise<void> => {
    const parsed = RetrySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      return;
    }
    sendResult(res, await retryService(pool, getUserIdentity(req), req.params.orchId as string, req.params.wsKey as string, parsed.data));
  });

  // ── POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/pause ───────
  router.post('/orchestrations/:orchId/workstreams/:wsKey/pause', async (req: Request, res: Response): Promise<void> => {
    const parsed = PauseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      return;
    }
    sendResult(res, await pauseService(pool, getUserIdentity(req), req.params.orchId as string, req.params.wsKey as string, parsed.data));
  });

  // ── POST /api/v1/orchestrations/:orchId/workstreams/:wsKey/unpause ─────
  router.post('/orchestrations/:orchId/workstreams/:wsKey/unpause', async (req: Request, res: Response): Promise<void> => {
    sendResult(res, await unpauseService(pool, getUserIdentity(req), req.params.orchId as string, req.params.wsKey as string));
  });

  return router;
}
