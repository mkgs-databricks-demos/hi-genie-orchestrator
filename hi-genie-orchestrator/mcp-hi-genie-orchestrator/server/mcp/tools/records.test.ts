/**
 * record_decision Contract Guard
 *
 * Migration 002 (`state.decisions`) declares `workstream_id UUID NOT NULL`.
 * This test locks the `record_decision` MCP tool's inputSchema (what
 * `tools/list` actually advertises to a calling LLM), its handler's
 * destructuring, and the DB write it performs into agreement — the exact
 * three-way mismatch class that Known Issue 16 / the backend-stabilization
 * gate review flagged for this tool ("residual from KI-16 that only fixed
 * 6 of 7 affected tools").
 *
 * If any of these three drift apart again (schema says optional but DB
 * requires it, or a handler param disappears from the schema, or a stale
 * field like the old `description`/`status`/`metadata` reappears), this
 * test fails.
 */

import { describe, it, expect } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { recordToolDefinitions, recordToolHandlers } from './records.js';
import type { McpSession } from '../transport.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const WORKSTREAM_ID = '22222222-2222-4222-8222-222222222222';

function getRecordDecisionDefinition() {
  const def = recordToolDefinitions.find((d) => d.name === 'record_decision');
  if (!def) throw new Error('record_decision tool definition not found in tools/list contract');
  return def;
}

describe('record_decision — tools/list schema contract', () => {
  it('advertises workstream_id as required, matching the DB NOT NULL constraint on state.decisions', () => {
    const def = getRecordDecisionDefinition();
    expect(def.inputSchema.required).toContain('workstream_id');
    expect(def.inputSchema.properties).toHaveProperty('workstream_id');
  });

  it('advertises exactly the fields the handler consumes — no stale KI-16 residue (description/status/metadata)', () => {
    const def = getRecordDecisionDefinition();
    const advertisedFields = Object.keys(def.inputSchema.properties as Record<string, unknown>);

    // Fields the handler actually destructures from params (records.ts recordDecision).
    const handlerFields = [
      'project_id', 'workstream_id', 'session_id', 'idempotency_key',
      'title', 'context', 'decision', 'rationale',
      'alternatives_considered', 'implications', 'tags',
    ];

    expect(new Set(advertisedFields)).toEqual(new Set(handlerFields));

    // Explicit regression guard for the exact stale fields the backend-stabilization
    // gate review found and removed.
    expect(advertisedFields).not.toContain('description');
    expect(advertisedFields).not.toContain('status');
    expect(advertisedFields).not.toContain('metadata');
  });

  it('required fields are all fields the handler cannot proceed without (project_id, workstream_id, idempotency_key, title, context, decision)', () => {
    const def = getRecordDecisionDefinition();
    expect(def.inputSchema.required).toEqual(
      expect.arrayContaining(['project_id', 'workstream_id', 'idempotency_key', 'title', 'context', 'decision']),
    );
  });
});

describe('record_decision — handler write matches the required-field contract', () => {
  function createFakePool() {
    const inserted: Record<string, unknown>[] = [];

    const client = {
      query: (sql: string, params: unknown[]) => {
        if (sql.includes('INSERT INTO state.decisions')) {
          const [decision_id, project_id, workstream_id] = params as [string, string, string | null];
          if (workstream_id === null || workstream_id === undefined) {
            // Simulates the real Postgres NOT NULL constraint violation on
            // state.decisions.workstream_id (migration 002) — a null here
            // would be rejected by the live database.
            throw new Error('null value in column "workstream_id" violates not-null constraint');
          }
          inserted.push({ decision_id, project_id, workstream_id });
          return { rows: [{ decision_id }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    } as unknown as PoolClient;

    const pool = { connect: () => client } as unknown as Pool;
    return { pool, inserted };
  }

  it('writes a non-null workstream_id to state.decisions when the caller supplies one (the required-field contract path)', async () => {
    const { pool, inserted } = createFakePool();
    const handler = recordToolHandlers.get('record_decision')!;
    const session: McpSession = { id: 's1', userId: 'alice@example.com', createdAt: new Date(), lastActiveAt: new Date() };

    const result = await handler(
      {
        project_id: PROJECT_ID,
        workstream_id: WORKSTREAM_ID,
        idempotency_key: randomUUID(),
        title: 'Adopt RLS via session variables',
        context: 'Need write-integrity without per-identity roles',
        decision: 'Use set_config/current_setting pattern',
      },
      session,
      pool,
    );

    expect((result as { created: boolean }).created).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].workstream_id).toBe(WORKSTREAM_ID);
  });
});
