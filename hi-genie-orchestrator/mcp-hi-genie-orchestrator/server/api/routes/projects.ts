/**
 * Supervisor API — Project Routes
 *
 * Implements versioned /api/v1/projects endpoints:
 *   - POST   /api/v1/projects                       → Create project
 *   - GET    /api/v1/projects/:projectId             → Get project
 *   - PATCH  /api/v1/projects/:projectId             → Update project (name, description, tags)
 *   - POST   /api/v1/projects/:projectId/archive     → Archive project
 *   - POST   /api/v1/projects/:projectId/unarchive   → Unarchive project
 *   - POST   /api/v1/projects/:projectId/transfer    → Transfer ownership
 *
 * These are REST API-only operations for the management UI. The MCP surface
 * exposes only create_project (architect persona). See migration 009 notes.
 *
 * Routes handle: input validation (Zod), identity extraction, response mapping.
 * Business logic lives in server/services/projects.service.ts.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { ServiceResult } from '../../services/types.js';
import { getUserIdentity } from './plans.js';
import {
  createProject,
  getProject,
  updateProject,
  archiveProject,
  unarchiveProject,
  transferOwnership,
} from '../../services/projects.service.js';

// ─── Zod Schemas ───────────────────────────────────────────────────────────────────

export const CreateProjectSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  tags: z.record(z.string(), z.unknown()).optional(),
});

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  tags: z.record(z.string(), z.unknown()).optional(),
}).refine(
  (data) => data.name !== undefined || data.description !== undefined || data.tags !== undefined,
  { message: 'At least one field (name, description, or tags) must be provided' },
);

export const TransferOwnershipSchema = z.object({
  new_owner: z.string().min(1),
});

// ─── Helpers ───────────────────────────────────────────────────────────────────────

function sendResult<T>(res: Response, result: ServiceResult<T>): void {
  if (!result.ok) {
    res.status(result.status).json({ error: result.error, message: result.message, details: result.details });
    return;
  }
  res.status(result.status).json(result.data);
}

// ─── Route Factory ──────────────────────────────────────────────────────────────────

export function createProjectRoutes(pool: Pool): Router {
  const router = Router();

  // ── POST /api/v1/projects — Create project ──────────────────────────────
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      return;
    }
    sendResult(res, await createProject(pool, getUserIdentity(req), parsed.data));
  });

  // ── GET /api/v1/projects/:projectId — Get project ────────────────────
  router.get('/:projectId', async (req: Request, res: Response): Promise<void> => {
    sendResult(res, await getProject(pool, req.params.projectId as string));
  });

  // ── PATCH /api/v1/projects/:projectId — Update project ─────────────────
  router.patch('/:projectId', async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      return;
    }
    sendResult(
      res,
      await updateProject(pool, getUserIdentity(req), req.params.projectId as string, parsed.data),
    );
  });

  // ── POST /api/v1/projects/:projectId/archive — Archive project ──────────
  router.post('/:projectId/archive', async (req: Request, res: Response): Promise<void> => {
    sendResult(
      res,
      await archiveProject(pool, getUserIdentity(req), req.params.projectId as string),
    );
  });

  // ── POST /api/v1/projects/:projectId/unarchive — Unarchive project ──────
  router.post('/:projectId/unarchive', async (req: Request, res: Response): Promise<void> => {
    sendResult(
      res,
      await unarchiveProject(pool, getUserIdentity(req), req.params.projectId as string),
    );
  });

  // ── POST /api/v1/projects/:projectId/transfer — Transfer ownership ──────
  router.post('/:projectId/transfer', async (req: Request, res: Response): Promise<void> => {
    const parsed = TransferOwnershipSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      return;
    }
    sendResult(
      res,
      await transferOwnership(
        pool,
        getUserIdentity(req),
        req.params.projectId as string,
        parsed.data,
      ),
    );
  });

  return router;
}
