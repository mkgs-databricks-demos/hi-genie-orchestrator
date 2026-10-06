/**
 * Hi Genie Orchestrator — Scheduled Tick Recovery
 *
 * Periodic evaluation of the full DAG state as a safety net for when
 * LISTEN/NOTIFY misses an event. Runs on a configurable interval
 * (default: 60s) and invokes the priority-tree evaluator.
 *
 * Features:
 * - Deduplication: tracks last-evaluated state fingerprint to avoid
 *   redundant action dispatch when nothing has changed
 * - Drains unprocessed completion_signals from the durable table
 * - Invokes the priority-tree for each active orchestration
 * - Dispatches resulting actions via a configurable action executor
 */

import type { Pool } from 'pg';
import { withDbSpan, withToolSpan } from '../telemetry/index.js';
import {
  evaluatePriorityTree,
  type DispatchDecision,
  type PriorityTreeConfig,
  type WorkstreamState,
  type WorkstreamStatus,
} from './priority-tree.js';
import type { WorkstreamListener, NotificationPayload } from './listener.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface TickEvaluatorConfig {
  /** Tick interval in milliseconds (default: 60_000) */
  intervalMs: number;
  /** Priority-tree configuration overrides */
  priorityTreeConfig: Partial<PriorityTreeConfig>;
  /** Whether to drain unprocessed signals on each tick */
  drainSignalsOnTick: boolean;
}

/** Callback invoked when the evaluator produces an actionable decision */
export type ActionExecutor = (decision: DispatchDecision) => Promise<void>;

interface WorkstreamRow {
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
}

const DEFAULT_CONFIG: TickEvaluatorConfig = {
  intervalMs: 60_000,
  priorityTreeConfig: {},
  drainSignalsOnTick: true,
};

// ── Tick Evaluator Class ────────────────────────────────────────────────

export class TickEvaluator {
  private pool: Pool;
  private config: TickEvaluatorConfig;
  private executor: ActionExecutor;
  private listener: WorkstreamListener | null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private lastStateFingerprint: string = '';
  private isEvaluating = false;
  private tickCount = 0;

  constructor(
    pool: Pool,
    executor: ActionExecutor,
    listener: WorkstreamListener | null = null,
    config: Partial<TickEvaluatorConfig> = {},
  ) {
    this.pool = pool;
    this.executor = executor;
    this.listener = listener;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Start the periodic tick evaluator.
   */
  start(): void {
    if (this.intervalHandle) {
      console.warn('[dispatch/tick] Already running.');
      return;
    }

    // Run immediately on start, then at interval
    this.tick().catch((err) => {
      console.error('[dispatch/tick] Initial tick error:', err);
    });

    this.intervalHandle = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[dispatch/tick] Tick error:', err);
      });
    }, this.config.intervalMs);

    console.log(
      `[dispatch/tick] Started with interval ${this.config.intervalMs}ms`,
    );
  }

  /**
   * Stop the periodic evaluator. Does NOT drain pending work.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    console.log('[dispatch/tick] Stopped.');
  }

  /**
   * Execute a single tick evaluation on-demand.
   * Useful for event-driven invocation from the listener.
   */
  async evaluateNow(): Promise<DispatchDecision | null> {
    return this.tick();
  }

  // ── Core Tick Logic ────────────────────────────────────────────────────

  private async tick(): Promise<DispatchDecision | null> {
    // Prevent concurrent tick evaluations
    if (this.isEvaluating) {
      console.log('[dispatch/tick] Skipping — evaluation already in progress.');
      return null;
    }

    this.isEvaluating = true;
    this.tickCount++;

    try {
      return await withToolSpan('dispatch_tick', async () => {
        // Step 1: Drain any unprocessed signals (recovery path)
        if (this.config.drainSignalsOnTick && this.listener) {
          const signals = await this.listener.drainUnprocessedSignals();
          if (signals.length > 0) {
            console.log(
              `[dispatch/tick] Recovered ${signals.length} unprocessed signal(s).`,
            );
          }
        }

        // Step 2: Query current state of all active workstreams
        const states = await this.fetchWorkstreamStates();
        if (states.length === 0) {
          return null;
        }

        // Step 3: Deduplication — skip if state hasn't changed
        const fingerprint = this.computeFingerprint(states);
        if (fingerprint === this.lastStateFingerprint) {
          return null;
        }
        this.lastStateFingerprint = fingerprint;

        // Step 4: Evaluate priority tree
        const decision = evaluatePriorityTree(
          states,
          this.config.priorityTreeConfig,
        );

        // Step 5: Execute action (skip NO_OP and STATUS_REPORT)
        if (decision.action !== 'NO_OP' && decision.action !== 'STATUS_REPORT') {
          console.log(
            `[dispatch/tick] Action: ${decision.action} target=${decision.target ?? 'none'} ` +
            `(tick #${this.tickCount})`,
          );
          await this.executor(decision);
        } else if (decision.action === 'STATUS_REPORT' && this.tickCount % 10 === 0) {
          // Log status report every 10th tick
          console.log(`[dispatch/tick] Status: ${decision.reasoning}`);
        }

        return decision;
      }, { workstream_key: 'dispatch-tick' });
    } finally {
      this.isEvaluating = false;
    }
  }

  // ── Data Fetching ──────────────────────────────────────────────────────

  /**
   * Fetch all workstream states for active (non-terminal) orchestrations.
   * Queries the dispatch.workstreams table.
   */
  private async fetchWorkstreamStates(): Promise<WorkstreamState[]> {
    return await withDbSpan('fetch_workstream_states', async () => {
      const client = await this.pool.connect();
      try {
        const result = await client.query<WorkstreamRow>(
          `SELECT
             w.workstream_id::text,
             w.workstream_key,
             w.orchestration_id::text,
             w.status,
             COALESCE(w.depends_on, '[]'::jsonb) AS depends_on,
             w.attempt_count,
             w.max_retries,
             w.started_at::text,
             COALESCE(w.last_heartbeat_at, w.updated_at)::text AS last_heartbeat_at,
             w.paused
           FROM dispatch.workstreams w
           JOIN dispatch.orchestrations o
             ON w.orchestration_id = o.orchestration_id
           WHERE o.status NOT IN ('COMPLETE', 'CANCELLED')
           ORDER BY w.orchestration_id, w.workstream_key`,
        );

        return result.rows.map((row): WorkstreamState => ({
          workstream_id: row.workstream_id,
          workstream_key: row.workstream_key,
          orchestration_id: row.orchestration_id,
          status: row.status,
          depends_on: Array.isArray(row.depends_on) ? row.depends_on : [],
          attempt_count: row.attempt_count,
          max_retries: row.max_retries,
          started_at: row.started_at,
          last_heartbeat_at: row.last_heartbeat_at,
          paused: row.paused,
          // Git sync detection is out-of-band; default false here
          has_uncommitted_changes: false,
        }));
      } finally {
        client.release();
      }
    }, { workstream_key: 'dispatch-tick' });
  }

  // ── Deduplication ──────────────────────────────────────────────────────

  /**
   * Compute a fingerprint of the current workstream state array.
   * Used to detect whether state has changed between ticks.
   */
  private computeFingerprint(states: WorkstreamState[]): string {
    // Simple deterministic serialization of status + attempt_count per workstream
    const parts = states.map(
      (ws) => `${ws.orchestration_id}:${ws.workstream_key}:${ws.status}:${ws.attempt_count}:${ws.paused}`,
    );
    return parts.sort().join('|');
  }

  // ── Event-Driven Invocation ────────────────────────────────────────────

  /**
   * Handle a notification from the LISTEN/NOTIFY listener.
   * Resets the deduplication fingerprint and triggers an immediate evaluation.
   */
  async handleNotification(payload: NotificationPayload): Promise<void> {
    console.log(
      `[dispatch/tick] Event-driven wakeup: ${payload.workstream_key} → ${payload.new_status}`,
    );

    // Reset fingerprint to ensure re-evaluation
    this.lastStateFingerprint = '';

    // Evaluate immediately
    await this.tick();
  }
}
