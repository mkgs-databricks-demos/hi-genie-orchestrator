---
date: 2026-08-26
title: "Projects table, dependency gate & MLflow 3 trace fix"
branch: mg-genie-r2-mcp-consolidation
commits: bd93b89, 49a058a, 9c0aeda, c43e5be, 3db2c37, db0549c
deployment: 01f1a16e53701ca3b4935375c6ca6f04
---

# 2026-08-26 — Projects table, dependency gate & MLflow 3 trace fix

## Summary

Deployed migration 009 (`dispatch.projects` table + FK constraints), added `create_project` MCP tool (architect persona), fixed 4 production bugs discovered via AI Playground testing, and added a dependency gate to `dispatch_workstream`.

## Key Accomplishments

### 1. App deployment + migration 009
- `dispatch.projects` table created with RLS, FK constraints on `dispatch.plans` and `dispatch.orchestrations`
- `create_project` MCP tool live (architect persona, 14 tools total)
- UC MCP Service selectors updated for all 4 personas (14/14/17/16)
- REST routes for project management (`/api/v1/projects`) deployed

### 2. Bug fixes discovered via production traffic

| Commit | Bug | Root Cause | Fix |
| --- | --- | --- | --- |
| `bd93b89` | TypeScript build failure | `UpdateProjectInput.description` didn't accept `null` (Zod schema had `.nullable()`) | Added `| null` to type |
| `49a058a` | App crash on `create_plan` with unknown project_id | FK violation (`23503`) unhandled → unhandled promise rejection → Node crash | Catch `23503`, return `badRequest()` |
| `c43e5be` | MLflow trace export 400 errors (132+ failures) | `mlflow.user` is a system-managed reserved tag — can't be set via API | Replaced with custom `hi_genie.user_identity` tag |
| `3db2c37` | `materialize_workstreams` NULL constraint violation | Plan content uses `title` for workstream names, code expected `name` | `ws.name ?? ws.title ?? ws.workstream_key` fallback |

### 3. Dependency gate on `dispatch_workstream` (commit `db0549c`)
- Server now queries upstream `depends_on` workstreams before allowing dispatch
- If any upstream dep is not COMPLETE → `400 BAD_REQUEST` with detailed error
- Root workstreams (`depends_on: []`) skip the check — zero overhead
- Validated in AI Playground: `ws-gold-tables` correctly rejected with `[ws-dlt-pipeline=IN_PROGRESS]`

### 4. AI Playground model comparison

| Model | Tool calls | Format consistency | Outcome |
| --- | --- | --- | --- |
| GLM 5.2 | 10/11 | Drifted to XML on #11 | UC proxy `JsonParseException` |
| Claude Opus 4.8 | 16+ | Stable JSON throughout | Full workflow + caught real bugs |

Claude Opus 4.8 notably:
- Correctly identified the dispatch tick auto-advancing `ws-catalog` (not an anomaly)
- Caught the missing dependency gate in `dispatch_workstream` before we added it
- Refused to dispatch into inconsistent state — architecturally sound behavior

### 5. OTel / MLflow 3 validation
- 0 errors post-deploy (across all spans and logs)
- 132+ MLflow trace exports at HTTP 200 (zero 400s after tag fix)
- New `db:dispatch.workstreams.check_deps` span visible in traces (5.42ms avg)
- Dispatch tick running clean (268+ ticks, 0 errors)

## Files Modified

| File | Change |
| --- | --- |
| `server/services/plans.service.ts` | Added `badRequest` import + FK violation handler |
| `server/services/projects.service.ts` | `description` type accepts `null` |
| `server/services/orchestration.service.ts` | `title` fallback in materialize + dependency gate in dispatch |
| `server/telemetry/mlflow-tracer.ts` | `mlflow.user` → `hi_genie.user_identity` + response body in error logs |

## Deployment History (this session)

| Deployment | Status | Note |
| --- | --- | --- |
| `01f1a10c` | FAILED | Build: TS type error (description null) |
| `01f1a10e` | SUCCEEDED | First successful deploy with migration 009 |
| `01f1a12b` | SUCCEEDED | FK violation fix |
| `01f1a1410` | SUCCEEDED | MLflow tag fix + error body logging |
| `01f1a142e` | SUCCEEDED | MLflow tag fix (final) |
| `01f1a1697` | SUCCEEDED | materialize title fallback |
| `01f1a16e5` | SUCCEEDED | Dependency gate (current) |

## Pending / Next Steps
1. **Fix `validate_deployment` task** — needs to `create_project` before `create_plan` (FK enforcement)
2. **Add `withToolSpan` to read-only MCP tools** — `get_health`, `search_decisions`, etc. missing from trace breakdown
3. **Dispatch tick + dependency gate interaction** — tick auto-advances without dep check; reconcile with server-side gate
4. **PR merge** — `mg-genie-r2-mcp-consolidation` → `main` (significant: 10+ commits this session)
