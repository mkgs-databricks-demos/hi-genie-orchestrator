/**
 * ReviewDispatcher.createReviewTask — Transaction Handling Tests
 *
 * Exercises the private createReviewTask path (via the public
 * handleStatusChange entry point) against a hand-rolled fake of the pg
 * Pool/PoolClient surface that records every query call in order. Proves:
 *   - BEGIN runs before set_config('app.user_identity', ...) (transaction-local
 *     identity context, required for the RLS insert policy on
 *     dispatch.review_tasks — set_config(..., true) is scoped like SET LOCAL).
 *   - COMMIT is issued on every successful/early-return path (including the
 *     "already exists" ON CONFLICT DO NOTHING branch).
 *   - ROLLBACK is issued when the workstream/execution lookups come up empty,
 *     and when the INSERT itself throws.
 *   - client.release() is always called, even on error, so the connection
 *     never leaks back to the pool wedged mid-transaction.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { ReviewDispatcher } from './review-dispatcher.js';
import type { NotificationPayload } from './listener.js';

const ORCH_ID = '11111111-1111-4111-8111-111111111111';
const WORKSTREAM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXECUTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROJECT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CORRELATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const WS_KEY = 'ws-under-review';

interface FakePoolOptions {
  /** Whether fetchWorkstreamContext should find the workstream row. */
  hasWorkstream?: boolean;
  /** Whether an execution row exists for the workstream. */
  hasExecution?: boolean;
  /** If set, the INSERT into dispatch.review_tasks throws this error. */
  insertError?: Error;
  /** If true, the INSERT's ON CONFLICT DO NOTHING branch fires (rowCount 0). */
  insertConflicts?: boolean;
  /** If set, ROLLBACK itself throws this error (simulates a connection that can't close its transaction). */
  rollbackError?: Error;
  /**
   * If set, client.release() throws this error (simulates pg-pool's
   * "Release called on client which has already been released" guard, or any
   * other pool-bookkeeping failure). The transaction is already closed by
   * then, so this must NOT be treated as a rollback failure or retried.
   */
  releaseError?: Error;
  /** If set, COMMIT itself throws this error. */
  commitError?: Error;
  /**
   * If set, reading the inserted row's created_at throws this error —
   * simulating a failure in post-COMMIT work (ReviewTask construction,
   * logging) which must never roll back the committed transaction nor
   * release the client a second time.
   */
  postCommitError?: Error;
}

function createFakePool(opts: FakePoolOptions = {}) {
  const calls: string[] = [];
  const releaseArgs: unknown[] = [];

  const client = {
    query: vi.fn((sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized === 'ROLLBACK' && opts.rollbackError) {
        calls.push('ROLLBACK_ATTEMPTED');
        throw opts.rollbackError;
      }
      if (normalized === 'COMMIT' && opts.commitError) {
        calls.push('COMMIT_ATTEMPTED');
        throw opts.commitError;
      }
      if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
        calls.push(normalized);
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("SELECT set_config('app.user_identity'")) {
        calls.push('SET_IDENTITY');
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('SELECT w.workstream_id')) {
        calls.push('FETCH_WORKSTREAM_CONTEXT');
        if (!(opts.hasWorkstream ?? true)) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [{
            workstream_id: WORKSTREAM_ID,
            name: 'Under review workstream',
            attempt_count: 1,
            max_retries: 3,
            error_message: null,
            started_at: new Date().toISOString(),
          }],
          rowCount: 1,
        };
      }
      if (normalized.startsWith('SELECT execution_id::text')) {
        calls.push('FETCH_EXECUTION');
        if (!(opts.hasExecution ?? true)) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ execution_id: EXECUTION_ID }], rowCount: 1 };
      }
      if (normalized.startsWith('SELECT project_id::text, correlation_id::text')) {
        calls.push('FETCH_WS_DETAILS');
        return { rows: [{ project_id: PROJECT_ID, correlation_id: CORRELATION_ID }], rowCount: 1 };
      }
      if (normalized.startsWith('INSERT INTO dispatch.review_tasks')) {
        calls.push('INSERT_REVIEW_TASK');
        if (opts.insertError) {
          throw opts.insertError;
        }
        if (opts.insertConflicts) {
          return { rows: [], rowCount: 0 };
        }
        const postCommitError = opts.postCommitError;
        if (postCommitError) {
          // Inject a failure that happens AFTER the transaction has
          // committed and the client has been released: reading created_at
          // while building the public ReviewTask throws. This is the
          // realistic shape of "post-commit work fails" (task construction,
          // logging, serialization) and is exactly what must NOT trigger a
          // rollback of the already-committed transaction or a second release.
          const row = {
            review_task_id: 'unused',
            get created_at(): string {
              throw postCommitError;
            },
          };
          return { rows: [row], rowCount: 1 };
        }
        return { rows: [{ review_task_id: 'unused', created_at: new Date().toISOString() }], rowCount: 1 };
      }

      throw new Error(`FakePool: unhandled query in test — ${normalized}`);
    }),
    release: vi.fn((err?: unknown) => {
      calls.push('RELEASE');
      releaseArgs.push(err);
      if (opts.releaseError) {
        throw opts.releaseError;
      }
    }),
  };

  const pool = {
    connect: vi.fn(() => client as unknown as PoolClient),
  };

  return { pool: pool as unknown as Pool, client, calls, releaseArgs };
}

function makePayload(newStatus: string = 'READY_FOR_REVIEW'): NotificationPayload {
  return {
    workstream_key: WS_KEY,
    old_status: 'VALIDATING',
    new_status: newStatus,
    orchestration_id: ORCH_ID,
    changed_at: new Date().toISOString(),
  };
}

describe('ReviewDispatcher.createReviewTask transaction handling', () => {
  it('BEGIN runs, then identity is set in the same transaction, before COMMIT on success', async () => {
    const { pool, calls } = createFakePool();
    const dispatcher = new ReviewDispatcher(pool);

    const task = await dispatcher.handleStatusChange(makePayload());

    expect(task).not.toBeNull();
    expect(task?.status).toBe('PENDING');

    // BEGIN must be the first call, and SET_IDENTITY must come immediately after
    // BEGIN and before any data-modifying statement, since set_config(..., true)
    // is transaction-scoped.
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toBe('SET_IDENTITY');
    expect(calls).toContain('COMMIT');
    expect(calls).not.toContain('ROLLBACK');
    expect(calls[calls.length - 1]).toBe('RELEASE');

    // COMMIT must come after the INSERT and before RELEASE.
    const insertIdx = calls.indexOf('INSERT_REVIEW_TASK');
    const commitIdx = calls.indexOf('COMMIT');
    const releaseIdx = calls.indexOf('RELEASE');
    expect(insertIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(insertIdx);
    expect(releaseIdx).toBeGreaterThan(commitIdx);
  });

  it('ignores notifications for any status other than READY_FOR_REVIEW without opening a transaction', async () => {
    const { pool, calls } = createFakePool();
    const dispatcher = new ReviewDispatcher(pool);

    const task = await dispatcher.handleStatusChange(makePayload('IN_PROGRESS'));

    expect(task).toBeNull();
    expect(calls).toEqual([]);
  });

  it('rolls back and releases cleanly (no error passed to release) when the workstream is not found in the orchestration', async () => {
    const { pool, calls, releaseArgs } = createFakePool({ hasWorkstream: false });
    const dispatcher = new ReviewDispatcher(pool);

    const task = await dispatcher.handleStatusChange(makePayload());

    expect(task).toBeNull();
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toBe('SET_IDENTITY');
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(calls[calls.length - 1]).toBe('RELEASE');
    expect(releaseArgs[releaseArgs.length - 1]).toBeUndefined();
  });

  it('rolls back and releases cleanly when no execution record exists for the workstream', async () => {
    const { pool, calls, releaseArgs } = createFakePool({ hasExecution: false });
    const dispatcher = new ReviewDispatcher(pool);

    const task = await dispatcher.handleStatusChange(makePayload());

    expect(task).toBeNull();
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(calls[calls.length - 1]).toBe('RELEASE');
    expect(releaseArgs[releaseArgs.length - 1]).toBeUndefined();
  });

  it('commits (does not roll back) and releases cleanly on an idempotent ON CONFLICT DO NOTHING — the transaction still completed cleanly', async () => {
    const { pool, calls, releaseArgs } = createFakePool({ insertConflicts: true });
    const dispatcher = new ReviewDispatcher(pool);

    const task = await dispatcher.handleStatusChange(makePayload());

    expect(task).toBeNull();
    expect(calls).toContain('COMMIT');
    expect(calls).not.toContain('ROLLBACK');
    expect(calls[calls.length - 1]).toBe('RELEASE');
    expect(releaseArgs[releaseArgs.length - 1]).toBeUndefined();
  });

  it('rolls back, releases cleanly, and propagates the error when the INSERT itself fails (but ROLLBACK succeeds)', async () => {
    const dbError = new Error('permission denied for table review_tasks (RLS policy violation)');
    const { pool, calls, releaseArgs } = createFakePool({ insertError: dbError });
    const dispatcher = new ReviewDispatcher(pool);

    await expect(dispatcher.handleStatusChange(makePayload())).rejects.toThrow(dbError.message);

    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    // release() must still run even though the transaction errored — and since
    // ROLLBACK itself succeeded here, it's released cleanly (no error arg),
    // returning the now-clean connection to the pool.
    expect(calls[calls.length - 1]).toBe('RELEASE');
    expect(releaseArgs[releaseArgs.length - 1]).toBeUndefined();
  });

  it('releases the client even when BEGIN itself throws before any transaction state exists', async () => {
    const { pool, client, calls } = createFakePool();
    client.query.mockImplementationOnce(() => {
      throw new Error('connection reset');
    });
    const dispatcher = new ReviewDispatcher(pool);

    await expect(dispatcher.handleStatusChange(makePayload())).rejects.toThrow('connection reset');
    expect(calls[calls.length - 1]).toBe('RELEASE');
  });

  it('when ROLLBACK itself fails after the INSERT throws, the client is destroyed via release(error) instead of returned to the pool', async () => {
    const insertError = new Error('permission denied for table review_tasks (RLS policy violation)');
    const rollbackError = new Error('server closed the connection unexpectedly');
    const { pool, calls, releaseArgs } = createFakePool({ insertError, rollbackError });
    const dispatcher = new ReviewDispatcher(pool);

    // The original INSERT failure is still what's thrown to the caller —
    // the rollback failure is a secondary problem logged, not swapped in as
    // the primary error.
    await expect(dispatcher.handleStatusChange(makePayload())).rejects.toThrow(insertError.message);

    expect(calls).toContain('ROLLBACK_ATTEMPTED');
    expect(calls).not.toContain('ROLLBACK'); // it threw before recording a successful ROLLBACK
    expect(calls).not.toContain('COMMIT');
    expect(calls[calls.length - 1]).toBe('RELEASE');

    // The critical assertion: release() received a truthy error, signaling
    // pg-pool to evict/destroy this connection rather than hand a
    // possibly-still-open-transaction client to the next borrower.
    const lastReleaseArg = releaseArgs[releaseArgs.length - 1];
    expect(lastReleaseArg).toBeInstanceOf(Error);
    expect((lastReleaseArg as Error).message).toBe(rollbackError.message);
  });

  it('when ROLLBACK itself fails after a not-found early return, the client is still destroyed via release(error)', async () => {
    const rollbackError = new Error('connection terminated');
    const { pool, calls, releaseArgs } = createFakePool({ hasWorkstream: false, rollbackError });
    const dispatcher = new ReviewDispatcher(pool);

    const task = await dispatcher.handleStatusChange(makePayload());

    // The early-return path returns null rather than throwing — but the
    // client must still be evicted, not quietly returned to the pool.
    expect(task).toBeNull();
    expect(calls).toContain('ROLLBACK_ATTEMPTED');
    expect(calls[calls.length - 1]).toBe('RELEASE');
    const lastReleaseArg = releaseArgs[releaseArgs.length - 1];
    expect(lastReleaseArg).toBeInstanceOf(Error);
    expect((lastReleaseArg as Error).message).toBe(rollbackError.message);
  });
});

/**
 * Cleanup-exactness contract.
 *
 * The transaction client must be settled EXACTLY ONCE on every path, and the
 * kind of cleanup must match what actually happened:
 *   - COMMIT succeeded          → one bare release(), no ROLLBACK
 *   - pre-commit failure        → one ROLLBACK, one bare release()
 *   - ROLLBACK query failed     → one release(error) eviction (only here)
 *   - post-commit failure       → NO ROLLBACK, NO second release
 *
 * These guard two specific defects: (a) a broad try/catch that let a
 * post-COMMIT throw fall into the rollback path, rolling back an
 * already-committed transaction and double-releasing an already-released
 * client; (b) rollbackAndRelease() catching a throwing release() and
 * misreporting it as a ROLLBACK failure, then calling release(error) a
 * second time.
 */
describe('ReviewDispatcher.createReviewTask cleanup exactness', () => {
  const countCalls = (calls: string[], label: string) => calls.filter((c) => c === label).length;

  it('successful COMMIT => exactly one release, no rollback', async () => {
    const { pool, calls, releaseArgs } = createFakePool();
    const dispatcher = new ReviewDispatcher(pool);

    const task = await dispatcher.handleStatusChange(makePayload());

    expect(task).not.toBeNull();
    expect(countCalls(calls, 'COMMIT')).toBe(1);
    expect(countCalls(calls, 'RELEASE')).toBe(1);
    expect(calls).not.toContain('ROLLBACK');
    expect(calls).not.toContain('ROLLBACK_ATTEMPTED');
    // A bare release() — no eviction, the connection is clean and reusable.
    expect(releaseArgs).toEqual([undefined]);
  });

  it('ordinary pre-commit failure => successful rollback and exactly one release', async () => {
    const insertError = new Error('deadlock detected');
    const { pool, calls, releaseArgs } = createFakePool({ insertError });
    const dispatcher = new ReviewDispatcher(pool);

    await expect(dispatcher.handleStatusChange(makePayload())).rejects.toThrow(insertError.message);

    expect(countCalls(calls, 'ROLLBACK')).toBe(1);
    expect(countCalls(calls, 'RELEASE')).toBe(1);
    expect(calls).not.toContain('COMMIT');
    // ROLLBACK succeeded, so the connection is clean — released, not evicted.
    expect(releaseArgs).toEqual([undefined]);
  });

  it('rollback query failure => exactly one release(error) eviction', async () => {
    const insertError = new Error('deadlock detected');
    const rollbackError = new Error('server closed the connection unexpectedly');
    const { pool, calls, releaseArgs } = createFakePool({ insertError, rollbackError });
    const dispatcher = new ReviewDispatcher(pool);

    // The original pre-commit error is what propagates; the rollback failure
    // is a secondary condition that changes cleanup, not the thrown error.
    await expect(dispatcher.handleStatusChange(makePayload())).rejects.toThrow(insertError.message);

    expect(countCalls(calls, 'ROLLBACK_ATTEMPTED')).toBe(1);
    expect(countCalls(calls, 'RELEASE')).toBe(1);
    expect(releaseArgs).toHaveLength(1);
    expect(releaseArgs[0]).toBeInstanceOf(Error);
    expect((releaseArgs[0] as Error).message).toBe(rollbackError.message);
  });

  it('exception after successful commit => no rollback and no second release; the post-commit error propagates', async () => {
    const postCommitError = new Error('post-commit task construction failed');
    const { pool, calls, releaseArgs } = createFakePool({ postCommitError });
    const dispatcher = new ReviewDispatcher(pool);

    // The post-commit error must surface to the caller — silently swallowing
    // it would hide a real bug in post-commit work.
    await expect(dispatcher.handleStatusChange(makePayload())).rejects.toThrow(postCommitError.message);

    // The transaction committed successfully and was released exactly once.
    expect(countCalls(calls, 'COMMIT')).toBe(1);
    expect(countCalls(calls, 'RELEASE')).toBe(1);

    // The critical assertions: the committed transaction was NOT rolled back,
    // and the already-released client was NOT released a second time (which
    // pg-pool rejects, and which would also mean an eviction of a healthy
    // connection).
    expect(calls).not.toContain('ROLLBACK');
    expect(calls).not.toContain('ROLLBACK_ATTEMPTED');
    expect(releaseArgs).toEqual([undefined]);
  });

  it('a throwing release() after a successful ROLLBACK is not misreported as a rollback failure, and is not retried', async () => {
    const insertError = new Error('deadlock detected');
    const releaseError = new Error('Release called on client which has already been released to the pool.');
    const { pool, calls, releaseArgs } = createFakePool({ insertError, releaseError });
    const dispatcher = new ReviewDispatcher(pool);

    // The pre-commit error still propagates — a failing release() must not
    // replace or mask it.
    await expect(dispatcher.handleStatusChange(makePayload())).rejects.toThrow(insertError.message);

    expect(countCalls(calls, 'ROLLBACK')).toBe(1);
    expect(calls).not.toContain('ROLLBACK_ATTEMPTED');

    // Exactly one release attempt, made WITHOUT an eviction error: the
    // ROLLBACK succeeded, so there is nothing to evict for. The old
    // implementation caught the throwing release() inside the same try as
    // the ROLLBACK, mislabelled it a rollback failure, and called
    // release(error) a second time — this asserts both are gone.
    expect(countCalls(calls, 'RELEASE')).toBe(1);
    expect(releaseArgs).toEqual([undefined]);
  });
});
