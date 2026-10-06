/**
 * Long-Term Episodic Memory
 *
 * Stores redacted session summaries, execution outcomes, errors, and blockers.
 * Backed by `state.episodic_memory` table (created by migration 003).
 *
 * Design decisions:
 *   - Decision 18: Episodic records are canonical long-term memory
 *   - Decision 2: Append-only, immutable after creation
 *   - Decision 19: Project-scoped, RLS-protected
 *   - Decision 15: Uses memory_id as idempotency key for retry-safe writes
 *
 * All operations are project-scoped via `projectId` parameter.
 */

import type { Pool } from 'pg';
import { withDbSpan } from '../telemetry/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type EpisodicMemoryType =
  | 'SESSION_SUMMARY'
  | 'EXECUTION_OUTCOME'
  | 'ERROR_RECORD'
  | 'BLOCKER_RECORD';

export interface EpisodicMemoryRecord {
  memoryId: string;
  projectId: string;
  workstreamId: string | null;
  sessionId: string | null;
  developerId: string;
  memoryType: EpisodicMemoryType;
  title: string;
  content: string;
  sourceRef: Record<string, unknown>;
  importance: number; // 0-100
  tags: string[];
  createdAt: Date;
}

export interface CreateEpisodicMemoryInput {
  memoryId: string; // Idempotency key (UUID)
  projectId: string;
  workstreamId?: string | null;
  sessionId?: string | null;
  developerId: string;
  memoryType: EpisodicMemoryType;
  title: string;
  content: string;
  sourceRef?: Record<string, unknown>;
  importance?: number; // 0-100, default 50
  tags?: string[];
}

export interface EpisodicQueryOptions {
  projectId: string;
  workstreamId?: string;
  sessionId?: string;
  developerId?: string;
  memoryType?: EpisodicMemoryType;
  minImportance?: number;
  tags?: string[];
  createdAfter?: Date;
  createdBefore?: Date;
  limit?: number; // Default 50
  offset?: number; // Pagination
}

export interface PaginatedEpisodicResult {
  records: EpisodicMemoryRecord[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_IMPORTANCE = 50;
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 200;

// ─── Service ────────────────────────────────────────────────────────────────

export class EpisodicMemoryService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Append a new episodic memory record.
   * Idempotent via `ON CONFLICT (memory_id) DO NOTHING`.
   * Returns the existing record if the memoryId was already written.
   */
  async append(input: CreateEpisodicMemoryInput): Promise<EpisodicMemoryRecord> {
    const importance = Math.min(Math.max(input.importance ?? DEFAULT_IMPORTANCE, 0), 100);

    const sql = `
      INSERT INTO state.episodic_memory (
        memory_id, project_id, workstream_id, session_id,
        developer_id, memory_type, title, content,
        source_ref, importance, tags, created_at
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9::jsonb, $10, $11::jsonb, now()
      )
      ON CONFLICT (memory_id) DO NOTHING
      RETURNING *
    `;

    const params = [
      input.memoryId,
      input.projectId,
      input.workstreamId ?? null,
      input.sessionId ?? null,
      input.developerId,
      input.memoryType,
      input.title,
      input.content,
      JSON.stringify(input.sourceRef ?? {}),
      importance,
      JSON.stringify(input.tags ?? []),
    ];

    return withDbSpan('INSERT episodic_memory', async () => {
      const result = await this.pool.query(sql, params);

      // If conflict (idempotent retry), fetch the existing record
      if (result.rowCount === 0) {
        const existing = await this.getById(input.memoryId, input.projectId);
        if (!existing) {
          throw new Error(
            `Episodic memory conflict: memoryId=${input.memoryId} exists but is not accessible in project=${input.projectId}`,
          );
        }
        return existing;
      }

      return this.mapRow(result.rows[0]);
    }, { project_id: input.projectId });
  }

  /**
   * Retrieve a single episodic memory record by ID.
   */
  async getById(
    memoryId: string,
    projectId: string,
  ): Promise<EpisodicMemoryRecord | null> {
    const sql = `
      SELECT * FROM state.episodic_memory
      WHERE memory_id = $1 AND project_id = $2
    `;

    return withDbSpan('SELECT episodic_memory by id', async () => {
      const result = await this.pool.query(sql, [memoryId, projectId]);
      return result.rows[0] ? this.mapRow(result.rows[0]) : null;
    }, { project_id: projectId });
  }

  /**
   * Query episodic memory with filters, pagination, and temporal filtering.
   * Returns paginated results ordered by created_at DESC.
   */
  async query(options: EpisodicQueryOptions): Promise<PaginatedEpisodicResult> {
    const conditions: string[] = ['project_id = $1'];
    const params: unknown[] = [options.projectId];
    let paramIdx = 2;

    if (options.workstreamId) {
      conditions.push(`workstream_id = ${paramIdx}`);
      params.push(options.workstreamId);
      paramIdx++;
    }

    if (options.sessionId) {
      conditions.push(`session_id = ${paramIdx}`);
      params.push(options.sessionId);
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

    if (options.minImportance !== undefined) {
      conditions.push(`importance >= ${paramIdx}`);
      params.push(options.minImportance);
      paramIdx++;
    }

    if (options.tags && options.tags.length > 0) {
      conditions.push(`tags ?| ${paramIdx}`);
      params.push(options.tags);
      paramIdx++;
    }

    if (options.createdAfter) {
      conditions.push(`created_at >= ${paramIdx}`);
      params.push(options.createdAfter.toISOString());
      paramIdx++;
    }

    if (options.createdBefore) {
      conditions.push(`created_at <= ${paramIdx}`);
      params.push(options.createdBefore.toISOString());
      paramIdx++;
    }

    const limit = Math.min(options.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
    const offset = options.offset ?? 0;
    const whereClause = conditions.join(' AND ');

    // Count total matching records
    const countSql = `
      SELECT COUNT(*) as total FROM state.episodic_memory
      WHERE ${whereClause}
    `;

    // Fetch paginated results
    const dataSql = `
      SELECT * FROM state.episodic_memory
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    return withDbSpan('SELECT episodic_memory query', async () => {
      const [countResult, dataResult] = await Promise.all([
        this.pool.query(countSql, params),
        this.pool.query(dataSql, params),
      ]);

      const total = parseInt(countResult.rows[0].total, 10);
      const records = dataResult.rows.map((row) => this.mapRow(row));

      return {
        records,
        total,
        limit,
        offset,
        hasMore: offset + records.length < total,
      };
    }, { project_id: options.projectId });
  }

  /**
   * Get recent session summaries for a project.
   * Convenience method for the `get_recent_session_summaries` MCP tool.
   */
  async getRecentSummaries(
    projectId: string,
    options?: {
      developerId?: string;
      workstreamId?: string;
      limit?: number;
      sinceDate?: Date;
    },
  ): Promise<EpisodicMemoryRecord[]> {
    const result = await this.query({
      projectId,
      memoryType: 'SESSION_SUMMARY',
      developerId: options?.developerId,
      workstreamId: options?.workstreamId,
      createdAfter: options?.sinceDate,
      limit: options?.limit ?? 20,
    });
    return result.records;
  }

  /**
   * Get relevant errors for a project, ordered by importance then recency.
   * Convenience method for the `get_relevant_errors` MCP tool.
   */
  async getRelevantErrors(
    projectId: string,
    options?: {
      workstreamId?: string;
      minImportance?: number;
      limit?: number;
    },
  ): Promise<EpisodicMemoryRecord[]> {
    const conditions: string[] = [
      'project_id = $1',
      "memory_type IN ('ERROR_RECORD', 'BLOCKER_RECORD')",
    ];
    const params: unknown[] = [projectId];
    let paramIdx = 2;

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

    const limit = Math.min(options?.limit ?? 20, MAX_QUERY_LIMIT);

    const sql = `
      SELECT * FROM state.episodic_memory
      WHERE ${conditions.join(' AND ')}
      ORDER BY importance DESC, created_at DESC
      LIMIT ${limit}
    `;

    return withDbSpan('SELECT episodic_memory errors', async () => {
      const result = await this.pool.query(sql, params);
      return result.rows.map((row) => this.mapRow(row));
    }, { project_id: projectId });
  }

  /**
   * Get total count of episodic records for a project.
   */
  async getCount(projectId: string): Promise<number> {
    const sql = `
      SELECT COUNT(*) as count FROM state.episodic_memory
      WHERE project_id = $1
    `;

    return withDbSpan('SELECT episodic_memory count', async () => {
      const result = await this.pool.query(sql, [projectId]);
      return parseInt(result.rows[0].count, 10);
    }, { project_id: projectId });
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private mapRow(row: Record<string, unknown>): EpisodicMemoryRecord {
    return {
      memoryId: row.memory_id as string,
      projectId: row.project_id as string,
      workstreamId: row.workstream_id as string | null,
      sessionId: row.session_id as string | null,
      developerId: row.developer_id as string,
      memoryType: row.memory_type as EpisodicMemoryType,
      title: row.title as string,
      content: row.content as string,
      sourceRef: (row.source_ref ?? {}) as Record<string, unknown>,
      importance: row.importance as number,
      tags: (Array.isArray(row.tags) ? row.tags : []) as string[],
      createdAt: new Date(row.created_at as string),
    };
  }
}
