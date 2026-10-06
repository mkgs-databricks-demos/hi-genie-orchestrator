# Session: publish_skills Job Parameter + OR-Gate

**Date:** 2026-08-24 10:15 UTC  
**Branch:** `mg-genie-r2-mcp-consolidation`  
**Commit:** `feat: add publish_skills job parameter with OR-gate to post-deploy DAG` (1 file)

---

## What Happened

Goal: decouple skill publishing from the full first_run lifecycle so skills can be republished without re-running connection/service/UC-function setup.

### Problem

Previously, publish_skill_version only ran when first_run=true, which also triggers connection creation, MCP service registration, UC function registration, and policy attachment.

### Solution

Added a new publish_skills job parameter (default false) with an independent condition gate. publish_skill_version now runs via an OR gate using AT_LEAST_ONE_SUCCESS on two condition_task dependencies.

**Behavior:**
- first_run=true: full setup INCLUDING skill publish
- publish_skills=true: skill publish ONLY (no infra)
- Both false: validation only (existing behavior)
- Both true: full setup (publish runs once)

Infra tasks (connections, services, UC functions) remain gated solely on first_run=true.

### Updated DAG

validate_deployment (always)
  - check_first_run (first_run == true) -> TRUE: infra tasks + publish (via OR)
  - check_publish_skills (publish_skills == true) -> TRUE: publish (via OR)
  - publish_skill_version: depends on both conditions, run_if AT_LEAST_ONE_SUCCESS

---

## Files Modified

| File | Change |
| --- | --- |
| resources/post_deploy.job.yml | Added publish_skills param, check_publish_skills condition, OR-gate on publish_skill_version |

---

## Usage

- Publish skills only: run job with publish_skills=true
- Full first-run (includes skills): run job with first_run=true
- Full first-run with connection reset: run job with first_run=true, drop_connection=true

---

## Execution Result

Post-deploy run `170949291493167` with `first_run=true drop_connection=true`: **ALL 8 TASKS GREEN**

Task execution order observed:
1. `validate_deployment` — app health, migrations, schemas, RLS
2. `check_first_run` (TRUE) + `check_publish_skills` (TRUE condition evaluated)
3. `publish_skill_version` (OR-gate fired via AT_LEAST_ONE_SUCCESS) + `reset_connection` (parallel)
4. `create_app_connection` (after reset_connection completes)
5. `register_mcp_service` + `discover_uc_functions` (parallel, both depend on create_app_connection)
6. `register_mcp_policy` (after register_mcp_service) + `register_uc_functions` forEach (after discover)

Total run time: ~5 minutes.

---

## Note: Partial Patch Fix

The initial two commits (`feat: dual MCP services...` and `feat: add publish_skills...`) only partially applied their patches to `post_deploy.job.yml`. The DAG comment and `reset_connection` params updated, but `create_app_connection`, `register_mcp_service`, `register_mcp_policy`, and the `publish_skills` parameter/gate were incomplete. A follow-up fix commit (`fix: complete post_deploy.job.yml...`) corrected all missing pieces before the job run.

---

---

# Session: 4-Persona MCP Service Split

**Date:** 2026-08-24 13:30 UTC
**Branch:** `mg-genie-r2-mcp-consolidation`
**Commits:**
1. `docs: design decision 004` (design doc)
2. `feat: implement 4-persona MCP service split` (7 files)

---

## What Happened

UC MCP Service limit is 20 tools per service. The previous 2-path split (worker: 25, supervisor: 24) exceeded this. Redesigned as 4 personas, each under 20.

### Design

See `docs/design/004-four-persona-mcp-split.md`.

| Persona | Path | Tools | Role |
| --- | --- | --- | --- |
| Architect | /mcp/architect | 13 | Plans, skills, design decisions |
| Reviewer | /mcp/reviewer | 14 | Reviews, quality gates, broad read |
| Worker | /mcp/worker | 17 | Records, sessions, task execution |
| Dispatcher | /mcp/dispatcher | 16 | Orchestration, workstream lifecycle |

Legacy /mcp (39 tools) retained as internal-only transport (no UC service).

### Key Changes

- `server/mcp/index.ts`: Switched from exclude-based to include-based (4 persona tool sets). New `buildIncludeRegistry()` function.
- `databricks.yml`: 8 new variables (4 connections + 4 services). Removed legacy mcp_connection_name, mcp_service_name, supervisor vars.
- Deploy notebooks: All updated to operate on 4 persona connections/services.
- `post_deploy.job.yml`: All task params updated.

### Infrastructure Mapping (Dev)

| Resource | Value |
| --- | --- |
| Architect connection | hi_genie_architect_mcp_conn_dev |
| Reviewer connection | hi_genie_reviewer_mcp_conn_dev |
| Worker connection | hi_genie_worker_mcp_conn_dev |
| Dispatcher connection | hi_genie_dispatcher_mcp_conn_dev |
| Architect service | hls_fde_dev.dev_matthew_giglia_hi_genie.hi_genie_architect_dev |
| Reviewer service | hls_fde_dev.dev_matthew_giglia_hi_genie.hi_genie_reviewer_dev |
| Worker service | hls_fde_dev.dev_matthew_giglia_hi_genie.hi_genie_worker_dev |
| Dispatcher service | hls_fde_dev.dev_matthew_giglia_hi_genie.hi_genie_dispatcher_dev |

---

## Deployment & Validation

### App Deploy

- Bundle deploy: source-linked, SUCCEEDED
- App deploy: `01f19fc20c5113688b52f8b688b9ad30` (SUCCEEDED, ~100s)

### OTel Verification (2026-08-24T13:47Z)

Startup log confirmed tool counts:
```
[mcp] Workstream MCP ready: /mcp/architect (13), /mcp/reviewer (14), /mcp/worker (17), /mcp/dispatcher (16), /mcp (39 internal)
```

### Live MCP tools/list (SPN-authenticated JSON-RPC)

All 4 paths respond to full MCP protocol (initialize + tools/list):
- `/mcp/architect` — 13 tools ✅
- `/mcp/reviewer` — 14 tools ✅
- `/mcp/worker` — 17 tools ✅
- `/mcp/dispatcher` — 16 tools ✅

### Post-Deploy Job (Run `755918384507973`)

Parameters: `first_run=true`, `drop_connection=true`

**ALL 10 TASKS GREEN** (~5 min):
- validate_deployment, check_first_run, check_publish_skills, check_drop_connection
- publish_skill_version (OR-gate fired)
- reset_connection (dropped old + new connections)
- create_app_connection (5 connections: REST + 4 persona)
- register_mcp_service (4 services registered)
- register_mcp_policy (ASK-gate on all 4)
- register_uc_functions (forEach — all functions)

### Legacy Cleanup

Dropped stale UC MCP Services via SDK DELETE:
- `hi_genie_orchestrator_dev` — GONE ✅
- `hi_genie_supervisor_dev` — GONE ✅

Patched worker service comment (was "25 tools", now "17 tools").

### Final Service State

| Service | Connection | Tools | Status |
| --- | --- | --- | --- |
| hi_genie_architect_dev | hi_genie_architect_mcp_conn_dev | 13 | HEALTHY |
| hi_genie_reviewer_dev | hi_genie_reviewer_mcp_conn_dev | 14 | HEALTHY |
| hi_genie_worker_dev | hi_genie_worker_mcp_conn_dev | 17 | HEALTHY |
| hi_genie_dispatcher_dev | hi_genie_dispatcher_mcp_conn_dev | 16 | HEALTHY |

---

## Commits

1. `docs: design decision 004 — four-persona MCP service split`
2. `docs: update session summary with run results + PROJECT_MEMORY baseline`
3. `fix: complete post_deploy.job.yml with all dual MCP params + publish_skills OR-gate`
4. `docs: add validation timestamp + evidence to design decision 004`
5. (pending) `feat: 4-persona MCP implementation + deployment notebooks + legacy cleanup`
