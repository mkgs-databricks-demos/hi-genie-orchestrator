/**
 * Dispatch Engine — executeAction SQL Scoping Tests
 *
 * Exercises executeAction (the function the tick evaluator's ActionExecutor
 * invokes for every real dispatch decision) against a fake Pool/PoolClient
 * that models two orchestrations sharing a workstream_key. Proves the live
 * HANDLE_STUCK/RESUME_RETRY/CREATE_NEXT/UNPAUSE_READY handlers scope their
 * UPDATE by (workstream_id, orchestration_id) and never mutate a same-keyed
 * row belonging to a different orchestration — the periodic-tick path, not
 * just the HTTP routes.
 */

import { describe, it, expect } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { executeAction } from './index.js';
import type { DispatchDecision } from './priority-tree.js';

const ORCH_A = '11111111-1111-4111-8111-111111111111';
const ORCH_B = '22222222-2222-4222-8222-222222222222';
const SHARED_KEY = 'ws-shared';

interface Row {
  workstream_id: string;
  orchestration_id: string;
  status: string;
  paused: boolean;
  attempt_count: number;
}

interface FakePoolResult {
  pool: Pool;
  table: Map<string, Row>;
  /** Execution records inserted by CREATE_NEXT / RESUME_RETRY handlers */
  executions: Array<{ execution_id: string; workstream_id: string; attempt_number: number }>;
}

function createFakePool(rows: Row[]): FakePoolResult {
  const table = new Map(rows.map((r) => [r.workstream_id, { ...r }]));
  const executions: FakePoolResult['executions'] = [];

  const client = {
    query: (sql: string, params: unknown[]) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      // Transaction bookkeeping — no-op in tests
      if (normalized === 'BEGIN' || normalized === 'COMMIT') {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      // ROLLBACK can also appear in error paths
      if (normalized === 'ROLLBACK') {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      // RLS identity context — no-op in tests
      if (normalized.startsWith('SELECT set_config')) {
        return Promise.resolve({ rowCount: 1, rows: [{}] });
      }

      // SELECT FOR UPDATE — used by createNextAction / resumeRetryAction
      // to read project_id (and attempt_count for retry)
      if (normalized.startsWith('SELECT') && normalized.includes('FOR UPDATE')) {
        const [workstreamId, orchestrationId] = params as [string, string];
        const row = table.get(workstreamId);
        if (!row || row.orchestration_id !== orchestrationId) {
          return Promise.resolve({ rowCount: 0, rows: [] });
        }
        return Promise.resolve({
          rowCount: 1,
          rows: [{ project_id: 'test-project', attempt_count: row.attempt_count }],
        });
      }

      // INSERT execution record — track for assertions
      if (normalized.startsWith('INSERT INTO dispatch.executions')) {
        const [execution_id, workstream_id, , attempt_number] = params as [string, string, string, number];
        executions.push({ execution_id, workstream_id, attempt_number });
        return Promise.resolve({ rowCount: 1, rows: [] });
      }

      // UPDATE dispatch.workstreams — the core scoping test
      if (normalized.startsWith('UPDATE dispatch.workstreams')) {
        const [workstreamId, orchestrationId] = params as [string, string];
        const row = table.get(workstreamId);
        // Every action handler's WHERE clause requires BOTH workstream_id AND
        // orchestration_id to match — simulate that exactly, so a decision
        // carrying the wrong orchestration_id for its workstream_id updates
        // nothing (rowCount 0), same as the real UPDATE would.
        if (!row || row.orchestration_id !== orchestrationId) {
          return Promise.resolve({ rowCount: 0, rows: [] });
        }

        // Distinguish by the WHERE clause's trailing status/paused filter,
        // which is unambiguous per handler (unlike the SET clause, which can
        // share literal substrings like 'RETRYING' or 'IN_PROGRESS' with a
        // different handler's WHERE filter).
        if (normalized.endsWith("AND status = 'IN_PROGRESS'")) {
          // HANDLE_STUCK
          row.status = 'RETRYING';
        } else if (normalized.endsWith("AND status = 'RETRYING'")) {
          // RESUME_RETRY
          row.status = 'IN_PROGRESS';
          row.attempt_count += 1;
        } else if (normalized.endsWith("AND status = 'NOT_STARTED'")) {
          // CREATE_NEXT
          row.status = 'IN_PROGRESS';
          row.attempt_count = 1;
        } else if (normalized.endsWith('AND paused = TRUE')) {
          // UNPAUSE_READY
          row.paused = false;
          row.status = 'NOT_STARTED';
        } else {
          throw new Error(`FakePool: unrecognized WHERE clause in test — ${normalized}`);
        }
        return Promise.resolve({ rowCount: 1, rows: [] });
      }

      throw new Error(`FakePool: unexpected query in test: ${normalized}`);
    },
    release: () => {},
  } as unknown as PoolClient;

  const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
  return { pool, table, executions };
}

function decision(overrides: Partial<DispatchDecision>): DispatchDecision {
  return {
    action: 'NO_OP',
    target: SHARED_KEY,
    targetWorkstreamId: null,
    targetOrchestrationId: null,
    reasoning: 'test',
    priority: 1,
    ...overrides,
  };
}

describe('executeAction — dispatch-engine SQL scoping across orchestrations', () => {
  it('HANDLE_STUCK only mutates the row in the targeted orchestration, never the same-keyed row in another', async () => {
    const { pool, table } = createFakePool([
      { workstream_id: 'a1', orchestration_id: ORCH_A, status: 'IN_PROGRESS', paused: false, attempt_count: 3 },
      { workstream_id: 'b1', orchestration_id: ORCH_B, status: 'IN_PROGRESS', paused: false, attempt_count: 1 },
    ]);

    await executeAction(
      decision({ action: 'HANDLE_STUCK', targetWorkstreamId: 'a1', targetOrchestrationId: ORCH_A }),
      pool,
    );

    expect(table.get('a1')!.status).toBe('RETRYING');
    expect(table.get('b1')!.status).toBe('IN_PROGRESS');
  });

  it('a decision whose targetOrchestrationId does not actually own targetWorkstreamId mutates nothing', async () => {
    const { pool, table } = createFakePool([
      { workstream_id: 'a1', orchestration_id: ORCH_A, status: 'IN_PROGRESS', paused: false, attempt_count: 3 },
    ]);

    // Simulates the exact bug class: a1 really belongs to ORCH_A, but the
    // decision (e.g. from a buggy evaluator that dropped orchestration
    // scoping) claims ORCH_B owns it.
    await executeAction(
      decision({ action: 'HANDLE_STUCK', targetWorkstreamId: 'a1', targetOrchestrationId: ORCH_B }),
      pool,
    );

    expect(table.get('a1')!.status).toBe('IN_PROGRESS');
  });

  it('RESUME_RETRY only mutates the row in the targeted orchestration', async () => {
    const { pool, table } = createFakePool([
      { workstream_id: 'a1', orchestration_id: ORCH_A, status: 'RETRYING', paused: false, attempt_count: 1 },
      { workstream_id: 'b1', orchestration_id: ORCH_B, status: 'RETRYING', paused: false, attempt_count: 2 },
    ]);

    await executeAction(
      decision({ action: 'RESUME_RETRY', targetWorkstreamId: 'b1', targetOrchestrationId: ORCH_B }),
      pool,
    );

    expect(table.get('b1')!.status).toBe('IN_PROGRESS');
    expect(table.get('b1')!.attempt_count).toBe(3);
    expect(table.get('a1')!.status).toBe('RETRYING');
    expect(table.get('a1')!.attempt_count).toBe(1);
  });

  it('CREATE_NEXT only mutates the row in the targeted orchestration', async () => {
    const { pool, table } = createFakePool([
      { workstream_id: 'a1', orchestration_id: ORCH_A, status: 'NOT_STARTED', paused: false, attempt_count: 0 },
      { workstream_id: 'b1', orchestration_id: ORCH_B, status: 'NOT_STARTED', paused: false, attempt_count: 0 },
    ]);

    await executeAction(
      decision({ action: 'CREATE_NEXT', targetWorkstreamId: 'a1', targetOrchestrationId: ORCH_A }),
      pool,
    );

    expect(table.get('a1')!.status).toBe('IN_PROGRESS');
    expect(table.get('b1')!.status).toBe('NOT_STARTED');
  });

  it('UNPAUSE_READY only mutates the row in the targeted orchestration', async () => {
    const { pool, table } = createFakePool([
      { workstream_id: 'a1', orchestration_id: ORCH_A, status: 'BLOCKED', paused: true, attempt_count: 0 },
      { workstream_id: 'b1', orchestration_id: ORCH_B, status: 'BLOCKED', paused: true, attempt_count: 0 },
    ]);

    await executeAction(
      decision({ action: 'UNPAUSE_READY', targetWorkstreamId: 'b1', targetOrchestrationId: ORCH_B }),
      pool,
    );

    expect(table.get('b1')!.paused).toBe(false);
    expect(table.get('b1')!.status).toBe('NOT_STARTED');
    expect(table.get('a1')!.paused).toBe(true);
    expect(table.get('a1')!.status).toBe('BLOCKED');
  });

  it('a decision with no targetWorkstreamId (e.g. STATUS_REPORT-shaped) performs no mutation', async () => {
    const { pool, table } = createFakePool([
      { workstream_id: 'a1', orchestration_id: ORCH_A, status: 'IN_PROGRESS', paused: false, attempt_count: 1 },
    ]);

    await executeAction(
      decision({ action: 'HANDLE_STUCK', targetWorkstreamId: null, targetOrchestrationId: null }),
      pool,
    );

    expect(table.get('a1')!.status).toBe('IN_PROGRESS');
  });

  it('CREATE_NEXT creates an execution record alongside the status transition', async () => {
    const { pool, table, executions } = createFakePool([
      { workstream_id: 'a1', orchestration_id: ORCH_A, status: 'NOT_STARTED', paused: false, attempt_count: 0 },
    ]);

    await executeAction(
      decision({ action: 'CREATE_NEXT', targetWorkstreamId: 'a1', targetOrchestrationId: ORCH_A }),
      pool,
    );

    expect(table.get('a1')!.status).toBe('IN_PROGRESS');
    expect(executions).toHaveLength(1);
    expect(executions[0].workstream_id).toBe('a1');
    expect(executions[0].attempt_number).toBe(1);
  });

  it('RESUME_RETRY creates an execution record with incremented attempt number', async () => {
    const { pool, table, executions } = createFakePool([
      { workstream_id: 'a1', orchestration_id: ORCH_A, status: 'RETRYING', paused: false, attempt_count: 2 },
    ]);

    await executeAction(
      decision({ action: 'RESUME_RETRY', targetWorkstreamId: 'a1', targetOrchestrationId: ORCH_A }),
      pool,
    );

    expect(table.get('a1')!.status).toBe('IN_PROGRESS');
    expect(executions).toHaveLength(1);
    expect(executions[0].workstream_id).toBe('a1');
    expect(executions[0].attempt_number).toBe(3);
  });
});
