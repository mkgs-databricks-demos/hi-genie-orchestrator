# Session Summary: ws-f — Semantic Memory Layer

**Date:** 2026-08-18  
**Workstream:** ws-f  
**Status:** COMPLETE  
**Duration:** ~15 min  

## Objective

Implement the three-layer Lakebase memory model in `server/memory/`: short-term
session memory, long-term episodic memory, and long-term semantic memory with
pgvector embeddings. Background embedding generation via Databricks Foundation
Model API endpoint.

## Changes

### Files Created

All paths relative to `mcp-hi-genie-orchestrator/server/memory/`:

| File | Lines | Purpose |
| --- | --- | --- |
| `index.ts` | ~160 | Module entry point, `setupMemory(appkit)`, barrel exports, singleton accessors, `shutdownMemory()` for graceful flush |
| `short-term.ts` | ~260 | `ShortTermMemoryService` — CRUD on `state.short_term_memory`, configurable TTL (1-7 days, default 3), optimistic concurrency via `updated_at`, bounded queries, `deleteExpired()` for background cleanup |
| `episodic.ts` | ~250 | `EpisodicMemoryService` — Append-only idempotent writes (`ON CONFLICT DO NOTHING`), paginated queries, temporal filtering, `getRecentSummaries()` and `getRelevantErrors()` convenience methods |
| `semantic.ts` | ~310 | `SemanticMemoryService` — Similarity search via `<=>` cosine distance on `lakebase_ann` index, configurable k/threshold, deduplication check (0.95 threshold), access count tracking |
| `embeddings.ts` | ~280 | `EmbeddingService` — Background polling, batch processing via Databricks serving endpoint (`/serving-endpoints/{name}/invocations`), rate-limit handling (Retry-After), bounded retries with exponential backoff |

### Status File Updated

- `orchestration/state/workstream-ws-f-status.md` → COMPLETE with full downstream integration notes

## Decisions Made

1. **No Drizzle ORM** — Used raw parameterized SQL via pg Pool (consistent with
   migrations and telemetry modules; no Drizzle schema definitions exist yet).

2. **Optimistic concurrency via `updated_at`** — Migration 003 DDL does not
   include a `version` column on `short_term_memory`, so `updated_at` comparison
   serves as the concurrency marker.

3. **Idempotent writes via PK conflict** — `ON CONFLICT (memory_id) DO NOTHING`
   on episodic and semantic tables. Returns existing record on conflict.

4. **Similarity threshold conversion** — User-facing threshold (0-1, higher =
   more similar) converts to max cosine distance as `1 - threshold`.

5. **Deduplication threshold at 0.95** — Near-identical content detection before
   storing new semantic facts.

6. **Embedding service is fire-and-forget** — `setInterval` polling with
   `.unref()` so it doesn't prevent process exit. Graceful shutdown waits up to
   10s for in-flight requests.

7. **Access tracking** — `access_count` and `last_accessed_at` auto-increment
   on similarity search hits (non-blocking UPDATE after SELECT).

8. **Module independently loadable** — No imports from mcp/, api/, dispatch/.
   Only depends on telemetry (`withDbSpan`).

## Dependencies

- **Upstream:** ws-b (migration 003 creates the three memory tables)
- **Downstream:** ws-c MCP tools (context retrieval tools will call these services)
- **No new packages** — Uses existing `pg` types from `@databricks/appkit`

## Environment Variables Required

| Variable | Purpose |
| --- | --- |
| `DATABRICKS_HOST` | Workspace URL for embedding endpoint calls |
| `EMBEDDING_ENDPOINT_NAME` | Serving endpoint name |
| `EMBEDDING_MODEL_NAME` | Model metadata (default: `databricks-gte-large-en`) |
| `EMBEDDING_MODEL_VERSION` | Version metadata (default: `v1`) |
| `DATABRICKS_TOKEN` | Bearer auth (platform-injected in App) |

## Integration

In `server/server.ts`, uncomment:
```typescript
import { setupMemory } from './memory/index.js';
// In onPluginsReady (after migrations, after telemetry):
await setupMemory(appkit);
```

Add to shutdown handler (before `pool.end()`):
```typescript
import { shutdownMemory } from './memory/index.js';
await shutdownMemory();
```

## Architecture Alignment

- Decision 18: Three-tier memory model (short-term → episodic → semantic)
- Decision 19: In-project only, lakebase_vector + lakebase_ann, RLS-protected
- Decision 20: Async embedding generation, model metadata tracking, bounded retries
- Decision 2: Append-first model, optimistic concurrency for mutable state
