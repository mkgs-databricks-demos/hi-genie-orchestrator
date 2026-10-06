# Session: MCP Single-Connection Consolidation

**Date:** 2026-08-25  
**Branch:** `mg-genie-r2-mcp-consolidation`  
**Commit:** `009c250`  
**Bundle:** `mcp-hi-genie-orchestrator` (target: dev)  

## Problem

The architecture used 5 separate UC HTTP connections (one per persona: architect, reviewer, worker, dispatcher, orchestrator), each with a unique `base_path` (`/mcp/architect`, `/mcp/reviewer`, etc.). This meant:
- 5 connections to rotate credentials for
- 5 CREATE CONNECTION statements in deployment
- 10 GRANT statements (USE + CREATE FUNCTION per connection)
- Complex variable management in `databricks.yml` (5 connection name vars)
- App-level routing logic to separate persona endpoints

## Root Cause

The original split was driven by the UC MCP Service 20-tool-per-service limit. Each persona needed its own filtered view of the 39 total tools. The assumption was that the connection itself needed to be scoped — but UC MCP Services support `include_tool_selectors` which achieves tool scoping at the service level, not the connection level.

## Solution

Consolidate to **2 connections** (REST + single MCP) with per-persona tool scoping via `include_tool_selectors`:

| Connection | Purpose | base_path |
| --- | --- | --- |
| `hi_genie_orchestrator_conn_dev` | REST API (UC functions) | `/api` |
| `hi_genie_mcp_conn_dev` | All 39 MCP tools | `/mcp` |

Each of the 5 UC MCP Services references the same MCP connection but uses `include_tool_selectors` to expose only its persona's tools:
- **Architect** — 13 tools (plans, skills, decisions)
- **Reviewer** — 14 tools (reviews, quality gates, broad read)
- **Worker** — 17 tools (records, sessions, execution)
- **Dispatcher** — 16 tools (orchestration, lifecycle)
- **Orchestrator** — all 39 tools (empty selector)

## Changes Made

### `databricks.yml`
- Replaced 5 persona connection variables with single `mcp_connection_name` (default: `hi_genie_mcp_conn`)
- Dev target override: `mcp_connection_name: hi_genie_mcp_conn_dev`

### `resources/post_deploy.job.yml`
- `reset_connection` task: 5 DROP params → 2 (`connection_name` + `mcp_connection_name`)
- `create_app_connection` task: 5 CREATE params → 2
- `register_mcp_service` task: 5 connection params → 1 (`mcp_connection_name`)

### `src/deploy/create_app_connection.sql`
- Reduced from 5 CREATE CONNECTION statements to 2
- Reduced GRANT statements from 10 to 4
- Deleted 3 cells (reviewer, worker, dispatcher connection creation)

### `src/deploy/reset_connection.py`
- Simplified from 5 DROP statements to 2

### `src/deploy/register_mcp_service.py`
- Complete rewrite of registration logic
- Added `PERSONA_TOOL_SELECTORS` dict (YAML-driven tool lists per persona)
- All services reference single `mcp_connection_name`
- Detects selector drift on PATCH (connection mismatch, selector changes)
- New cell: exponential-backoff polling for async tool discovery (2s→15s, 120s timeout)
- Comprehensive verification summary cell

## Deployment Status

- **Bundle deployed:** `bundle deploy --target dev` — 1 job updated
- **Post-deploy run:** FAILED (task `create_app_connection`)
  - Error: `${mcp_connection_name}` widget resolved to empty string
  - Root cause: Job was running stale config (pre-refactor parameters)
  - Fix: Re-deployed bundle to push new job definition (this session)
- **New connection `hi_genie_mcp_conn_dev`:** NOT YET CREATED (awaiting successful post-deploy run)

## Cleanup Completed

6 stale connections deleted:
- `hi_genie_architect_mcp_conn_dev`
- `hi_genie_reviewer_mcp_conn_dev`
- `hi_genie_worker_mcp_conn_dev`
- `hi_genie_dispatcher_mcp_conn_dev`
- `hi_genie_orchestrator_mcp_conn_dev`
- `hi_genie_supervisor_mcp_conn_dev`

2 connections retained:
- `hi_genie_orchestrator_conn_dev` (REST, existing)
- `hi_genie_orchestrator_conn` (REST, non-dev)

## Next Steps

1. Run `bundle run post_deploy --target dev --params first_run=true` — creates `hi_genie_mcp_conn_dev` and registers services with new selectors
2. Validate tool discovery counts match expected per persona
3. Test in AI Playground: confirm persona-filtered tool lists
4. PR merge `mg-genie-r2-mcp-consolidation` → `main`

## Decisions

- **Tool selectors are placeholder names** — actual tool names TBD once app MCP endpoint is validated with the new single-path routing
- **Orchestrator gets empty selectors** (all tools) — no filtering, full access
- **Rate limits unchanged** — still 120 QPM service / 30 QPM user
