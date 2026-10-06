/**
 * Hi Genie Orchestrator — App Entry Point
 *
 * Creates the AppKit application with the Lakebase plugin for durable
 * orchestration state. Exposes:
 *   - /healthz    → Health check
 *   - Lakebase migrations (applied on startup)
 *
 * Module enablement (incremental — each deployed and verified stable):
 *   - [x] ws-b: migrations (runMigrations)
 *   - [ ] ws-g: Telemetry instrumentation (setupTelemetry)
 *   - [ ] ws-f: Memory service (setupMemory)
 *   - [ ] ws-e: Dispatch engine (setupDispatch)
 *   - [ ] ws-c: MCP tools (setupMcpRoutes)
 *   - [ ] ws-d: Supervisor API (setupApiRoutes)
 */

import { createApp, lakebase, server } from '@databricks/appkit';
import { runMigrations } from './migrations/index.js';

const PORT = parseInt(process.env['PORT'] ?? '8080', 10);

createApp({
  plugins: [
    server({ port: PORT }),
    lakebase(),
  ],

  async onPluginsReady(appkit) {
    // ── Migrations (ws-b) ─────────────────────────────────────────────────
    // Must run BEFORE any module that queries dispatch/state/memory schemas.
    await runMigrations(appkit.lakebase);

    // ── Telemetry (ws-g) — ENABLED ──────────────────────────────────────
    const { setupTelemetry } = await import('./telemetry/index.js');
    await setupTelemetry(appkit);

    // ── Memory (ws-f) — ENABLED ──────────────────────────────────────────────
    const { setupMemory } = await import('./memory/index.js');
    await setupMemory(appkit);

    // ── Dispatch (ws-e) — ENABLED ────────────────────────────────────────
    const { setupDispatch } = await import('./dispatch/index.js');
    await setupDispatch(appkit);

    // ── MCP (ws-c) — ENABLED ─────────────────────────────────────────────
    const { setupMcpRoutes } = await import('./mcp/index.js');
    await setupMcpRoutes(appkit);

    // ── Supervisor API (ws-d) — ENABLED ──────────────────────────────────
    const { setupApiRoutes } = await import('./api/index.js');
    await setupApiRoutes(appkit);

    // ── Health check ─────────────────────────────────────────────────────
    // NOTE: /healthz is intercepted by the platform's liveness probe (returns
    // empty 200). Use /api/health for our custom status with module details.
    appkit.server.extend((app) => {
      app.get('/api/health', (_req, res) => {
        res.status(200).json({
          status: 'ok',
          service: 'mcp-hi-genie-orchestrator',
          version: '1.1.0',
          timestamp: new Date().toISOString(),
          modules: {
            migrations: true,
            telemetry: true,
            memory: true,
            dispatch: true,
            mcp: true,
            api: true,
          },
        });
      });
    });

    // ── Graceful shutdown ─────────────────────────────────────────────────
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[shutdown] Received ${signal}, shutting down gracefully...`);

      try {
        await appkit.lakebase.pool.end();
        console.log('[shutdown] Lakebase pool closed.');
      } catch (err) {
        console.error('[shutdown] Lakebase shutdown error:', err);
      }

      console.log('[shutdown] Clean exit.');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    console.log(`[startup] Hi Genie Orchestrator ready on port ${PORT}`);
  },
}).catch((err) => {
  console.error('[fatal] App failed to start:', err);
  process.exit(1);
});
