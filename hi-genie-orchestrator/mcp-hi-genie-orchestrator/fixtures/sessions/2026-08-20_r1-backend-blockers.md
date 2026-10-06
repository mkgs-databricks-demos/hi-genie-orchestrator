# Session: R1 Backend Blocking-Fix Stabilization

**Date:** 2026-08-20  
**Branch:** `feature/r1-backend-blockers`  
**Historical stabilization cross-review commit:** `8a7ee13` (stabilization-only head; passed independent Codex cross-review with no findings, predates the `main` merge)  
**Final code commit as of this writing:** `43e2cc7` — `8a7ee13` merged with `main` `310ebe2`, plus lockfile regeneration, `tsconfig.test.json` expansion, cross-review test-mock realism fixes, and the `client.test.ts` fetch-mock contract fix. All gate numbers below were measured against this exact commit. This doc's own commit lands on top of `43e2cc7` and changes no code; resolve the true branch tip with `git rev-parse feature/r1-backend-blockers`.  
**Status:** Implementation complete, independently cross-reviewed, integrated with `main`, branch pushed; PR creation blocked by GitHub CLI authentication

---

## Objective

Resolve the backend defects that blocked production-backed R1 UI read models and make the stabilization branch reproducible and independently verifiable.

## Changes Completed

1. **Orchestration-scoped workstream operations**
   - Dispatch, retry, pause, and unpause predicates now bind both `orchestration_id` and `workstream_key`.
   - Periodic dispatch and dependency evaluation carry `orchestration_id` and `workstream_id` through the dispatch engine.
   - Added route and dispatch isolation coverage to prevent cross-orchestration mutations.

2. **Review dispatcher transaction lifecycle**
   - `createReviewTask` settles each database client exactly once.
   - Success and conflict paths commit before release.
   - Pre-commit failures roll back before release.
   - Rollback failures destroy the client rather than returning a potentially unsafe connection to the pool.
   - Post-commit failures release without attempting rollback.
   - Added focused lifecycle regression tests; the final independent transaction review reported no findings.

3. **`record_decision` contract alignment**
   - `workstream_id` is required by the MCP tool schema, handler contract, and database constraint.
   - Added schema regression coverage.

4. **Validation and reproducibility**
   - Replaced invalid UUID fixtures.
   - Regenerated `package-lock.json` and added a test-specific TypeScript configuration.
   - Reworked `post_deploy_validation.py` to validate the real plan → publish → orchestrate → materialize → dispatch flow and corrected Databricks widget dictionary handling.
   - Added Python validation tests and included the validator in the post-deploy job assets.

5. **Bookkeeping accuracy**
   - Corrected debate-state counters/status handling and strengthened pause-isolation coverage.
   - Reported the measured lint delta (200 vs `main`'s 212 errors) instead of claiming lint is green *or* claiming the backlog is unchanged.

6. **`main` integration and test-mock realism**
   - Merged `main` (`310ebe2`): OpenAPI 3.1 spec, Swagger UI, MCP catalog REST, `shared/sdk/` TypeScript client, prod git-deployment target.
   - Regenerated `package-lock.json` so `npm ci` resolves `main`'s `swagger-ui-express` deps alongside this branch's.
   - Expanded `tsconfig.test.json` to cover `shared/**/*.test.ts` as well as `server/**/*.test.ts`, which surfaced real findings in eight test files previously masked by a blanket "not found by the project service" parsing error; all were fixed with proper types rather than `any` or suppressions.
   - `server/migrations/runner.test.ts`: restored realistic asynchronous contracts — every mocked `pool.query` branch and `pool.connect` resolves a Promise (matching pg), and the DDL-failure migration rejects rather than throwing synchronously. Assertions strengthened to pin the exact failure message and verify BEGIN/ROLLBACK/no-COMMIT plus a single client release.

7. **`shared/sdk/client.test.ts` fetch-mock contract fix**
   - Prior code declared a `ConsumedResponse` interface (documenting the subset of `Response` the client reads) but then widened the typed literal to `Mock<typeof fetch>` via `as unknown as Mock<typeof fetch>` — an unchecked double assertion, so the comment's claim that member drift would be a compile error was false.
   - Fixed by typing the mock through inference — `vi.fn<typeof fetch>()` rather than `vi.fn()` + a cast — and resolving with a real `new Response(...)` instead of a hand-rolled object, so `.mockResolvedValue(...)` is genuinely checked against `Promise<Response>`.
   - Verified the fix catches drift, not just removes casts: temporarily resolved with an incompatible value and got a real `TS2322` compile error before restoring the correct version. No behavior change — all 25 tests still pass.

## Independent Validation

Measured at the **final code commit** `43e2cc7`, i.e. after merging `main` and applying the cross-review fixes above:

| Gate | Result |
| --- | --- |
| Reproducible install (`npm ci`) | ✅ Pass |
| TypeScript typecheck (server + client + test) | ✅ Pass |
| Server/client build | ✅ Pass |
| Vitest | ✅ **115 passed** |
| Python validator tests | ✅ **4 passed** |
| Playwright smoke | ✅ **13 passed** |
| Independent Codex cross-review | ✅ Pass — no findings at the historical `8a7ee13` |
| Lint | ⚠️ **200 errors / 3 warnings**, vs `main` (`310ebe2`) at **212 errors / 3 warnings** — a **12-error improvement**; ~200 legacy errors remain as follow-up scope |

> The earlier stabilization-only head `8a7ee13` reported 67 Vitest tests and a
> different lint total. Those numbers are **superseded** — the counts above
> include `main`'s OpenAPI/SDK/Swagger test suites brought in by the merge.

## Remaining Work

- Authenticate GitHub CLI (`gh auth login` or `GH_TOKEN`) and have the implementer open the PR from `feature/r1-backend-blockers`; do not merge automatically.
- The branch is ready for human PR review. It *reduces* the legacy lint backlog by 12 errors (212 → 200 vs `main`), but clearing the remaining ~200 legacy errors stays outside this stabilization scope.
- Recommended follow-up coverage: failed-`COMMIT` handling and failures in logging performed after commit.
- Production-backed R1 UI routes still require the separately approved authorization/read-model contract and should only proceed after this branch is merged.

## Key Files

- `server/api/routes/workstreams.ts`
- `server/api/routes/workstreams.integration.test.ts`
- `server/dispatch/index.ts`
- `server/dispatch/index.test.ts`
- `server/dispatch/priority-tree.ts`
- `server/dispatch/priority-tree.test.ts`
- `server/dispatch/tick-evaluator.ts`
- `server/dispatch/tick-evaluator.test.ts`
- `server/dispatch/review-dispatcher.ts`
- `server/dispatch/review-dispatcher.test.ts`
- `server/mcp/tools/records.ts`
- `server/mcp/tools/records.test.ts`
- `src/tests/post_deploy_validation.py`
- `src/tests/test_post_deploy_validation.py`
- `server/migrations/runner.test.ts`
- `server/api/openapi.test.ts`
- `server/api/routes/mcp-catalog.test.ts`
- `shared/sdk/client.test.ts`
- `package-lock.json`
- `tsconfig.test.json`

