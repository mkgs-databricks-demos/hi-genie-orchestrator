/**
 * Unit tests for MCP Identity Helpers (RLS Session Variable Management)
 *
 * Verifies that:
 * - withIdentity sets the app.user_identity session variable correctly
 * - Transactions commit on success, rollback on error
 * - Client is always released back to the pool
 * - idempotentInsertWithIdentity delegates to withIdentity and handles
 *   both the "created" and "conflict" paths
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { withIdentity, idempotentInsertWithIdentity } from './identity.js';

// ── Mock Factory ────────────────────────────────────────────────────────────

interface MockClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  /** Ordered list of SQL statements received by this client. */
  statements: string[];
}

function createMockPool(): { pool: Pool; client: MockClient } {
  const statements: string[] = [];

  const client: MockClient = {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      statements.push(sql);
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    }),
    release: vi.fn(),
    statements,
  };

  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as Pool;

  return { pool, client };
}

// ── withIdentity ────────────────────────────────────────────────────────────

describe('withIdentity', () => {
  let pool: Pool;
  let client: MockClient;

  beforeEach(() => {
    ({ pool, client } = createMockPool());
  });

  it('executes BEGIN, set_config, fn, COMMIT in order on success', async () => {
    const fn = vi.fn(async () => 'result-value');

    const result = await withIdentity(pool, 'alice@example.com', fn);

    expect(result).toBe('result-value');

    // Verify statement ordering
    expect(client.statements[0]).toBe('BEGIN');
    expect(client.statements[1]).toContain("set_config('app.user_identity'");
    expect(client.statements[2]).toBe('COMMIT');
    expect(client.statements).toHaveLength(3);

    // Verify set_config was called with the correct userId
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("set_config('app.user_identity'"),
      ['alice@example.com'],
    );

    // fn received the client
    expect(fn).toHaveBeenCalledWith(client);
  });

  it('executes ROLLBACK (not COMMIT) when fn throws, then re-throws the error', async () => {
    const error = new Error('handler failed');
    const fn = vi.fn(async () => { throw error; });

    await expect(withIdentity(pool, 'bob@example.com', fn)).rejects.toThrow('handler failed');

    // Should have BEGIN, set_config, ROLLBACK (no COMMIT)
    expect(client.statements[0]).toBe('BEGIN');
    expect(client.statements[1]).toContain("set_config('app.user_identity'");
    expect(client.statements[2]).toBe('ROLLBACK');
    expect(client.statements).not.toContain('COMMIT');
  });

  it('always releases the client back to the pool, even on error', async () => {
    const fn = vi.fn(async () => { throw new Error('boom'); });

    await expect(withIdentity(pool, 'carol@example.com', fn)).rejects.toThrow();

    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('releases the client on success', async () => {
    await withIdentity(pool, 'dave@example.com', async () => 42);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('still releases the client if ROLLBACK itself fails', async () => {
    // Make ROLLBACK throw (simulates a broken connection)
    client.query = vi.fn(async (sql: string) => {
      client.statements.push(sql);
      if (sql === 'ROLLBACK') throw new Error('connection lost');
      return { rows: [], rowCount: 0 };
    });

    const fn = vi.fn(async () => { throw new Error('original error'); });

    // The original error should still propagate (ROLLBACK failure swallowed)
    await expect(withIdentity(pool, 'eve@example.com', fn)).rejects.toThrow('original error');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('uses transaction-scoped set_config (third argument is true)', async () => {
    await withIdentity(pool, 'frank@example.com', async () => 'ok');

    // The set_config call should use `true` for transaction-scoped
    const setConfigCall = (client.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('set_config'),
    );
    expect(setConfigCall).toBeDefined();
    // The SQL text contains 'true' as the third positional parameter
    expect(setConfigCall![0]).toContain(', true)');
  });
});

// ── idempotentInsertWithIdentity ────────────────────────────────────────────

describe('idempotentInsertWithIdentity', () => {
  it('returns { created: true, id } when INSERT succeeds (no conflict)', async () => {
    const { pool, client } = createMockPool();

    // Override query to return the inserted PK on the INSERT statement
    client.query = vi.fn(async (sql: string, _params?: unknown[]) => {
      client.statements.push(sql);
      if (sql.includes('INSERT INTO')) {
        return { rows: [{ decision_id: 'new-uuid-123' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await idempotentInsertWithIdentity(
      pool, 'alice@example.com', 'state', 'decisions', 'decision_id',
      ['decision_id', 'project_id', 'idempotency_key'],
      ['new-uuid-123', 'proj-1', 'idem-1'],
      'proj-1', 'idem-1',
    );

    expect(result).toEqual({ created: true, id: 'new-uuid-123' });

    // Should have: BEGIN, set_config, INSERT, COMMIT
    expect(client.statements).toContain('BEGIN');
    expect(client.statements.some(s => s.includes('set_config'))).toBe(true);
    expect(client.statements.some(s => s.includes('INSERT INTO state.decisions'))).toBe(true);
    expect(client.statements).toContain('COMMIT');
  });

  it('returns { created: false, id } when conflict occurs (fetches existing PK)', async () => {
    const { pool, client } = createMockPool();

    // INSERT returns empty (conflict), SELECT returns the existing record
    client.query = vi.fn(async (sql: string, params?: unknown[]) => {
      client.statements.push(sql);
      if (sql.includes('INSERT INTO')) {
        return { rows: [], rowCount: 0 };  // ON CONFLICT DO NOTHING -> no rows
      }
      if (sql.includes('SELECT')) {
        return { rows: [{ error_id: 'existing-uuid-456' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await idempotentInsertWithIdentity(
      pool, 'bob@example.com', 'state', 'errors', 'error_id',
      ['error_id', 'project_id', 'idempotency_key'],
      ['attempt-uuid', 'proj-2', 'idem-2'],
      'proj-2', 'idem-2',
    );

    expect(result).toEqual({ created: false, id: 'existing-uuid-456' });

    // The conflict-lookup SELECT should query by project_id and idempotency_key.
    // Match on the lookup's distinguishing SQL text — `SELECT set_config(...)`
    // also contains "SELECT", so a bare `includes('SELECT')` predicate would
    // match the identity statement instead (params: ['bob@example.com']).
    const selectCall = (client.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === 'string' &&
        call[0].includes('SELECT error_id FROM state.errors') &&
        call[0].includes('WHERE project_id = $1 AND idempotency_key = $2'),
    );
    expect(selectCall).toBeDefined();
    expect(selectCall![1]).toEqual(['proj-2', 'idem-2']);
  });

  it('returns { created: false, id: "unknown" } when conflict occurs but existing record not found', async () => {
    const { pool, client } = createMockPool();

    // Both INSERT and SELECT return empty
    client.query = vi.fn(async (sql: string) => {
      client.statements.push(sql);
      return { rows: [], rowCount: 0 };
    });

    const result = await idempotentInsertWithIdentity(
      pool, 'carol@example.com', 'state', 'events', 'event_id',
      ['event_id', 'project_id', 'idempotency_key'],
      ['new-uuid', 'proj-3', 'idem-3'],
      'proj-3', 'idem-3',
    );

    expect(result).toEqual({ created: false, id: 'unknown' });
  });

  it('sets app.user_identity before the INSERT (RLS enforcement)', async () => {
    const { pool, client } = createMockPool();
    const callOrder: string[] = [];

    client.query = vi.fn(async (sql: string) => {
      if (sql.includes('set_config')) callOrder.push('set_config');
      if (sql.includes('INSERT')) callOrder.push('insert');
      client.statements.push(sql);
      if (sql.includes('INSERT')) {
        return { rows: [{ task_id: 'uuid-999' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await idempotentInsertWithIdentity(
      pool, 'dave@example.com', 'state', 'task_attempts', 'task_id',
      ['task_id', 'project_id', 'idempotency_key'],
      ['uuid-999', 'proj-4', 'idem-4'],
      'proj-4', 'idem-4',
    );

    // set_config MUST happen before INSERT
    expect(callOrder.indexOf('set_config')).toBeLessThan(callOrder.indexOf('insert'));
  });
});
