# Release 1 Readiness Review

**Review type:** Read-only implementation review  
**Branch:** `feature/hi-genie-orchestrator`  
**Commit reviewed:** `961fde8`  
**Scope:** `mcp-hi-genie-orchestrator` Databricks App bundle and Release 1 requirements  
**Status:** Not ready for Release 1 acceptance

## Review Note

This report is the initial standalone review artifact. It was created before writing the protocol-formatted recommendation to Genie because the `.review-protocol` delivery path was not yet available in the active review flow.

The application-focused audit completed. The deployment-focused audit did not produce a final report because its worker encountered a blocked/failed execution path. Deployment findings below are therefore limited to previously observed repository evidence and should receive a separate bundle-focused pass.

## Executive Verdict

The current branch is an early implementation snapshot, not a Release 1 candidate. The most serious issue is that the application entry point does not appear to wire the implemented routes, MCP tools, migrations, or dispatch behavior into the running application. In addition, the code has schema/query mismatches, no RLS policies, unsafe identity fallback behavior, and no meaningful automated test coverage.

No source files were changed during this review.

## Blocking Findings

### 1. Application capabilities are not wired into the entry point

**Severity:** `BLOCKING`  
**Area:** App startup and route registration  
**Evidence:** The application audit found that `server/server.ts` disables or omits the implemented application capabilities. The repository contains substantial route, MCP, migration, and dispatch code, but the active entry point does not wire those capabilities into the running server.

**Required action:** Register the intended AppKit bootstrap, migration startup, health/readiness routes, `/mcp` surface, Supervisor API routes, and dispatch listener through the actual production entry point. Add an integration smoke test that proves the running entry point exposes the expected routes.

### 2. Release 1 source is not fully typechecked or built

**Severity:** `BLOCKING`  
**Area:** Build configuration  
**Evidence:** `tsconfig.server.json` includes only `server/server.ts`, leaving the broader server tree outside the typecheck boundary. The audit also found missing or incomplete client build inputs and an effectively empty `tsdown.config.ts`.

**Required action:** Make the production build and typecheck cover every Release 1 server module. Either add the minimum supported client scaffold and build it, or explicitly remove the client from Release 1 build gates. Do not allow a configuration that reports success while excluding implementation modules.

### 3. User identity and Lakebase RLS are not safe for Release 1

**Severity:** `BLOCKING`  
**Area:** Authentication, authorization, and database security  
**Evidence:** No Lakebase RLS policies were found. The implementation still contains an unsafe fallback to a `system` identity. The OBO-to-Lakebase transaction identity bridge is not implemented or fail-closed.

**Required action:** Implement and test the approved identity bridge before enabling user-scoped state reads or writes:

- Validate the authenticated Databricks user through OBO.
- Derive a verified canonical identity.
- Set transaction-local identity context on every state transaction.
- Enforce database RLS against that context.
- Reject requests when identity context is absent, stale, or unverifiable.
- Remove the `system` fallback for user-facing operations.

### 4. MCP and database schema contracts are inconsistent

**Severity:** `BLOCKING`  
**Area:** State and MCP data access  
**Evidence:** The audit found systematic mismatches between MCP queries and migration-defined columns, including use of generic `id`/`actor` names where migrations define entity-specific identifiers and `created_by`. It also found SQL parameterization defects in MCP query code where `$` placeholders are missing, causing values to be treated as literal integers rather than bound parameters.

**Required action:** Reconcile migrations, TypeScript types, and every MCP query against one versioned schema contract. Add integration tests that execute representative queries against Lakebase and verify authorization filtering, parameter binding, pagination, and result shape.

### 5. Release 1 tests are not meaningful

**Severity:** `BLOCKING`  
**Area:** Validation  
**Evidence:** No substantive test suite was found for the application behavior. Test configuration permits success with no tests, so green output can be vacuous.

**Required action:** Disable `passWithNoTests` for Release 1 gates and add tests for at least:

- App startup and route registration.
- Migration execution and failure behavior.
- MCP tool request/response contracts.
- Supervisor API authorization.
- Lakebase query parameter binding.
- RLS identity propagation and denial cases.
- Review/remediation state transitions.
- Dispatch idempotency, leases, and duplicate notifications.

## Required Fixes

### 6. Readiness must verify database compatibility

**Severity:** `REQUIRED_FIX`  
**Area:** Operations  
**Evidence:** The audit did not find a complete database-backed readiness implementation. A process-level health response is insufficient for a service whose routes depend on migrations and schema compatibility.

**Required action:** Separate liveness and readiness. Readiness must verify migration state, required schemas/tables/indexes, and database connectivity before serving MCP or Supervisor traffic. Migration failure must keep the app unready.

### 7. Migration command and startup behavior are incomplete

**Severity:** `REQUIRED_FIX`  
**Area:** Lakebase migrations  
**Evidence:** The repository contains references to a migration script that is missing or not connected to the actual startup path. The Release 1 LakeLoom-style migration runner must be a real executable path, not only a package script reference.

**Required action:** Ensure ordered TypeScript migration files are discovered, executed during startup, recorded in migration history, and covered by tests. Keep DDL out of MCP and API request handlers. Document the Release 1 limitations separately from Release 1.1 hardening such as checksums and advisory locking.

### 8. Supervisor API references must match persisted records

**Severity:** `REQUIRED_FIX`  
**Area:** Dispatch and Supervisor API  
**Evidence:** The audit found route references to objects or tables that do not exist in the current implementation/schema, and workstream lookups that are not consistently scoped.

**Required action:** Reconcile Supervisor API routes with the actual dispatch schema. Scope lookups by the complete orchestration/workstream identity, not by a key that is only locally unique. Add route-level contract tests.

### 9. Dispatch and review lifecycle enforcement is incomplete

**Severity:** `REQUIRED_FIX`  
**Area:** WS-INIT, review, and remediation  
**Evidence:** The current implementation does not yet demonstrate end-to-end enforcement of the approved lifecycle, including `READY_FOR_REVIEW`, independent review, remediation findings, and supervisor-only completion.

**Required action:** Add executable state-transition validation and tests proving:

- Workers can submit `READY_FOR_REVIEW` but cannot mark `COMPLETE`.
- Review findings remain authoritative in Lakebase.
- Remediation prompts reference findings rather than duplicating them.
- Required fixes block direct dependents while unrelated work continues.
- Completion requires verified blocking findings and current evidence.

### 10. Scaffold leftovers must be removed or isolated

**Severity:** `REQUIRED_FIX`  
**Area:** Application quality  
**Evidence:** A todo-oriented Lakebase route module remains in the server tree and appears unrelated to the Hi Genie domain model.

**Required action:** Remove scaffold-only routes from the production build or isolate them outside the Release 1 application surface. Add a route inventory test so accidental example endpoints cannot ship.

## Deployment Review Pending

The separate deployment audit did not complete, so the following must still receive explicit verification before Release 1 acceptance:

- App and platform bundle separation.
- DAB target configuration and required variables.
- Lakebase project/database/branch/endpoint resources.
- App resource binding and service-principal permissions.
- CLI version pin and reproducible dependency resolution.
- `sync.exclude` behavior for `.review-protocol/` and collaboration artifacts.
- Production catalog/schema values.
- Lakeflow recovery/reconciliation resources.
- MLflow trace-retention cleanup job and `mlflow_trace_retention_days` propagation.
- Bundle validation and deployment against a real workspace.

## Recommended Fix Order

1. Wire the real application entry point and make the complete server tree build.
2. Reconcile migrations, types, queries, and route contracts.
3. Remove unsafe identity fallback and implement OBO-to-Lakebase identity context plus RLS.
4. Add meaningful startup, migration, API, MCP, and authorization tests.
5. Implement database-backed readiness and fail-closed startup behavior.
6. Enforce review/remediation state transitions and dispatch idempotency.
7. Remove scaffold routes and add route inventory checks.
8. Complete the separate DAB/platform deployment audit and validate in a workspace.

## Release 1 Acceptance Recommendation

Do not mark the app ready for Release 1 until all `BLOCKING` findings are closed and the deployment audit passes. The current implementation demonstrates useful backend progress, but the running application, security boundary, schema contract, and test gates are not yet trustworthy enough for release acceptance.

The next protocol step should be to convert this report into a Genie-facing `hi_genie/` recommendation after the deployment audit is successfully completed or explicitly recorded as unavailable.
