---
workstream_key: ws-g
name: Observability
status: COMPLETE
depends_on: [ws-a]
scheduled_task_id: c31f0a560d864b83a4ac4bd8737690ff
task_paused: false
attempt_count: 1
max_retries: 5
started_at: "2026-08-17T23:45:00Z"
completed_at: "2026-08-17T23:55:00Z"
error_message: null
prior_error: null
last_attempt_at: "2026-08-17T23:45:00Z"
---

# Workstream ws-g: Observability — OpenTelemetry and MLflow 3

## Scope

Implement dual observability in `server/telemetry/`:
- OpenTelemetry: Databricks App telemetry, auto-instrumentation (HTTP, Express, pg)
- Trace/request correlation propagation across MCP/API boundaries
- MLflow 3: traces to Unity Catalog, root span per MCP request, TOOL child spans
- Dual export when OTLP endpoint configured
- Retention: configurable via DAB variable `mlflow_trace_retention_days` (default 90)
- Sanitization: strip tokens, secrets, auth headers, sensitive SQL literals
- Span attributes: workstream_key, session_id, tool_name, user_identity

## Notes for Downstream Sessions

### Files Created

All paths relative to `mcp-hi-genie-orchestrator/server/telemetry/`:

| File | Lines | Purpose |
| --- | --- | --- |
| `index.ts` | 176 | Module entry point, `setupTelemetry(appkit)`, barrel exports, shutdown hooks |
| `otel-setup.ts` | 293 | OTel NodeSDK config, auto-instrumentations (HTTP/Express/pg), BatchSpanProcessor, W3C propagator |
| `mlflow-tracer.ts` | 599 | MLflow 3 REST API integration, root/tool/db spans, Express middleware, span helpers |
| `sanitizer.ts` | 328 | SpanProcessor for redacting tokens, auth headers, SQL literals before export |

### Function Signatures for Downstream

```typescript
// Entry point (called in server.ts onPluginsReady)
export async function setupTelemetry(appkit: AppKit): Promise<void>;

// Express middleware — mount BEFORE route registration
export function createTracingMiddleware(): (req, res, next) => void;

// Wrap MCP tool execution with a TOOL span
export async function withToolSpan<T>(
  toolName: string,
  fn: () => Promise<T>,
  attributes?: TraceAttributes,
): Promise<T>;

// Wrap Lakebase/SQL operations with a DB span
export async function withDbSpan<T>(
  operation: string,
  fn: () => Promise<T>,
  attributes?: TraceAttributes,
): Promise<T>;

// Get trace context from an Express request
export function getTraceFromRequest(req: Request): {
  span: Span | undefined;
  requestId: string;
  userIdentity: string;
};

// Get the OTel tracer for advanced use
export function getTracer(): Tracer | null;

// Sanitizer factory (for custom processors)
export function createSanitizingProcessor(
  inner: SpanProcessor,
  options?: SanitizerOptions,
): SpanProcessor;
```

### Span Attribute Conventions

Downstream modules MUST use these attribute keys for correlation:

| Attribute | Type | Description |
| --- | --- | --- |
| `request_id` | string | Per-request UUID (from X-Request-ID header or generated) |
| `session_id` | string | MCP session identifier |
| `workstream_key` | string | Workstream identifier (e.g., `ws-c`) |
| `tool_name` | string | MCP tool name being invoked |
| `user_identity` | string | Pseudonymous user from X-Forwarded-User |
| `project_id` | string | Project scope for the operation |
| `service.surface` | string | `workstream-mcp` or `supervisor-api` or `internal` |
| `span.type` | string | `TOOL` or `DB` (set by helpers) |

### How to Create Child Spans

```typescript
import { withToolSpan, withDbSpan } from './telemetry/index';

// For MCP tool handlers:
const result = await withToolSpan('get_project_context', async () => {
  return await projectService.getContext(projectId);
}, { workstream_key: 'ws-c', session_id });

// For database operations:
const rows = await withDbSpan('SELECT sessions', async () => {
  return await pool.query(sql, params);
}, { workstream_key: 'ws-f' });
```

### OTel Packages Required

The following packages must be added to `package.json` dependencies:

```json
{
  "@opentelemetry/api": "^1.9.0",
  "@opentelemetry/sdk-node": "^0.57.0",
  "@opentelemetry/sdk-trace-base": "^1.30.0",
  "@opentelemetry/auto-instrumentations-node": "^0.56.0",
  "@opentelemetry/exporter-trace-otlp-http": "^0.57.0",
  "@opentelemetry/resources": "^1.30.0",
  "@opentelemetry/semantic-conventions": "^1.30.0",
  "@opentelemetry/core": "^1.30.0"
}
```

Downstream modules importing OTel types should use `@opentelemetry/api` (for `Span`, `Tracer`, `SpanKind`, etc.).

### Registration in server.ts

Uncomment in `server/server.ts`:
```typescript
import { setupTelemetry } from './telemetry/index';
// In onPluginsReady (BEFORE other modules):
await setupTelemetry(appkit);
```

### Environment Variables Consumed

| Variable | Required | Description |
| --- | --- | --- |
| `DATABRICKS_HOST` | Yes | Workspace URL for MLflow API calls |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | Enables dual OTLP export when set |
| `OTEL_SERVICE_NAME` | No | Override service name (default: `mcp-hi-genie-orchestrator`) |
| `UC_CATALOG` | No | UC catalog (default from DAB) |
| `UC_SCHEMA` | No | UC schema (default from DAB) |
| `MLFLOW_TRACE_RETENTION_DAYS` | No | Trace retention (default: 90) |
| `NODE_ENV` | No | Environment (affects console exporter and diag level) |
| `DATABRICKS_TOKEN` | No | Auth token for MLflow API (platform-injected in App) |

### Design Choices Made

- MLflow integration uses workspace REST API (`/api/2.0/mlflow/*`) — no Node.js MLflow SDK exists
- Sanitizer is a wrapping SpanProcessor (decorator pattern) — applied before both OTLP and console exporters
- Health check endpoint (`/healthz`) is excluded from tracing to avoid noise
- pg instrumentation has `enhancedDatabaseReporting: false` to avoid capturing full SQL (security)
- Trace export to MLflow is fire-and-forget (non-blocking) to avoid impacting request latency
- Graceful shutdown flushes OTel spans → MLflow pending exports → OTel SDK, in that order
- Module is independently loadable — zero imports from mcp/, api/, dispatch/, or memory/
