/**
 * Hi Genie Orchestrator — Review Task Dispatcher
 *
 * Detects workstreams entering READY_FOR_REVIEW state and creates
 * corresponding review tasks via the Supervisor API (direct DB insert
 * into dispatch.review_tasks).
 *
 * Idempotency: uses a deterministic `review_task_id` derived from
 * (orchestration_id + workstream_key + attempt_count) to prevent
 * duplicate review creation on retries or redundant notifications.
 *
 * Includes remediation context: prior_error, attempt_count, and
 * output artifact paths for the reviewer.
 */

import type { Pool, PoolClient } from 'pg';
import { createHash } from 'crypto';
import { withToolSpan, withDbSpan } from '../telemetry/index.js';
import type { NotificationPayload } from './listener.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReviewTask {
  review_task_id: string;
  orchestration_id: string;
  workstream_key: string;
  attempt_count: number;
  status: 'PENDING' | 'IN_REVIEW' | 'APPROVED' | 'CANCELLED';
  context: ReviewContext;
  created_at: string;
}

export interface ReviewContext {
  prior_error: string | null;
  attempt_count: number;
  max_retries: number;
  workstream_name: string | null;
  started_at: string | null;
}

export interface ReviewDispatcherConfig {
  /** Whether to include full error details in review context */
  includeErrorDetails: boolean;
}

/**
 * Data carried out of the insert transaction once it has COMMITted and the
 * client has been released. Deliberately holds no client/transaction handle:
 * the caller builds the public ReviewTask from this with no database
 * resources in scope, so post-commit work cannot touch the connection.
 */
interface CommittedReviewTaskData {
  reviewTaskId: string;
  attemptCount: number;
  reviewFindings: ReviewContext;
  createdAt: string;
}

const DEFAULT_CONFIG: ReviewDispatcherConfig = {
  includeErrorDetails: true,
};

// ── Review Dispatcher Class ────────────────────────────────────────────

export class ReviewDispatcher {
  private pool: Pool;
  private config: ReviewDispatcherConfig;

  constructor(pool: Pool, config: Partial<ReviewDispatcherConfig> = {}) {
    this.pool = pool;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Handle a workstream status change notification.
   * Creates a review task if the new status is READY_FOR_REVIEW.
   */
  async handleStatusChange(payload: NotificationPayload): Promise<ReviewTask | null> {
    if (payload.new_status !== 'READY_FOR_REVIEW') {
      return null;
    }

    return await withToolSpan('dispatch_review_task', async () => {
      return await this.createReviewTask(
        payload.orchestration_id,
        payload.workstream_key,
      );
    }, {
      workstream_key: payload.workstream_key,
      'service.surface': 'internal',
    });
  }

  /**
   * Scan for any workstreams in READY_FOR_REVIEW that don't have a
   * corresponding review task. Used as a recovery mechanism.
   */
  async scanAndCreateMissing(): Promise<ReviewTask[]> {
    return await withToolSpan('scan_missing_reviews', async () => {
      const workstreams = await this.findUnreviewedWorkstreams();
      const tasks: ReviewTask[] = [];

      for (const ws of workstreams) {
        const task = await this.createReviewTask(
          ws.orchestration_id,
          ws.workstream_key,
        );
        if (task) {
          tasks.push(task);
        }
      }

      if (tasks.length > 0) {
        console.log(
          `[dispatch/review] Created ${tasks.length} missing review task(s).`,
        );
      }

      return tasks;
    }, { workstream_key: 'dispatch-review' });
  }

  // ── Transaction Safety ───────────────────────────────────────────────────

  /**
   * Releases a client back to the pool exactly once, swallowing (but
   * logging) a failure from `release()` itself.
   *
   * `release()` throwing is NOT a transaction-integrity problem — by the
   * time we call it the transaction is already closed (COMMIT or ROLLBACK
   * has returned). The only realistic cause is pg-pool's own
   * "Release called on client which has already been released" guard, and
   * retrying or escalating would be strictly worse: a second `release()`
   * call is exactly what that guard exists to reject. So it is logged and
   * dropped, never converted into an eviction (which would be a second
   * release) and never conflated with a rollback failure.
   *
   * @param evictionError When set, passed to `release(err)` so pg-pool
   *   destroys the connection instead of reusing it. Reserved for the case
   *   where the `ROLLBACK` *query* failed — see rollbackAndRelease.
   */
  private releaseOnce(client: PoolClient, context: string, evictionError?: Error): void {
    try {
      if (evictionError) {
        client.release(evictionError);
      } else {
        client.release();
      }
    } catch (releaseErr) {
      console.error(
        `[dispatch/review] client.release() failed (${context}); the transaction was already ` +
        `closed, so this is a pool-bookkeeping problem only — not retrying.`,
        releaseErr,
      );
    }
  }

  /**
   * Closes a failed transaction: ROLLBACK, then release the client exactly once.
   *
   * If the ROLLBACK *query* fails, the transaction's actual state on the
   * server is unknown — the connection must NOT be quietly returned to the
   * pool, since a half-open (or unexpectedly still-open) transaction handed
   * to the next borrower would corrupt that borrower's session (their
   * statements would run inside OUR abandoned transaction). pg's
   * `PoolClient.release(err)` form signals pg-pool to destroy the
   * connection rather than reuse it — see pg-pool's `_release`, which
   * treats a truthy argument as "evict this client" — so that's what we
   * pass in that case.
   *
   * Rollback failure and release failure are handled separately and never
   * conflated: a successful ROLLBACK followed by a throwing `release()` is
   * a pool-bookkeeping issue (logged by releaseOnce), NOT a reason to evict
   * — and crucially not a reason to call `release()` a second time.
   *
   * Never throws, so callers can invoke it from a catch block without
   * masking the original error.
   */
  private async rollbackAndRelease(client: PoolClient, context: string): Promise<void> {
    let rollbackFailure: Error | undefined;
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      rollbackFailure = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
      console.error(
        `[dispatch/review] ROLLBACK failed while closing the transaction (${context}); ` +
        `destroying the connection instead of returning a possibly open-transaction client to the pool.`,
        rollbackFailure,
      );
    }
    this.releaseOnce(client, context, rollbackFailure);
  }

  // ── Core Logic ─────────────────────────────────────────────────────────

  /**
   * Create a review task for a specific workstream.
   * Idempotent: ON CONFLICT DO NOTHING using review_task_id.
   *
   * @returns The created ReviewTask, or null if it already exists.
   */
  private async createReviewTask(
    orchestrationId: string,
    workstreamKey: string,
  ): Promise<ReviewTask | null> {
    return await withDbSpan('create_review_task', async () => {
      // The transaction is confined to runInsertTransaction below: it owns
      // the client for its entire lifetime and guarantees the client is
      // settled (COMMIT+release, or ROLLBACK+release) exactly once before
      // it returns or throws. Everything after it — building the ReviewTask
      // object, logging — runs with NO client in scope at all, so a post-commit
      // exception cannot reach a rollback path or double-release. That
      // structural separation is the point: an earlier version wrapped both
      // phases in one broad try/catch whose catch called rollback+release,
      // so any post-COMMIT throw rolled back an already-committed transaction
      // and released an already-released client.
      const committed = await this.runInsertTransaction(orchestrationId, workstreamKey);

      if (!committed) {
        return null;
      }

      const task: ReviewTask = {
        review_task_id: committed.reviewTaskId,
        orchestration_id: orchestrationId,
        workstream_key: workstreamKey,
        attempt_count: committed.attemptCount,
        status: 'PENDING',
        context: committed.reviewFindings as unknown as ReviewContext,
        created_at: committed.createdAt,
      };

      console.log(
        `[dispatch/review] Created review task ${committed.reviewTaskId} for ${workstreamKey} ` +
        `(attempt ${committed.attemptCount}).`,
      );

      return task;
    }, { workstream_key: workstreamKey });
  }

  /**
   * Runs the BEGIN → … → COMMIT transaction that inserts the review task.
   *
   * Owns the pooled client for its whole lifetime and settles it exactly
   * once on every path:
   *   - success            → COMMIT, then release()
   *   - already exists     → COMMIT, then release() (nothing was written,
   *                          but the transaction still closed cleanly)
   *   - not-found / no-exec→ ROLLBACK, then release()
   *   - query failure      → ROLLBACK, then release() (or eviction if the
   *                          ROLLBACK query itself fails), then rethrow
   *
   * `settled` guards the catch block so a throw that happens *after* the
   * transaction was already closed can never trigger a second
   * rollback/release — the client is out of scope for the caller entirely,
   * but this guard also protects against a future edit adding post-COMMIT
   * work inside this function.
   *
   * @returns Data needed to build the ReviewTask, or null if no row was
   *   inserted (already exists, or preconditions not met).
   */
  private async runInsertTransaction(
    orchestrationId: string,
    workstreamKey: string,
  ): Promise<CommittedReviewTaskData | null> {
    const client = await this.pool.connect();
    let settled = false;

    try {
      // Phase 3b (migration 006): Set RLS identity context for the
      // review_tasks_insert_policy which checks created_by =
      // current_setting('app.user_identity', true). The dispatcher is
      // an automated actor — it uses the identity 'dispatch-engine'
      // (matching the created_by value in the INSERT below).
      // set_config(..., true) is transaction-scoped (like SET LOCAL), so it
      // MUST run inside the same BEGIN/COMMIT as the INSERT — every code path
      // below (including early returns) closes the transaction with either
      // COMMIT or ROLLBACK before the connection is released back to the
      // pool, so a half-open transaction is never handed to the next borrower.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_identity', $1, true)`, ['dispatch-engine']);

      // Fetch workstream context for the review
      const wsContext = await this.fetchWorkstreamContext(
        client,
        orchestrationId,
        workstreamKey,
      );

      if (!wsContext) {
        settled = true;
        await this.rollbackAndRelease(client, `workstream ${workstreamKey} not found`);
        console.warn(
          `[dispatch/review] Workstream ${workstreamKey} not found in orchestration ${orchestrationId}`,
        );
        return null;
      }

      // Generate deterministic review_task_id
      const reviewTaskId = this.generateReviewTaskId(
        orchestrationId,
        workstreamKey,
        wsContext.attempt_count,
      );

      // Build review findings
      const reviewFindings = {
        prior_error: this.config.includeErrorDetails
          ? wsContext.error_message
          : wsContext.error_message
            ? '[error details available]'
            : null,
        attempt_count: wsContext.attempt_count,
        max_retries: wsContext.max_retries,
        workstream_name: wsContext.name,
        started_at: wsContext.started_at,
      };

      // Look up latest execution_id for FK
      const execResult = await client.query<{ execution_id: string }>(
        `SELECT execution_id::text FROM dispatch.executions
         WHERE workstream_id = $1::uuid
         ORDER BY attempt_number DESC LIMIT 1`,
        [wsContext.workstream_id],
      );
      const executionId = execResult.rows[0]?.execution_id;
      if (!executionId) {
        settled = true;
        await this.rollbackAndRelease(client, `no execution for workstream ${wsContext.workstream_id}`);
        console.warn(`[dispatch/review] No execution for workstream ${wsContext.workstream_id}`);
        return null;
      }

      const wsDetails = await client.query<{ project_id: string; correlation_id: string }>(
        `SELECT project_id::text, correlation_id::text FROM dispatch.workstreams WHERE workstream_id = $1::uuid`,
        [wsContext.workstream_id],
      );
      const projectId = wsDetails.rows[0]?.project_id;
      const correlationId = wsDetails.rows[0]?.correlation_id;

      const result = await client.query<{ review_task_id: string; created_at: string }>(
        `INSERT INTO dispatch.review_tasks
           (review_task_id, workstream_id, orchestration_id, project_id, execution_id, status, findings, correlation_id, created_by, created_at)
         VALUES
           ($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PENDING', $6::jsonb, $7::uuid, 'dispatch-engine', NOW())
         ON CONFLICT (review_task_id) DO NOTHING
         RETURNING review_task_id, created_at::text`,
        [reviewTaskId, wsContext.workstream_id, orchestrationId, projectId, executionId, JSON.stringify([reviewFindings]), correlationId],
      );

      const insertedRow = result.rowCount === 0 ? null : result.rows[0];

      // COMMIT is the last statement on this client. Mark the transaction
      // settled BEFORE releasing so that if release() itself throws, the
      // catch block below does not try to roll back a committed transaction
      // or release the client again.
      await client.query('COMMIT');
      settled = true;
      this.releaseOnce(client, 'post-commit release');

      if (!insertedRow) {
        console.log(`[dispatch/review] Review task ${reviewTaskId} already exists.`);
        return null;
      }

      return {
        reviewTaskId,
        attemptCount: wsContext.attempt_count,
        reviewFindings,
        createdAt: insertedRow.created_at,
      };
    } catch (err) {
      if (!settled) {
        settled = true;
        await this.rollbackAndRelease(client, 'query or insert failure');
      }
      throw err;
    }
  }

  // ── Data Access ────────────────────────────────────────────────────────

  /**
   * Fetch context needed for building the review task.
   */
  private async fetchWorkstreamContext(
    client: import('pg').PoolClient,
    orchestrationId: string,
    workstreamKey: string,
  ): Promise<{
    workstream_id: string;
    name: string | null;
    attempt_count: number;
    max_retries: number;
    error_message: string | null;
    started_at: string | null;
  } | null> {
    const result = await client.query<{
      workstream_id: string;
      name: string | null;
      attempt_count: number;
      max_retries: number;
      error_message: string | null;
      started_at: string | null;
    }>(
      `SELECT
         w.workstream_id::text,
         w.name,
         w.attempt_count,
         w.max_retries,
         w.error_message,
         w.started_at::text
       FROM dispatch.workstreams w
       WHERE w.orchestration_id = $1::uuid
         AND w.workstream_key = $2`,
      [orchestrationId, workstreamKey],
    );

    return result.rows[0] ?? null;
  }

  /**
   * Find workstreams in READY_FOR_REVIEW that don't yet have a review task.
   */
  private async findUnreviewedWorkstreams(): Promise<
    Array<{ orchestration_id: string; workstream_key: string }>
  > {
    return await withDbSpan('find_unreviewed_workstreams', async () => {
      const client = await this.pool.connect();
      try {
        const result = await client.query<{
          orchestration_id: string;
          workstream_key: string;
        }>(
          `SELECT
             w.orchestration_id::text,
             w.workstream_key
           FROM dispatch.workstreams w
           LEFT JOIN dispatch.review_tasks rt
             ON rt.workstream_id = w.workstream_id
            AND rt.orchestration_id = w.orchestration_id
           WHERE w.status = 'READY_FOR_REVIEW'
             AND rt.review_task_id IS NULL`,
        );
        return result.rows;
      } finally {
        client.release();
      }
    }, { workstream_key: 'dispatch-review' });
  }

  // ── Idempotency Key Generation ────────────────────────────────────────

  /**
   * Generate a deterministic review_task_id from orchestration context.
   * SHA-256 hash of (orchestration_id + workstream_key + attempt_count)
   * truncated to UUID-like format for readability.
   */
  private generateReviewTaskId(
    orchestrationId: string,
    workstreamKey: string,
    attemptCount: number,
  ): string {
    const input = `${orchestrationId}:${workstreamKey}:${attemptCount}`;
    const hash = createHash('sha256').update(input).digest('hex');

    // Format as UUID-like (8-4-4-4-12) for readability and PK compatibility
    return [
      hash.slice(0, 8),
      hash.slice(8, 12),
      hash.slice(12, 16),
      hash.slice(16, 20),
      hash.slice(20, 32),
    ].join('-');
  }
}
