import type { PoolClient } from 'pg';
import type { Migration } from './runner.js';

// Adds last_heartbeat_at, paused, error_message to dispatch.workstreams
const UP_SQL = [
  `ALTER TABLE dispatch.workstreams`,
  `  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ,`,
  `  ADD COLUMN IF NOT EXISTS paused BOOLEAN NOT NULL DEFAULT FALSE,`,
  `  ADD COLUMN IF NOT EXISTS error_message TEXT`,
].join('\n') + ';\n' + [
  `UPDATE dispatch.workstreams`,
  `  SET last_heartbeat_at = updated_at`,
  `  WHERE last_heartbeat_at IS NULL`,
].join('\n') + ';\n' + [
  `CREATE INDEX IF NOT EXISTS idx_workstreams_heartbeat`,
  `  ON dispatch.workstreams (status, last_heartbeat_at)`,
  `  WHERE status = 'IN_PROGRESS'`,
].join('\n') + ';';

const migration: Migration = {
  version: 4,
  name: 'workstream_columns',
  async up(client: PoolClient): Promise<void> {
    await client.query(UP_SQL);
  },
};

export { migration as migration004WorkstreamColumns };
