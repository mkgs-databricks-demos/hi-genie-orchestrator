/**
 * Telemetry — Module Entry Point
 *
 * Dual observability for the Hi Genie Orchestrator App:
 *   1. OpenTelemetry instrumentation (auto-instrumentation + manual spans)
 *   2. MLflow 3 trace export to Unity Catalog
 *
 * This module is loaded early in `onPluginsReady` (before dispatch/mcp/api)
 * so all downstream modules are instrumented.
 *
 * Usage in server.ts:
 * ```typescript
 * import { setupTelemetry } from './telemetry/index';
 * // In onPluginsReady:
 * await setupTelemetry(appkit);
 * ```
 *
 * Architecture decisions:
 *   - Decision 9: Both OTel and MLflow 3 tracing required
 *   - Decision 10: Store traces in UC-backed trace storage
 *   - Decision 11: Retention via mlflow_trace_retention_days
 *   - Decision 12: Sanitize before export
 */

// AppKit type not exported in 0.38.1 — use structural interface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AppKitInstance = any;

import { initializeOtelSdk, shutdownOtelSdk, flushOtelSpans } from './otel-setup.js';
import type { OtelConfig } from './otel-setup.js'; // re-exported for external consumers
import {
  initMlflowTracer,
  shutdownMlflowTracer,
  createTracingMiddleware,
  withToolSpan,
  withDbSpan,
  getTraceFromRequest,
  getTracer,
} from './mlflow-tracer.js';
import type { MlflowTracerConfig, TraceAttributes, RequestWithTrace } from './mlflow-tracer.js';
import { createSanitizingProcessor, sanitizeAttribute } from './sanitizer.js';
import type { SanitizerOptions } from './sanitizer.js';

// ─── Module Initialization ──────────────────────────────────────────────────

let telemetryInitialized = false;

/**
 * Initializes the full telemetry stack for the Hi Genie Orchestrator.
 *
 * Call order in onPluginsReady:
 *   1. setupTelemetry(appkit)   ← this function (ws-g)
 *   2. setupMemory(appkit)      ← ws-f
 *   3. setupDispatch(appkit)    ← ws-e
 *   4. MCP/API routes           ← ws-c, ws-d
 *
 * Telemetry MUST be initialized before other modules so that:
 *   - Auto-instrumentation captures all HTTP/Express/pg operations
 *   - The tracing middleware is available for route registration
 *   - Downstream modules can use withToolSpan/withDbSpan
 *
 * Graceful degradation: if OTel or MLflow initialization fails, the app
 * continues with reduced observability (warning logged, never crashes).
 *
 * @param appkit - The AppKit instance with server and lakebase plugins
 */
export async function setupTelemetry(appkit: AppKitInstance): Promise<void> {
  if (telemetryInitialized) {
    console.warn('[telemetry] Already initialized, skipping.');
    return;
  }

  console.log('[telemetry] Initializing dual observability...');

  // ── Step 1: Extend AppKit's OTel with custom processors + instrumentations
  try {
    initializeOtelSdk();
  } catch (err) {
    console.error(
      '[telemetry] OTel initialization failed (continuing with degraded observability):',
      err,
    );
  }

  // ── Step 2: Initialize MLflow 3 Tracer ────────────────────────────────
  try {
    const mlflowConfig: MlflowTracerConfig = {
      workspaceHost: process.env['DATABRICKS_HOST'],
      catalog: process.env['UC_CATALOG'],
      schema: process.env['UC_SCHEMA'],
      retentionDays: parseInt(
        process.env['MLFLOW_TRACE_RETENTION_DAYS'] ?? '90',
        10,
      ),
    };
    await initMlflowTracer(mlflowConfig);
  } catch (err) {
    console.error(
      '[telemetry] MLflow tracer initialization failed (continuing with OTel only):',
      err,
    );
  }

  // ── Step 3: Register tracing middleware on the Express app ─────────────
  try {
    appkit.server.extend((app: AppKitInstance['server']['app']) => {
      app.use(createTracingMiddleware());
    });
  } catch (err) {
    console.error(
      '[telemetry] Failed to register tracing middleware:',
      err,
    );
  }

  // ── Step 4: Register shutdown hooks ───────────────────────────────────
  registerShutdownHooks();

  telemetryInitialized = true;
  console.log('[telemetry] Dual observability initialized successfully.');
}

// ─── Shutdown ───────────────────────────────────────────────────────────────

let shutdownRegistered = false;

function registerShutdownHooks(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const gracefulShutdown = async (): Promise<void> => {
    console.log('[telemetry] Graceful shutdown: flushing spans...');
    try {
      // Flush OTel spans first (includes sanitized export)
      await flushOtelSpans();
      // Then shut down MLflow tracer (flushes pending API calls)
      await shutdownMlflowTracer();
      // Finally shut down OTel SDK
      await shutdownOtelSdk();
      console.log('[telemetry] Shutdown complete.');
    } catch (err) {
      console.error('[telemetry] Error during shutdown:', err);
    }
  };

  // Hook into process signals for clean shutdown
  process.on('SIGTERM', () => void gracefulShutdown());
  process.on('SIGINT', () => void gracefulShutdown());

  // Also handle beforeExit for unexpected shutdowns
  process.on('beforeExit', () => void gracefulShutdown());
}

// ─── Barrel Exports ─────────────────────────────────────────────────────────

// OTel SDK
export { initializeOtelSdk, shutdownOtelSdk, flushOtelSpans } from './otel-setup.js';
export type { OtelConfig } from './otel-setup.js';

// MLflow Tracer
export {
  initMlflowTracer,
  shutdownMlflowTracer,
  createTracingMiddleware,
  withToolSpan,
  withDbSpan,
  getTraceFromRequest,
  getTracer,
} from './mlflow-tracer.js';
export type { MlflowTracerConfig, TraceAttributes, RequestWithTrace } from './mlflow-tracer.js';

// Sanitizer
export { createSanitizingProcessor, sanitizeAttribute } from './sanitizer.js';
export type { SanitizerOptions } from './sanitizer.js';
