/**
 * Migration 006 — Row-Level Security (Workstreams & Reviews) — Phase 3b, extension
 *
 * Extends the write-integrity RLS pattern validated in migration 005
 * (dispatch.plans / dispatch.plan_snapshots, see server/api/routes/plans.ts) to
 * the tables written by server/api/routes/workstreams.ts and reviews.ts:
 * dispatch.orchestrations, dispatch.workstreams, dispatch.executions, and
 * dispatch.review_tasks.
 *
 * Same pattern as migration 005: ENABLE + FORCE ROW LEVEL SECURITY (the app's
 * service-principal role owns these tables and would otherwise bypass RLS as
 * the owner), permissive SELECT (no project-membership/ACL model exists yet),
 * and an identity-checked WITH CHECK clause only where there is an actual
 * caller-identity column to compare against `current_setting('app.user_identity', true)`
 * (set per-transaction via `SELECT set_config(...)` in the route handlers).
 *
 * Per-table identity semantics:
 *   - dispatch.orchestrations: INSERT checks `created_by`. No route currently
 *     inserts into this table (workstreams.ts materialize only UPDATEs an
 *     existing orchestration row) — this policy is forward-looking for
 *     whichever code eventually creates orchestrations; it must set
 *     app.user_identity in the same transaction or its INSERT will be
 *     rejected. UPDATE is permissive (materialize only changes status/
 *     plan_snapshot_id/timestamps, never created_by).
 *   - dispatch.workstreams: INSERT checks `created_by` (materialize handler).
 *     UPDATE is permissive — dispatch/retry/pause/unpause/approve all mutate
 *     status-machine columns (status, attempt_count, assigned_to, timestamps),
 *     never created_by, and are invoked by different identities (worker vs.
 *     reviewer vs. dispatcher) with no single consistent column to check.
 *   - dispatch.executions: INSERT checks `worker_identity`, NOT a `created_by`
 *     column (this table has none — see migration 001). The dispatch handler
 *     in workstreams.ts treats the caller as self-attesting: `worker_identity`
 *     comes from the request body, and this check requires it to equal the
 *     caller's own verified identity, i.e. a caller can only create an
 *     execution record claiming to be the worker performing it, never a
 *     different worker. UPDATE is permissive (no execution UPDATE path exists
 *     in the reviewed routes today; forward-looking placeholder).
 *   - dispatch.review_tasks: INSERT checks `created_by` (create handler in
 *     reviews.ts). UPDATE checks `reviewer_identity` — both the remediation
 *     and approve handlers set `reviewer_identity` to the caller's own
 *     verified identity in the same UPDATE, so this rejects any write that
 *     would attribute the review action to someone other than the caller.
 *
 * current_setting('app.user_identity', true) uses the `missing_ok` form so a
 * connection that never ran `set_config` reads as NULL rather than erroring —
 * NULL fails every equality check above, which is the correct fail-closed
 * behavior for a write that skipped the identity-context step.
 *
 * ── R1 Authorization Limitation (Approved 2026-08-20) ──────────────────────
 *
 * All SELECT policies use `USING (true)` — any authenticated identity can read
 * any row in these tables. This is an APPROVED Release 1 simplification:
 *
 *   - No project-membership or ACL model exists yet.
 *   - The Supervisor API serves a single orchestrator (one project at a time).
 *   - All callers are workspace-authenticated (M2M SPN or verified user).
 *   - Reads are intentionally unrestricted for operational observability.
 *
 * For R1.1+, when multi-project or cross-tenant isolation is required, replace
 * `USING (true)` with project-membership checks, e.g.:
 *   USING (project_id IN (SELECT project_id FROM membership.user_projects
 *          WHERE user_identity = current_setting('app.user_identity', true)))
 *
 * This decision was reviewed in the independent main-branch audit (2026-08-20)
 * and explicitly accepted as the R1 contract.
 *
 * Note on idempotency: as with migration 005, DROP POLICY IF EXISTS is
 * intentionally omitted. The migration runner records applied versions and
 * only ever runs version 6 once per database.
 */

import type { PoolClient } from 'pg';
import type { Migration } from './runner.js';

const UP_SQL = `
-- ============================================================
-- dispatch.orchestrations
-- ============================================================
ALTER TABLE dispatch.orchestrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.orchestrations FORCE ROW LEVEL SECURITY;

CREATE POLICY orchestrations_select_policy ON dispatch.orchestrations
  FOR SELECT USING (true);

CREATE POLICY orchestrations_insert_policy ON dispatch.orchestrations
  FOR INSERT WITH CHECK (created_by = current_setting('app.user_identity', true));

CREATE POLICY orchestrations_update_policy ON dispatch.orchestrations
  FOR UPDATE USING (true) WITH CHECK (true);

-- ============================================================
-- dispatch.workstreams
-- ============================================================
ALTER TABLE dispatch.workstreams ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.workstreams FORCE ROW LEVEL SECURITY;

CREATE POLICY workstreams_select_policy ON dispatch.workstreams
  FOR SELECT USING (true);

CREATE POLICY workstreams_insert_policy ON dispatch.workstreams
  FOR INSERT WITH CHECK (created_by = current_setting('app.user_identity', true));

CREATE POLICY workstreams_update_policy ON dispatch.workstreams
  FOR UPDATE USING (true) WITH CHECK (true);

-- ============================================================
-- dispatch.executions (no created_by column — checks worker_identity instead)
-- ============================================================
ALTER TABLE dispatch.executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.executions FORCE ROW LEVEL SECURITY;

CREATE POLICY executions_select_policy ON dispatch.executions
  FOR SELECT USING (true);

CREATE POLICY executions_insert_policy ON dispatch.executions
  FOR INSERT WITH CHECK (worker_identity = current_setting('app.user_identity', true));

CREATE POLICY executions_update_policy ON dispatch.executions
  FOR UPDATE USING (true) WITH CHECK (true);

-- ============================================================
-- dispatch.review_tasks
-- ============================================================
ALTER TABLE dispatch.review_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.review_tasks FORCE ROW LEVEL SECURITY;

CREATE POLICY review_tasks_select_policy ON dispatch.review_tasks
  FOR SELECT USING (true);

CREATE POLICY review_tasks_insert_policy ON dispatch.review_tasks
  FOR INSERT WITH CHECK (created_by = current_setting('app.user_identity', true));

CREATE POLICY review_tasks_update_policy ON dispatch.review_tasks
  FOR UPDATE USING (true) WITH CHECK (reviewer_identity = current_setting('app.user_identity', true));
`;

export const migration006RowLevelSecurityWorkstreamsReviews: Migration = {
  version: 6,
  name: 'row_level_security_workstreams_reviews',
  up: async (client: PoolClient): Promise<void> => {
    await client.query(UP_SQL);
  },
};
