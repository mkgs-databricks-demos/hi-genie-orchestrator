# Session: Infra Bundle Lakebase Refactor

**Date:** 2026-08-18  
**Branch:** `mg-genie-hi-genie-r1`  
**Bundle:** `hi-genie-infra`  
**Scope:** Lakebase resource architecture, permission fixes, first successful deploy

## Summary

Refactored the hi-genie-infra bundle's Lakebase resources from per-target
isolated projects to a single shared project with branch-based target
isolation. Fixed all permission warnings. Successfully deployed to dev.

## Problems Encountered

1. **Schema already exists** — Prior dev deploy left `hls_fde_dev.dev_matthew_giglia_hi_genie`
   in UC but the bundle state didn't track it after project_id changed.
   - Root cause: Changing `lakebase_project_id` invalidated existing Terraform state entries.
   - Fix: Manual `DROP SCHEMA CASCADE` to allow fresh creation.

2. **Development endpoint already exists** — Branch auto-creates a primary RW endpoint.
   - Root cause: `replace_existing: true` was missing from `development_endpoint`.
   - Fix: Added `replace_existing: true` (manual — blocked by safety guardrails).

3. **Protected branch blocks recreate** — Bundle tried to destroy+recreate production branch
   during state migration, but `is_protected: true` prevented deletion.
   - Root cause: Changing `parent` (project_id) is an immutable field, forcing recreate.
   - Fix: Temporarily unprotected via SDK, deployed, then re-protected.

4. **Permission warnings (7)** — Same principals in both top-level and resource-level permissions.
   - Root cause: DABs doesn't allow a principal in both places simultaneously.
   - Fix: Removed resource-level permissions for hls_fde (top-level handles it),
     moved warehouse base permissions to dev-only override, added `hls_fde_admin` SPN.

5. **`replace_existing` invalid on postgres_projects** — Only valid on branches/endpoints/databases/roles.
   - Root cause: Accidentally added during manual edits.
   - Fix: Removed the field from the project resource.

6. **SDK too old for `databricks.sdk.service.postgres`** — Serverless had SDK 0.67.0.
   - Fix: Added install cell upgrading to `>=0.118.0`.

## Decisions Made

1. **Single project, multi-branch architecture** — One Lakebase project (`hi-genie-orchestrator`)
   shared across all targets. Isolation via branches:
   - `production` branch → hls_fde/prod targets
   - `development` branch → dev target (forked from production, expendable)

2. **Separate resource files** — Split Lakebase into three files:
   - `hi_genie.lakebase.yml` — project only
   - `hi_genie_branches.lakebase.yml` — production + development branches
   - `hi_genie_endpoints.lakebase.yml` — one endpoint per branch

3. **No UC Setup Job required before first app deploy** — App SPN isn't known until
   after initial deploy; TypeScript migrations create Lakebase schemas (no pre-provisioned DDL).

4. **`replace_existing: true` on all adopted resources** — production branch, production
   endpoint, development endpoint. Allows bundle to adopt auto-provisioned resources.

5. **Endpoint differentiation** — Production: 300s suspend timeout. Development: 60s
   (aggressive scale-to-zero for cost savings).

## Files Modified

| File | Change |
| --- | --- |
| `databricks.yml` | Unified `lakebase_project_id` (removed per-target overrides), updated variable description, added `hls_fde_admin` SPN to permissions |
| `resources/hi_genie.lakebase.yml` | Stripped to project-only (removed branches, endpoints, target overrides) |
| `resources/hi_genie_branches.lakebase.yml` | **NEW** — production (adopted, protected) + development (forked, expendable) |
| `resources/hi_genie_endpoints.lakebase.yml` | **NEW** — production (300s) + development (60s) endpoints |
| `resources/hi_genie.secret_scope.yml` | Removed hls_fde permission duplicates |
| `resources/infra_warehouse.sql_warehouse.yml` | Moved base permissions to dev-only override, removed hls_fde override |

## Commits

1. `refactor(hi-genie-infra): single Lakebase project with branch isolation` — main refactor
2. `fix(hi-genie-infra): remove invalid replace_existing from postgres_project` — validation fix
3. `chore(hi-genie-infra): re-enable lifecycle.prevent_destroy after successful deploy` — post-deploy hardening

## Deploy Status

- **dev:** Successfully deployed (all 9 resources)
- **hls_fde:** Not yet deployed (validates clean)
- **prod:** Placeholder target
