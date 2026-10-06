/**
 * Migration 007 — Row-Level Security (State Schema)
 *
 * Extends RLS to all 8 tables in the `state` schema, completing the
 * write-integrity coverage started in migrations 005 (dispatch.plans) and
 * 006 (dispatch.workstreams/orchestrations/executions/review_tasks).
 *
 * Security property: write-integrity only (same as dispatch schema).
 * A caller cannot INSERT a row and attribute its `created_by` (or `user_id`
 * for sessions) to an identity other than the one set in the transaction
 * via `set_config('app.user_identity', ...)`. SELECT policies remain
 * permissive (no ACL model yet). UPDATE policies are permissive for
 * mutable tables (sessions, recovery_state) since updates don't change
 * the identity column.
 *
 * Tables covered:
 *   - state.sessions         (INSERT checks user_id = identity)
 *   - state.decisions        (INSERT checks created_by = identity)
 *   - state.errors           (INSERT checks created_by = identity)
 *   - state.events           (INSERT checks created_by = identity)
 *   - state.task_attempts    (INSERT checks created_by = identity)
 *   - state.task_completions (INSERT checks created_by = identity)
 *   - state.workstream_events (INSERT checks created_by = identity)
 *   - state.recovery_state   (INSERT checks created_by = identity)
 *
 * FORCE ROW LEVEL SECURITY is required because the app SPN role owns these
 * tables (created them via migrations) and table owners bypass RLS by default.
 *
 * current_setting('app.user_identity', true) uses `missing_ok` = true so a
 * connection that never ran set_config reads NULL rather than erroring — NULL
 * fails the equality check and the INSERT is rejected (fail-closed).
 *
 * Prerequisite: MCP tool handlers must call
 *   `SELECT set_config('app.user_identity', $1, true)`
 * within the same transaction as their writes. See `server/mcp/tools/identity.ts`.
 */

import type { PoolClient } from 'pg';
import type { Migration } from './runner.js';

const UP_SQL = `
-- ============================================================
-- state.sessions (identity column: user_id, not created_by)
-- ============================================================
ALTER TABLE state.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE state.sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY sessions_select_policy ON state.sessions
  FOR SELECT USING (true);

CREATE POLICY sessions_insert_policy ON state.sessions
  FOR INSERT WITH CHECK (user_id = current_setting('app.user_identity', true));

CREATE POLICY sessions_update_policy ON state.sessions
  FOR UPDATE USING (true) WITH CHECK (true);

-- ============================================================
-- state.decisions (append-only)
-- ============================================================
ALTER TABLE state.decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE state.decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY decisions_select_policy ON state.decisions
  FOR SELECT USING (true);

CREATE POLICY decisions_insert_policy ON state.decisions
  FOR INSERT WITH CHECK (created_by = current_setting('app.user_identity', true));

-- ============================================================
-- state.errors (append-only)
-- ============================================================
ALTER TABLE state.errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE state.errors FORCE ROW LEVEL SECURITY;

CREATE POLICY errors_select_policy ON state.errors
  FOR SELECT USING (true);

CREATE POLICY errors_insert_policy ON state.errors
  FOR INSERT WITH CHECK (created_by = current_setting('app.user_identity', true));

-- ============================================================
-- state.events (append-only)
-- ============================================================
ALTER TABLE state.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE state.events FORCE ROW LEVEL SECURITY;

CREATE POLICY events_select_policy ON state.events
  FOR SELECT USING (true);

CREATE POLICY events_insert_policy ON state.events
  FOR INSERT WITH CHECK (created_by = current_setting('app.user_identity', true));

-- ============================================================
-- state.task_attempts (append-only)
-- ============================================================
ALTER TABLE state.task_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE state.task_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY task_attempts_select_policy ON state.task_attempts
  FOR SELECT USING (true);

CREATE POLICY task_attempts_insert_policy ON state.task_attempts
  FOR INSERT WITH CHECK (created_by = current_setting('app.user_identity', true));

-- ============================================================
-- state.task_completions (append-only)
-- ============================================================
ALTER TABLE state.task_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE state.task_completions FORCE ROW LEVEL SECURITY;

CREATE POLICY task_completions_select_policy ON state.task_completions
  FOR SELECT USING (true);

CREATE POLICY task_completions_insert_policy ON state.task_completions
  FOR INSERT WITH CHECK (created_by = current_setting('app.user_identity', true));

-- ============================================================
-- state.workstream_events (append-only)
-- ============================================================
ALTER TABLE state.workstream_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE state.workstream_events FORCE ROW LEVEL SECURITY;

CREATE POLICY workstream_events_select_policy ON state.workstream_events
  FOR SELECT USING (true);

CREATE POLICY workstream_events_insert_policy ON state.workstream_events
  FOR INSERT WITH CHECK (created_by = current_setting('app.user_identity', true));

-- ============================================================
-- state.recovery_state (mutable, optimistic concurrency)
-- ============================================================
ALTER TABLE state.recovery_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE state.recovery_state FORCE ROW LEVEL SECURITY;

CREATE POLICY recovery_state_select_policy ON state.recovery_state
  FOR SELECT USING (true);

CREATE POLICY recovery_state_insert_policy ON state.recovery_state
  FOR INSERT WITH CHECK (created_by = current_setting('app.user_identity', true));

CREATE POLICY recovery_state_update_policy ON state.recovery_state
  FOR UPDATE USING (true) WITH CHECK (true);
`;

export const migration007RowLevelSecurityState: Migration = {
  version: 7,
  name: 'row_level_security_state',
  up: async (client: PoolClient): Promise<void> => {
    await client.query(UP_SQL);
  },
};
