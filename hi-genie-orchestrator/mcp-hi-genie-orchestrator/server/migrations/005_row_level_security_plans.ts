/**
 * Migration 005 — Row-Level Security (Plans) — Phase 3b, first validation pass
 *
 * Scope is intentionally narrow: only the two tables written by
 * `server/api/routes/plans.ts` (dispatch.plans, dispatch.plan_snapshots).
 * This validates the SET LOCAL + RLS pattern end-to-end before extending it
 * to workstreams.ts / reviews.ts and the rest of the dispatch/state schemas
 * in a follow-up migration.
 *
 * Security property enforced: write-integrity only. A caller cannot INSERT
 * a row and attribute it to a `created_by` other than their own verified
 * identity (set per-transaction via `SET LOCAL app.user_identity` — see
 * `server/api/routes/plans.ts`). This is NOT row-visibility RLS: SELECT
 * policies are permissive (USING (true)) because the schema has no
 * project-membership/ACL model yet, so there is no correct predicate for
 * "who is allowed to see this project's data". UPDATE policies are also
 * permissive (neither endpoint mutates created_by on UPDATE), so this does
 * not change who can publish a snapshot for an existing plan.
 *
 * FORCE ROW LEVEL SECURITY is required in addition to ENABLE: the app
 * connects via its service-principal role, which owns these tables (it
 * created them via migrations), and table owners bypass RLS by default.
 * Without FORCE, this migration would be a no-op for all app traffic.
 *
 * current_setting('app.user_identity', true) uses the `missing_ok` form so
 * a connection that never ran SET LOCAL (e.g. a stray query outside the
 * app's request path) reads as NULL rather than erroring — NULL fails the
 * `created_by = ...` equality check and the INSERT is rejected, which is
 * the correct fail-closed behavior.
 *
 * Note on idempotency: unlike earlier migrations (which use IF NOT EXISTS
 * so they're safe to re-run outside the tracked version history), this one
 * intentionally omits IF NOT EXISTS / DROP-before-CREATE on the policies.
 * The migration runner records applied versions and only ever runs version
 * 5 once per database, so CREATE POLICY re-running is not a real scenario
 * — and skipping DROP POLICY here avoids transiently removing an active
 * security policy on every restart.
 */

import type { PoolClient } from 'pg';
import type { Migration } from './runner.js';

const UP_SQL = `
-- ============================================================
-- dispatch.plans
-- ============================================================
ALTER TABLE dispatch.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.plans FORCE ROW LEVEL SECURITY;

CREATE POLICY plans_select_policy ON dispatch.plans
  FOR SELECT USING (true);

CREATE POLICY plans_insert_policy ON dispatch.plans
  FOR INSERT WITH CHECK (created_by = current_setting('app.user_identity', true));

CREATE POLICY plans_update_policy ON dispatch.plans
  FOR UPDATE USING (true) WITH CHECK (true);

-- ============================================================
-- dispatch.plan_snapshots (immutable/append-only — no UPDATE policy needed)
-- ============================================================
ALTER TABLE dispatch.plan_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.plan_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY plan_snapshots_select_policy ON dispatch.plan_snapshots
  FOR SELECT USING (true);

CREATE POLICY plan_snapshots_insert_policy ON dispatch.plan_snapshots
  FOR INSERT WITH CHECK (created_by = current_setting('app.user_identity', true));
`;

export const migration005RowLevelSecurityPlans: Migration = {
  version: 5,
  name: 'row_level_security_plans',
  up: async (client: PoolClient): Promise<void> => {
    await client.query(UP_SQL);
  },
};
