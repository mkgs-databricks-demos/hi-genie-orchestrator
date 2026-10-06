/**
 * Migration Runner Engine — Unit Tests
 *
 * Exercises executeMigrations() against a hand-rolled in-memory fake of the
 * pg Pool/PoolClient surface it actually calls, so these tests need no live
 * Lakebase connection. Covers ordering, idempotent skip, duplicate-version
 * rejection, and fail-fast rollback behavior.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { executeMigrations, type Migration } from './runner.js';

interface HistoryRow {
  version: number;
  name: string;
  duration_ms: number;
  status: string;
  checksum: string | null;
}

function createMockPool() {
  const historyRows: HistoryRow[] = [];

  // Both fakes mirror pg's real asynchronous contract: every query and every
  // connect resolves a Promise, never a bare object. runner.ts depends on that
  // in two places — it `await`s pool.query/pool.connect, and it calls
  // client.query('ROLLBACK').catch(() => {}), which needs a real thenable.
  // (These are plain functions returning Promises rather than `async` fns so
  // they don't trip @typescript-eslint/require-await, which flags an `async`
  // body containing no `await`.)
  const client = {
    query: vi.fn((sql: string, params?: unknown[]) => {
      if (sql.startsWith('INSERT INTO state._migration_history')) {
        const [version, name, duration_ms, status, checksum] = params as [
          number,
          string,
          number,
          string,
          string | null,
        ];
        if (!historyRows.some((r) => r.version === version)) {
          historyRows.push({ version, name, duration_ms, status, checksum: checksum ?? null });
        }
      }
      return Promise.resolve({ rows: [] });
    }),
    release: vi.fn(),
  };

  const pool = {
    query: vi.fn((sql: string, params?: unknown[]) => {
      if (sql.includes('CREATE SCHEMA') || sql.includes('CREATE TABLE')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.startsWith('SELECT version FROM')) {
        return Promise.resolve({
          rows: historyRows.filter((r) => r.status === 'applied').map((r) => ({ version: r.version })),
        });
      }
      if (sql.startsWith('INSERT INTO state._migration_history')) {
        const [version, name, duration_ms, status] = params as [number, string, number, string];
        if (!historyRows.some((r) => r.version === version)) {
          historyRows.push({ version, name, duration_ms, status, checksum: null });
        }
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    }),
    connect: vi.fn(() => Promise.resolve(client as unknown as PoolClient)),
  };

  return { pool: pool as unknown as Pool, client, historyRows };
}

describe('executeMigrations', () => {
  it('applies migrations in ascending version order regardless of input order', async () => {
    const { pool } = createMockPool();
    const order: number[] = [];
    const migrations: Migration[] = [
      { version: 2, name: 'second', up: () => { order.push(2); return Promise.resolve(); } },
      { version: 1, name: 'first', up: () => { order.push(1); return Promise.resolve(); } },
    ];

    const summary = await executeMigrations(pool, migrations);

    expect(order).toEqual([1, 2]);
    expect(summary.applied).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.totalMigrations).toBe(2);
  });

  it('skips migrations already recorded as applied and only runs the new one', async () => {
    const { pool, historyRows } = createMockPool();
    historyRows.push({ version: 1, name: 'first', duration_ms: 5, status: 'applied', checksum: null });

    const ran: number[] = [];
    const migrations: Migration[] = [
      { version: 1, name: 'first', up: () => { ran.push(1); return Promise.resolve(); } },
      { version: 2, name: 'second', up: () => { ran.push(2); return Promise.resolve(); } },
    ];

    const summary = await executeMigrations(pool, migrations);

    expect(ran).toEqual([2]);
    expect(summary.applied).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  it('fails fast: a failing migration stops the run and later migrations never execute', async () => {
    const { pool, client } = createMockPool();
    const ran: number[] = [];
    const migrations: Migration[] = [
      // Rejects rather than throwing synchronously — a real migration's DDL
      // failure surfaces as a rejected Promise from the awaited pg call.
      { version: 1, name: 'boom', up: () => Promise.reject(new Error('ddl error')) },
      { version: 2, name: 'never runs', up: () => { ran.push(2); return Promise.resolve(); } },
    ];

    await expect(executeMigrations(pool, migrations)).rejects.toThrow(
      /Migration v1 "boom" failed: ddl error/,
    );
    expect(ran).toEqual([]);

    // The failed migration must be rolled back and its client released, and the
    // run must abort before v2 ever opens a transaction.
    const clientSql = client.query.mock.calls.map(([sql]) => sql);
    expect(clientSql).toContain('BEGIN');
    expect(clientSql).toContain('ROLLBACK');
    expect(clientSql).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate migration version numbers before running anything', async () => {
    const { pool } = createMockPool();
    const migrations: Migration[] = [
      { version: 1, name: 'a', up: () => Promise.resolve() },
      { version: 1, name: 'b', up: () => Promise.resolve() },
    ];

    await expect(executeMigrations(pool, migrations)).rejects.toThrow(/Duplicate migration version/);
  });

  it('returns an empty-but-successful summary when there are no migrations to run', async () => {
    const { pool } = createMockPool();

    const summary = await executeMigrations(pool, []);

    expect(summary.totalMigrations).toBe(0);
    expect(summary.applied).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
  });
});
