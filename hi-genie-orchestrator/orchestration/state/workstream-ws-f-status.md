---
workstream_key: ws-f
name: Semantic Memory Layer
status: COMPLETE
depends_on: [ws-b]
scheduled_task_id: edd06ea763374f978df9f68d15384374
task_paused: false
attempt_count: 1
max_retries: 5
started_at: "2026-08-18T06:00:00Z"
completed_at: "2026-08-18T06:15:00Z"
error_message: null
prior_error: null
last_attempt_at: "2026-08-18T06:00:00Z"
---

# Workstream ws-f: Semantic Memory Layer

## Scope

Implement three-layer memory model in `server/memory/`:
- Short-term session memory (thread-scoped, configurable TTL 1-7 days)
- Long-term episodic memory (redacted session summaries, execution outcomes)
- Long-term semantic memory (compacted facts, deduplicated, pgvector embeddings)
- lakebase_vector extension + lakebase_ann index
- Background embedding generation via Databricks model endpoint
- RLS-protected, project-scoped, in-project only (cross-project deferred to 1.1)
- Retrieval: similarity search with configurable k and threshold

## Notes for Downstream Sessions

### Files Created

All paths relative to `mcp-hi-genie-orchestrator/server/memory/`:

| File | Lines | Purpose |
| --- | --- | --- |
| `index.ts` | ~160 | Module entry point, `setupMemory(appkit)`, barrel exports, accessors, graceful shutdown |
| `short-term.ts` | ~260 | CRUD operations on `state.short_term_memory`, TTL enforcement, optimistic concurrency |
| `episodic.ts` | ~250 | Append-only writes to `state.episodic_memory`, paginated queries, temporal filtering |
| `semantic.ts` | ~310 | Similarity search via `<=>` cosine distance, deduplication check, access tracking |
| `embeddings.ts` | ~280 | Background embedding generation, batch processing, retry with exponential backoff |

### Function Signatures for Downstream

```typescript
// Entry point (called in server.ts onPluginsReady)
export async function setupMemory(appkit: AppKit): Promise<void>;

// Graceful shutdown (call from app shutdown handler)
export async function shutdownMemory(): Promise<void>;

// Service accessors (throw if setupMemory not yet called)
export function getShortTermMemory(): ShortTermMemoryService;
export function getEpisodicMemory(): EpisodicMemoryService;
export function getSemanticMemory(): SemanticMemoryService;
export function getEmbeddingService(): EmbeddingService | null;
```

### Short-Term Memory API

```typescript
class ShortTermMemoryService {
  create(input: CreateShortTermMemoryInput): Promise<ShortTermMemoryRecord>;
  update(input: UpdateShortTermMemoryInput): Promise<ShortTermMemoryRecord>; // Optimistic concurrency via expectedUpdatedAt
  getById(memoryId, projectId): Promise<ShortTermMemoryRecord | null>;
  query(options: ShortTermQueryOptions): Promise<ShortTermMemoryRecord[]>;
  delete(memoryId, projectId): Promise<boolean>;
  deleteExpired(): Promise<number>; // Background cleanup
  getSessionCount(sessionId, projectId): Promise<number>;
}
```

### Episodic Memory API

```typescript
class EpisodicMemoryService {
  append(input: CreateEpisodicMemoryInput): Promise<EpisodicMemoryRecord>; // Idempotent via ON CONFLICT
  getById(memoryId, projectId): Promise<EpisodicMemoryRecord | null>;
  query(options: EpisodicQueryOptions): Promise<PaginatedEpisodicResult>;
  getRecentSummaries(projectId, options?): Promise<EpisodicMemoryRecord[]>;
  getRelevantErrors(projectId, options?): Promise<EpisodicMemoryRecord[]>;
  getCount(projectId): Promise<number>;
}
```

### Semantic Memory API

```typescript
class SemanticMemoryService {
  store(input: CreateSemanticMemoryInput): Promise<SemanticMemoryRecord>; // Starts as embedding_status='pending'
  getById(memoryId, projectId): Promise<SemanticMemoryRecord | null>;
  similaritySearch(options: SimilaritySearchOptions): Promise<SimilarityResult[]>;
  checkDuplicate(projectId, contentEmbedding, excludeMemoryId?): Promise<DeduplicationResult>;
  setEmbedding(memoryId, projectId, embedding, model, modelVersion): Promise<void>;
  markEmbeddingFailed(memoryId, projectId): Promise<void>;
  getPendingEmbeddings(limit?): Promise<SemanticMemoryRecord[]>;
  queryByProject(projectId, options?): Promise<SemanticMemoryRecord[]>;
}
```

### How to Register in server.ts

Uncomment the existing placeholder in `server/server.ts`:
```typescript
import { setupMemory } from './memory/index.js';
// In onPluginsReady (after migrations, after telemetry):
await setupMemory(appkit);
```

Add shutdown integration:
```typescript
import { shutdownMemory } from './memory/index.js';
// In shutdown handler (before pool.end()):
await shutdownMemory();
```

### Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABRICKS_HOST` | Yes (for embeddings) | Workspace URL for serving endpoint calls |
| `EMBEDDING_ENDPOINT_NAME` | Yes (for embeddings) | Serving endpoint name (e.g., `databricks-gte-large-en`) |
| `EMBEDDING_MODEL_NAME` | No | Model name for metadata (default: `databricks-gte-large-en`) |
| `EMBEDDING_MODEL_VERSION` | No | Model version for metadata (default: `v1`) |
| `EMBEDDING_BATCH_SIZE` | No | Records per batch (default: 20) |
| `EMBEDDING_POLL_INTERVAL_MS` | No | Polling interval in ms (default: 30000) |
| `DATABRICKS_TOKEN` | Yes (for embeddings) | Bearer token (platform-injected in App) |

### Package Dependencies

No new packages required. Uses existing `pg` (via `@databricks/appkit`) for pool types.

### Design Decisions Made

- **Optimistic concurrency** on short-term memory uses `updated_at` comparison (no `version` column in migration 003 DDL)
- **Idempotent writes** on episodic/semantic use `ON CONFLICT (memory_id) DO NOTHING` since `memory_id` is the PK
- **Similarity threshold** converts from user-friendly 0-1 scale to cosine distance (1 - threshold = max distance)
- **Deduplication threshold** set at 0.95 similarity for near-identical content detection
- **Embedding service** is fire-and-forget with `setInterval` polling (non-blocking to request path)
- **Access tracking** auto-increments `access_count` and `last_accessed_at` on similarity search hits
- **Rate limiting** respects `Retry-After` header from 429 responses
- **No Drizzle ORM** used — raw parameterized SQL via pg Pool (consistent with migrations/telemetry modules; Drizzle schema generation is a future task)
- **Module is independently loadable** — no imports from mcp/, api/, dispatch/ (only telemetry for withDbSpan)
