# 2026-08-19 — Full Module Reactivation

**Branch:** `mg-genie-server-modules-r1`
**Deployment:** `01f19bc711181874ad6344d85a552e95` (SUCCEEDED)

## Summary

Enabled all 5 server modules (telemetry, memory, dispatch, MCP, API) in a single session. Resolved build-blocking TypeScript errors and deployed successfully. All modules initialize at runtime with graceful degradation for missing credentials/env vars.

## Problem

Modules were disabled in `server.ts` behind comments after the initial scaffold deployment. Enabling them introduced TypeScript build errors due to:
1. Zod 4 breaking change (`z.record()` requires 2 args)
2. OpenTelemetry semantic convention renames (`ATTR_DEPLOYMENT_ENVIRONMENT_NAME` → `SEMRESATTRS_DEPLOYMENT_ENVIRONMENT`)
3. pg instrumentation option rename (`addSqlCommenterComment` → `addSqlCommenterCommentToQueries`)
4. Type mismatches (`AppKit` vs `AppKitInstance`, implicit `any`, duplicate exports)

## Root Causes

| Error | Root Cause | Fix |
| --- | --- | --- |
| `TS2554` plans.ts L33,37 | Zod 4 requires `z.record(keySchema, valueSchema)` | `z.record(z.unknown())` → `z.record(z.string(), z.unknown())` |
| `TS2724` otel-setup.ts | `@opentelemetry/semantic-conventions` v1.28 renamed exports | Used `SEMRESATTRS_DEPLOYMENT_ENVIRONMENT` |
| `TS2322`/`TS2339` mlflow-tracer.ts | Return type `Record<string, unknown>` blocked property access | Changed to `Promise<any>` |
| `TS7006` telemetry/index.ts | Implicit `any` on Express app param | Typed as `AppKitInstance['server']['app']` |
| `TS2484` mlflow-tracer.ts | Duplicate type export conflicting with barrel | Commented out line 599 |
| `TS2484` otel-setup.ts | Duplicate `export type { OtelConfig }` | Removed (barrel handles it) |

## Changes Made

| File | Change |
| --- | --- |
| `tsconfig.server.json` | Added all module dirs to `include`: telemetry, memory, dispatch, mcp, api |
| `server/server.ts` | Enabled all 5 dynamic imports + updated health check module flags |
| `server/telemetry/index.ts` | Fixed `AppKitInstance` type, typed Express app param |
| `server/telemetry/otel-setup.ts` | Fixed semantic convention constant, pg option name, removed duplicate export |
| `server/telemetry/mlflow-tracer.ts` | Changed return type to `any`, removed duplicate type export |
| `server/api/routes/plans.ts` | `z.record(z.unknown())` → `z.record(z.string(), z.unknown())` (2 occurrences) |

## Runtime Status (Post-Deploy)

All modules load without crashing. Non-fatal warnings:

| Module | Issue | Impact |
| --- | --- | --- |
| Telemetry/OTel | Duplicate API registration (trace, context, propagation) | Non-fatal — AppKit registers first, ours is skipped |
| Telemetry/MLflow | `TypeError: Invalid URL` — host missing `https://` prefix | MLflow tracer disabled, falls back to OTel-only |
| Memory | Embedding service not started (missing `DATABRICKS_HOST` env) | Semantic search disabled, short-term/episodic still work |
| Dispatch/Listener | `syntax error at or near "$"` — parameterized LISTEN/NOTIFY | Falls back to tick-only mode (60s polling) |
| Dispatch/Tick | `column o.id does not exist` — schema mismatch | Initial tick fails, subsequent ticks may also fail |

## Decisions

1. **All-at-once enablement** — modules were already authored and typed; incremental would have been slower than fixing all TS errors in one pass.
2. **Graceful degradation accepted** — runtime warnings are not blocking; the app serves health checks and MCP tools. Fix in follow-up session.
3. **Zod 4 migration** — only `plans.ts` used single-arg `z.record()`. Other files already had the two-arg form.

## Next Steps (Runtime Fixes)

1. **MLflow tracer URL** — `mlflow-tracer.ts` constructs URL without protocol prefix. Need to prepend `https://` to `DATABRICKS_HOST` or use `appkit.config` host.
2. **Dispatch LISTEN/NOTIFY** — `listener.ts` uses `$1`-style parameterized queries in `LISTEN` commands (not supported by PG protocol for utility statements). Switch to string interpolation with sanitization.
3. **Dispatch tick-evaluator** — SQL references `o.id` but the actual column may be `o.workstream_id` or similar after migration 001 schema. Verify against migration DDL.
4. **Memory embeddings** — needs `DATABRICKS_HOST` and `EMBEDDING_ENDPOINT_NAME` env vars in `app.yaml` resources definition.
5. **OTel duplicate registration** — guard `sdk.start()` with a check for existing global tracer provider, or skip our SDK init if AppKit already provides one.
