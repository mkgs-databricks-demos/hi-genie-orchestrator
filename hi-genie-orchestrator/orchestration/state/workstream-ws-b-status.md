---
workstream_key: ws-b
name: TypeScript Migration Module
status: COMPLETE
depends_on: [ws-a]
scheduled_task_id: 44bfef8c74f646888157e0829997f1a6
task_paused: false
attempt_count: 1
max_retries: 5
started_at: "2026-08-17T23:25:00Z"
completed_at: "2026-08-17T23:35:00Z"
error_message: null
prior_error: null
last_attempt_at: "2026-08-17T23:25:00Z"
---

# Workstream ws-b: TypeScript Migration Module

## Scope

Build startup migration system in `server/migrations/`:
- Migration runner (ordered, versioned, idempotent)
- `_migration_history` table for tracking applied versions
- `001_dispatch_schema.ts` — orchestrations, plans, plan_snapshots, workstreams, executions, review_tasks
- `002_state_schema.ts` — sessions, decisions, errors, events, task_attempts, task_completions, workstream_events, recovery_state
- `003_memory_tables.ts` — short_term_memory, episodic_memory, semantic_memory (pgvector)
- Execute via `onPluginsReady` hook using AppKit service-principal pool
- No DDL from request paths

## Notes for Downstream Sessions

### Files Created

All paths relative to `mcp-hi-genie-orchestrator/server/migrations/`:

- `index.ts` — Barrel export. Exposes `runMigrations(lakebase)` for `onPluginsReady`. Registers all migrations in order. Re-exports `Migration`, `MigrationResult`, `MigrationRunSummary` types.
- `runner.ts` — Migration engine. Creates `state._migration_history` for version tracking. Executes migrations in order, each in its own transaction. Skips already-applied. Fails fast on error.
- `001_dispatch_schema.ts` — Dispatch schema DDL (v1). Tables: `dispatch.plans`, `dispatch.plan_snapshots`, `dispatch.orchestrations`, `dispatch.workstreams`, `dispatch.executions`, `dispatch.review_tasks`.
- `002_state_schema.ts` — State schema DDL (v2). Tables: `state.sessions`, `state.decisions`, `state.errors`, `state.events`, `state.task_attempts`, `state.task_completions`, `state.workstream_events`, `state.recovery_state`.
- `003_memory_tables.ts` — Memory tables DDL (v3). Enables `lakebase_vector` extension. Tables: `state.short_term_memory`, `state.episodic_memory`, `state.semantic_memory`. Creates `lakebase_ann` cosine index on `semantic_memory.embedding`.

### Migration Interface

```typescript
export interface Migration {
  version: number;      // Monotonically increasing, unique
  name: string;         // Human-readable for logging
  up: (client: PoolClient) => Promise<void>;
}
```

### How to Add New Migrations

1. Create `NNN_description.ts` (e.g., `004_add_indexes.ts`)
2. Export a `Migration` object with the next version number
3. Import and register in `index.ts` MIGRATIONS array (append only)
4. Never reuse or reorder version numbers after deployment
5. Use `IF NOT EXISTS` / `IF NOT EXISTS` for all DDL

### Lakebase Schemas Created

| Schema | Owner | Tables |
| --- | --- | --- |
| `dispatch` | Supervisor surface | plans, plan_snapshots, orchestrations, workstreams, executions, review_tasks |
| `state` | Workstream MCP | _migration_history, sessions, decisions, errors, events, task_attempts, task_completions, workstream_events, recovery_state, short_term_memory, episodic_memory, semantic_memory |

### Integration Notes for Downstream Workstreams

- **Import path:** `import { runMigrations } from './migrations'` (resolves to `index.ts`). Update the commented import in `server.ts` from `'./migrations/migrate'` to `'./migrations'`.
- **Pool access:** `appkit.lakebase.pool` provides the SPN pool for DDL. For runtime queries (ws-c through ws-f), use the same pool reference: `appkit.lakebase.pool`.
- **Runtime queries use Drizzle ORM** (not raw SQL). Migrations use raw SQL for DDL. The pool is the same `pg.Pool` instance in both cases.
- **Mutable tables** (sessions, recovery_state) use `version` column for optimistic concurrency. Downstream must implement `WHERE version = $expected` on updates.
- **Append-only tables** (decisions, errors, events, task_attempts, task_completions, workstream_events, episodic_memory) use `(project_id, idempotency_key)` unique constraint for retry-safe writes.
- **Vector search:** `semantic_memory.embedding` is `vector(1536)`. Use `<=>` operator for cosine distance queries. Embedding generation is async (ws-f memory service).
- **TTL cleanup:** `short_term_memory.expires_at` index enables efficient expired-row cleanup (scheduled background task, not request-path).

### Deviations from Contract

- The `omnigent-postgresql-contract.md` tables (`dispatch.agent_handoffs`, `dispatch.agent_handoff_attempts`, `state.planning_research_runs/reports/synthesis`) are Release 1.1 scope and are NOT created by these migrations.
- Memory tables live in the `state` schema (not a separate `memory` schema) per the "two schemas" architectural decision.
- No RLS policies applied in Release 1 migrations (Release 1.1 hardening).
- No advisory locking or checksum verification (Release 1.1 hardening).
