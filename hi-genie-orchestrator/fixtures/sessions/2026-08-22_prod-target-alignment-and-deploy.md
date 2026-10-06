# Session: Prod Target Alignment & Top-Level Deploy Script

**Date:** 2026-08-22  
**Branch:** `main`  
**Status:** Complete — ready for R1 SIT cut  
**Context:** Preparing both bundles for system integration testing on a `prod` target

---

## Summary

Aligned the `prod` targets across both `hi-genie-infra` and `mcp-hi-genie-orchestrator` bundles for system integration testing. Created the missing top-level `deploy.sh` that orchestrates the full 3-step deployment sequence. Fixed a secret-key mismatch in `app_deploy.sh`.

---

## Problems Found

1. **Infra bundle `prod` target was a bare placeholder** — no variables for catalog, schema, Lakebase, credentials, or app name. Would fail to deploy any resources.

2. **App bundle `prod` target had empty-string variables** — catalog/schema/lakebase all `""`, making it undeployable without manual `--var` overrides that no script was providing.

3. **No top-level deploy.sh existed** — `app_deploy.sh` comment said "Later, a top-level deploy.sh at the orchestrator root will call this" but it was never created.

4. **`app_deploy.sh` prod case statement used wrong secret keys** — `client_id_hi_genie` / `client_secret_hi_genie` (matching `hls_fde` target) instead of the `_prod`-suffixed keys declared in the bundle YAML.

5. **App resource YAML had no permissions block for prod** — only git deployment config, missing `CAN_MANAGE` for the admin user.

---

## Changes Made

| File | Change |
| --- | --- |
| `hi-genie-infra/databricks.yml` | Populated `prod` target: `hls_fde.hi_genie_prod`, Lakebase project, schema-qualified secret keys, tags preset, permissions block |
| `mcp-hi-genie-orchestrator/databricks.yml` | Populated `prod` target: matching catalog/schema/lakebase/credentials, production branch, tags, permissions |
| `mcp-hi-genie-orchestrator/app_deploy.sh` | Fixed prod case: `client_id_hi_genie` → `client_id_hi_genie_prod`, `client_secret_hi_genie` → `client_secret_hi_genie_prod` |
| `mcp-hi-genie-orchestrator/resources/hi_genie_app.app.yml` | Added `permissions` block to prod target (CAN_MANAGE for admin user) |
| `deploy.sh` (NEW) | Top-level orchestrator script: 3-step (infra → UC Setup Job → app), `--skip-infra`/`--skip-app`/`--skip-uc-setup` flags, proper exit codes |

---

## Design Decisions

1. **Prod target uses `hls_fde.hi_genie_prod` (isolated schema, same workspace)** — enables SIT without interfering with the dev environment (`hls_fde_dev.dev_matthew_giglia_hi_genie`) or the eventual production schema (`hls_fde.hi_genie`).

2. **Shared Lakebase project, `production` branch for prod** — consistent with the single-project-per-workspace convention. SIT traffic hits the same Lakebase branch as future production, which is intentional (validates RLS, migrations, dispatch against the real infrastructure).

3. **`run_as: matthew.giglia@databricks.com` for prod during SIT** — no separate SPN bootstrapped yet for the prod target. This is acceptable for system integration testing; move to a dedicated SPN when cutting actual production.

4. **Top-level deploy.sh at orchestrator root** — sits alongside both bundle dirs, calls infra first (direct `bundle deploy`), runs UC Setup Job (`bundle run`), then delegates to app's `app_deploy.sh` (which handles infra-summary resolution and credential bootstrapping).

---

## Cross-Bundle Variable Alignment (prod)

| Variable | Infra | App | Status |
| --- | --- | --- | --- |
| catalog | `hls_fde` | `hls_fde` | ✅ |
| schema | `hi_genie_prod` | `hi_genie_prod` | ✅ |
| lakebase_project_id | `hi-genie-orchestrator` | `hi-genie-orchestrator` | ✅ |
| lakebase_branch | (implied: production) | `production` | ✅ |
| client_id_dbs_key | `client_id_hi_genie_prod` | `client_id_hi_genie_prod` | ✅ |
| client_secret_dbs_key | `client_secret_hi_genie_prod` | `client_secret_hi_genie_prod` | ✅ |
| app_name | `mcp-hi-genie-orchestrator-prod` | `mcp-hi-genie-orchestrator-prod` | ✅ |
| embedding_endpoint_key | `embedding_endpoint_hi_genie_prod` | `embedding_endpoint_hi_genie_prod` | ✅ |
| run_as_user | `matthew.giglia@databricks.com` | `matthew.giglia@databricks.com` | ✅ |
| workspace.host | `fevm-hls-fde` | `fevm-hls-fde` | ✅ |

---

## Deployment Flow (prod target)

```
./deploy.sh --target prod --auto-approve

  Step 1: databricks bundle deploy --target prod  (hi-genie-infra)
          → UC schema, Lakebase, secrets scope, MLflow experiment, SQL warehouse

  Step 2: databricks bundle run uc_setup --target prod  (hi-genie-infra)
          → Lakebase extensions, experiment directories, app SPN secrets

  Step 3: ./app_deploy.sh --target prod --auto-approve  (mcp-hi-genie-orchestrator)
          → Resolves infra summary → bundle deploy → container deployment
```

---

## Next Steps for R1 SIT

1. **Push to feature branch** and PR to main
2. **First prod deploy** (will trigger credential bootstrap flow)
3. **Generate SPN OAuth2 secret** and store in scope
4. **Re-run deploy** (now with real credentials → live app)
5. **Run post-deploy validation** against prod app URL
6. **Exercise MCP tools** via AI Playground against prod
