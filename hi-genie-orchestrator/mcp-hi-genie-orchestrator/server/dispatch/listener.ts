/**
 * Hi Genie Orchestrator — Lakebase LISTEN/NOTIFY Consumer
 *
 * Manages a dedicated Postgres client for LISTEN on the
 * `workstream_status_changed` channel. When a workstream status transition
 * occurs, the pg_notify trigger fires a notification payload which this
 * consumer parses and forwards to the tick evaluator.
 *
 * Also manages the `dispatch.completion_signals` table for durable signal
 * logging and the trigger function that emits notifications.
 *
 * Reconnect logic: exponential backoff on connection loss, automatic
 * re-LISTEN on reconnect.
 */

import type { Pool, PoolClient } from 'pg';
import { withDbSpan } from '../telemetry/index.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface NotificationPayload {
  workstream_key: string;
  old_status: string;
  new_status: string;
  orchestration_id: string;
  changed_at: string;
}

export interface ListenerConfig {
  /** Postgres channel name to LISTEN on */
  channel: string;
  /** Maximum reconnect attempts before giving up (0 = unlimited) */
  maxReconnectAttempts: number;
  /** Base delay in ms for exponential backoff */
  baseReconnectDelayMs: number;
  /** Maximum delay in ms for backoff cap */
  maxReconnectDelayMs: number;
}

export type NotificationHandler = (payload: NotificationPayload) => Promise<void>;

const DEFAULT_CONFIG: ListenerConfig = {
  channel: 'workstream_status_changed',
  maxReconnectAttempts: 0, // unlimited
  baseReconnectDelayMs: 1_000,
  maxReconnectDelayMs: 60_000,
};

// ── DDL for completion_signals and trigger ───────────────────────────────

const COMPLETION_SIGNALS_DDL = `
CREATE TABLE IF NOT EXISTS dispatch.completion_signals (
  id              BIGSERIAL PRIMARY KEY,
  workstream_key  TEXT NOT NULL,
  orchestration_id UUID NOT NULL,
  old_status      TEXT NOT NULL,
  new_status      TEXT NOT NULL,
  emitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed       BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at    TIMESTAMPTZ,
  CONSTRAINT fk_completion_workstream
    FOREIGN KEY (orchestration_id, workstream_key)
    REFERENCES dispatch.workstreams(orchestration_id, workstream_key)
);

CREATE INDEX IF NOT EXISTS idx_completion_signals_unprocessed
  ON dispatch.completion_signals (processed, emitted_at)
  WHERE processed = FALSE;
`;

const NOTIFY_TRIGGER_DDL = `
CREATE OR REPLACE FUNCTION dispatch.notify_workstream_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    -- Insert durable signal record
    INSERT INTO dispatch.completion_signals
      (workstream_key, orchestration_id, old_status, new_status)
    VALUES
      (NEW.workstream_key, NEW.orchestration_id, OLD.status, NEW.status);

    -- Fire async notification
    PERFORM pg_notify(
      'workstream_status_changed',
      json_build_object(
        'workstream_key', NEW.workstream_key,
        'old_status', OLD.status,
        'new_status', NEW.status,
        'orchestration_id', NEW.orchestration_id::text,
        'changed_at', NOW()::text
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workstream_status_notify
  ON dispatch.workstreams;

CREATE TRIGGER trg_workstream_status_notify
  AFTER UPDATE OF status ON dispatch.workstreams
  FOR EACH ROW
  EXECUTE FUNCTION dispatch.notify_workstream_status_change();
`;

// ── Listener Class ────────────────────────────────────────────────────────

export class WorkstreamListener {
  private pool: Pool;
  private config: ListenerConfig;
  private handler: NotificationHandler;
  private client: PoolClient | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;
  private isConnected = false;

  constructor(
    pool: Pool,
    handler: NotificationHandler,
    config: Partial<ListenerConfig> = {},
  ) {
    this.pool = pool;
    this.handler = handler;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Install DDL (completion_signals table + trigger) only.
   * Safe to call through a pooled connection — does not require LISTEN.
   * Idempotent; can be called on every startup.
   */
  async installDDL(): Promise<void> {
    await this.installInfrastructure();
    console.log('[dispatch/listener] DDL installed (completion_signals + trigger).');
  }

  /**
   * Install DDL and start a persistent LISTEN connection.
   * Requires a non-pooled (session-mode) connection. Will fail on
   * PgBouncer transaction-mode pools (Lakebase default).
   */
  async start(): Promise<void> {
    await this.installInfrastructure();
    await this.connect();
    console.log(`[dispatch/listener] Listening on channel "${this.config.channel}"`);
  }

  /**
   * Gracefully stop: UNLISTEN, release dedicated client, clear timers.
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.client) {
      try {
        await this.client.query(`UNLISTEN ${this.config.channel}`);
        this.client.release();
      } catch (err) {
        console.error('[dispatch/listener] Error during shutdown:', err);
      }
      this.client = null;
    }

    this.isConnected = false;
    console.log('[dispatch/listener] Shutdown complete.');
  }

  /** Whether the listener has an active connection */
  get connected(): boolean {
    return this.isConnected;
  }

  // ── Infrastructure Setup ───────────────────────────────────────────────

  /**
   * Install the completion_signals table and the notify trigger.
   * Uses IF NOT EXISTS / CREATE OR REPLACE for idempotency.
   */
  private async installInfrastructure(): Promise<void> {
    await withDbSpan('install_completion_signals_ddl', async () => {
      const client = await this.pool.connect();
      try {
        await client.query(COMPLETION_SIGNALS_DDL);
        await client.query(NOTIFY_TRIGGER_DDL);
        console.log('[dispatch/listener] Infrastructure DDL applied.');
      } finally {
        client.release();
      }
    });
  }

  // ── Connection Management ──────────────────────────────────────────────

  /**
   * Acquire a dedicated client from the pool and begin LISTEN.
   * The dedicated client is NOT returned to the pool until shutdown
   * (LISTEN requires a persistent connection).
   */
  private async connect(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      this.client = await this.pool.connect();
      await this.client.query(`LISTEN ${this.config.channel}`);

      // Attach notification handler
      this.client.on('notification', (msg) => {
        if (msg.channel === this.config.channel && msg.payload) {
          this.handleNotification(msg.payload).catch((err) => {
            console.error('[dispatch/listener] Handler error:', err);
          });
        }
      });

      // Handle connection loss
      this.client.on('error', (err) => {
        console.error('[dispatch/listener] Client error:', err);
        this.isConnected = false;
        this.client = null;
        this.scheduleReconnect();
      });

      this.isConnected = true;
      this.reconnectAttempts = 0;
      console.log('[dispatch/listener] Connected and listening.');
    } catch (err) {
      console.error('[dispatch/listener] Connection failed:', err);
      this.isConnected = false;
      this.client = null;
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.isShuttingDown) return;

    if (
      this.config.maxReconnectAttempts > 0 &&
      this.reconnectAttempts >= this.config.maxReconnectAttempts
    ) {
      console.error(
        `[dispatch/listener] Max reconnect attempts (${this.config.maxReconnectAttempts}) reached. Giving up.`,
      );
      return;
    }

    const delay = Math.min(
      this.config.baseReconnectDelayMs * Math.pow(2, this.reconnectAttempts),
      this.config.maxReconnectDelayMs,
    );

    this.reconnectAttempts++;
    console.log(
      `[dispatch/listener] Reconnect attempt ${this.reconnectAttempts} in ${delay}ms...`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        console.error('[dispatch/listener] Reconnect failed:', err);
      });
    }, delay);
  }

  // ── Notification Processing ────────────────────────────────────────────

  /**
   * Parse raw notification payload JSON and invoke the handler.
   */
  private async handleNotification(rawPayload: string): Promise<void> {
    await withDbSpan('process_notification', async () => {
      let payload: NotificationPayload;
      try {
        payload = JSON.parse(rawPayload) as NotificationPayload;
      } catch (parseErr) {
        console.error('[dispatch/listener] Failed to parse payload:', rawPayload, parseErr);
        return;
      }

      console.log(
        `[dispatch/listener] Notification: ${payload.workstream_key} ` +
        `${payload.old_status} → ${payload.new_status}`,
      );

      await this.handler(payload);
    }, { workstream_key: 'dispatch-listener' });
  }

  // ── Signal Recovery ───────────────────────────────────────────────────

  /**
   * Process any unprocessed completion signals from the durable table.
   * Called by tick-evaluator as a recovery mechanism when notifications
   * may have been missed (e.g., during listener downtime).
   */
  async drainUnprocessedSignals(): Promise<NotificationPayload[]> {
    return await withDbSpan('drain_unprocessed_signals', async () => {
      const client = await this.pool.connect();
      try {
        const result = await client.query<{
          id: number;
          workstream_key: string;
          orchestration_id: string;
          old_status: string;
          new_status: string;
          emitted_at: Date;
        }>(
          `UPDATE dispatch.completion_signals
           SET processed = TRUE, processed_at = NOW()
           WHERE id IN (
             SELECT id FROM dispatch.completion_signals
             WHERE processed = FALSE
             ORDER BY emitted_at ASC
             LIMIT 100
             FOR UPDATE SKIP LOCKED
           )
           RETURNING workstream_key, orchestration_id::text, old_status, new_status, emitted_at`,
        );

        return result.rows.map((row) => ({
          workstream_key: row.workstream_key,
          orchestration_id: row.orchestration_id,
          old_status: row.old_status,
          new_status: row.new_status,
          changed_at: row.emitted_at.toISOString(),
        }));
      } finally {
        client.release();
      }
    }, { workstream_key: 'dispatch-listener' });
  }
}
