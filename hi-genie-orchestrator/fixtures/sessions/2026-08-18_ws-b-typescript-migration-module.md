# Session: ws-b TypeScript Migration Module

**Date:** 2026-08-18  
**Workstream:** ws-b  
**Duration:** ~10 minutes  
**Status:** COMPLETE (attempt 1)  
**Branch:** `mg-genie-hi-genie-r1-build`

## Summary

Built the ordered, versioned, idempotent startup migration system for the Hi
Genie Orchestrator App. The module creates the Release 1 Lakebase schema across
two PostgreSQL schemas (`dispatch` and `state`) plus a three-tier memory model
with pgvector embeddings. All DDL executes during App startup via the
`onPluginsReady` hook using the AppKit service-principal Lakebase pool. No DDL
from request paths.

## Problems Encountered

1. **Omnigent contract tables are Release 1.1 only** — the physical contract in
   `omnigent-postgresql-contract.md` defines 5 tables (agent_handoffs,
   agent_handoff_attempts, planning_research_runs/reports/synthesis) that are
   explicitly scoped to Release 1.1. Release 1 required designing the
   dispatch/state/memory tables from the requirements and decisions documents.

2. **Import path mismatch** — `server.ts` has a commented import from
   `'./migrations/migrate'` but the task specified `index.ts` as the barrel. The
   downstream uncomment step must adjust the path to `'./migrations'`.

## Root Causes

- The contract document was finalized for Omnigent scope (Release 1.1); Release 1
  tables were specified only at the scope/requirements level, requiring schema
  design from decisions 2, 7, 18-20, 21, and 24.
- The `migrate` path in server.ts came from the ws-a scaffold (which used a
  package.json CLI script convention); the barrel export pattern is the correct
  programmatic entry point.

## Changes Made

### Files Created

All paths relative to `mcp-hi-genie-orchestrator/server/migrations/`:

| File | Lines | Purpose |
| --- | --- | --- |
| `index.ts` | 65 | Barrel export: `runMigrations(lakebase)`, migration registry, type re-exports |
| `runner.ts` | 209 | Migration engine: `state._migration_history` table, version tracking, transaction-per-migration, fail-fast |
| `001_dispatch_schema.ts` | 195 | Dispatch schema v1: plans, plan_snapshots, orchestrations, workstreams, executions, review_tasks |
| `002_state_schema.ts` | 215 | State schema v2: sessions, decisions, errors, events, task_attempts, task_completions, workstream_events, recovery_state |
| `003_memory_tables.ts` | 139 | Memory tables v3: short_term_memory, episodic_memory, semantic_memory + lakebase_vector extension + ANN index |

### Files Modified

| File | Change |
| --- | --- |
| `orchestration/state/workstream-ws-b-status.md` | NOT_STARTED → IN_PROGRESS → COMPLETE; populated Notes for Downstream Sessions |

## Decisions

1. **Raw SQL for DDL, Drizzle for runtime** — migrations use `client.query(sql)`
   directly against the pg pool. Drizzle ORM is reserved for type-safe runtime
   queries in ws-c through ws-f.

2. **Memory tables in `state` schema** — the architecture specifies two schemas
   (`dispatch` + `state`). Memory is worker-facing context owned by the MCP
   surface, so it lives in `state` rather than a third schema.

3. **Transaction-per-migration** — each migration runs in its own BEGIN/COMMIT
   block. Failure rolls back that migration only, records it in history, and
   halts execution (fail-fast).

4. **Version integers, not timestamps** — version numbers are monotonically
   increasing integers (1, 2, 3...) for simplicity. Timestamp-based versions
   deferred to Release 1.1 if needed.

5. **No RLS in Release 1** — row-level security policies are Release 1.1
   hardening per the contract document. Tables include `project_id` and
   `user_id`/`developer_id` columns ready for RLS application.

6. **Optimistic concurrency on mutable tables** — `sessions` and
   `recovery_state` include a `version` column. Downstream must use
   `WHERE version = $expected` on updates.

7. **vector(1536)** — embedding dimension matches common Databricks-hosted
   embedding models (e.g., bge-large, text-embedding-3-small). Configurable
   via future migration if model changes.

8. **lakebase_ann with cosine** — per Decision 19, cosine similarity is the
   initial distance metric for semantic memory retrieval.

## Key Patterns for Downstream

- **Adding migrations:** Create `NNN_description.ts`, export a `Migration`
  object, import and append to the `MIGRATIONS` array in `index.ts`. Never
  reuse version numbers.
- **Pool access:** `appkit.lakebase.pool` for both DDL (migrations) and DML
  (runtime queries via Drizzle).
- **Idempotency:** All append-only tables enforce `UNIQUE (project_id,
  idempotency_key)`. Callers must generate idempotency keys for retry-safe
  writes.
- **Correlation:** Every table includes `correlation_id UUID NOT NULL` for
  end-to-end tracing.
- **Import path:** Use `import { runMigrations } from './migrations'` (not
  `'./migrations/migrate'`) when uncommenting in `server.ts`.
