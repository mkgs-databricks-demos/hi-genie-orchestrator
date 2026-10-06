/**
 * Background Embedding Generation Service
 *
 * Asynchronously generates embeddings for semantic memory records
 * via a Databricks Foundation Model API endpoint.
 *
 * Design decisions:
 *   - Decision 20: Embedding generation is asynchronous, non-blocking
 *   - Fire-and-forget pattern: does not block the request path
 *   - Bounded retries with exponential backoff
 *   - Batch processing for efficiency
 *   - Rate limiting to respect endpoint quotas
 *
 * Uses workspace REST API: POST /serving-endpoints/{endpoint}/invocations
 */

import type { Pool } from 'pg';
import { withDbSpan } from '../telemetry/index.js';
import type { SemanticMemoryRecord } from './semantic.js';
import { SemanticMemoryService } from './semantic.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EmbeddingServiceConfig {
  /** Databricks workspace host URL (e.g., https://workspace.cloud.databricks.com) */
  workspaceHost: string;
  /** Serving endpoint name for embeddings model */
  endpointName: string;
  /** Model name for metadata tracking */
  modelName: string;
  /** Model version for metadata tracking */
  modelVersion: string;
  /** Auth token (platform-injected in App) */
  token?: string;
  /** Batch size for embedding requests (default 20) */
  batchSize?: number;
  /** Interval between processing cycles in ms (default 30000) */
  pollIntervalMs?: number;
  /** Max retries per record (default 3) */
  maxRetries?: number;
  /** Base backoff delay in ms (default 1000) */
  baseBackoffMs?: number;
  /** Max concurrent requests (default 2) */
  maxConcurrency?: number;
}

interface EmbeddingRequest {
  input: string[];
}

interface EmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

interface PendingRecord {
  record: SemanticMemoryRecord;
  retryCount: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_CONCURRENCY = 2;
const MAX_INPUT_LENGTH = 8192; // Characters per text input

// ─── Service ────────────────────────────────────────────────────────────────

export class EmbeddingService {
  private pool: Pool;
  private semanticService: SemanticMemoryService;
  private config: Required<EmbeddingServiceConfig>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;
  private isShuttingDown = false;
  private retryMap: Map<string, number> = new Map();
  private activeRequests = 0;

  constructor(pool: Pool, semanticService: SemanticMemoryService, config: EmbeddingServiceConfig) {
    this.pool = pool;
    this.semanticService = semanticService;
    this.config = {
      workspaceHost: config.workspaceHost,
      endpointName: config.endpointName,
      modelName: config.modelName,
      modelVersion: config.modelVersion,
      token: config.token ?? process.env['DATABRICKS_TOKEN'] ?? '',
      batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
      pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      baseBackoffMs: config.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
      maxConcurrency: config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    };
  }

  /**
   * Start the background embedding generation loop.
   * Non-blocking: returns immediately, processes in the background.
   */
  start(): void {
    if (this.timer) {
      console.warn('[embeddings] Service already running.');
      return;
    }

    console.log(
      `[embeddings] Starting background service (poll=${this.config.pollIntervalMs}ms, batch=${this.config.batchSize}).`,
    );

    // Initial run after a short delay
    setTimeout(() => this.processPendingBatch(), 5_000);

    // Recurring poll
    this.timer = setInterval(() => {
      if (!this.isProcessing && !this.isShuttingDown) {
        this.processPendingBatch();
      }
    }, this.config.pollIntervalMs);

    this.timer.unref(); // Don't prevent process exit
  }

  /**
   * Gracefully stop the embedding service.
   * Waits for in-flight requests to complete.
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Wait for active requests to complete (max 10s)
    const deadline = Date.now() + 10_000;
    while (this.activeRequests > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (this.activeRequests > 0) {
      console.warn(`[embeddings] Shutdown with ${this.activeRequests} active requests.`);
    } else {
      console.log('[embeddings] Shutdown complete.');
    }
  }

  /**
   * Process a batch of pending embedding records.
   * Fire-and-forget from the caller's perspective.
   */
  private async processPendingBatch(): Promise<void> {
    if (this.isProcessing || this.isShuttingDown) return;
    this.isProcessing = true;

    try {
      const pendingRecords = await this.semanticService.getPendingEmbeddings(
        this.config.batchSize,
      );

      if (pendingRecords.length === 0) return;

      console.log(`[embeddings] Processing ${pendingRecords.length} pending records.`);

      // Process in sub-batches respecting concurrency
      const subBatchSize = Math.ceil(pendingRecords.length / this.config.maxConcurrency);
      const subBatches: SemanticMemoryRecord[][] = [];

      for (let i = 0; i < pendingRecords.length; i += subBatchSize) {
        subBatches.push(pendingRecords.slice(i, i + subBatchSize));
      }

      await Promise.allSettled(
        subBatches.map((batch) => this.processSubBatch(batch)),
      );
    } catch (err) {
      console.error('[embeddings] Batch processing error:', err);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a sub-batch of records by calling the embedding endpoint.
   */
  private async processSubBatch(records: SemanticMemoryRecord[]): Promise<void> {
    this.activeRequests++;

    try {
      // Prepare inputs (truncate if necessary)
      const inputs = records.map((r) =>
        r.content.length > MAX_INPUT_LENGTH
          ? r.content.slice(0, MAX_INPUT_LENGTH)
          : r.content,
      );

      // Call the Databricks serving endpoint
      const embeddings = await this.callEmbeddingEndpoint(inputs);

      if (!embeddings) {
        // Endpoint failure — retry logic
        for (const record of records) {
          await this.handleFailure(record);
        }
        return;
      }

      // Store embeddings
      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const embedding = embeddings.data.find((d) => d.index === i);

        if (embedding) {
          try {
            await this.semanticService.setEmbedding(
              record.memoryId,
              record.projectId,
              embedding.embedding,
              this.config.modelName,
              this.config.modelVersion,
            );
            this.retryMap.delete(record.memoryId);
          } catch (err) {
            console.error(
              `[embeddings] Failed to store embedding for ${record.memoryId}:`,
              err,
            );
            await this.handleFailure(record);
          }
        } else {
          await this.handleFailure(record);
        }
      }
    } finally {
      this.activeRequests--;
    }
  }

  /**
   * Call the Databricks Foundation Model API embedding endpoint.
   * POST /serving-endpoints/{endpoint}/invocations
   */
  private async callEmbeddingEndpoint(
    inputs: string[],
  ): Promise<EmbeddingResponse | null> {
    const url = `${this.config.workspaceHost}/serving-endpoints/${this.config.endpointName}/invocations`;

    const body: EmbeddingRequest = { input: inputs };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000), // 30s timeout
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        console.error(
          `[embeddings] Endpoint returned ${response.status}: ${errorText}`,
        );

        // Rate limiting: back off
        if (response.status === 429) {
          const retryAfter = parseInt(
            response.headers.get('Retry-After') ?? '60',
            10,
          );
          console.warn(`[embeddings] Rate limited. Backing off ${retryAfter}s.`);
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        }

        return null;
      }

      return (await response.json()) as EmbeddingResponse;
    } catch (err) {
      console.error('[embeddings] Endpoint request failed:', err);
      return null;
    }
  }

  /**
   * Handle a failed embedding attempt with exponential backoff.
   * Marks as 'failed' after exhausting retries.
   */
  private async handleFailure(record: SemanticMemoryRecord): Promise<void> {
    const currentRetries = this.retryMap.get(record.memoryId) ?? 0;
    const nextRetry = currentRetries + 1;

    if (nextRetry >= this.config.maxRetries) {
      console.error(
        `[embeddings] Terminal failure for ${record.memoryId} after ${nextRetry} attempts.`,
      );
      this.retryMap.delete(record.memoryId);
      await this.semanticService.markEmbeddingFailed(record.memoryId, record.projectId);
      return;
    }

    this.retryMap.set(record.memoryId, nextRetry);

    // Exponential backoff: base * 2^retry
    const backoffMs = this.config.baseBackoffMs * Math.pow(2, currentRetries);
    console.warn(
      `[embeddings] Retry ${nextRetry}/${this.config.maxRetries} for ${record.memoryId} in ${backoffMs}ms.`,
    );

    // Schedule retry (non-blocking)
    setTimeout(async () => {
      if (this.isShuttingDown) return;
      try {
        await this.processSubBatch([record]);
      } catch (err) {
        console.error(`[embeddings] Retry failed for ${record.memoryId}:`, err);
      }
    }, backoffMs);
  }

  /**
   * Manually trigger embedding generation for specific records.
   * Useful for testing or priority processing.
   */
  async generateForRecords(records: SemanticMemoryRecord[]): Promise<void> {
    await this.processSubBatch(records);
  }

  /**
   * Get service status for health checks.
   */
  getStatus(): {
    running: boolean;
    processing: boolean;
    activeRequests: number;
    pendingRetries: number;
  } {
    return {
      running: this.timer !== null,
      processing: this.isProcessing,
      activeRequests: this.activeRequests,
      pendingRetries: this.retryMap.size,
    };
  }
}
