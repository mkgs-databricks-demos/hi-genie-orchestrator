# Session: ws-a App Bundle Scaffold

**Date:** 2026-08-18  
**Workstream:** ws-a  
**Duration:** ~5 minutes  
**Status:** COMPLETE (attempt 1)  
**Branch:** `mg-genie-hi-genie-r1-build`

## Summary

Scaffolded the `mcp-hi-genie-orchestrator/` Databricks App bundle using AppKit
with the Lakebase plugin. All files were created in a prior orchestration tick
and verified in-place during this session. The workstream was claimed, validated,
and marked COMPLETE with comprehensive downstream notes.

## Problems Encountered

1. **Files already existed** — a prior tick had created all scaffold files before
   the status was properly claimed. This is benign; the content was correct and
   complete.

## Root Causes

- Tick 6 dispatched ws-a's worker task prematurely (stale cache showed ws-a as
  COMPLETE before it actually was). The worker self-gated on the first attempt
  but left artifacts from an earlier partial run.

## Changes Made

No file content was modified — all scaffold files were verified in-place.
Only the status file was updated (NOT_STARTED → IN_PROGRESS → COMPLETE).

## Decisions

1. **AppKit 0.61.1** — latest stable at time of scaffold; matches monorepo HEAD.
2. **drizzle-orm ^0.38.0** — chosen for type-safe Lakebase queries; drizzle-kit
   for migration generation in ws-b.
3. **No client build tooling** — `client/` is a placeholder for Release 1.1 UI;
   no Vite/React deps until then.
4. **tsdown for server bundling** — consistent with lakeloom-ai pattern.
5. **Single tsconfig.json** — server-only until client is added.
6. **Lakebase + Server plugins only** — no analytics, files, genie, or serving
   plugins needed for the orchestrator.

## Files Verified

All paths relative to `mcp-hi-genie-orchestrator/`:

| File | Purpose |
| --- | --- |
| `databricks.yml` | Bundle manifest: app resource, Lakebase, OTel, 3 targets |
| `app.yaml` | Runtime config: command, env vars, Lakebase endpoint |
| `package.json` | Node deps: AppKit, drizzle-orm, zod, uuid, TS toolchain |
| `tsconfig.json` | Strict ESNext, bundler moduleResolution |
| `appkit.plugins.json` | Plugin registry: lakebase + server |
| `server/server.ts` | Entry point: createApp, lakebase(), server(), healthz |
| `server/migrations/.gitkeep` | Placeholder for ws-b |
| `server/mcp/index.ts` | Placeholder for ws-c |
| `server/api/index.ts` | Placeholder for ws-d |
| `server/dispatch/index.ts` | Placeholder for ws-e |
| `server/memory/index.ts` | Placeholder for ws-f |
| `server/telemetry/index.ts` | Placeholder for ws-g |
| `client/.gitkeep` | Placeholder for Release 1.1 UI |
| `config/.gitkeep` | Placeholder for runtime policy config |

## Key Patterns for Downstream

- **Module registration:** Uncomment import + invocation in `server/server.ts`
  `onPluginsReady`. Each module receives the `appkit` context object.
- **Lakebase access:** `appkit.lakebase.pool` (connection pool),
  `appkit.lakebase` (client with OAuth refresh).
- **Health check:** `/healthz` already wired; downstream can extend.
- **Graceful shutdown:** SIGTERM/SIGINT handler closes pool; downstream modules
  should register their own cleanup before the pool close.
- **Variable inheritance:** All infra-derived values passed by deploy.sh as
  `--var` overrides; target defaults allow standalone `databricks bundle validate`.
