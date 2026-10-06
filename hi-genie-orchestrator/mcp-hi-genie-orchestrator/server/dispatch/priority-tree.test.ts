/**
 * Priority-Tree Evaluator — Cross-Orchestration Isolation Tests
 *
 * The tick evaluator's fetchWorkstreamStates() intentionally spans ALL active
 * orchestrations in one query (it's a periodic safety net, not scoped to a
 * single orchestration). Because workstream_key is only unique per
 * orchestration_id (migration 001's UNIQUE (orchestration_id, workstream_key)
 * constraint), a naive evaluator that keys its dependency-lookup map by
 * workstream_key alone would let orchestration A's "ws-a" satisfy a
 * dependency check for orchestration B's "ws-a" — or dispatch A's row when
 * evaluating B's DAG. These tests prove evaluatePriorityTree/evaluateAllActions
 * evaluate each orchestration's dependency graph independently and never
 * produce a decision whose targetWorkstreamId belongs to the wrong
 * targetOrchestrationId.
 */

import { describe, it, expect } from 'vitest';
import { evaluatePriorityTree, evaluateAllActions, type WorkstreamState } from './priority-tree.js';

const ORCH_A = '11111111-1111-4111-8111-111111111111';
const ORCH_B = '22222222-2222-4222-8222-222222222222';

function ws(overrides: Partial<WorkstreamState> & { workstream_id: string; workstream_key: string; orchestration_id: string }): WorkstreamState {
  return {
    status: 'NOT_STARTED',
    depends_on: [],
    attempt_count: 0,
    max_retries: 3,
    started_at: null,
    last_heartbeat_at: null,
    paused: false,
    has_uncommitted_changes: false,
    ...overrides,
  };
}

describe('evaluatePriorityTree — cross-orchestration dependency isolation', () => {
  it('does not let orchestration A satisfy a same-keyed dependency for orchestration B', () => {
    // Both orchestrations have a workstream keyed "ws-a" (upstream) and "ws-b"
    // (downstream, depends_on: ["ws-a"]). Orchestration A's "ws-a" is COMPLETE;
    // orchestration B's "ws-a" is still NOT_STARTED. If the evaluator collapsed
    // both "ws-a" rows into one map entry keyed by workstream_key alone, B's
    // "ws-b" could incorrectly see its dependency as satisfied by A's row.
    const states: WorkstreamState[] = [
      ws({ workstream_id: 'a1', workstream_key: 'ws-a', orchestration_id: ORCH_A, status: 'COMPLETE' }),
      ws({ workstream_id: 'a2', workstream_key: 'ws-b', orchestration_id: ORCH_A, status: 'NOT_STARTED', depends_on: ['ws-a'] }),
      ws({ workstream_id: 'b1', workstream_key: 'ws-a', orchestration_id: ORCH_B, status: 'NOT_STARTED' }),
      ws({ workstream_id: 'b2', workstream_key: 'ws-b', orchestration_id: ORCH_B, status: 'NOT_STARTED', depends_on: ['ws-a'] }),
    ];

    const decisions = evaluateAllActions(states);
    const createNextDecisions = decisions.filter((d) => d.action === 'CREATE_NEXT');

    // Only orchestration A's "ws-a" (NOT_STARTED, no deps) and A's "ws-b"
    // (deps met by A's own "ws-a") should be eligible. B's "ws-b" must NOT
    // appear — its own orchestration's "ws-a" is NOT_STARTED, not COMPLETE.
    const bWsB = createNextDecisions.find(
      (d) => d.targetWorkstreamId === 'b2' && d.targetOrchestrationId === ORCH_B,
    );
    expect(bWsB).toBeUndefined();

    // A's "ws-b" — whose dependency IS genuinely satisfied within A — must appear.
    const aWsB = createNextDecisions.find(
      (d) => d.targetWorkstreamId === 'a2' && d.targetOrchestrationId === ORCH_A,
    );
    expect(aWsB).toBeDefined();

    // B's "ws-a" (NOT_STARTED, no deps) is independently eligible — this is
    // correct and orchestration-scoped, not a leak.
    const bWsA = createNextDecisions.find(
      (d) => d.targetWorkstreamId === 'b1' && d.targetOrchestrationId === ORCH_B,
    );
    expect(bWsA).toBeDefined();
  });

  it('every decision carries a targetOrchestrationId that actually owns targetWorkstreamId', () => {
    const states: WorkstreamState[] = [
      ws({ workstream_id: 'a1', workstream_key: 'shared-key', orchestration_id: ORCH_A, status: 'RETRYING', attempt_count: 1, max_retries: 3 }),
      ws({ workstream_id: 'b1', workstream_key: 'shared-key', orchestration_id: ORCH_B, status: 'BLOCKED' }),
    ];

    const ownerByWorkstreamId = new Map(states.map((s) => [s.workstream_id, s.orchestration_id]));

    const decisions = evaluateAllActions(states);
    for (const decision of decisions) {
      if (decision.targetWorkstreamId === null) continue;
      expect(decision.targetOrchestrationId).toBe(ownerByWorkstreamId.get(decision.targetWorkstreamId));
    }
  });

  it('evaluatePriorityTree returns the single best decision and it targets the correct orchestration', () => {
    // A's workstream is stuck (priority 1); B's is merely retrying (priority 2).
    // The single best decision across both orchestrations must be A's stuck one.
    const states: WorkstreamState[] = [
      ws({
        workstream_id: 'a1',
        workstream_key: 'shared-key',
        orchestration_id: ORCH_A,
        status: 'IN_PROGRESS',
        started_at: new Date(Date.now() - 200 * 60_000).toISOString(),
        last_heartbeat_at: new Date(Date.now() - 200 * 60_000).toISOString(),
      }),
      ws({
        workstream_id: 'b1',
        workstream_key: 'shared-key',
        orchestration_id: ORCH_B,
        status: 'RETRYING',
        attempt_count: 1,
        max_retries: 3,
      }),
    ];

    const decision = evaluatePriorityTree(states);
    expect(decision.action).toBe('HANDLE_STUCK');
    expect(decision.targetWorkstreamId).toBe('a1');
    expect(decision.targetOrchestrationId).toBe(ORCH_A);
  });

  it('an UNPAUSE_READY decision for a paused workstream never fires because a same-keyed row in another orchestration completed its deps', () => {
    // A's "ws-b" is paused, depends_on ["ws-a"]; A's "ws-a" is NOT_STARTED (not
    // met). B's "ws-a" (same key) IS complete. A naive same-key lookup would
    // let B's completion satisfy A's pause-gate.
    const states: WorkstreamState[] = [
      ws({ workstream_id: 'a1', workstream_key: 'ws-a', orchestration_id: ORCH_A, status: 'NOT_STARTED' }),
      ws({ workstream_id: 'a2', workstream_key: 'ws-b', orchestration_id: ORCH_A, status: 'BLOCKED', paused: true, depends_on: ['ws-a'] }),
      ws({ workstream_id: 'b1', workstream_key: 'ws-a', orchestration_id: ORCH_B, status: 'COMPLETE' }),
    ];

    const decisions = evaluateAllActions(states);
    const unpauseDecisions = decisions.filter((d) => d.action === 'UNPAUSE_READY');
    const leaked = unpauseDecisions.find((d) => d.targetWorkstreamId === 'a2');
    expect(leaked).toBeUndefined();
  });
});
