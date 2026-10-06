# Session: ws-g Observability — OpenTelemetry and MLflow 3

**Date:** 2026-08-18  
**Workstream:** ws-g  
**Status:** COMPLETE  
**Branch:** `mg-genie-hi-genie-r1-build`  
**Commit:** `5ba6bed`

## Summary

Implemented dual observability for the Hi Genie Orchestrator App in
`server/telemetry/`. The module instruments MCP request handling and downstream
Lakebase operations, propagates trace/request correlation, stores traces in
Unity Catalog via MLflow 3, and sanitizes sensitive data before export.

## Problems Solved

1. **No observability instrumentation** — the AppKit scaffold had a placeholder
   `setupTelemetry` function with no implementation.
2. **Sensitive data leakage risk** — OAuth tokens, PATs, auth headers, and SQL
   credentials could appear in trace exports without a sanitization boundary.
3. **Dual export requirement** — Decision 9 mandates both Databricks App OTel
   telemetry (to UC tables) and MLflow 3 traces (to UC experiment), with
   correlation between the two.
4. **Downstream instrumentation API** — other workstreams (ws-c MCP, ws-d API,
   ws-e dispatch, ws-f memory) need a clean interface for creating child spans
   without coupling to OTel internals.

## Root Causes / Design Constraints

- No Node.js MLflow SDK exists → MLflow integration via workspace REST API
  (`/api/2.0/mlflow/*`)
- Databricks App telemetry routes to UC tables via platform
  (`telemetry_export_destinations` in databricks.yml) — the module configures
  OTel SDK for auto-instrumentation, the platform handles the UC routing
- Module must initialize before all other modules (position #2 in
  `onPluginsReady` after migrations) so auto-instrumentation captures everything
- Graceful degradation required — telemetry failures must never crash the app

## Changes Made

### Files Created (4 files, 1,396 lines)

| File | Lines | Purpose |
| --- | --- | --- |
| `server/telemetry/index.ts` | 176 | Entry point (`setupTelemetry(appkit)`), barrel exports, shutdown hooks |
| `server/telemetry/otel-setup.ts` | 293 | NodeSDK config, auto-instrumentations (HTTP/Express/pg), BatchSpanProcessor, W3C propagator, conditional OTLP dual export, span limits |
| `server/telemetry/mlflow-tracer.ts` | 599 | MLflow 3 REST API integration, root SERVER spans, TOOL child spans, DB child spans, `createTracingMiddleware()`, `withToolSpan()`, `withDbSpan()` |
| `server/telemetry/sanitizer.ts` | 328 | Wrapping SpanProcessor: redacts OAuth/bearer tokens, PATs, JWTs, auth headers, connection strings, sensitive SQL literals |

### Files Modified

| File | Change |
| --- | --- |
| `orchestration/state/workstream-ws-g-status.md` | NOT_STARTED → COMPLETE, downstream notes with full API docs |
| `orchestration/state/orchestration-status.md` | ws-g row COMPLETE, tick 9 logged, completed count 2→3 |

## Key Decisions

1. **MLflow via REST API** — no Node SDK; fire-and-forget async export to avoid
   impacting request latency.
2. **Sanitizer as decorator SpanProcessor** — wraps BatchSpanProcessor, applied
   before both OTLP and console exporters. All sensitive data is stripped before
   it leaves the process.
3. **Health check exclusion** — `/healthz` skipped from tracing to avoid noise.
4. **pg `enhancedDatabaseReporting: false`** — full SQL statements not captured
   by default (security, per Decision 12).
5. **Span attribute conventions documented** — `request_id`, `session_id`,
   `workstream_key`, `tool_name`, `user_identity`, `project_id`,
   `service.surface`, `span.type` standardized for all downstream modules.
6. **Independent module** — zero imports from mcp/, api/, dispatch/, or memory/.
   Loadable and testable in isolation.

## OTel Packages Required (not yet in package.json)

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

## Follow-Up Work

- **ws-c/ws-d/ws-e/ws-f:** Import `withToolSpan`/`withDbSpan` and wrap their
  respective operations.
- **package.json:** Add OTel dependencies listed above.
- **server.ts:** Uncomment `setupTelemetry(appkit)` import and invocation.
- **Trace cleanup job:** Implement scheduled deletion using
  `mlflow_trace_retention_days` DAB variable.
