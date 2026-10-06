/**
 * Short-Term Session Memory
 *
 * Thread/session-scoped working context with configurable TTL (1-7 days).
 * Backed by `state.short_term_memory` table (created by migration 003).
 *
 * Design decisions:
 *   - Decision 18: Short-term memory is bounded and session-scoped
 *   - Decision 2: Mutable state with optimistic concurrency (updated_at)
 *   - Decision 19: Project-scoped, RLS-protected
 *
 * All operations are project-scoped via `projectId` parameter.
 * Uses `withDbSpan` from telemetry for observability.
 */

import type { Pool } from 'pg';
import { withDbSpan } from '../telemetry/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ShortTermMemoryType = 'WORKING_CONTEXT' | 'THREAD_SUMMARY' | 'SCRATCH';

export interface ShortTermMemoryRecord {
  memoryId: string;
  projectId: string;
  workstreamId: string | null;
  sessionId: string;
  developerId: string;
  memoryType: ShortTermMemoryType;
  content: string;
  metadata: Record<string, unknown>;
  ttlDays: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateShortTermMemoryInput {
  memoryId: string;
  projectId: string;
  workstreamId?: string | null;
  sessionId: string;
  developerId: string;
  memoryType: ShortTermMemoryType;
  content: string;
  metadata?: Record<string, unknown>;
  ttlDays?: number; // 1-7, default 3
}

export interface UpdateShortTermMemoryInput {
  memoryId: string;
  projectId: string;
  content?: string;
  metadata?: Record<string, unknown>;
  ttlDays?: number;
  expectedUpdatedAt: Date; // Optimistic concurrency
}

export interface ShortTermQueryOptions {
  projectId: string;
  sessionId?: string;
  workstreamId?: string;
  developerId?: string;
  memoryType?: ShortTermMemoryType;
  limit?: number; // Max items per query, default 50
  includeExpired?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TTL_DAYS = 3;
const MIN_TTL_DAYS = 1;
const MAX_TTL_DAYS = 7;
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 200;

// ─── Service ────────────────────────────────────────────────────────────────

export class ShortTermMemoryService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Create a new short-term memory record.
   * Computes `expires_at` from `created_at + ttl_days`.
   */
  async create(input: CreateShortTermMemoryInput): Promise<ShortTermMemoryRecord> {
    const ttlDays = Math.min(
      Math.max(input.ttlDays ?? DEFAULT_TTL_DAYS, MIN_TTL_DAYS),
      MAX_TTL_DAYS,
    );

    const sql = `
      INSERT INTO state.short_term_memory (
        memory_id, project_id, workstream_id, session_id,
        developer_id, memory_type, content, metadata,
        ttl_days, expires_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8::jsonb,
        $9, now() + ($9 || ' days')::interval, now(), now()
      )
      RETURNING *
    `;

    const params = [
      input.memoryId,
      input.projectId,
      input.workstreamId ?? null,
      input.sessionId,
      input.developerId,
      input.memoryType,
      input.content,
      JSON.stringify(input.metadata ?? {}),
      ttlDays,
    ];

    return withDbSpan('INSERT short_term_memory', async () => {
      const result = await this.pool.query(sql, params);
      return this.mapRow(result.rows[0]);
    }, { project_id: input.projectId });
  }

  /**
   * Update an existing short-term memory record.
   * Uses optimistic concurrency via `updated_at` comparison.
   * Throws if the record was modified since the caller last read it.
   */
  async update(input: UpdateShortTermMemoryInput): Promise<ShortTermMemoryRecord> {
    const setClauses: string[] = ['updated_at = now()'];
    const params: unknown[] = [input.memoryId, input.projectId, input.expectedUpdatedAt];
    let paramIdx = 4;

    if (input.content !== undefined) {
      setClauses.push(`content = ${paramIdx}`);
      params.push(input.content);
      paramIdx++;
    }

    if (input.metadata !== undefined) {
      setClauses.push(`metadata = ${paramIdx}::jsonb`);
      params.push(JSON.stringify(input.metadata));
      paramIdx++;
    }

    if (input.ttlDays !== undefined) {
      const ttlDays = Math.min(Math.max(input.ttlDays, MIN_TTL_DAYS), MAX_TTL_DAYS);
      setClauses.push(`ttl_days = ${paramIdx}`);
      params.push(ttlDays);
      paramIdx++;
      setClauses.push(`expires_at = created_at + (${paramIdx - 1} || ' days')::interval`);
    }

    const sql = `
      UPDATE state.short_term_memory
      SET ${setClauses.join(', ')}
      WHERE memory_id = $1
        AND project_id = $2
        AND updated_at = $3
      RETURNING *
    `;

    return withDbSpan('UPDATE short_term_memory', async () => {
      const result = await this.pool.query(sql, params);
      if (result.rowCount === 0) {
        throw new ConcurrencyError(
          'short_term_memory',
          input.memoryId,
          'Record was modified by another process or does not exist.',
        );
      }
      return this.mapRow(result.rows[0]);
    }, { project_id: input.projectId });
  }

  /**
   * Retrieve a single short-term memory record by ID.
   * Project-scoped for RLS enforcement.
   */
  async getById(
    memoryId: string,
    projectId: string,
  ): Promise<ShortTermMemoryRecord | null> {
    const sql = `
      SELECT * FROM state.short_term_memory
      WHERE memory_id = $1 AND project_id = $2
    `;

    return withDbSpan('SELECT short_term_memory by id', async () => {
      const result = await this.pool.query(sql, [memoryId, projectId]);
      return result.rows[0] ? this.mapRow(result.rows[0]) : null;
    }, { project_id: projectId });
  }

  /**
   * Query short-term memory with filters.
   * Returns non-expired records by default, ordered by creation (newest first).
   * Bounded by configurable limit (max 200).
   */
  async query(options: ShortTermQueryOptions): Promise<ShortTermMemoryRecord[]> {
    const conditions: string[] = ['project_id = $1'];
    const params: unknown[] = [options.projectId];
    let paramIdx = 2;

    if (!options.includeExpired) {
      conditions.push('expires_at > now()');
    }

    if (options.sessionId) {
      conditions.push(`session_id = ${paramIdx}`);
      params.push(options.sessionId);
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

    if (options.memoryType) {
      conditions.push(`memory_type = ${paramIdx}`);
      params.push(options.memoryType);
      paramIdx++;
    }

    const limit = Math.min(options.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);

    const sql = `
      SELECT * FROM state.short_term_memory
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    return withDbSpan('SELECT short_term_memory query', async () => {
      const result = await this.pool.query(sql, params);
      return result.rows.map((row) => this.mapRow(row));
    }, { project_id: options.projectId });
  }

  /**
   * Delete a specific short-term memory record.
   * Project-scoped.
   */
  async delete(memoryId: string, projectId: string): Promise<boolean> {
    const sql = `
      DELETE FROM state.short_term_memory
      WHERE memory_id = $1 AND project_id = $2
    `;

    return withDbSpan('DELETE short_term_memory', async () => {
      const result = await this.pool.query(sql, [memoryId, projectId]);
      return (result.rowCount ?? 0) > 0;
    }, { project_id: projectId });
  }

  /**
   * Delete all expired records across all projects.
   * Intended for background cleanup scheduling, not request-path.
   */
  async deleteExpired(): Promise<number> {
    const sql = `
      DELETE FROM state.short_term_memory
      WHERE expires_at <= now()
    `;

    return withDbSpan('DELETE short_term_memory expired', async () => {
      const result = await this.pool.query(sql);
      return result.rowCount ?? 0;
    });
  }

  /**
   * Get count of active (non-expired) records for a session.
   */
  async getSessionCount(sessionId: string, projectId: string): Promise<number> {
    const sql = `
      SELECT COUNT(*) as count FROM state.short_term_memory
      WHERE session_id = $1 AND project_id = $2 AND expires_at > now()
    `;

    return withDbSpan('SELECT short_term_memory count', async () => {
      const result = await this.pool.query(sql, [sessionId, projectId]);
      return parseInt(result.rows[0].count, 10);
    }, { project_id: projectId });
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private mapRow(row: Record<string, unknown>): ShortTermMemoryRecord {
    return {
      memoryId: row.memory_id as string,
      projectId: row.project_id as string,
      workstreamId: row.workstream_id as string | null,
      sessionId: row.session_id as string,
      developerId: row.developer_id as string,
      memoryType: row.memory_type as ShortTermMemoryType,
      content: row.content as string,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      ttlDays: row.ttl_days as number,
      expiresAt: new Date(row.expires_at as string),
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class ConcurrencyError extends Error {
  public readonly table: string;
  public readonly recordId: string;

  constructor(table: string, recordId: string, message: string) {
    super(message);
    this.name = 'ConcurrencyError';
    this.table = table;
    this.recordId = recordId;
  }
}
