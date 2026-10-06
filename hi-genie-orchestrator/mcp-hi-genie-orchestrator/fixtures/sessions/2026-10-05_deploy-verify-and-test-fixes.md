# Session: Deploy, Verify & Test Fixes

**Date:** 2026-10-05  
**Thread ID:** `1791206388973`  
**Branch:** `mg-genie-r2-mcp-consolidation`  
**Duration:** ~45 min  

---

## Summary

Deployed the app to dev to verify Item 8 (dispatch engine reconciliation) TypeScript changes and Item 7 (E2E test create_project fix). Uncovered and resolved a stale SPN credential and a second FK violation in the post-deploy test suite. All post-deploy tasks GREEN.

## Problems & Root Causes

### 1. SPN OAuth credential stale

**Symptom:** `validate_deployment` task failed at Cell 4 — `401 invalid_client` on the `client_credentials` OAuth flow.  
**Root cause:** Secret scope key `client_secret_dev_matthew_giglia_hi_genie` was last updated 2026-08-18, but the SPN's OAuth secret had been rotated on 2026-09-27. The scope was never updated with the new value.  
**Fix:** User generated a new OAuth secret (ID `917fc97a...`, expires 2028-10-04) and stored it in the scope. Verified via notebook: OAuth flow returns HTTP 200, Bearer token acquired.

### 2. Test 4 FK violation (negative_scoping_cross_orchestration)

**Symptom:** `KeyError: 'plan'` in Test 4 — `negative_scoping_cross_orchestration`.  
**Root cause:** Identical to Item 7's Test 3 fix — migration 009 added FK constraint `dispatch.plans.project_id → dispatch.projects.project_id`. Test 4 used `other_project_id = str(uuid.uuid4())` without first creating the project via `POST /api/v1/projects`. The FK violation returned a 400 error response (no `plan` key), causing the `KeyError`.  
**Fix:** Added `POST /api/v1/projects` call to create a project before creating the control plan. Same pattern as the Item 7 fix for Test 3.

### 3. Deployment polling loop didn't break on SUCCEEDED

**Symptom:** Polling continued printing "SUCCEEDED" for 10 minutes despite the deployment completing at 100s.  
**Root cause:** String comparison checked for `"SUCCEEDED"` but the SDK returns `"AppDeploymentState.SUCCEEDED"`. Non-blocking — the deployment was successful and the job was triggered regardless.  
**Not fixed:** Cosmetic; the polling cell was deleted after use.

### 4. SDK `apps.deploy()` signature mismatch

**Symptom:** `TypeError: AppsAPI.deploy() got an unexpected keyword argument 'source_code_path'`.  
**Root cause:** The installed `databricks-sdk` version's `AppsAPI.deploy()` method has a different signature than documented in PROJECT_MEMORY.  
**Workaround:** Used `w.api_client.do("POST", f"/api/2.0/apps/{APP_NAME}/deployments", body={"source_code_path": SRC})` — the REST API directly. This matches the pattern in `deploy_source.sh`.

## Changes

| File | Change |
| --- | --- |
| `src/tests/post_deploy_validation.py` (Cell 8, Test 4) | Added `POST /api/v1/projects` before plan creation in `negative_scoping_cross_orchestration` test (same FK fix pattern as Item 7/Test 3) |

## Deployments & Runs

| Action | ID | Result |
| --- | --- | --- |
| App deploy | `01f1c0c023fb1c6e91d08ba37ee22940` | SUCCEEDED (100s) |
| Post-deploy job (attempt 1) | `776865892518299` | FAILED — SPN credential stale |
| Post-deploy job (attempt 2) | `1070466596773258` | FAILED — Test 4 FK violation |
| Post-deploy job (attempt 3) | `717399212414434` | **SUCCEEDED** — all tasks GREEN |

## Commits

1. `fix: add create_project to negative-scoping test (Test 4, FK from migration 009)` — 1 file

## Decisions

- **Deploy method:** `w.api_client.do("POST", ...)` is the reliable deploy path from notebooks. The Python SDK's `w.apps.deploy()` has a signature mismatch. The REST API matches `deploy_source.sh`.

## Files Modified

- `genie-workstream-orchestrator/hi-genie-orchestrator/mcp-hi-genie-orchestrator/src/tests/post_deploy_validation.py`
- `genie-workstream-orchestrator/hi-genie-orchestrator/mcp-hi-genie-orchestrator/fixtures/sessions/2026-10-05_deploy-verify-and-test-fixes.md` (this file)
- `genie-workstream-orchestrator/hi-genie-orchestrator/mcp-hi-genie-orchestrator/fixtures/sessions/INDEX.md`
- `genie-workstream-orchestrator/hi-genie-orchestrator/mcp-hi-genie-orchestrator/PROJECT_MEMORY.md`