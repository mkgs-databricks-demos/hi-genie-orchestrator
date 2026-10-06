/**
 * Memory Service — Module Entry Point
 *
 * Three-layer memory model for the Hi Genie Orchestrator:
 *   1. Short-term: session/thread-scoped working context (TTL 1-7 days)
 *   2. Episodic: redacted session summaries, execution outcomes (append-only)
 *   3. Semantic: compacted facts with pgvector embeddings (similarity search)
 *
 * Design decisions:
 *   - Decision 18: Three-tier memory (short-term, episodic, semantic)
 *   - Decision 19: In-project only, lakebase_vector + lakebase_ann
 *   - Decision 20: Async embedding generation via model endpoint
 *
 * Usage in server.ts:
 * ```typescript
 * import { setupMemory } from './memory/index';
 * // In onPluginsReady:
 * await setupMemory(appkit);
 * ```
 */

// AppKit type not exported in 0.38.1 — use structural interface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AppKitInstance = any;

import { ShortTermMemoryService } from './short-term.js';
import { EpisodicMemoryService } from './episodic.js';
import { SemanticMemoryService } from './semantic.js';
import { EmbeddingService } from './embeddings.js';
import type { EmbeddingServiceConfig } from './embeddings.js';

// ─── Re-exports (barrel) ────────────────────────────────────────────────────

export { ShortTermMemoryService } from './short-term.js';
export type {
  ShortTermMemoryType,
  ShortTermMemoryRecord,
  CreateShortTermMemoryInput,
  UpdateShortTermMemoryInput,
  ShortTermQueryOptions,
} from './short-term.js';
export { ConcurrencyError } from './short-term.js';

export { EpisodicMemoryService } from './episodic.js';
export type {
  EpisodicMemoryType,
  EpisodicMemoryRecord,
  CreateEpisodicMemoryInput,
  EpisodicQueryOptions,
  PaginatedEpisodicResult,
} from './episodic.js';

export { SemanticMemoryService } from './semantic.js';
export type {
  SemanticMemoryType,
  EmbeddingStatus,
  SemanticMemoryRecord,
  CreateSemanticMemoryInput,
  SimilaritySearchOptions,
  SimilarityResult,
  DeduplicationResult,
} from './semantic.js';

export { EmbeddingService } from './embeddings.js';
export type { EmbeddingServiceConfig } from './embeddings.js';

// ─── Module State ─────────────────────────────────────────────────────────

let memoryInitialized = false;
let embeddingServiceInstance: EmbeddingService | null = null;
let shortTermInstance: ShortTermMemoryService | null = null;
let episodicInstance: EpisodicMemoryService | null = null;
let semanticInstance: SemanticMemoryService | null = null;

// ─── Initialization ───────────────────────────────────────────────────────

/**
 * Initialize all three memory layers with the AppKit Lakebase pool.
 * Called from `server.ts` in `onPluginsReady` after migrations.
 */
export async function setupMemory(appkit: AppKitInstance): Promise<void> {
  if (memoryInitialized) {
    console.warn('[memory] Already initialized, skipping.');
    return;
  }

  const pool = appkit.lakebase.pool;

  // Initialize service instances
  shortTermInstance = new ShortTermMemoryService(pool);
  episodicInstance = new EpisodicMemoryService(pool);
  semanticInstance = new SemanticMemoryService(pool);

  // Initialize embedding service if endpoint is configured
  const rawHost = process.env['DATABRICKS_HOST'];
  const endpointName = process.env['EMBEDDING_ENDPOINT_NAME'];

  if (rawHost && endpointName) {
    // Platform injects host without protocol prefix
    const workspaceHost = rawHost.startsWith('http://') || rawHost.startsWith('https://') ? rawHost : `https://${rawHost}`;
    const embeddingConfig: EmbeddingServiceConfig = {
      workspaceHost,
      endpointName,
      modelName: process.env['EMBEDDING_MODEL_NAME'] ?? 'databricks-gte-large-en',
      modelVersion: process.env['EMBEDDING_MODEL_VERSION'] ?? 'v1',
      batchSize: parseInt(process.env['EMBEDDING_BATCH_SIZE'] ?? '20', 10),
      pollIntervalMs: parseInt(process.env['EMBEDDING_POLL_INTERVAL_MS'] ?? '30000', 10),
    };

    embeddingServiceInstance = new EmbeddingService(pool, semanticInstance, embeddingConfig);
    embeddingServiceInstance.start();
    console.log(`[memory] Embedding service started (endpoint: ${endpointName}).`);
  } else {
    console.warn(
      '[memory] Embedding service NOT started: DATABRICKS_HOST or EMBEDDING_ENDPOINT_NAME not set.',
    );
  }

  memoryInitialized = true;
  console.log('[memory] All memory layers initialized.');
}

// ─── Accessors ────────────────────────────────────────────────────────────

/**
 * Get the short-term memory service instance.
 * Throws if setupMemory has not been called.
 */
export function getShortTermMemory(): ShortTermMemoryService {
  if (!shortTermInstance) {
    throw new Error('[memory] Not initialized. Call setupMemory(appkit) first.');
  }
  return shortTermInstance;
}

/**
 * Get the episodic memory service instance.
 * Throws if setupMemory has not been called.
 */
export function getEpisodicMemory(): EpisodicMemoryService {
  if (!episodicInstance) {
    throw new Error('[memory] Not initialized. Call setupMemory(appkit) first.');
  }
  return episodicInstance;
}

/**
 * Get the semantic memory service instance.
 * Throws if setupMemory has not been called.
 */
export function getSemanticMemory(): SemanticMemoryService {
  if (!semanticInstance) {
    throw new Error('[memory] Not initialized. Call setupMemory(appkit) first.');
  }
  return semanticInstance;
}

/**
 * Get the embedding service instance (may be null if not configured).
 */
export function getEmbeddingService(): EmbeddingService | null {
  return embeddingServiceInstance;
}

// ─── Shutdown ─────────────────────────────────────────────────────────────

/**
 * Graceful shutdown: flush pending embeddings and release resources.
 * Call from the app's shutdown handler.
 */
export async function shutdownMemory(): Promise<void> {
  if (embeddingServiceInstance) {
    await embeddingServiceInstance.shutdown();
    embeddingServiceInstance = null;
  }

  shortTermInstance = null;
  episodicInstance = null;
  semanticInstance = null;
  memoryInitialized = false;

  console.log('[memory] Shutdown complete.');
}
