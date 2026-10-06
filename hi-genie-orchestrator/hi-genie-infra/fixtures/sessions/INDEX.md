# Session Summaries — hi-genie-infra

Reverse-chronological log of hi-genie-infra bundle sessions.

<!-- Last pushed: 2026-08-19 -->

## 2026-08-19

| Session | Description |
| --- | --- |
| [app-spn-scope-grant-and-embedding-secret](2026-08-19_app-spn-scope-grant-and-embedding-secret.md) | Added `configure_app_secrets` task to UC Setup Job. Grants App SPN READ on secret scope (fixes MLflow 401), writes embedding endpoint name (fixes memory module). AclPermission enum fix. Both tasks green. |
| [lakebase-extensions-self-healing](2026-08-19_lakebase-extensions-self-healing.md) | Added self-healing Lakebase extension installation (both app migration v3 and infra UC Setup job). Fixed IMMUTABLE index, re-enabled memory tables migration. Created UC Setup job with bundle-resource-inherited parameters. All deployments green. |

## 2026-08-18

| Session | Description |
| --- | --- |
| [infra-bundle-lakebase-refactor](2026-08-18_infra-bundle-lakebase-refactor.md) | Refactored Lakebase to single-project/multi-branch architecture (production + development). Split into 3 resource files. Fixed 7 permission warnings. Successfully deployed all 9 resources to dev. |
