# Session: App SPN Scope Grant & Embedding Secret Injection

**Date:** 2026-08-19  
**Branch:** `mg-genie-server-modules-r1`  
**Bundle:** hi-genie-infra  
**Outcome:** UC Setup Job gains `configure_app_secrets` task. Job run verified green.

---

## Problem

The deployed App hit two runtime errors:

1. **MLflow 401 Unauthorized** - App's managed SPN lacked scope read permission, so `valueFrom` references in `app.yaml` could not resolve.
2. **Memory module degraded** - `EMBEDDING_ENDPOINT_NAME` env var was never injected (no scope key existed).

## Root Cause

Infra-level provisioning gaps. The scope was created by the bundle but:
- No ACL had been configured for the App's platform-managed SPN
- No key held the embedding endpoint name for the app to read

## Changes

### `databricks.yml`
- Added variables: `app_name`, `embedding_endpoint_name` (default: `databricks-gte-large-en`), `embedding_endpoint_key`
- Dev target: `app_name: mcp-hi-genie-orchestrator-dev`, schema-qualified key
- hls_fde target: `app_name: mcp-hi-genie-orchestrator`, schema-qualified key

### `resources/uc_setup.job.yml`
- Added job parameters: `secret_scope_name`, `app_name`, `embedding_endpoint_name`, `embedding_endpoint_key`
- Added task `configure_app_secrets` (depends on `install_lakebase_extensions`)

### `src/configure_app_secrets` (native notebook, ID: 4038008988923202)
- Looks up App SPN via SDK (`apps.get` -> `service_principals.get`)
- Configures scope access using `AclPermission.READ` enum
- Writes embedding endpoint name to scope

## Decisions

- **Enum not string:** SDK method requires `AclPermission.READ` enum object, not `"READ"` string. First run failed on `'str' object has no attribute 'value'`; fixed immediately.
- **Native notebook:** Created as proper Databricks notebook, not `.py` file. Matches sibling `lakebase_platform_setup` pattern.
- **Task ordering:** `configure_app_secrets` depends on `install_lakebase_extensions`.

## Verification

- `bundle validate --target dev` - OK
- `bundle deploy --target dev` - OK
- `bundle run uc_setup --target dev` - TERMINATED SUCCESS (both tasks green)

## Files Modified

| File | Change |
| --- | --- |
| `databricks.yml` | +3 variables, +2 target overrides each |
| `resources/uc_setup.job.yml` | +4 job params, +1 task |
| `src/configure_app_secrets` | New notebook (9 cells) |

## Next Steps

- Switch to app bundle (`mcp-hi-genie-orchestrator`)
- Add `embedding-endpoint` resource to `resources/hi_genie_app.app.yml`
- Add `EMBEDDING_ENDPOINT_NAME` env entry to `app.yaml`
- Deploy app and verify memory module + MLflow tracer initialize cleanly
