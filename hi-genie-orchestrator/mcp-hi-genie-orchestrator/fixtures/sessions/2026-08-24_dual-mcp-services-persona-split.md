# Session: Dual MCP Services — Persona Path Split + ASK-Gate Policy

**Date:** 2026-08-24 09:30 UTC  
**Branch:** `mg-genie-r2-mcp-consolidation`  
**Commit:** `feat: dual MCP services (worker/supervisor) with persona path split` (8 files)

---

## What Happened

Goal: split the monolithic `/mcp` endpoint into persona-specific paths, create matching UC Connections + MCP Services, and simplify the service policy from DENY-based persona enforcement to ASK-only gates (since tool visibility is now pre-filtered by the service boundary).

### 1. Server Path Split (server/mcp/index.ts)

Implemented three-transport architecture:

| Path | Tools | Persona |
| --- | --- | --- |
| `/mcp/worker` | 25 | context(7) + records(6) + state(5) + search(5) + skill(2) |
| `/mcp/supervisor` | 24 | plans(3) + orchestration(7) + reviews(4) + shared context(6) + monitoring(4) |
| `/mcp` | 39 | all tools (legacy / human / direct proxy) |

**Design:** Used exclusion sets (`WORKER_EXCLUSIVE_TOOLS`, `SUPERVISOR_EXCLUSIVE_TOOLS`) to filter the full registry. Shared tools (list_projects, get_project_context, etc.) appear on both persona paths. Express mounts specific paths first to avoid prefix conflicts.

**Deployed + validated via OTel:** Startup log confirms `39/25/24` split.

### 2. databricks.yml Variables

Added 4 new variables with dev target overrides:
- `worker_mcp_connection_name` → `hi_genie_worker_mcp_conn_dev`
- `supervisor_mcp_connection_name` → `hi_genie_supervisor_mcp_conn_dev`
- `worker_mcp_service_name` → `hi_genie_worker_dev`
- `supervisor_mcp_service_name` → `hi_genie_supervisor_dev`

### 3. UC Connections (create_app_connection.sql)

Added two new `CREATE CONNECTION IF NOT EXISTS` statements:
- `hi_genie_worker_mcp_conn_dev` — `base_path: /mcp/worker`
- `hi_genie_supervisor_mcp_conn_dev` — `base_path: /mcp/supervisor`

Updated grants cell to include USE CONNECTION + READ METADATA on all 4 connections.

### 4. MCP Service Registration (register_mcp_service.py)

Refactored from single-service to loop-based registration of all 3 services:
- Legacy: `hi_genie_orchestrator_dev` → `hi_genie_orchestrator_mcp_conn_dev`
- Worker: `hi_genie_worker_dev` → `hi_genie_worker_mcp_conn_dev`
- Supervisor: `hi_genie_supervisor_dev` → `hi_genie_supervisor_mcp_conn_dev`

Grants (EXECUTE + READ_METADATA) and rate limits applied to all 3.

### 5. Service Policy (persona_tool_policy.sql) — Phase 3 Complete

**Before:** DENY-based persona enforcement (architect/dispatcher/worker persona checks via persona_assignments table lookup for every tool call).

**After:** ASK-only gates for 4 destructive/irreversible operations:
- `publish_plan` — makes plan snapshot immutable
- `dispatch_workstream` — triggers execution
- `approve_review` — final sign-off
- `update_workstream_status` (when CANCELLED) — terminates work

Everything else: ALLOW. Tool visibility is now enforced at the service boundary.

### 6. Policy Registration (register_mcp_policy.py)

Updated to attach the policy to all 3 MCP Services.

### 7. Reset Connection + Post-Deploy Job

Reset drops all 4 connections. Job YAML passes all new parameters.

---

## Files Modified

| File | Change |
| --- | --- |
| `server/mcp/index.ts` | Three-transport mount with exclusion sets |
| `databricks.yml` | 4 new variables + dev overrides |
| `resources/post_deploy.job.yml` | Pass new params to 4 tasks |
| `src/deploy/create_app_connection.sql` | 2 new CREATE CONNECTION + expanded grants |
| `src/deploy/reset_connection.py` | Drop 4 connections |
| `src/deploy/register_mcp_service.py` | Loop-based 3-service registration |
| `src/deploy/register_mcp_policy.py` | Attach policy to all 3 services |
| `src/deploy/policies/persona_tool_policy.sql` | ASK-only gates (removed all DENY logic) |

---

## Phase Status After Session

| Phase | Status |
| --- | --- |
| Phase 1: Service layer extraction | COMPLETE |
| Phase 2: 14 new MCP tools | COMPLETE |
| Phase 3: Policy integration (ASK gates) | COMPLETE |
| Phase 4: UC function deprecation | TODO |
| Phase 5: Documentation | DONE |

## Next Steps

1. Run post-deploy job with `first_run=true` + `drop_connection=true` to create connections and register services.
2. Validate in AI Playground via `hi_genie_worker_dev` (25 tools) and `hi_genie_supervisor_dev` (24 tools).
3. Phase 4: deprecate UC SQL functions.
