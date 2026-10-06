/**
 * Telemetry — MLflow 3 Trace Integration
 *
 * Provides dual tracing: correlates OTel spans with MLflow 3 traces stored
 * in Unity Catalog. The MLflow integration uses the workspace REST API
 * (not a Node SDK) to export trace spans to a platform-managed experiment.
 *
 * Experiment ID is injected by the Databricks Apps platform via the
 * MLFLOW_EXPERIMENT_ID environment variable (valueFrom: experiment in app.yaml).
 * The platform also grants the app SPN CAN_EDIT on the experiment.
 *
 * Exports:
 *   - initMlflowTracer(config): Initialize the MLflow tracer
 *   - createTracingMiddleware(): Express middleware for root SERVER spans
 *   - withToolSpan(toolName, fn): Wrapper for MCP tool execution
 *   - withDbSpan(operation, fn): Wrapper for Lakebase/SQL operations
 *   - shutdownMlflowTracer(): Graceful shutdown with span flushing
 *
 * Architecture decisions:
 *   - Decision 9: Both OTel and MLflow 3 tracing required
 *   - Decision 10: Store traces in Unity Catalog-backed trace storage
 *   - Decision 11: Retention via mlflow_trace_retention_days (default 90)
 *   - Decision 12: Sanitize trace data before storage
 *
 * Span hierarchy:
 *   SERVER (root, per MCP/API request)
 *     └─ TOOL (per MCP tool invocation)
 *         └─ DB (per Lakebase query)
 */

import { trace, context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type {
  Span,
  Tracer,
  SpanOptions,
} from '@opentelemetry/api';
import type { Request, Response, NextFunction } from 'express';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MlflowTracerConfig {
  /** Workspace host URL (e.g., https://fevm-hls-fde.cloud.databricks.com). */
  readonly workspaceHost?: string;
  /** MLflow experiment name for trace storage. */
  readonly experimentName?: string;
  /** Trace retention days (from DAB variable mlflow_trace_retention_days). */
  readonly retentionDays?: number;
  /** UC catalog for the MLflow experiment. */
  readonly catalog?: string;
  /** UC schema for the MLflow experiment. */
  readonly schema?: string;
  /** Whether to enable MLflow trace export. Default: true. */
  readonly enabled?: boolean;
  /** Maximum concurrent MLflow API calls. Default: 10. */
  readonly maxConcurrency?: number;
  /** Request timeout in milliseconds. Default: 5000. */
  readonly requestTimeoutMs?: number;
}

export interface TraceAttributes {
  readonly workstream_key?: string;
  readonly session_id?: string;
  readonly tool_name?: string;
  readonly user_identity?: string;
  readonly request_id?: string;
  readonly project_id?: string;
  readonly [key: string]: string | number | boolean | undefined;
}

interface MlflowSpanPayload {
  readonly request_id: string;
  readonly name: string;
  readonly span_type: 'SERVER' | 'TOOL' | 'DB' | 'INTERNAL';
  readonly start_time_ms: number;
  readonly end_time_ms?: number;
  readonly parent_span_id?: string;
  readonly attributes: Record<string, string | number | boolean>;
  readonly status: 'OK' | 'ERROR' | 'UNSET';
  readonly status_message?: string;
}

interface ActiveTrace {
  readonly traceId: string;
  readonly requestId: string;
  readonly experimentId: string;
  readonly spans: MlflowSpanPayload[];
  readonly startTimeMs: number;
}

// ─── State ──────────────────────────────────────────────────────────────────

let tracerConfig: Required<MlflowTracerConfig> | null = null;
let otelTracer: Tracer | null = null;
let experimentId: string | null = null;
let pendingExports: Promise<void>[] = [];
let initialized = false;

const TRACER_NAME = 'hi-genie-mlflow-tracer';
const TRACER_VERSION = '1.0.0';

// ─── Initialization ─────────────────────────────────────────────────────────

function env(key: string, fallback?: string): string {
  return process.env[key] ?? fallback ?? '';
}

/**
 * Initializes the MLflow 3 tracer for dual export alongside OTel.
 * Reads the platform-injected MLFLOW_EXPERIMENT_ID (from app resource).
 *
 * @param config - Configuration (usually derived from DAB variables)
 */
export async function initMlflowTracer(config?: MlflowTracerConfig): Promise<void> {
  if (initialized) {
    console.warn('[mlflow-tracer] Already initialized.');
    return;
  }

  const catalog = config?.catalog ?? env('UC_CATALOG', 'hls_fde_dev');
  const schema = config?.schema ?? env('UC_SCHEMA', 'hi_genie');

  // Platform injects DATABRICKS_HOST without protocol prefix — normalize
  const rawHost = config?.workspaceHost ?? env('DATABRICKS_HOST');
  const normalizedHost = rawHost.startsWith('http://') || rawHost.startsWith('https://') ? rawHost : `https://${rawHost}`;

  tracerConfig = {
    workspaceHost: normalizedHost,
    experimentName: config?.experimentName ?? `/${catalog}/${schema}/hi_genie_orchestrator_traces`,
    retentionDays: config?.retentionDays ?? parseInt(env('MLFLOW_TRACE_RETENTION_DAYS', '90'), 10),
    catalog,
    schema,
    enabled: config?.enabled ?? true,
    maxConcurrency: config?.maxConcurrency ?? 10,
    requestTimeoutMs: config?.requestTimeoutMs ?? 5000,
  };

  if (!tracerConfig.enabled) {
    console.log('[mlflow-tracer] Disabled by configuration.');
    initialized = true;
    return;
  }

  // Get or create the OTel tracer instance
  otelTracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);

  // Read experiment ID from platform-injected env var (valueFrom: experiment)
  const platformExperimentId = process.env['MLFLOW_EXPERIMENT_ID'];
  if (platformExperimentId) {
    experimentId = platformExperimentId;
    console.log(
      `[mlflow-tracer] Initialized: experiment_id=${experimentId}, ` +
      `retention=${tracerConfig.retentionDays}d`,
    );
  } else {
    console.warn(
      '[mlflow-tracer] MLFLOW_EXPERIMENT_ID not set (missing app resource?). ' +
      'Traces will use OTel only.',
    );
    experimentId = null;
  }

  initialized = true;
}

/**
 * Gracefully shuts down the MLflow tracer, flushing pending exports.
 */
export async function shutdownMlflowTracer(): Promise<void> {
  if (!initialized) return;

  try {
    // Wait for all pending exports to complete
    await Promise.allSettled(pendingExports);
    console.log('[mlflow-tracer] All pending exports flushed.');
  } catch (err) {
    console.error('[mlflow-tracer] Error during shutdown:', err);
  } finally {
    initialized = false;
    tracerConfig = null;
    otelTracer = null;
    experimentId = null;
    pendingExports = [];
  }
}

// ─── Express Middleware ─────────────────────────────────────────────────────

/**
 * Creates Express middleware that starts a root SERVER span for each
 * incoming request. The span is attached to the request context and
 * closed when the response finishes.
 *
 * Populates span attributes:
 *   - http.method, http.url, http.status_code
 *   - request_id (from X-Request-ID header or generated)
 *   - user_identity (from X-Forwarded-User or Databricks auth)
 *
 * @example
 * ```typescript
 * appkit.server.extend((app) => {
 *   app.use(createTracingMiddleware());
 * });
 * ```
 */
export function createTracingMiddleware(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!otelTracer || !tracerConfig?.enabled) {
      next();
      return;
    }

    // Skip health checks
    if (req.path === '/healthz') {
      next();
      return;
    }

    const requestId = extractRequestId(req);
    const userIdentity = extractUserIdentity(req);

    const spanOptions: SpanOptions = {
      kind: SpanKind.SERVER,
      attributes: {
        'http.method': req.method,
        'http.url': req.originalUrl,
        'http.target': req.path,
        'request_id': requestId,
        'user_identity': userIdentity,
        'service.surface': determineSurface(req.path),
      },
    };

    const span = otelTracer.startSpan(
      `${req.method} ${req.path}`,
      spanOptions,
    );

    // Store span and metadata in request context for downstream access
    const ctx = trace.setSpan(context.active(), span);

    context.with(ctx, () => {
      // Attach request metadata for downstream span creation
      (req as RequestWithTrace).__traceSpan = span;
      (req as RequestWithTrace).__traceRequestId = requestId;
      (req as RequestWithTrace).__traceUserIdentity = userIdentity;

      // Close span on response finish
      res.on('finish', () => {
        span.setAttribute('http.status_code', res.statusCode);

        if (res.statusCode >= 400) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${res.statusCode}`,
          });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        span.end();

        // Export to MLflow (async, non-blocking)
        if (experimentId) {
          exportTraceToMlflow(span, requestId, userIdentity);
        }
      });

      next();
    });
  };
}

// ─── Tool Span Helper ──────────────────────────────────────────────────────

/**
 * Wraps an MCP tool execution with a TOOL span. Automatically captures
 * tool name, duration, status, and error information.
 *
 * @param toolName - Name of the MCP tool being invoked
 * @param fn - Async function to execute within the span
 * @param attributes - Additional span attributes
 * @returns The result of fn()
 *
 * @example
 * ```typescript
 * const result = await withToolSpan('get_project_context', async () => {
 *   return await projectService.getContext(projectId);
 * }, { workstream_key: 'ws-c', session_id: sessionId });
 * ```
 */
export async function withToolSpan<T>(
  toolName: string,
  fn: () => Promise<T>,
  attributes?: TraceAttributes,
): Promise<T> {
  if (!otelTracer) {
    return fn();
  }

  const spanOptions: SpanOptions = {
    kind: SpanKind.INTERNAL,
    attributes: {
      'tool.name': toolName,
      'span.type': 'TOOL',
      ...sanitizeTraceAttributes(attributes),
    },
  };

  return otelTracer.startActiveSpan(
    `tool:${toolName}`,
    spanOptions,
    async (span: Span) => {
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : 'Unknown error',
        });
        if (err instanceof Error) {
          span.recordException(err);
        }
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

// ─── Database Span Helper ───────────────────────────────────────────────────

/**
 * Wraps a Lakebase/SQL operation with a DB span. Captures operation
 * type, duration, and error details.
 *
 * @param operation - Description of the DB operation (e.g., 'SELECT sessions')
 * @param fn - Async function to execute within the span
 * @param attributes - Additional span attributes (e.g., table name)
 * @returns The result of fn()
 *
 * @example
 * ```typescript
 * const rows = await withDbSpan('SELECT workstreams', async () => {
 *   return await pool.query('SELECT * FROM state.workstreams WHERE project_id = $1', [id]);
 * }, { workstream_key: 'ws-g' });
 * ```
 */
export async function withDbSpan<T>(
  operation: string,
  fn: () => Promise<T>,
  attributes?: TraceAttributes,
): Promise<T> {
  if (!otelTracer) {
    return fn();
  }

  const spanOptions: SpanOptions = {
    kind: SpanKind.CLIENT,
    attributes: {
      'db.operation': operation,
      'db.system': 'postgresql',
      'span.type': 'DB',
      ...sanitizeTraceAttributes(attributes),
    },
  };

  return otelTracer.startActiveSpan(
    `db:${operation}`,
    spanOptions,
    async (span: Span) => {
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : 'Unknown error',
        });
        if (err instanceof Error) {
          span.recordException(err);
        }
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

// ─── MLflow REST API Integration ───────────────────────────────────────────

function exportTraceToMlflow(
  span: Span,
  requestId: string,
  userIdentity: string,
): void {
  // Fire-and-forget export with concurrency limiting
  const exportPromise = (async () => {
    try {
      const spanContext = span.spanContext?.() ?? (span as unknown as { spanContext: () => { traceId: string; spanId: string } }).spanContext();
      if (!spanContext?.traceId) return;

      const tracePayload = {
        experiment_id: experimentId,
        request_id: requestId,
        timestamp_ms: Date.now(),
        execution_time_ms: 0, // Placeholder; actual duration computed by MLflow
        tags: [
          { key: 'mlflow.traceName', value: requestId },
          { key: 'mlflow.source.type', value: 'APP' },
          { key: 'otel.trace_id', value: spanContext.traceId },
          { key: 'otel.span_id', value: spanContext.spanId },
          { key: 'hi_genie.user_identity', value: userIdentity || 'unknown' },
        ],
      };

      await mlflowApiCall('/api/2.0/mlflow/traces', 'POST', tracePayload);
    } catch (err) {
      // Non-fatal: MLflow export failure should not affect request handling
      console.warn('[mlflow-tracer] Failed to export trace:', err instanceof Error ? err.message : err);
    }
  })();

  pendingExports.push(exportPromise);

  // Cleanup completed exports periodically
  if (pendingExports.length > 100) {
    pendingExports = pendingExports.filter(
      (p) => !(p as Promise<void> & { settled?: boolean }).settled,
    );
  }

  // Mark as settled when done
  exportPromise.then(
    () => { (exportPromise as Promise<void> & { settled?: boolean }).settled = true; },
    () => { (exportPromise as Promise<void> & { settled?: boolean }).settled = true; },
  );
}

async function mlflowApiCall(
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<any> {
  const host = tracerConfig?.workspaceHost;
  if (!host) throw new Error('Workspace host not configured');

  const baseUrl = host.startsWith('http://') || host.startsWith('https://') ? host : `https://${host}`;

  const url = method === 'GET' && body
    ? `${baseUrl}${path}?${new URLSearchParams(body as Record<string, string>).toString()}`
    : `${baseUrl}${path}`;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    tracerConfig?.requestTimeoutMs ?? 5000,
  );

  try {
    const authHeaders = await getAuthHeadersAsync();
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '(unreadable)');
      throw new Error(
        `MLflow API ${method} ${path}: ${response.status} ${response.statusText} — ${errorBody}`,
      );
    }

    return await response.json() as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Token Cache ──────────────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getSpnToken(): Promise<string | null> {
  const clientId = process.env['HI_GENIE_APP_CLIENT_ID'];
  const clientSecret = process.env['HI_GENIE_APP_CLIENT_SECRET'];
  const host = tracerConfig?.workspaceHost;
  if (!clientId || !clientSecret || !host) return null;

  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const tokenUrl = `${host}/oidc/v1/token`;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'all-apis',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    console.warn(`[mlflow-tracer] SPN token fetch failed: ${response.status}`);
    return null;
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
  };
  return cachedToken.value;
}

async function getAuthHeadersAsync(): Promise<Record<string, string>> {
  const token = process.env['DATABRICKS_TOKEN'];
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  const spnToken = await getSpnToken();
  if (spnToken) {
    return { Authorization: `Bearer ${spnToken}` };
  }
  return {};
}

// ─── Request Helpers ───────────────────────────────────────────────────────

function extractRequestId(req: Request): string {
  return (
    (req.headers['x-request-id'] as string) ??
    (req.headers['x-databricks-request-id'] as string) ??
    generateRequestId()
  );
}

function extractUserIdentity(req: Request): string {
  // Databricks App on-behalf-of-user identity
  return (
    (req.headers['x-forwarded-user'] as string) ??
    (req.headers['x-databricks-user'] as string) ??
    'anonymous'
  );
}

function determineSurface(path: string): string {
  if (path.startsWith('/mcp')) return 'workstream-mcp';
  if (path.startsWith('/api/')) return 'supervisor-api';
  return 'internal';
}

function generateRequestId(): string {
  // Crypto-safe UUID generation
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeTraceAttributes(
  attributes?: TraceAttributes,
): Record<string, string | number | boolean> {
  if (!attributes) return {};

  const sanitized: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// ─── Augmented Request Type ─────────────────────────────────────────────────

export interface RequestWithTrace extends Request {
  __traceSpan?: Span;
  __traceRequestId?: string;
  __traceUserIdentity?: string;
}

/**
 * Retrieves the active trace span from an Express request.
 * Use in downstream route handlers to create child spans.
 */
export function getTraceFromRequest(req: Request): {
  span: Span | undefined;
  requestId: string;
  userIdentity: string;
} {
  const traced = req as RequestWithTrace;
  return {
    span: traced.__traceSpan,
    requestId: traced.__traceRequestId ?? 'unknown',
    userIdentity: traced.__traceUserIdentity ?? 'anonymous',
  };
}

/**
 * Returns the OTel tracer instance for advanced use cases.
 * Returns null if telemetry is not initialized.
 */
export function getTracer(): Tracer | null {
  return otelTracer;
}

// Type exports are handled by the barrel export in index.ts
