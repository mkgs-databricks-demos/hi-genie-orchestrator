/**
 * TickEvaluator — Periodic Tick Cross-Orchestration Test
 *
 * Exercises TickEvaluator.evaluateNow() (the entry point the scheduled
 * interval and event-driven wakeups both call) against a fake Pool that
 * returns duplicate workstream_key rows across two active orchestrations —
 * exactly the query shape fetchWorkstreamStates() issues. Proves the
 * decision the tick evaluator hands to the executor always carries a
 * targetWorkstreamId/targetOrchestrationId pair that actually correspond to
 * one real row, never a cross-orchestration mismatch.
 */

import { describe, it, expect } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { TickEvaluator } from './tick-evaluator.js';
import type { DispatchDecision } from './priority-tree.js';

const ORCH_A = '11111111-1111-4111-8111-111111111111';
const ORCH_B = '22222222-2222-4222-8222-222222222222';
const SHARED_KEY = 'ws-shared';

interface FakeRow {
  workstream_id: string;
  workstream_key: string;
  orchestration_id: string;
  status: string;
  depends_on: string[];
  attempt_count: number;
  max_retries: number;
  started_at: string | null;
  last_heartbeat_at: string | null;
  paused: boolean;
}

function createFakePool(rows: FakeRow[]) {
  const client = {
    query: (sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT') && normalized.includes('dispatch.workstreams')) {
        return Promise.resolve({ rows });
      }
      throw new Error(`FakePool: unhandled query in test — ${normalized}`);
    },
    release: () => {},
  } as unknown as PoolClient;

  return { connect: () => Promise.resolve(client) } as unknown as Pool;
}

describe('TickEvaluator.evaluateNow — cross-orchestration safety over the periodic tick path', () => {
  it('a decision for a stuck workstream in orchestration A never targets the same-keyed row in orchestration B', async () => {
    const staleTimestamp = new Date(Date.now() - 200 * 60_000).toISOString();
    const rows: FakeRow[] = [
      {
        workstream_id: 'a1',
        workstream_key: SHARED_KEY,
        orchestration_id: ORCH_A,
        status: 'IN_PROGRESS',
        depends_on: [],
        attempt_count: 1,
        max_retries: 3,
        started_at: staleTimestamp,
        last_heartbeat_at: staleTimestamp,
        paused: false,
      },
      {
        workstream_id: 'b1',
        workstream_key: SHARED_KEY,
        orchestration_id: ORCH_B,
        status: 'RETRYING',
        depends_on: [],
        attempt_count: 1,
        max_retries: 3,
        started_at: null,
        last_heartbeat_at: null,
        paused: false,
      },
    ];

    const pool = createFakePool(rows);
    const decisions: DispatchDecision[] = [];
    const evaluator = new TickEvaluator(pool, (decision) => {
      decisions.push(decision);
      return Promise.resolve();
    });

    const decision = await evaluator.evaluateNow();

    // A's row is genuinely stuck (priority 1) — beats B's retry (priority 2).
    expect(decision?.action).toBe('HANDLE_STUCK');
    expect(decision?.targetWorkstreamId).toBe('a1');
    expect(decision?.targetOrchestrationId).toBe(ORCH_A);

    // The executor received exactly the same scoped decision — never one
    // that claims orchestration B for workstream_id 'a1' or vice versa.
    expect(decisions).toHaveLength(1);
    expect(decisions[0].targetWorkstreamId).toBe('a1');
    expect(decisions[0].targetOrchestrationId).toBe(ORCH_A);
  });

  it('fetchWorkstreamStates carries workstream_id and orchestration_id through to the evaluated state', async () => {
    const rows: FakeRow[] = [
      {
        workstream_id: 'x1',
        workstream_key: SHARED_KEY,
        orchestration_id: ORCH_A,
        status: 'NOT_STARTED',
        depends_on: [],
        attempt_count: 0,
        max_retries: 3,
        started_at: null,
        last_heartbeat_at: null,
        paused: false,
      },
    ];

    const pool = createFakePool(rows);
    const evaluator = new TickEvaluator(pool, async () => {});

    const decision = await evaluator.evaluateNow();

    expect(decision?.action).toBe('CREATE_NEXT');
    expect(decision?.targetWorkstreamId).toBe('x1');
    expect(decision?.targetOrchestrationId).toBe(ORCH_A);
  });
});
