/**
 * Project Service — Business Logic Layer
 *
 * Extracted service functions for project management. Called by:
 *   - REST routes (server/api/routes/projects.ts) — maps ServiceResult to HTTP
 *   - MCP tool handler (server/mcp/tools/projects.ts) — create_project only
 *
 * All functions accept a Pool + userId + typed input.
 * Returns ServiceResult<T> — never throws for business-logic failures.
 *
 * NOTE: update_project, archive, unarchive, and transfer_ownership are
 * REST API-only operations for the management UI. The MCP surface exposes
 * only create_project (architect persona). See migration 009 design notes.
 *
 * RLS pattern: BEGIN → set_config('app.user_identity', userId, true) → DML → COMMIT/ROLLBACK
 */

import type { Pool } from 'pg';
import { withToolSpan, withDbSpan } from '../telemetry/index.js';
import { type ServiceResult, success, notFound, badRequest } from './types.js';

// ── Input Types ─────────────────────────────────────────────────────────────────────

export interface CreateProjectInput {
  name: string;
  description?: string;
  tags?: Record<string, unknown>;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  tags?: Record<string, unknown>;
}

export interface TransferOwnershipInput {
  new_owner: string;
}

// ── Output Types ────────────────────────────────────────────────────────────────────

export interface ProjectRow {
  project_id: string;
  name: string;
  description: string | null;
  status: string;
  owner: string;
  tags: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// ── Constants ───────────────────────────────────────────────────────────────────────

const PROJECT_COLUMNS = `
  project_id, name, description, status, owner, tags,
  created_by, created_at, updated_at
`;

// ── Service Functions ───────────────────────────────────────────────────────────────

/**
 * Create a new project.
 * Called by both the MCP create_project tool and POST /api/v1/projects.
 */
export async function createProject(
  pool: Pool,
  userId: string,
  input: CreateProjectInput,
): Promise<ServiceResult<{ project: ProjectRow }>> {
  return withToolSpan('service.projects.create', async () => {
    const { name, description, tags } = input;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);

      const result = await withDbSpan('dispatch.projects.insert', async () => {
        return client.query(
          `INSERT INTO dispatch.projects
             (name, description, owner, tags, created_by)
           VALUES ($1, $2, $3, $4::jsonb, $5)
           RETURNING ${PROJECT_COLUMNS}`,
          [name, description ?? null, userId, JSON.stringify(tags ?? {}), userId],
        );
      });

      await client.query('COMMIT');
      return success({ project: result.rows[0] }, 201);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Get a project by ID.
 */
export async function getProject(
  pool: Pool,
  projectId: string,
): Promise<ServiceResult<{ project: ProjectRow }>> {
  return withToolSpan('service.projects.get', async () => {
    const result = await withDbSpan('dispatch.projects.select', async () => {
      return pool.query(
        `SELECT ${PROJECT_COLUMNS} FROM dispatch.projects WHERE project_id = $1`,
        [projectId],
      );
    });

    if (result.rows.length === 0) {
      return notFound('Project not found');
    }
    return success({ project: result.rows[0] });
  });
}

/**
 * Update a project's mutable fields (name, description, tags).
 * Only the owner or the original creator can update.
 */
export async function updateProject(
  pool: Pool,
  userId: string,
  projectId: string,
  input: UpdateProjectInput,
): Promise<ServiceResult<{ project: ProjectRow }>> {
  return withToolSpan('service.projects.update', async () => {
    const { name, description, tags } = input;

    // Build dynamic SET clause
    const setClauses: string[] = ['updated_at = now()'];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (name !== undefined) {
      setClauses.push(`name = $${paramIdx}`);
      values.push(name);
      paramIdx++;
    }
    if (description !== undefined) {
      setClauses.push(`description = $${paramIdx}`);
      values.push(description);
      paramIdx++;
    }
    if (tags !== undefined) {
      setClauses.push(`tags = $${paramIdx}::jsonb`);
      values.push(JSON.stringify(tags));
      paramIdx++;
    }

    if (setClauses.length === 1) {
      // Only updated_at — no actual changes
      return badRequest('No fields to update');
    }

    values.push(projectId);
    const projectIdParam = `$${paramIdx}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);

      const result = await withDbSpan('dispatch.projects.update', async () => {
        return client.query(
          `UPDATE dispatch.projects
           SET ${setClauses.join(', ')}
           WHERE project_id = ${projectIdParam}
           RETURNING ${PROJECT_COLUMNS}`,
          values,
        );
      });

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFound('Project not found');
      }

      await client.query('COMMIT');
      return success({ project: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Archive a project (set status = 'archived').
 * Prevents new plans/workstreams from being created against it.
 */
export async function archiveProject(
  pool: Pool,
  userId: string,
  projectId: string,
): Promise<ServiceResult<{ project: ProjectRow }>> {
  return withToolSpan('service.projects.archive', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);

      const result = await withDbSpan('dispatch.projects.archive', async () => {
        return client.query(
          `UPDATE dispatch.projects
           SET status = 'archived', updated_at = now()
           WHERE project_id = $1 AND status = 'active'
           RETURNING ${PROJECT_COLUMNS}`,
          [projectId],
        );
      });

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        // Check if project exists but is already archived
        const exists = await client.query(
          'SELECT status FROM dispatch.projects WHERE project_id = $1',
          [projectId],
        );
        if (exists.rows.length === 0) return notFound('Project not found');
        return badRequest(`Cannot archive: project is already '${exists.rows[0].status}'`);
      }

      await client.query('COMMIT');
      return success({ project: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Unarchive a project (set status back to 'active').
 */
export async function unarchiveProject(
  pool: Pool,
  userId: string,
  projectId: string,
): Promise<ServiceResult<{ project: ProjectRow }>> {
  return withToolSpan('service.projects.unarchive', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);

      const result = await withDbSpan('dispatch.projects.unarchive', async () => {
        return client.query(
          `UPDATE dispatch.projects
           SET status = 'active', updated_at = now()
           WHERE project_id = $1 AND status = 'archived'
           RETURNING ${PROJECT_COLUMNS}`,
          [projectId],
        );
      });

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        const exists = await client.query(
          'SELECT status FROM dispatch.projects WHERE project_id = $1',
          [projectId],
        );
        if (exists.rows.length === 0) return notFound('Project not found');
        return badRequest(`Cannot unarchive: project is '${exists.rows[0].status}', not 'archived'`);
      }

      await client.query('COMMIT');
      return success({ project: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Transfer project ownership to another user.
 * Only the current owner can transfer.
 */
export async function transferOwnership(
  pool: Pool,
  userId: string,
  projectId: string,
  input: TransferOwnershipInput,
): Promise<ServiceResult<{ project: ProjectRow }>> {
  return withToolSpan('service.projects.transfer', async () => {
    const { new_owner } = input;

    if (new_owner === userId) {
      return badRequest('Cannot transfer ownership to yourself');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);

      // Only current owner can transfer
      const result = await withDbSpan('dispatch.projects.transfer', async () => {
        return client.query(
          `UPDATE dispatch.projects
           SET owner = $1, updated_at = now()
           WHERE project_id = $2 AND owner = $3
           RETURNING ${PROJECT_COLUMNS}`,
          [new_owner, projectId, userId],
        );
      });

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        const exists = await client.query(
          'SELECT owner FROM dispatch.projects WHERE project_id = $1',
          [projectId],
        );
        if (exists.rows.length === 0) return notFound('Project not found');
        return badRequest(
          `Cannot transfer: you are not the owner (owner: ${exists.rows[0].owner})`,
        );
      }

      await client.query('COMMIT');
      return success({ project: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}
