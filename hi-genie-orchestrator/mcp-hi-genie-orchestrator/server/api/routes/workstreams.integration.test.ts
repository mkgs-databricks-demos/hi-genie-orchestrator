/**
 * Workstream Routes — Orchestration Scoping Integration Tests
 *
 * Exercises the dispatch/retry/pause/unpause handlers against an in-memory
 * fake of the pg Pool/PoolClient surface, modeling the real constraint from
 * migration 001: `workstream_key` is only UNIQUE per (orchestration_id,
 * workstream_key) — the same key can legitimately exist in two different
 * orchestrations. Proves that a caller who knows a workstream_key cannot
 * dispatch/retry/pause/unpause a same-keyed row that belongs to a *different*
 * orchestration by supplying the wrong orchestration_id in the URL.
 */

import express, { type Express } from 'express';
import { describe, it, expect, beforeEach } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createWorkstreamRoutes } from './workstreams.js';

interface WorkstreamRow {
  workstream_id: string;
  orchestration_id: string;
  project_id: string;
  workstream_key: string;
  status: string;
  attempt_count: number;
  max_retries: number;
  assigned_to: string | null;
  correlation_id: string | null;
  updated_at: string;
}

/**
 * Minimal fake Lakebase pool: understands only the exact query shapes issued
 * by workstreams.ts (SELECT ... FOR UPDATE, UPDATE ... WHERE orchestration_id
 * AND workstream_key, INSERT INTO dispatch.executions). Anything else throws,
 * so a query drifting from the handler's real SQL fails loudly rather than
 * silently no-opping.
 */
function createFakePool(seedRows: WorkstreamRow[]) {
  const rows = new Map<string, WorkstreamRow>(seedRows.map((r) => [r.workstream_id, r]));
  const executions: Array<{ workstream_id: string; worker_identity: string }> = [];

  function findByOrchAndKey(orchestrationId: string, workstreamKey: string): WorkstreamRow | undefined {
    for (const row of rows.values()) {
      if (row.orchestration_id === orchestrationId && row.workstream_key === workstreamKey) {
        return row;
      }
    }
    return undefined;
  }

  function handleQuery(sql: string, params: unknown[] = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (normalized.startsWith("SELECT set_config('app.user_identity'")) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith('SELECT workstream_id, orchestration_id, project_id, status, attempt_count, max_retries')) {
      // dispatch handler's lock query: WHERE orchestration_id = $1 AND workstream_key = $2
      const [orchestrationId, workstreamKey] = params as [string, string];
      const row = findByOrchAndKey(orchestrationId, workstreamKey);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith('SELECT workstream_id, status, attempt_count, max_retries')) {
      // retry handler's lock query: WHERE orchestration_id = $1 AND workstream_key = $2
      const [orchestrationId, workstreamKey] = params as [string, string];
      const row = findByOrchAndKey(orchestrationId, workstreamKey);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith('INSERT INTO dispatch.executions')) {
      const [, workstream_id, , , worker_identity] = params as [string, string, string, number, string, string];
      executions.push({ workstream_id, worker_identity });
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('UPDATE dispatch.workstreams') && normalized.includes('WHERE workstream_id = $')) {
      // dispatch/retry: unconditional update by workstream_id (already locked+validated above)
      const workstreamId = params[params.length - 1] as string;
      const row = rows.get(workstreamId);
      if (row) {
        if (normalized.includes("status = 'IN_PROGRESS'")) {
          const [attempt_count, assigned_to, correlation_id] = params as [number, string, string, string];
          row.status = 'IN_PROGRESS';
          row.attempt_count = attempt_count;
          row.assigned_to = assigned_to;
          row.correlation_id = correlation_id;
        } else if (normalized.includes("status = 'RETRYING'")) {
          const [correlation_id] = params as [string, string];
          row.status = 'RETRYING';
          row.correlation_id = correlation_id;
        }
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (
      normalized.startsWith('UPDATE dispatch.workstreams') &&
      normalized.includes('WHERE orchestration_id = $1 AND workstream_key = $2 AND status = ANY($3)')
    ) {
      // pause/unpause: single-statement conditional update, scoped by orchestration_id.
      const [orchestrationId, workstreamKey, allowedStatuses] = params as [string, string, string[]];
      const row = findByOrchAndKey(orchestrationId, workstreamKey);
      if (row && allowedStatuses.includes(row.status)) {
        row.status = normalized.includes("status = 'BLOCKED'") ? 'BLOCKED' : 'RETRYING';
        return {
          rows: [{ workstream_id: row.workstream_id, workstream_key: row.workstream_key, status: row.status }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`FakePool: unhandled query — ${normalized}`);
  }

  const client = {
    query: (sql: string, params?: unknown[]) => handleQuery(sql, params ?? []),
    release: () => {},
  } as unknown as PoolClient;

  const pool = {
    query: (sql: string, params?: unknown[]) => handleQuery(sql, params ?? []),
    connect: () => client,
  } as unknown as Pool;

  return { pool, rows, executions };
}

function makeApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.verifiedIdentity = 'alice@example.com';
    next();
  });
  app.use('/api/v1', createWorkstreamRoutes(pool));
  return app;
}

const ORCH_A = '11111111-1111-4111-8111-111111111111';
const ORCH_B = '22222222-2222-4222-8222-222222222222';
const SHARED_KEY = 'ws-shared-key';

function seedTwoOrchestrationsWithSameKey(): WorkstreamRow[] {
  return [
    {
      workstream_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      orchestration_id: ORCH_A,
      project_id: 'proj-a',
      workstream_key: SHARED_KEY,
      status: 'NOT_STARTED',
      attempt_count: 0,
      max_retries: 3,
      assigned_to: null,
      correlation_id: null,
      updated_at: new Date().toISOString(),
    },
    {
      workstream_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      orchestration_id: ORCH_B,
      project_id: 'proj-b',
      workstream_key: SHARED_KEY,
      status: 'BLOCKED',
      attempt_count: 1,
      max_retries: 3,
      assigned_to: null,
      correlation_id: null,
      updated_at: new Date().toISOString(),
    },
  ];
}

/**
 * Both rows start IN_PROGRESS — a status genuinely eligible for pause
 * (PAUSE_FROM includes IN_PROGRESS). This matters: seedTwoOrchestrationsWithSameKey's
 * ORCH_B row starts BLOCKED, which pause's own `AND status = ANY($3)` filter
 * would exclude regardless of orchestration scoping — so using that seed for
 * the pause isolation test would pass even if the orchestration_id predicate
 * were silently dropped, because the status filter alone would still protect
 * the control row. Using a control row that IS pause-eligible means a
 * regression to workstream_key-only scoping would visibly flip its status
 * too, making this a real regression test rather than a vacuous one.
 */
function seedTwoOrchestrationsBothPauseEligible(): WorkstreamRow[] {
  return [
    {
      workstream_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      orchestration_id: ORCH_A,
      project_id: 'proj-a',
      workstream_key: SHARED_KEY,
      status: 'IN_PROGRESS',
      attempt_count: 1,
      max_retries: 3,
      assigned_to: null,
      correlation_id: null,
      updated_at: new Date().toISOString(),
    },
    {
      workstream_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      orchestration_id: ORCH_B,
      project_id: 'proj-b',
      workstream_key: SHARED_KEY,
      status: 'IN_PROGRESS',
      attempt_count: 1,
      max_retries: 3,
      assigned_to: null,
      correlation_id: null,
      updated_at: new Date().toISOString(),
    },
  ];
}

async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('workstream operations are scoped by orchestration_id', () => {
  let seed: WorkstreamRow[];

  beforeEach(() => {
    seed = seedTwoOrchestrationsWithSameKey();
  });

  it('dispatch: same workstream_key in a different orchestration is not found (404), and the correct one dispatches', async () => {
    const { pool, rows } = createFakePool(seed);
    const app = makeApp(pool);
    const { url, close } = await listen(app);
    try {
      // ORCH_B's row is BLOCKED, not dispatchable — but more importantly, dispatching
      // under ORCH_A for the shared key must only ever touch ORCH_A's NOT_STARTED row.
      const res = await fetch(`${url}/api/v1/orchestrations/${ORCH_A}/workstreams/${SHARED_KEY}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worker_identity: 'worker-1' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { workstream_id: string };
      expect(body.workstream_id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

      // ORCH_A's row transitioned; ORCH_B's same-keyed row must be untouched.
      expect(rows.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')!.status).toBe('IN_PROGRESS');
      expect(rows.get('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')!.status).toBe('BLOCKED');
    } finally {
      await close();
    }
  });

  it('dispatch: an unknown orchestration_id paired with a real workstream_key from another orchestration 404s', async () => {
    const { pool } = createFakePool(seed);
    const app = makeApp(pool);
    const { url, close } = await listen(app);
    try {
      const unrelatedOrch = '33333333-3333-4333-8333-333333333333';
      const res = await fetch(`${url}/api/v1/orchestrations/${unrelatedOrch}/workstreams/${SHARED_KEY}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worker_identity: 'worker-1' }),
      });
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('retry: only affects the row in the specified orchestration, never the same-keyed row in another', async () => {
    const { pool, rows } = createFakePool(seed);
    const app = makeApp(pool);
    const { url, close } = await listen(app);
    try {
      // ORCH_B's row is BLOCKED (retryable); ORCH_A's is NOT_STARTED (not retryable).
      const res = await fetch(`${url}/api/v1/orchestrations/${ORCH_B}/workstreams/${SHARED_KEY}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'transient failure' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { workstream_id: string };
      expect(body.workstream_id).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

      expect(rows.get('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')!.status).toBe('RETRYING');
      expect(rows.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')!.status).toBe('NOT_STARTED');
    } finally {
      await close();
    }
  });

  it('retry: requesting the non-retryable orchestration for the shared key 409s instead of silently matching the other one', async () => {
    const { pool } = createFakePool(seed);
    const app = makeApp(pool);
    const { url, close } = await listen(app);
    try {
      // ORCH_A's row is NOT_STARTED — not in RETRY_FROM — must 409, not fall through
      // to ORCH_B's BLOCKED row just because the workstream_key matches.
      const res = await fetch(`${url}/api/v1/orchestrations/${ORCH_A}/workstreams/${SHARED_KEY}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'attempt retry on wrong orchestration' }),
      });
      expect(res.status).toBe(409);
    } finally {
      await close();
    }
  });

  it('pause: scoped to orchestration_id — pausing under one orchestration never blocks the same-keyed row in another', async () => {
    // Both rows start IN_PROGRESS (pause-eligible) — see
    // seedTwoOrchestrationsBothPauseEligible's comment for why this matters:
    // a BLOCKED control row would pass this test vacuously even with the
    // orchestration_id predicate dropped, since PAUSE_FROM excludes BLOCKED
    // independent of scoping.
    const pauseSeed = seedTwoOrchestrationsBothPauseEligible();
    const { pool, rows } = createFakePool(pauseSeed);
    const app = makeApp(pool);
    const { url, close } = await listen(app);
    try {
      const res = await fetch(`${url}/api/v1/orchestrations/${ORCH_A}/workstreams/${SHARED_KEY}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);

      expect(rows.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')!.status).toBe('BLOCKED');
      // ORCH_B's row was also IN_PROGRESS (equally pause-eligible) and must
      // remain untouched — proves the pause UPDATE matched on orchestration_id
      // AND workstream_key together, not workstream_key (or status) alone.
      expect(rows.get('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')!.status).toBe('IN_PROGRESS');
    } finally {
      await close();
    }
  });

  it('unpause: scoped to orchestration_id — the wrong orchestration for a BLOCKED shared key 409s', async () => {
    const { pool, rows } = createFakePool(seed);
    const app = makeApp(pool);
    const { url, close } = await listen(app);
    try {
      // ORCH_A's row is NOT_STARTED, not BLOCKED — cannot unpause even though ORCH_B's
      // same-keyed row is BLOCKED. If orchestration scoping were missing, this would
      // incorrectly 200 by matching ORCH_B's row.
      const res = await fetch(`${url}/api/v1/orchestrations/${ORCH_A}/workstreams/${SHARED_KEY}/unpause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(409);

      // The real BLOCKED row (in ORCH_B) must remain untouched by ORCH_A's request.
      expect(rows.get('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')!.status).toBe('BLOCKED');

      // Confirm unpause DOES work when targeting the correct orchestration.
      const okRes = await fetch(`${url}/api/v1/orchestrations/${ORCH_B}/workstreams/${SHARED_KEY}/unpause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(okRes.status).toBe(200);
      expect(rows.get('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')!.status).toBe('RETRYING');
    } finally {
      await close();
    }
  });
});
