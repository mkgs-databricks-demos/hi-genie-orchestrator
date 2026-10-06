/**
 * Hi Genie Orchestrator — Dispatch Engine Entry Point
 *
 * Event-driven dispatch combining:
 * - Lakebase LISTEN/NOTIFY for real-time workstream status wakeups
 * - Scheduled tick recovery as a fallback safety net
 * - WS-INIT stateless priority-tree evaluation
 * - Review task dispatch for READY_FOR_REVIEW transitions
 *
 * Import pattern:
 *   import { setupDispatch } from './dispatch/index.js';
 *
 * Then call in server.ts onPluginsReady:
 *   await setupDispatch(appkit);
 */

// AppKit type not exported in 0.38.1 — use structural interface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AppKitInstance = any;
import { randomUUID } from 'crypto';
import { WorkstreamListener, type NotificationPayload } from './listener.js';
import { TickEvaluator, type ActionExecutor } from './tick-evaluator.js';
import { ReviewDispatcher } from './review-dispatcher.js';
import { type DispatchDecision } from './priority-tree.js';
import { withToolSpan } from '../telemetry/index.js';

// ── System Identity ─────────────────────────────────────────────────────────

/**
 * Well-known identity for dispatch-engine operations that run without a
 * user context (tick evaluator, listener handler). Used as:
 *   - app.user_identity GUC for RLS (set_config per transaction)
 *   - worker_identity in dispatch.executions INSERT (satisfies RLS policy)
 *   - assigned_to in dispatch.workstreams UPDATE
 */
export const SYSTEM_IDENTITY = 'system:dispatch-engine';

// ── Re-exports ──────────────────────────────────────────────────────────────

export type {
  WorkstreamStatus,
  WorkstreamState,
  DispatchAction,
  DispatchDecision,
  DagDefinition,
  PriorityTreeConfig,
} from './priority-tree.js';

export { evaluatePriorityTree, evaluateAllActions } from './priority-tree.js';

export type {
  NotificationPayload,
  ListenerConfig,
} from './listener.js';

export type {
  TickEvaluatorConfig,
  ActionExecutor,
} from './tick-evaluator.js';

export type {
  ReviewTask,
  ReviewContext,
  ReviewDispatcherConfig,
} from './review-dispatcher.js';

export { WorkstreamListener } from './listener.js';
export { TickEvaluator } from './tick-evaluator.js';
export { ReviewDispatcher } from './review-dispatcher.js';

// ── Module State ────────────────────────────────────────────────────────────

let listener: WorkstreamListener | null = null;
let tickEvaluator: TickEvaluator | null = null;
let reviewDispatcher: ReviewDispatcher | null = null;

// ── Configuration ───────────────────────────────────────────────────────────

interface DispatchConfig {
  /** Tick evaluator interval in ms (env: DISPATCH_TICK_INTERVAL_MS) */
  tickIntervalMs: number;
  /** Stuck threshold in minutes (env: DISPATCH_STUCK_THRESHOLD_MIN) */
  stuckThresholdMinutes: number;
  /** Enable LISTEN/NOTIFY (env: DISPATCH_LISTEN_ENABLED) */
  listenEnabled: boolean;
  /** Enable GIT_SYNC detection (env: DISPATCH_GIT_SYNC_ENABLED) */
  gitSyncEnabled: boolean;
}

function loadConfig(): DispatchConfig {
  return {
    tickIntervalMs: parseInt(
      process.env['DISPATCH_TICK_INTERVAL_MS'] ?? '60000',
      10,
    ),
    stuckThresholdMinutes: parseInt(
      process.env['DISPATCH_STUCK_THRESHOLD_MIN'] ?? '90',
      10,
    ),
    listenEnabled:
      (process.env['DISPATCH_LISTEN_ENABLED'] ?? 'false') === 'true',
    gitSyncEnabled:
      (process.env['DISPATCH_GIT_SYNC_ENABLED'] ?? 'true') === 'true',
  };
}

// ── Setup ───────────────────────────────────────────────────────────────────

/**
 * Initialize the dispatch engine. Called from server.ts onPluginsReady
 * after migrations and telemetry are initialized.
 *
 * Sets up:
 * 1. LISTEN/NOTIFY consumer (real-time wakeups)
 * 2. Tick evaluator (periodic fallback)
 * 3. Review dispatcher (READY_FOR_REVIEW → review task creation)
 */
export async function setupDispatch(appkit: AppKitInstance): Promise<void> {
  const config = loadConfig();
  const pool = appkit.lakebase.pool;

  console.log('[dispatch] Initializing dispatch engine...');
  console.log(
    `[dispatch] Config: tick=${config.tickIntervalMs}ms, stuck=${config.stuckThresholdMinutes}min, ` +
    `listen=${config.listenEnabled}, gitSync=${config.gitSyncEnabled}`,
  );

  // Initialize review dispatcher
  reviewDispatcher = new ReviewDispatcher(pool);

  // Build the action executor that handles priority-tree decisions
  const executor: ActionExecutor = async (decision: DispatchDecision) => {
    await executeAction(decision, pool);
  };

  // Initialize notification handler that bridges listener → evaluator + review
  const notificationHandler = async (payload: NotificationPayload): Promise<void> => {
    // Dispatch review task creation for READY_FOR_REVIEW
    await reviewDispatcher!.handleStatusChange(payload);

    // Trigger priority-tree evaluation
    if (tickEvaluator) {
      await tickEvaluator.handleNotification(payload);
    }
  };

  // Always install DDL (completion_signals table + trigger) — works through pool
  const ddlListener = new WorkstreamListener(pool, notificationHandler);
  try {
    await ddlListener.installDDL();
  } catch (err) {
    console.warn('[dispatch] Failed to install listener DDL (non-fatal):', err);
  }

  // LISTEN/NOTIFY requires a persistent non-pooled connection.
  // Disabled by default on Lakebase (PgBouncer transaction mode).
  if (config.listenEnabled) {
    listener = ddlListener;
    try {
      await listener.start();
      console.log('[dispatch] LISTEN/NOTIFY consumer active.');
    } catch (err) {
      console.error('[dispatch] Failed to start listener (falling back to tick-only):', err);
      listener = null;
    }
  } else {
    console.log('[dispatch] LISTEN/NOTIFY disabled; using tick + outbox polling.');
  }

  // Initialize tick evaluator (always active as safety net)
  tickEvaluator = new TickEvaluator(pool, executor, listener, {
    intervalMs: config.tickIntervalMs,
    priorityTreeConfig: {
      stuckThresholdMinutes: config.stuckThresholdMinutes,
      gitSyncEnabled: config.gitSyncEnabled,
    },
    drainSignalsOnTick: true,
  });
  tickEvaluator.start();

  console.log('[dispatch] Dispatch engine initialized.');
}

// ── Action Executor ─────────────────────────────────────────────────────────

/**
 * Execute an action produced by the priority-tree evaluator.
 * Routes each action type to the appropriate handler.
 *
 * Exported (not just an internal helper) so tests can exercise the actual
 * dispatch-engine SQL scoping directly, rather than only through the
 * Supervisor API's HTTP routes.
 */
export async function executeAction(
  decision: DispatchDecision,
  pool: import('pg').Pool,
): Promise<void> {
  await withToolSpan(`dispatch_action_${decision.action}`, async () => {
    switch (decision.action) {
      case 'HANDLE_STUCK':
        await handleStuckAction(decision, pool);
        break;

      case 'RESUME_RETRY':
        await resumeRetryAction(decision, pool);
        break;

      case 'CREATE_NEXT':
        await createNextAction(decision, pool);
        break;

      case 'SURFACE_BLOCKER':
        console.warn(
          `[dispatch/action] BLOCKER: ${decision.target} (orchestration ${decision.targetOrchestrationId ?? 'unknown'}) — ${decision.reasoning}`,
        );
        // In Release 1, blockers are logged. Release 1.1 adds notification.
        break;

      case 'UNPAUSE_READY':
        await unpauseReadyAction(decision, pool);
        break;

      case 'GIT_SYNC':
        console.log(
          `[dispatch/action] GIT_SYNC needed for ${decision.target} (orchestration ${decision.targetOrchestrationId ?? 'unknown'})`,
        );
        // Git sync is advisory in Release 1; scheduled task handles actual commits
        break;

      case 'STATUS_REPORT':
      case 'NO_OP':
        // No action needed
        break;
    }
  }, {
    workstream_key: decision.target ?? 'dispatch',
    'service.surface': 'internal',
  });
}

/**
 * Mark a stuck workstream as RETRYING with incremented attempt count.
 *
 * Scoped by workstream_id (the real, globally-unique primary key) rather
 * than workstream_key, which is only unique per orchestration_id — a bare
 * workstream_key filter could mutate a same-keyed row belonging to a
 * different orchestration. targetOrchestrationId is included as a
 * defense-in-depth belt-and-suspenders check, not because workstream_id
 * alone is ambiguous.
 */
async function handleStuckAction(
  decision: DispatchDecision,
  pool: import('pg').Pool,
): Promise<void> {
  if (!decision.targetWorkstreamId || !decision.targetOrchestrationId) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_identity', $1, true)`, [SYSTEM_IDENTITY]);

    const result = await client.query(
      `UPDATE dispatch.workstreams
       SET status = 'RETRYING',
           error_message = 'Marked stuck by dispatch engine (no heartbeat)',
           updated_at = NOW()
       WHERE workstream_id = $1
         AND orchestration_id = $2
         AND status = 'IN_PROGRESS'`,
      [decision.targetWorkstreamId, decision.targetOrchestrationId],
    );

    await client.query('COMMIT');
    if (result.rowCount) {
      console.log(`[dispatch/action] Marked ${decision.target} (orchestration ${decision.targetOrchestrationId}) as RETRYING (stuck).`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Transition a RETRYING workstream to IN_PROGRESS for the next attempt.
 * Scoped by workstream_id + orchestration_id — see handleStuckAction.
 */
async function resumeRetryAction(
  decision: DispatchDecision,
  pool: import('pg').Pool,
): Promise<void> {
  if (!decision.targetWorkstreamId || !decision.targetOrchestrationId) return;

  const execution_id = randomUUID();
  const correlation_id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_identity', $1, true)`, [SYSTEM_IDENTITY]);

    // Read current attempt_count + project_id for execution record
    const wsResult = await client.query(
      `SELECT attempt_count, project_id
       FROM dispatch.workstreams
       WHERE workstream_id = $1
         AND orchestration_id = $2
         AND status = 'RETRYING'
       FOR UPDATE`,
      [decision.targetWorkstreamId, decision.targetOrchestrationId],
    );

    if (wsResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return;
    }

    const nextAttempt = wsResult.rows[0].attempt_count + 1;
    const project_id = wsResult.rows[0].project_id;

    // Create execution record (audit trail — previously missing from tick path)
    await client.query(
      `INSERT INTO dispatch.executions
         (execution_id, workstream_id, project_id, attempt_number,
          status, worker_identity, correlation_id)
       VALUES ($1, $2, $3, $4, 'RUNNING', $5, $6)`,
      [execution_id, decision.targetWorkstreamId, project_id, nextAttempt, SYSTEM_IDENTITY, correlation_id],
    );

    // Advance workstream status
    const result = await client.query(
      `UPDATE dispatch.workstreams
       SET status = 'IN_PROGRESS',
           attempt_count = $3,
           assigned_to = $4,
           started_at = NOW(),
           last_heartbeat_at = NOW(),
           error_message = NULL,
           correlation_id = $5,
           updated_at = NOW()
       WHERE workstream_id = $1
         AND orchestration_id = $2
         AND status = 'RETRYING'`,
      [decision.targetWorkstreamId, decision.targetOrchestrationId, nextAttempt, SYSTEM_IDENTITY, correlation_id],
    );

    await client.query('COMMIT');
    if (result.rowCount) {
      console.log(
        `[dispatch/action] Dispatched retry for ${decision.target} (orchestration ${decision.targetOrchestrationId}, ` +
        `attempt ${nextAttempt}, execution ${execution_id}).`,
      );
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Transition a NOT_STARTED workstream to IN_PROGRESS (initial dispatch).
 * Scoped by workstream_id + orchestration_id — see handleStuckAction.
 */
async function createNextAction(
  decision: DispatchDecision,
  pool: import('pg').Pool,
): Promise<void> {
  if (!decision.targetWorkstreamId || !decision.targetOrchestrationId) return;

  const execution_id = randomUUID();
  const correlation_id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_identity', $1, true)`, [SYSTEM_IDENTITY]);

    // Read project_id for execution record (also re-confirms NOT_STARTED under lock)
    const wsResult = await client.query(
      `SELECT project_id
       FROM dispatch.workstreams
       WHERE workstream_id = $1
         AND orchestration_id = $2
         AND status = 'NOT_STARTED'
       FOR UPDATE`,
      [decision.targetWorkstreamId, decision.targetOrchestrationId],
    );

    if (wsResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return;
    }

    const project_id = wsResult.rows[0].project_id;

    // Create execution record (audit trail — previously missing from tick path)
    await client.query(
      `INSERT INTO dispatch.executions
         (execution_id, workstream_id, project_id, attempt_number,
          status, worker_identity, correlation_id)
       VALUES ($1, $2, $3, 1, 'RUNNING', $4, $5)`,
      [execution_id, decision.targetWorkstreamId, project_id, SYSTEM_IDENTITY, correlation_id],
    );

    // Advance workstream status
    const result = await client.query(
      `UPDATE dispatch.workstreams
       SET status = 'IN_PROGRESS',
           attempt_count = 1,
           assigned_to = $3,
           started_at = NOW(),
           last_heartbeat_at = NOW(),
           correlation_id = $4,
           updated_at = NOW()
       WHERE workstream_id = $1
         AND orchestration_id = $2
         AND status = 'NOT_STARTED'`,
      [decision.targetWorkstreamId, decision.targetOrchestrationId, SYSTEM_IDENTITY, correlation_id],
    );

    await client.query('COMMIT');
    if (result.rowCount) {
      console.log(
        `[dispatch/action] Dispatched initial execution for ${decision.target} (orchestration ${decision.targetOrchestrationId}, ` +
        `execution ${execution_id}).`,
      );
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Unpause a workstream whose dependencies are now met.
 * Scoped by workstream_id + orchestration_id — see handleStuckAction.
 */
async function unpauseReadyAction(
  decision: DispatchDecision,
  pool: import('pg').Pool,
): Promise<void> {
  if (!decision.targetWorkstreamId || !decision.targetOrchestrationId) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_identity', $1, true)`, [SYSTEM_IDENTITY]);

    const result = await client.query(
      `UPDATE dispatch.workstreams
       SET paused = FALSE,
           status = 'NOT_STARTED',
           updated_at = NOW()
       WHERE workstream_id = $1
         AND orchestration_id = $2
         AND paused = TRUE`,
      [decision.targetWorkstreamId, decision.targetOrchestrationId],
    );

    await client.query('COMMIT');
    if (result.rowCount) {
      console.log(`[dispatch/action] Unpaused ${decision.target} (orchestration ${decision.targetOrchestrationId}).`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Graceful Shutdown ───────────────────────────────────────────────────────

/**
 * Gracefully shut down the dispatch engine.
 * Called during App shutdown to drain pending work and release resources.
 */
export async function shutdownDispatch(): Promise<void> {
  console.log('[dispatch] Shutting down...');

  // Stop tick evaluator first (prevents new evaluations)
  if (tickEvaluator) {
    tickEvaluator.stop();
    tickEvaluator = null;
  }

  // Shut down listener (UNLISTEN + release dedicated client)
  if (listener) {
    await listener.shutdown();
    listener = null;
  }

  reviewDispatcher = null;
  console.log('[dispatch] Shutdown complete.');
}
