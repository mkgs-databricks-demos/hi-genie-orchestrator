# 2026-08-20 — MCP Schema/Query Contract Reconciliation (Phase 4)

**Branch:** `mg-genie-r1-readiness-fixes`
**Follows:** `2026-08-20_rls-extension-and-mcp-contract-trace.md`
**Status:** Complete — all 4 MCP tool files + review-dispatcher.ts fixed, orchestration creation route added.

## Summary

Completed the MCP contract trace started in the prior session and implemented fixes for all
identified schema mismatches. This directly addresses Polly's R1 readiness finding 4
("Reconcile the schema and query contracts").

## Audit Findings

### Confirmed: No orchestration creation path existed

Searched the entire server tree (`server/api/routes/*.ts`, `server/mcp/tools/*.ts`,
`server/dispatch/*.ts`). **Zero files INSERT into `dispatch.orchestrations`.** The dispatch
engine only UPDATEs existing workstream rows; the API routes only work with plans/snapshots;
the MCP tools reference fabricated column names that would fail before any insert.

### Systemic schema mismatches across all MCP tools

All 4 files in `server/mcp/tools/` were authored against an assumed/earlier schema design
that migration 001/002 never matched. The issues fell into these categories:

1. **Wrong PK column names** — Every table uses `<entity>_id` (e.g., `workstream_id`,
   `decision_id`, `error_id`), but all Drizzle defs used bare `id`.
2. **`actor` → `created_by`** — Universal rename across all state tables.
3. **Fabricated columns** — `decisions.description`/`.status`/`.metadata`,
   `errors.severity`/`.error_type`, `workstream_events.idempotency_key`/`.payload`,
   `executions.metadata`/`.updated_at`, `workstreams.metadata`/`.version`,
   `sessions.summary`, `recovery_state.retry_count`/`.last_error`/etc.
4. **Missing required columns** — `correlation_id` missing everywhere, plus table-specific
   columns like `decision` (separate from `context`), `is_blocking`, `error_code`.
5. **Incorrect concurrency model** — `state.ts` assumed all tables have a `version` column;
   in reality only `state.sessions` and `state.recovery_state` do. `dispatch.workstreams`
   and `dispatch.executions` use `FOR UPDATE` row-locking.
6. **Invalid ON CONFLICT clauses** — `workstream_events` has no `idempotency_key` or
   unique constraint, but handlers used `ON CONFLICT (project_id, idempotency_key)`.

### review-dispatcher.ts also broken

- `fetchWorkstreamContext` referenced non-existent `w.output_artifacts`
- INSERT into `review_tasks` used fabricated columns (`workstream_key`, `attempt_count`,
  `context`) and was missing required FKs (`workstream_id`, `execution_id`, `project_id`,
  `correlation_id`, `created_by`)
- `findUnreviewedWorkstreams` JOIN used non-existent `rt.workstream_key`/`rt.attempt_count`

## Changes Made

### server/mcp/tools/context.ts
- Rewrote all 6 Drizzle schema definitions to match real DDL
- Fixed `getWorkstreamContext` to use `workstream_id` PK
- Fixed `getRecentSessionSummaries` to return `metadata` instead of `summary`
- Fixed `searchDecisions` to search `context` + `decision` instead of `description`
- Fixed `getRelevantErrors` to filter on `is_blocking` instead of `severity`
- Fixed `getSessionContext` to use `session_id` PK

### server/mcp/tools/state.ts
- Redesigned `optimisticUpdate` helper: now takes `pkColumn` parameter instead of hardcoding `id`
- Fixed parameterized query placeholders (`$N` instead of bare `N`)
- **Rewrote `updateWorkstreamStatus`**: uses `FOR UPDATE` row-locking (no version column)
  with proper transition validation, records events in `state.workstream_events` with
  correct columns (`workstream_event_id`, `previous_value`, `new_value`, `metadata`,
  `correlation_id`, `created_by`)
- **Rewrote `updateTaskStatus`**: uses `FOR UPDATE` row-locking, records events in
  `state.events` with correct columns, handles terminal status `ended_at` logic
- **Rewrote `updateRecoveryState`**: correctly targets `state_data` JSONB column, uses
  `workstream_id` lookup with version-based optimistic concurrency
- **Fixed `startSession`**: uses `session_id` PK, adds `correlation_id`, status `ACTIVE`
- **Fixed `endSession`**: uses `session_id` via `pkColumn`, removed non-existent `summary`
- Updated all tool definitions to remove fabricated parameters

### server/mcp/tools/records.ts
- Rewrote all Drizzle defs (decisions, errors, workstreamEvents, taskAttempts,
  taskCompletions, sessions) to match migration 002 DDL
- Fixed `idempotentInsert` helper: takes `pkColumn` param, uses `$N` placeholders
- **Fixed `recordDecision`**: uses `decision_id`, `context`+`decision` (not `description`),
  `correlation_id`, `created_by`, proper JSONB columns
- **Fixed `recordSessionSummary`**: records as event (sessions has no `summary` column),
  stores in session `metadata` JSONB instead
- **Fixed `recordError`**: uses `error_id`, `error_class`, `is_blocking`, `correlation_id`
- **Rewrote `recordWorkstreamEvent`**: plain INSERT (no idempotency constraint exists),
  uses `workstream_event_id`, `previous_value`/`new_value`/`metadata`, `correlation_id`
- **Fixed `recordTaskAttempt`**: uses `task_attempt_id`, `output_ref`, `duration_ms`,
  `correlation_id`
- **Fixed `recordTaskCompletion`**: uses `task_completion_id`, `final_status`,
  `artifacts_ref`, `total_attempts`, `correlation_id`

### server/mcp/tools/search.ts
- Rewrote all Drizzle defs to match real DDL
- Fixed `searchContext` to search `decisions.context`/`.decision` instead of `.description`
- Fixed `getExecutionSummary` to order by `created_at` (no `updated_at` on executions)

### server/dispatch/review-dispatcher.ts
- Fixed `fetchWorkstreamContext`: returns `workstream_id`, removed `output_artifacts`
- Fixed review task INSERT: uses real columns (`workstream_id`, `orchestration_id`,
  `project_id`, `execution_id`, `findings`, `correlation_id`, `created_by`), looks up
  latest `execution_id` for the workstream
- Fixed `findUnreviewedWorkstreams`: JOIN uses `rt.workstream_id = w.workstream_id`

### server/api/routes/plans.ts
- Added `POST /api/v1/plans/:planId/orchestrate` — the missing entry point that creates
  an orchestration row + materializes workstreams from a plan snapshot's content.
  Includes RLS identity context, idempotent workstream creation, and transitions the
  orchestration to RUNNING after materialization.

## Impact

- **22 MCP tools** now have schema-aligned queries that should execute without
  "column does not exist" errors
- **Dispatch engine** (review-dispatcher) can now correctly create review tasks with
  proper FK references
- **Orchestration lifecycle** now has a complete path: create plan → publish snapshot →
  orchestrate (creates orchestration + workstreams) → dispatch engine evaluates
- MCP module status can be upgraded from "registered but not verified" once a live
  deployment is tested

## Still Remaining (not in this session)

- Live end-to-end test of the orchestrate → dispatch → review flow
- Polly finding 9 (review/remediation lifecycle enforcement)
- Phase 4 readiness endpoint + deployment audit
- `passWithNoTests` disabled + real integration tests (Polly finding 5)
