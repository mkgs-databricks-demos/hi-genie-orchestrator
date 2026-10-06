/**
 * Supervisor API — Versioned dispatch control-plane routes.
 *
 * Registers /api/v1 endpoints for:
 *   - Plan ingestion, validation, and immutable publication
 *   - Workstream materialization, dispatch, retry, pause/unpause
 *   - Review task creation, remediation delivery, completion approval
 *   - Skill content retrieval and interactive publishing
 *
 * Import pattern (server.ts):
 *   import { setupApiRoutes } from './api/index';
 *   await setupApiRoutes(appkit);
 *
 * Architecture:
 *   - Decision 5: /api/v1 prefix for Supervisor surface
 *   - Decision 7: dispatch schema ownership via pool
 *   - Decision 9: Telemetry spans for all route handlers
 */

import { json, type Express } from 'express';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AppKitInstance = any;
import { createPlanRoutes } from './routes/plans.js';
import { createWorkstreamRoutes } from './routes/workstreams.js';
import { createReviewRoutes } from './routes/reviews.js';
import { createMcpCatalogRoutes } from './routes/mcp-catalog.js';
import { createSkillRoutes } from './routes/skills.js';
import { createProjectRoutes } from './routes/projects.js';
import { requireVerifiedIdentity } from './middleware/identity.js';
import { setupDocs } from './docs.js';

/**
 * Registers all Supervisor API v1 routes on the AppKit Express server.
 *
 * Routes are mounted under /api/v1 with the following sub-routers:
 *   - /api/v1/plans/*          → Plan lifecycle
 *   - /api/v1/orchestrations/* → Orchestration/workstream operations
 *   - /api/v1/workstreams/*    → Workstream control (dispatch/retry/pause)
 *   - /api/v1/reviews/*        → Review lifecycle
 *
 * @param appkit - AppKit instance with server and lakebase plugins
 */
export async function setupApiRoutes(appkit: AppKitInstance): Promise<void> {
  const pool = appkit.lakebase.pool;

  // Create route sub-routers
  const planRoutes = createPlanRoutes(pool);
  const workstreamRoutes = createWorkstreamRoutes(pool);
  const reviewRoutes = createReviewRoutes(pool);
  const mcpCatalogRoutes = createMcpCatalogRoutes();
  const skillRoutes = createSkillRoutes(pool);
  const projectRoutes = createProjectRoutes(pool);

  // Register on Express via appkit.server.extend
  appkit.server.extend((app: Express) => {
    // ── Swagger UI (no auth, mounted before identity middleware) ────
    setupDocs(app);

    // JSON body parsing for API routes
    app.use('/api/v1', json({ limit: '2mb' }));

    // Fail-closed identity check — rejects any request without a verified
    // Databricks identity before it reaches a route handler (Phase 3 of
    // Polly review 001_release-1-readiness; replaces the previous silent
    // fallback to the shared 'system' identity).
    app.use('/api/v1', requireVerifiedIdentity);

    // Mount sub-routers
    app.use('/api/v1/plans', planRoutes);
    app.use('/api/v1', workstreamRoutes); // orchestrations + workstreams paths
    app.use('/api/v1/reviews', reviewRoutes);
    app.use('/api/v1/mcp', mcpCatalogRoutes);
    app.use('/api/v1/skills', skillRoutes);
    app.use('/api/v1/projects', projectRoutes);

    // Global error handler for API routes
    app.use('/api/v1', (err: Error, _req: unknown, res: any, _next: unknown) => {
      console.error('[api] Unhandled error:', err.message);
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      });
    });
  });

  console.log('[api] Supervisor API v1 routes registered.');
}

// Barrel exports for downstream consumption
export { createPlanRoutes } from './routes/plans.js';
export { createWorkstreamRoutes } from './routes/workstreams.js';
export { createReviewRoutes } from './routes/reviews.js';
export { createMcpCatalogRoutes } from './routes/mcp-catalog.js';
export { getUserIdentity } from './routes/plans.js';
export { createProjectRoutes } from './routes/projects.js';
export { setupDocs } from './docs.js';
export { openApiSpec } from './openapi.js';
