# Session: MCP Governance, Split Connections & Persona Policy

**Date:** 2026-08-23 (session 2 of the day)  
**Branch:** `mg-genie-skill-publishing-and-post-deploy`  
**Run ID (verified green):** `572680553956276` (9 tasks, all SUCCESS/EXCLUDED)

---

## Problems Encountered

1. **MCP Service tools "no permission"** — Service showed `is_deleted: True` on its connection reference because `create_app_connection` did DROP+CREATE (new internal ID) but `register_mcp_service` only patched when the NAME changed.
2. **"Cannot POST /"** — MCP Service posted JSON-RPC to root `/` because connection had `base_path: /` and MCP transport lives at `/mcp`.
3. **forEach cross-task refs** — `{{tasks.X.values.Y}}` doesn't interpolate inside forEach subtask parameters.
4. **Condition task dependency** — Jobs API rejects bare dependency on a condition_task without explicit `outcome`.

## Root Causes & Fixes

| Problem | Root Cause | Fix |
|---------|-----------|-----|
| Stale connection ref | DROP+CREATE gives new ID; service skipped PATCH when name matched | Conditional DAG: `check_drop_connection` → `reset_connection` (only when `drop_connection=true`); `create_app_connection` uses `CREATE IF NOT EXISTS` |
| Cannot POST / | Single connection with `base_path: /` can't serve both REST and MCP | Split into two connections: `connection_name` (`/api`) + `mcp_connection_name` (`/mcp`) |
| forEach refs | Platform limitation | Runner notebook self-derives path from `notebookPath()` |
| condition_task dep | API constraint | Changed to depend on `check_first_run` (outcome: true) + `reset_connection` with `run_if: NONE_FAILED` |

## Architecture Decisions

1. **Two connections, one app:** `base_path: /api` for UC functions, `base_path: /mcp` for MCP Service. Same SPN credentials, same app host.
2. **Conditional DAG for connection reset:** `drop_connection` job parameter (default false) gates destructive DROP. EXCLUDED ≠ FAILED, so `NONE_FAILED` lets `create_app_connection` proceed.
3. **Rate limits as bundle variables:** `mcp_service_rate_limit_qpm: 120` (global), `mcp_service_user_rate_limit_qpm: 30` (per-caller). Applied via PUT in `register_mcp_service`.
4. **Persona-based service policy:** UC SQL function (`persona_tool_policy`) checks caller identity against `persona_assignments` table. Humans: ALLOW all (ASK on `publish_plan`). Agent SPNs: restricted to their persona's tools.
5. **R2 direction: single MCP surface** — All personas (architect, dispatcher, worker, human) use the MCP Service. Policies gate access. UC SQL functions become redundant.

## Changes Made

### New Files
| File | Purpose |
|------|--------|
| `src/deploy/reset_connection.py` | Conditional DROP for both connections |
| `src/deploy/policies/persona_tool_policy.sql` | Service policy function template |
| `src/deploy/policies/persona_assignments_ddl.sql` | Lookup table DDL template |
| `src/deploy/register_mcp_policy.py` | Creates table + function + attaches policy |

### Modified Files
| File | Change |
|------|--------|
| `databricks.yml` | Added `mcp_connection_name`, `mcp_service_rate_limit_qpm`, `mcp_service_user_rate_limit_qpm` variables |
| `resources/post_deploy.job.yml` | Added `check_drop_connection`, `reset_connection`, `register_mcp_policy` tasks; `drop_connection` param; `run_if: NONE_FAILED` pattern |
| `src/deploy/create_app_connection.sql` | Creates BOTH connections (REST /api + MCP /mcp), grants on both |
| `src/deploy/register_mcp_service.py` | Uses `mcp_connection_name`; detects stale binding; configures rate limits |
| `src/deploy/uc_functions/*.sql` (6 files) | Paths `/api/v1/...` → `/v1/...` (base_path now includes `/api`) |
| `PROJECT_MEMORY.md` | Reframed proxy style; downgraded revisit |

## Post-Deploy DAG (Final, 10 tasks)

```
validate_deployment (always)
    │
    ▼
check_first_run (first_run == "true")
    │
    ├─ TRUE ─┬─▶ publish_skill_version
    │        ├─▶ check_drop_connection (drop_connection == "true")
    │        │       └─ TRUE ─▶ reset_connection
    │        │
    │        └─▶ create_app_connection (run_if: NONE_FAILED)
    │                 ├─▶ register_mcp_service ─▶ register_mcp_policy
    │                 └─▶ discover_uc_functions ─▶ register_uc_functions (forEach)
    │
    └─ FALSE ▶ (end)
```

## Pending (Next Session)

1. **Deploy with `drop_connection=true`** — atomically updates REST connection to `base_path: /api` + re-registers UC functions with `/v1/...` paths
2. **Add architect/dispatcher tools to MCP server** — Express → MCP tool handlers for create_plan, publish_plan, orchestrate_plan, etc.
3. **Seed persona_assignments** — INSERT rows for known agent SPNs
4. **Test policy enforcement** — verify DENY/ASK behavior in Catalog Explorer
5. **Deprecate UC SQL functions** — once all personas route through MCP
