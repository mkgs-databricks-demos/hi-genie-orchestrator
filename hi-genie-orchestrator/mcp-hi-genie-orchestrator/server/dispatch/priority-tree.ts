/**
 * Hi Genie Orchestrator — WS-INIT Stateless Priority-Tree Evaluator
 *
 * Evaluates workstream states against a fixed 8-priority decision tree.
 * Stateless: reads DAG state, produces the single highest-priority action
 * without mutating any state. Callers (tick-evaluator, listener) own
 * action execution.
 *
 * Priority order (first match wins):
 *   1. HANDLE_STUCK — IN_PROGRESS > 90 min, no heartbeat
 *   2. RESUME_RETRY — RETRYING with attempt_count < max_retries
 *   3. CREATE_NEXT — NOT_STARTED with all depends_on COMPLETE
 *   4. SURFACE_BLOCKER — BLOCKED (log for human review)
 *   5. UNPAUSE_READY — Paused workstream whose deps are now met
 *   6. GIT_SYNC — Uncommitted state file changes detected
 *   7. STATUS_REPORT — Periodic summary (no pending actions)
 *   8. NO_OP — Nothing to do
 */

// ── Types ──────────────────────────────────────────────────────────────

/** Valid workstream status values (mirrors dispatch.workstreams.status enum) */
export type WorkstreamStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'COMPLETE'
  | 'BLOCKED'
  | 'RETRYING'
  | 'READY_FOR_REVIEW'
  | 'PAUSED';

/**
 * Snapshot of a single workstream's state at evaluation time.
 *
 * workstream_id is the real primary key (globally unique). workstream_key is
 * only unique per orchestration_id (see migration 001's
 * UNIQUE (orchestration_id, workstream_key) constraint) — two different
 * orchestrations can legitimately have a workstream sharing the same key.
 * Both are carried through so callers can scope mutations and dependency
 * lookups correctly rather than colliding on workstream_key alone.
 */
export interface WorkstreamState {
  workstream_id: string;
  workstream_key: string;
  orchestration_id: string;
  status: WorkstreamStatus;
  depends_on: string[];
  attempt_count: number;
  max_retries: number;
  started_at: string | null;
  last_heartbeat_at: string | null;
  paused: boolean;
  has_uncommitted_changes: boolean;
}

/** The action type produced by the priority-tree */
export type DispatchAction =
  | 'HANDLE_STUCK'
  | 'RESUME_RETRY'
  | 'CREATE_NEXT'
  | 'SURFACE_BLOCKER'
  | 'UNPAUSE_READY'
  | 'GIT_SYNC'
  | 'STATUS_REPORT'
  | 'NO_OP';

/**
 * Result of a priority-tree evaluation.
 *
 * target is the human-readable workstream_key for logging/reasoning only.
 * Callers that mutate database state MUST use targetWorkstreamId (the real
 * PK) and/or targetOrchestrationId — never target alone — since
 * workstream_key is not globally unique.
 */
export interface DispatchDecision {
  action: DispatchAction;
  target: string | null;
  targetWorkstreamId: string | null;
  targetOrchestrationId: string | null;
  reasoning: string;
  priority: number;
}

/** DAG definition: maps workstream_key → depends_on keys */
export interface DagDefinition {
  [workstream_key: string]: string[];
}

// ── Configuration ────────────────────────────────────────────────────────

export interface PriorityTreeConfig {
  /** Minutes after which an IN_PROGRESS workstream without heartbeat is stuck */
  stuckThresholdMinutes: number;
  /** Whether GIT_SYNC detection is enabled */
  gitSyncEnabled: boolean;
}

const DEFAULT_CONFIG: PriorityTreeConfig = {
  stuckThresholdMinutes: 90,
  gitSyncEnabled: true,
};

// ── Helpers ──────────────────────────────────────────────────────────────

function minutesSince(isoTimestamp: string | null): number {
  if (!isoTimestamp) return Infinity;
  const then = new Date(isoTimestamp).getTime();
  const now = Date.now();
  return (now - then) / 60_000;
}

/**
 * Composite key for dependency-lookup maps: workstream_key alone is only
 * unique per orchestration_id (migration 001's UNIQUE constraint), so a
 * map keyed by workstream_key bare would collapse same-keyed workstreams
 * from two different orchestrations onto a single entry — a dependency
 * check for orchestration A's "ws-a" could then read orchestration B's
 * "ws-a" row (or vice versa, depending on insertion order).
 */
function dependencyMapKey(orchestrationId: string, workstreamKey: string): string {
  return `${orchestrationId}:${workstreamKey}`;
}

function allDependenciesMet(
  ws: WorkstreamState,
  stateMap: Map<string, WorkstreamState>,
): boolean {
  if (ws.depends_on.length === 0) return true;
  return ws.depends_on.every((dep) => {
    const depState = stateMap.get(dependencyMapKey(ws.orchestration_id, dep));
    return depState?.status === 'COMPLETE';
  });
}

/**
 * Groups a mixed-orchestration state array into per-orchestration buckets.
 * Every consumer that runs dependency-graph logic MUST operate on a single
 * orchestration's states at a time — this is the seam that guarantees that.
 */
function groupByOrchestration(states: WorkstreamState[]): Map<string, WorkstreamState[]> {
  const groups = new Map<string, WorkstreamState[]>();
  for (const ws of states) {
    const bucket = groups.get(ws.orchestration_id);
    if (bucket) {
      bucket.push(ws);
    } else {
      groups.set(ws.orchestration_id, [ws]);
    }
  }
  return groups;
}

/** Deterministic ordering so tie-broken cross-orchestration picks are stable across ticks. */
function compareDecisions(a: DispatchDecision, b: DispatchDecision): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const orchA = a.targetOrchestrationId ?? '';
  const orchB = b.targetOrchestrationId ?? '';
  if (orchA !== orchB) return orchA < orchB ? -1 : 1;
  const keyA = a.target ?? '';
  const keyB = b.target ?? '';
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

// ── Priority Rules ───────────────────────────────────────────────────────

type Rule = (
  states: WorkstreamState[],
  stateMap: Map<string, WorkstreamState>,
  config: PriorityTreeConfig,
) => DispatchDecision | null;

/** Builds a decision targeting a specific workstream, carrying its real PK + orchestration scope. */
function forWorkstream(
  ws: WorkstreamState,
  action: DispatchAction,
  priority: number,
  reasoning: string,
): DispatchDecision {
  return {
    action,
    target: ws.workstream_key,
    targetWorkstreamId: ws.workstream_id,
    targetOrchestrationId: ws.orchestration_id,
    reasoning,
    priority,
  };
}

/**
 * Priority 1: HANDLE_STUCK
 * Workstream IN_PROGRESS for > stuckThresholdMinutes with no recent heartbeat.
 */
const handleStuck: Rule = (states, _stateMap, config) => {
  for (const ws of states) {
    if (ws.status !== 'IN_PROGRESS') continue;

    const elapsed = minutesSince(ws.started_at);
    const heartbeatAge = minutesSince(ws.last_heartbeat_at);

    if (
      elapsed > config.stuckThresholdMinutes &&
      heartbeatAge > config.stuckThresholdMinutes
    ) {
      return forWorkstream(
        ws,
        'HANDLE_STUCK',
        1,
        `Workstream ${ws.workstream_key} (orchestration ${ws.orchestration_id}) has been IN_PROGRESS for ${Math.round(elapsed)} min with no heartbeat in ${Math.round(heartbeatAge)} min (threshold: ${config.stuckThresholdMinutes} min).`,
      );
    }
  }
  return null;
};

/**
 * Priority 2: RESUME_RETRY
 * Workstream in RETRYING state with attempts remaining AND all deps still COMPLETE.
 * The dep check is belt-and-suspenders: deps should still be COMPLETE from the
 * original dispatch, but a rolled-back or re-blocked upstream would make a retry
 * premature. Without this check, the tick would auto-advance a workstream whose
 * upstream is no longer satisfied.
 */
const resumeRetry: Rule = (states, stateMap) => {
  for (const ws of states) {
    if (ws.status !== 'RETRYING') continue;
    if (ws.attempt_count < ws.max_retries && allDependenciesMet(ws, stateMap)) {
      return forWorkstream(
        ws,
        'RESUME_RETRY',
        2,
        `Workstream ${ws.workstream_key} (orchestration ${ws.orchestration_id}) is RETRYING (attempt ${ws.attempt_count}/${ws.max_retries}), deps satisfied. Eligible for retry dispatch.`,
      );
    }
  }
  return null;
};

/**
 * Priority 3: CREATE_NEXT
 * Workstream NOT_STARTED with all depends_on COMPLETE.
 */
const createNext: Rule = (states, stateMap) => {
  for (const ws of states) {
    if (ws.status !== 'NOT_STARTED') continue;
    if (allDependenciesMet(ws, stateMap)) {
      return forWorkstream(
        ws,
        'CREATE_NEXT',
        3,
        `Workstream ${ws.workstream_key} (orchestration ${ws.orchestration_id}) is NOT_STARTED and all dependencies [${ws.depends_on.join(', ')}] are COMPLETE. Ready for dispatch.`,
      );
    }
  }
  return null;
};

/**
 * Priority 4: SURFACE_BLOCKER
 * Workstream BLOCKED — needs human attention.
 */
const surfaceBlocker: Rule = (states) => {
  for (const ws of states) {
    if (ws.status !== 'BLOCKED') continue;
    return forWorkstream(
      ws,
      'SURFACE_BLOCKER',
      4,
      `Workstream ${ws.workstream_key} (orchestration ${ws.orchestration_id}) is BLOCKED. Surfacing for human review and intervention.`,
    );
  }
  return null;
};

/**
 * Priority 5: UNPAUSE_READY
 * Workstream marked paused but whose dependencies are now all met.
 */
const unpauseReady: Rule = (states, stateMap) => {
  for (const ws of states) {
    if (!ws.paused) continue;
    if (ws.status === 'COMPLETE') continue;
    if (allDependenciesMet(ws, stateMap)) {
      return forWorkstream(
        ws,
        'UNPAUSE_READY',
        5,
        `Workstream ${ws.workstream_key} (orchestration ${ws.orchestration_id}) is paused but all dependencies are now COMPLETE. Eligible for unpausing.`,
      );
    }
  }
  return null;
};

/**
 * Priority 6: GIT_SYNC
 * Any workstream has uncommitted state file changes.
 */
const gitSync: Rule = (states, _stateMap, config) => {
  if (!config.gitSyncEnabled) return null;
  for (const ws of states) {
    if (ws.has_uncommitted_changes) {
      return forWorkstream(
        ws,
        'GIT_SYNC',
        6,
        `Workstream ${ws.workstream_key} (orchestration ${ws.orchestration_id}) has uncommitted state file changes. Git sync recommended.`,
      );
    }
  }
  return null;
};

/**
 * Priority 7: STATUS_REPORT
 * No pending actions but orchestration is still active (not all COMPLETE).
 */
const statusReport: Rule = (states) => {
  const allComplete = states.every((ws) => ws.status === 'COMPLETE');
  if (allComplete) return null;

  const orchestrationId = states[0]?.orchestration_id ?? null;
  const inProgress = states.filter((ws) => ws.status === 'IN_PROGRESS');
  const waiting = states.filter(
    (ws) => ws.status === 'NOT_STARTED' || ws.status === 'READY_FOR_REVIEW',
  );
  return {
    action: 'STATUS_REPORT',
    target: null,
    targetWorkstreamId: null,
    targetOrchestrationId: orchestrationId,
    reasoning: `Orchestration ${orchestrationId ?? '(unknown)'} active: ${inProgress.length} in-progress, ${waiting.length} waiting. No immediate actions required.`,
    priority: 7,
  };
};

const NO_OP_DECISION: DispatchDecision = {
  action: 'NO_OP',
  target: null,
  targetWorkstreamId: null,
  targetOrchestrationId: null,
  reasoning: 'All workstreams complete or no actionable conditions detected.',
  priority: 8,
};

// ── Evaluation Pipeline ──────────────────────────────────────────────────

/** Ordered list of priority rules. First non-null result wins. */
const PRIORITY_RULES: Rule[] = [
  handleStuck,    // Priority 1
  resumeRetry,    // Priority 2
  createNext,     // Priority 3
  surfaceBlocker, // Priority 4
  unpauseReady,   // Priority 5
  gitSync,        // Priority 6
  statusReport,   // Priority 7
];

/**
 * Evaluates a single orchestration's states in isolation. Internal helper —
 * the exported evaluatePriorityTree/evaluateAllActions partition a
 * (potentially multi-orchestration) input into per-orchestration buckets and
 * call this for each, so the dependency-graph rules above never see states
 * from more than one orchestration in a single pass.
 */
function evaluateSingleOrchestration(
  states: WorkstreamState[],
  config: PriorityTreeConfig,
): DispatchDecision[] {
  const stateMap = new Map<string, WorkstreamState>();
  for (const ws of states) {
    stateMap.set(dependencyMapKey(ws.orchestration_id, ws.workstream_key), ws);
  }

  const decisions: DispatchDecision[] = [];
  for (const rule of PRIORITY_RULES) {
    const decision = rule(states, stateMap, config);
    if (decision !== null) {
      decisions.push(decision);
    }
  }
  return decisions;
}

/**
 * Evaluate the full DAG state and produce the single highest-priority action.
 *
 * The input may span multiple orchestrations (e.g. the tick evaluator's
 * fetch across all active orchestrations) — each orchestration's dependency
 * graph is evaluated independently, and the single best decision across all
 * of them is returned (lowest priority number wins; ties broken
 * deterministically by orchestration_id then workstream_key so repeated
 * evaluations of unchanged state pick the same target).
 *
 * @param states - Current snapshot of workstream states, any number of orchestrations
 * @param config - Optional configuration overrides
 * @returns The highest-priority dispatch decision across all orchestrations
 */
export function evaluatePriorityTree(
  states: WorkstreamState[],
  config: Partial<PriorityTreeConfig> = {},
): DispatchDecision {
  const resolvedConfig: PriorityTreeConfig = { ...DEFAULT_CONFIG, ...config };
  if (states.length === 0) return NO_OP_DECISION;

  const groups = groupByOrchestration(states);
  let best: DispatchDecision | null = null;

  for (const orchStates of groups.values()) {
    const decisions = evaluateSingleOrchestration(orchStates, resolvedConfig);
    for (const decision of decisions) {
      if (best === null || compareDecisions(decision, best) < 0) {
        best = decision;
      }
    }
  }

  return best ?? NO_OP_DECISION;
}

/**
 * Evaluate all actionable items across all orchestrations (returns every
 * matching rule per orchestration, not just the single best). Useful for
 * batch processing and status reports.
 *
 * @param states - Current snapshot of workstream states, any number of orchestrations
 * @param config - Optional configuration overrides
 * @returns All matching dispatch decisions, ordered by priority then orchestration/key
 */
export function evaluateAllActions(
  states: WorkstreamState[],
  config: Partial<PriorityTreeConfig> = {},
): DispatchDecision[] {
  const resolvedConfig: PriorityTreeConfig = { ...DEFAULT_CONFIG, ...config };
  if (states.length === 0) return [NO_OP_DECISION];

  const groups = groupByOrchestration(states);
  const decisions: DispatchDecision[] = [];

  for (const orchStates of groups.values()) {
    decisions.push(...evaluateSingleOrchestration(orchStates, resolvedConfig));
  }

  if (decisions.length === 0) {
    return [NO_OP_DECISION];
  }

  return decisions.sort(compareDecisions);
}
