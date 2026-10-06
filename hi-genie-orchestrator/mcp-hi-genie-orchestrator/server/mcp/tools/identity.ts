/**
 * MCP Identity Helpers — RLS Session Variable Management
 *
 * Provides transactional wrappers that set `app.user_identity` via
 * `set_config('app.user_identity', $1, true)` before database writes.
 * This enables Postgres Row-Level Security (RLS) policies on the state
 * schema to enforce write-integrity: a caller cannot INSERT a row and
 * attribute its `created_by` (or `user_id`) to a different identity.
 *
 * Pattern matches the dispatch API routes (plans.ts, workstreams.ts,
 * reviews.ts) which use the same `set_config` approach.
 *
 * The `true` parameter to `set_config` makes it transaction-scoped
 * (equivalent to SET LOCAL). When the transaction ends (COMMIT or
 * ROLLBACK), the setting is automatically cleared — no cleanup needed.
 *
 * If `set_config` is never called (e.g., a stray query outside the app's
 * request path), `current_setting('app.user_identity', true)` returns NULL,
 * which fails the `created_by = ...` equality check in the RLS policy —
 * this is the correct fail-closed behavior.
 */

import type { Pool, PoolClient } from 'pg';

// ── Transactional Identity Wrapper ──────────────────────────────────────────

/**
 * Executes `fn` within a transaction that has `app.user_identity` set to the
 * given `userId`. Handles BEGIN, set_config, COMMIT, and ROLLBACK.
 *
 * Use this for any MCP tool write that touches RLS-protected tables.
 *
 * @param pool   - Postgres connection pool
 * @param userId - The authenticated user identity (from session.userId)
 * @param fn     - Async function receiving the transactional PoolClient
 * @returns      - Whatever `fn` returns
 */
export async function withIdentity<T>(
  pool: Pool,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_identity', $1, true)`, [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Idempotent Insert with Identity ─────────────────────────────────────────

/**
 * Performs an idempotent insert within a transaction that has
 * `app.user_identity` set. Uses ON CONFLICT (project_id, idempotency_key)
 * DO NOTHING for retry-safe writes.
 *
 * Returns { created: true, id } on new insert, { created: false, id } on
 * conflict (fetches existing record's PK).
 *
 * @param pool           - Postgres connection pool
 * @param userId         - The authenticated user identity
 * @param schema         - Schema name (e.g., 'state')
 * @param table          - Table name (e.g., 'decisions')
 * @param pkColumn       - Primary key column name
 * @param columns        - Column names for the INSERT
 * @param values         - Values corresponding to columns
 * @param projectId      - Project UUID (for conflict lookup)
 * @param idempotencyKey - Idempotency key (for conflict lookup)
 */
export async function idempotentInsertWithIdentity(
  pool: Pool,
  userId: string,
  schema: string,
  table: string,
  pkColumn: string,
  columns: string[],
  values: unknown[],
  projectId: string,
  idempotencyKey: string,
): Promise<{ created: boolean; id: string }> {
  return withIdentity(pool, userId, async (client) => {
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    const columnList = columns.join(', ');

    const query = `
      INSERT INTO ${schema}.${table} (${columnList})
      VALUES (${placeholders})
      ON CONFLICT (project_id, idempotency_key) DO NOTHING
      RETURNING ${pkColumn}
    `;

    const result = await client.query(query, values);
    if (result.rows.length > 0) {
      return { created: true, id: result.rows[0][pkColumn] };
    }

    // Conflict — fetch existing record's PK
    const existing = await client.query(
      `SELECT ${pkColumn} FROM ${schema}.${table} WHERE project_id = $1 AND idempotency_key = $2`,
      [projectId, idempotencyKey],
    );
    return { created: false, id: existing.rows[0]?.[pkColumn] ?? 'unknown' };
  });
}
