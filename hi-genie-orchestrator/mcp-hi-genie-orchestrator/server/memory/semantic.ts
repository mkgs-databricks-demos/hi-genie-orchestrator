/**
 * Long-Term Semantic Memory
 *
 * Compacted, deduplicated facts with pgvector embeddings for similarity search.
 * Backed by `state.semantic_memory` table (created by migration 003).
 *
 * Design decisions:
 *   - Decision 18: Semantic records are derived from episodic records
 *   - Decision 19: In-project only, pgvector via lakebase_vector + lakebase_ann
 *   - Decision 20: Embeddings are async-derived, not blocking
 *   - Uses `<=>` operator for cosine distance (lower = more similar)
 *
 * All operations are project-scoped via `projectId` parameter.
 */

import type { Pool } from 'pg';
import { withDbSpan } from '../telemetry/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SemanticMemoryType = 'PATTERN' | 'CONVENTION' | 'LESSON' | 'FACT';

export type EmbeddingStatus = 'pending' | 'ready' | 'failed';

export interface SemanticMemoryRecord {
  memoryId: string;
  projectId: string;
  workstreamId: string | null;
  developerId: string;
  memoryType: SemanticMemoryType;
  content: string;
  embedding: number[] | null;
  embeddingModel: string | null;
  embeddingModelVersion: string | null;
  embeddingStatus: EmbeddingStatus;
  embeddingGeneratedAt: Date | null;
  sourceEpisodicIds: string[];
  importance: number;
  accessCount: number;
  lastAccessedAt: Date | null;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSemanticMemoryInput {
  memoryId: string;
  projectId: string;
  workstreamId?: string | null;
  developerId: string;
  memoryType: SemanticMemoryType;
  content: string;
  sourceEpisodicIds?: string[];
  importance?: number; // 0-100, default 50
  tags?: string[];
}

export interface SimilaritySearchOptions {
  projectId: string;
  queryEmbedding: number[]; // 1536-dimensional vector
  k?: number; // Top-K results, default 10
  threshold?: number; // Minimum similarity (0-1), default 0.7
  memoryType?: SemanticMemoryType;
  workstreamId?: string;
  developerId?: string;
}

export interface SimilarityResult {
  record: SemanticMemoryRecord;
  similarity: number; // 0-1 (1 = identical)
}

export interface DeduplicationResult {
  isDuplicate: boolean;
  existingMemoryId: string | null;
  similarity: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_K = 10;
const MAX_K = 50;
const DEFAULT_SIMILARITY_THRESHOLD = 0.7;
const DEDUP_SIMILARITY_THRESHOLD = 0.95; // Threshold for considering content duplicate
const EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_IMPORTANCE = 50;

// ─── Service ────────────────────────────────────────────────────────────────

export class SemanticMemoryService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Store a new semantic memory record.
   * Embedding starts as `pending` — background job fills it in.
   * Idempotent via ON CONFLICT (memory_id) DO NOTHING.
   */
  async store(input: CreateSemanticMemoryInput): Promise<SemanticMemoryRecord> {
    const importance = Math.min(Math.max(input.importance ?? DEFAULT_IMPORTANCE, 0), 100);

    const sql = `
      INSERT INTO state.semantic_memory (
        memory_id, project_id, workstream_id, developer_id,
        memory_type, content, embedding_status,
        source_episodic_ids, importance, tags,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, 'pending',
        $7::jsonb, $8, $9::jsonb,
        now(), now()
      )
      ON CONFLICT (memory_id) DO NOTHING
      RETURNING *
    `;

    const params = [
      input.memoryId,
      input.projectId,
      input.workstreamId ?? null,
      input.developerId,
      input.memoryType,
      input.content,
      JSON.stringify(input.sourceEpisodicIds ?? []),
      importance,
      JSON.stringify(input.tags ?? []),
    ];

    return withDbSpan('INSERT semantic_memory', async () => {
      const result = await this.pool.query(sql, params);

      if (result.rowCount === 0) {
        const existing = await this.getById(input.memoryId, input.projectId);
        if (!existing) {
          throw new Error(
            `Semantic memory conflict: memoryId=${input.memoryId} exists outside project=${input.projectId}`,
          );
        }
        return existing;
      }

      return this.mapRow(result.rows[0]);
    }, { project_id: input.projectId });
  }

  /**
   * Retrieve a single semantic memory record by ID.
   */
  async getById(
    memoryId: string,
    projectId: string,
  ): Promise<SemanticMemoryRecord | null> {
    const sql = `
      SELECT * FROM state.semantic_memory
      WHERE memory_id = $1 AND project_id = $2
    `;

    return withDbSpan('SELECT semantic_memory by id', async () => {
      const result = await this.pool.query(sql, [memoryId, projectId]);
      return result.rows[0] ? this.mapRow(result.rows[0]) : null;
    }, { project_id: projectId });
  }

  /**
   * Similarity search using cosine distance on the `lakebase_ann` index.
   * Returns top-K results above the similarity threshold, ordered by similarity.
   *
   * Cosine distance: 0 = identical, 2 = opposite.
   * We convert to similarity: 1 - distance (range 0-1, higher = more similar).
   */
  async similaritySearch(options: SimilaritySearchOptions): Promise<SimilarityResult[]> {
    if (options.queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding must be ${EMBEDDING_DIMENSIONS}-dimensional, got ${options.queryEmbedding.length}`,
      );
    }

    const k = Math.min(options.k ?? DEFAULT_K, MAX_K);
    const threshold = options.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    const maxDistance = 1 - threshold; // Convert similarity threshold to max distance

    const conditions: string[] = [
      'project_id = $1',
      "embedding_status = 'ready'",
      'embedding IS NOT NULL',
      `(embedding <=> $2::vector) <= ${maxDistance}`,
    ];
    const params: unknown[] = [
      options.projectId,
      `[${options.queryEmbedding.join(',')}]`,
    ];
    let paramIdx = 3;

    if (options.memoryType) {
      conditions.push(`memory_type = ${paramIdx}`);
      params.push(options.memoryType);
      paramIdx++;
    }

    if (options.workstreamId) {
      conditions.push(`workstream_id = ${paramIdx}`);
      params.push(options.workstreamId);
      paramIdx++;
    }

    if (options.developerId) {
      conditions.push(`developer_id = ${paramIdx}`);
      params.push(options.developerId);
      paramIdx++;
    }

    const sql = `
      SELECT *,
        (1 - (embedding <=> $2::vector)) AS similarity
      FROM state.semantic_memory
      WHERE ${conditions.join(' AND ')}
      ORDER BY embedding <=> $2::vector ASC
      LIMIT ${k}
    `;

    return withDbSpan('SELECT semantic_memory similarity', async () => {
      const result = await this.pool.query(sql, params);

      // Update access counts for retrieved records
      if (result.rows.length > 0) {
        const ids = result.rows.map((r) => r.memory_id);
        await this.incrementAccessCounts(ids, options.projectId);
      }

      return result.rows.map((row) => ({
        record: this.mapRow(row),
        similarity: parseFloat(row.similarity),
      }));
    }, { project_id: options.projectId });
  }

  /**
   * Check if content is semantically duplicate within a project.
   * Uses a high similarity threshold (0.95) to detect near-identical facts.
   * Requires the content's embedding to be pre-computed.
   */
  async checkDuplicate(
    projectId: string,
    contentEmbedding: number[],
    excludeMemoryId?: string,
  ): Promise<DeduplicationResult> {
    if (contentEmbedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding must be ${EMBEDDING_DIMENSIONS}-dimensional, got ${contentEmbedding.length}`,
      );
    }

    const conditions: string[] = [
      'project_id = $1',
      "embedding_status = 'ready'",
      'embedding IS NOT NULL',
      `(embedding <=> $2::vector) <= ${1 - DEDUP_SIMILARITY_THRESHOLD}`,
    ];
    const params: unknown[] = [
      projectId,
      `[${contentEmbedding.join(',')}]`,
    ];

    if (excludeMemoryId) {
      conditions.push('memory_id != $3');
      params.push(excludeMemoryId);
    }

    const sql = `
      SELECT memory_id,
        (1 - (embedding <=> $2::vector)) AS similarity
      FROM state.semantic_memory
      WHERE ${conditions.join(' AND ')}
      ORDER BY embedding <=> $2::vector ASC
      LIMIT 1
    `;

    return withDbSpan('SELECT semantic_memory dedup check', async () => {
      const result = await this.pool.query(sql, params);

      if (result.rows.length === 0) {
        return { isDuplicate: false, existingMemoryId: null, similarity: 0 };
      }

      return {
        isDuplicate: true,
        existingMemoryId: result.rows[0].memory_id,
        similarity: parseFloat(result.rows[0].similarity),
      };
    }, { project_id: projectId });
  }

  /**
   * Update the embedding for a semantic memory record.
   * Called by the background embedding generation service.
   */
  async setEmbedding(
    memoryId: string,
    projectId: string,
    embedding: number[],
    model: string,
    modelVersion: string,
  ): Promise<void> {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding must be ${EMBEDDING_DIMENSIONS}-dimensional, got ${embedding.length}`,
      );
    }

    const sql = `
      UPDATE state.semantic_memory
      SET embedding = $3::vector,
          embedding_model = $4,
          embedding_model_version = $5,
          embedding_status = 'ready',
          embedding_generated_at = now(),
          updated_at = now()
      WHERE memory_id = $1 AND project_id = $2
    `;

    await withDbSpan('UPDATE semantic_memory embedding', async () => {
      const result = await this.pool.query(sql, [
        memoryId,
        projectId,
        `[${embedding.join(',')}]`,
        model,
        modelVersion,
      ]);
      if (result.rowCount === 0) {
        throw new Error(
          `Semantic memory not found: memoryId=${memoryId}, projectId=${projectId}`,
        );
      }
    }, { project_id: projectId });
  }

  /**
   * Mark an embedding as failed.
   * Called by the background embedding service on terminal failure.
   */
  async markEmbeddingFailed(memoryId: string, projectId: string): Promise<void> {
    const sql = `
      UPDATE state.semantic_memory
      SET embedding_status = 'failed',
          updated_at = now()
      WHERE memory_id = $1 AND project_id = $2
    `;

    await withDbSpan('UPDATE semantic_memory failed', async () => {
      await this.pool.query(sql, [memoryId, projectId]);
    }, { project_id: projectId });
  }

  /**
   * Get records pending embedding generation.
   * Used by the background embedding job to find work.
   */
  async getPendingEmbeddings(limit: number = 50): Promise<SemanticMemoryRecord[]> {
    const sql = `
      SELECT * FROM state.semantic_memory
      WHERE embedding_status = 'pending'
      ORDER BY created_at ASC
      LIMIT $1
    `;

    return withDbSpan('SELECT semantic_memory pending', async () => {
      const result = await this.pool.query(sql, [limit]);
      return result.rows.map((row) => this.mapRow(row));
    });
  }

  /**
   * Get memory records by project, optionally filtered.
   */
  async queryByProject(
    projectId: string,
    options?: {
      memoryType?: SemanticMemoryType;
      workstreamId?: string;
      minImportance?: number;
      limit?: number;
    },
  ): Promise<SemanticMemoryRecord[]> {
    const conditions: string[] = ['project_id = $1'];
    const params: unknown[] = [projectId];
    let paramIdx = 2;

    if (options?.memoryType) {
      conditions.push(`memory_type = ${paramIdx}`);
      params.push(options.memoryType);
      paramIdx++;
    }

    if (options?.workstreamId) {
      conditions.push(`workstream_id = ${paramIdx}`);
      params.push(options.workstreamId);
      paramIdx++;
    }

    if (options?.minImportance !== undefined) {
      conditions.push(`importance >= ${paramIdx}`);
      params.push(options.minImportance);
      paramIdx++;
    }

    const limit = Math.min(options?.limit ?? DEFAULT_K, MAX_K);

    const sql = `
      SELECT * FROM state.semantic_memory
      WHERE ${conditions.join(' AND ')}
      ORDER BY importance DESC, access_count DESC, created_at DESC
      LIMIT ${limit}
    `;

    return withDbSpan('SELECT semantic_memory by project', async () => {
      const result = await this.pool.query(sql, params);
      return result.rows.map((row) => this.mapRow(row));
    }, { project_id: projectId });
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async incrementAccessCounts(
    memoryIds: string[],
    projectId: string,
  ): Promise<void> {
    const sql = `
      UPDATE state.semantic_memory
      SET access_count = access_count + 1,
          last_accessed_at = now(),
          updated_at = now()
      WHERE memory_id = ANY($1) AND project_id = $2
    `;

    await withDbSpan('UPDATE semantic_memory access_count', async () => {
      await this.pool.query(sql, [memoryIds, projectId]);
    }, { project_id: projectId });
  }

  private mapRow(row: Record<string, unknown>): SemanticMemoryRecord {
    return {
      memoryId: row.memory_id as string,
      projectId: row.project_id as string,
      workstreamId: row.workstream_id as string | null,
      developerId: row.developer_id as string,
      memoryType: row.memory_type as SemanticMemoryType,
      content: row.content as string,
      embedding: row.embedding ? this.parseVector(row.embedding) : null,
      embeddingModel: row.embedding_model as string | null,
      embeddingModelVersion: row.embedding_model_version as string | null,
      embeddingStatus: row.embedding_status as EmbeddingStatus,
      embeddingGeneratedAt: row.embedding_generated_at
        ? new Date(row.embedding_generated_at as string)
        : null,
      sourceEpisodicIds: (Array.isArray(row.source_episodic_ids)
        ? row.source_episodic_ids
        : []) as string[],
      importance: row.importance as number,
      accessCount: row.access_count as number,
      lastAccessedAt: row.last_accessed_at
        ? new Date(row.last_accessed_at as string)
        : null,
      tags: (Array.isArray(row.tags) ? row.tags : []) as string[],
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  /**
   * Parse a pgvector string representation `[0.1,0.2,...]` to number array.
   */
  private parseVector(value: unknown): number[] {
    if (Array.isArray(value)) return value as number[];
    if (typeof value === 'string') {
      const trimmed = value.replace(/^\[|\]$/g, '');
      return trimmed.split(',').map(Number);
    }
    return [];
  }
}
