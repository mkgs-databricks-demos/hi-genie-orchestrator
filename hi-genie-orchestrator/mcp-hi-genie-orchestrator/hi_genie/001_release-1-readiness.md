# Release 1 Readiness Review

## Round 1

**Date:** 2026-08-19  
**Type:** REQUIREMENT_UPDATE  
**Priority:** CRITICAL

### References

| File | Location | Description |
| --- | --- | --- |
| `server/server.ts` | Application entry point | Implemented capabilities are not fully wired into the running app. |
| `tsconfig.server.json` | TypeScript include configuration | The server build boundary excludes most of the server tree. |
| `server/mcp/` | MCP tool implementations | Query/schema mismatches and parameter-binding defects were identified. |
| `server/routes/` | Supervisor and Lakebase routes | Route references and scope keys do not consistently match persisted records. |
| `server/migrations/` | Startup migration implementation | Migration command/startup wiring is incomplete or inconsistent. |
| `server/auth/` | User identity handling | Unsafe `system` identity fallback remains for user-facing operations. |
| `server/` and migration files | Lakebase authorization | No Lakebase RLS policies were found. |
| `package.json` and test configuration | Build and test gates | Tests can pass without collecting substantive test files. |
| `server/routes/lakebase/todo-routes.ts` | Scaffold route | Example todo functionality remains in the application tree. |
| `databricks.yml` and `resources/` | Deployment configuration | Deployment-focused audit remains pending and must be completed separately. |

### Current State

The Release 1 application contains a substantial backend scaffold, but the running entry point, database contract, authorization boundary, and validation gates are not yet trustworthy enough for release acceptance.

The application-focused audit verified the findings below. The separate deployment-focused audit did not produce a final report because its worker encountered a blocked/failed execution path. Deployment configuration therefore remains an explicit follow-up review rather than an assumed pass.

### Recommendation

Before Release 1 acceptance, Genie should close all `BLOCKING` findings and then complete the deployment audit.

#### Blocking requirements

1. **Wire the production entry point.** Register AppKit bootstrap, startup migrations, readiness routes, `/mcp`, Supervisor API routes, and dispatch behavior through the actual application entry point. Add a smoke test proving those routes are exposed.
2. **Build and typecheck the complete server tree.** Do not allow `tsconfig.server.json` or the production build to exclude implemented modules. Add the minimum client scaffold or explicitly remove client build requirements from Release 1.
3. **Implement the OBO-to-Lakebase identity bridge and RLS.** Validate the Databricks user, derive a verified identity, set transaction-local identity context, enforce RLS, and fail closed when identity context is missing or unverifiable. Remove the user-facing `system` fallback.
4. **Reconcile the schema and query contracts.** Align migrations, TypeScript types, MCP queries, and route handlers. Correct the SQL parameter-binding defects and entity-column mismatches. Add integration tests against Lakebase.
5. **Add non-vacuous tests.** Disable `passWithNoTests` for Release 1 gates and add startup, migration, MCP, API authorization, RLS, review/remediation, and dispatch idempotency tests.

#### Required fixes

6. Add database-backed `/health/ready` behavior that verifies migration state, required schemas/tables/indexes, and connectivity before serving application traffic.
7. Complete the executable TypeScript startup migration path and test failure behavior. Keep DDL out of MCP and API request handlers.
8. Reconcile Supervisor API routes with actual dispatch records and scope workstream lookups by complete orchestration/workstream identity.
9. Enforce the approved review/remediation lifecycle, including worker `READY_FOR_REVIEW`, independent findings, remediation references, dependent blocking, and supervisor-only completion.
10. Remove or isolate scaffold-only todo routes from the production application surface.

#### Deployment audit still required

Verify the two-bundle deployment contract, DAB targets and variables, Lakebase project/database/branch/endpoint resources, App resource bindings, service-principal permissions, CLI and dependency pinning, sync exclusions, production catalog/schema configuration, Lakeflow recovery resources, and MLflow trace-retention cleanup configuration.

### Rationale

The documented architecture requires a user-authorized MCP surface, separate dispatch and state boundaries, startup-controlled migrations, review-gated completion, and fail-closed authorization. The current implementation has gaps at each of those enforcement boundaries:

- Unwired modules can create a false impression of implemented capability.
- Partial typechecking can conceal compile and integration errors.
- Missing RLS and an implicit system identity can expose cross-user or cross-project state.
- Query/schema drift makes the MCP contract unreliable.
- Vacuous tests cannot establish Release 1 behavior.
- A process health response cannot prove database compatibility.

These are implementation acceptance requirements, not optional polish.

### Expected Impact

Closing these findings will establish a trustworthy Release 1 baseline with:

- A running application whose advertised surfaces are actually registered.
- Complete build and typecheck coverage.
- User-scoped, fail-closed Lakebase access.
- Consistent MCP/API/schema contracts.
- Meaningful automated validation.
- Safe startup and readiness behavior.
- Enforceable review and remediation lifecycle rules.
- A separately verified Databricks-native deployment path.

The standalone supporting report is available at:

`../architecture/release-1-readiness-review.md`
