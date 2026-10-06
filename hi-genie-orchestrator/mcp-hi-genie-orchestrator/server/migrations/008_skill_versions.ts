/**
 * Migration 008 — Skill Versions & Execution Tracking
 *
 * Creates:
 *   1. dispatch.skill_versions — Versioned skill content store. Each publish
 *      operation appends a complete set of sections at a new version number.
 *      Workers load skill content via `get_skill_content`; orchestrations pin
 *      to a version at creation time.
 *
 *   2. dispatch.project_skill_overrides — Per-project section overrides.
 *      Resolution order: override > project-specific version > global version.
 *
 *   3. Execution tracking columns on dispatch.executions — automation_id,
 *      worker_prompt_hash, skill_version, heartbeat_at, timeout_threshold_min,
 *      last_known_phase, dispatched_at.
 *
 * RLS: Write-integrity (INSERT) on both skill tables. SELECT permissive.
 * Same pattern as migrations 005-007.
 *
 * Design doc: docs/design/2026-08-23_skill-publishing-and-post-deploy-job.md
 */

import type { PoolClient } from 'pg';
import type { Migration } from './runner.js';

const UP_SQL = `
-- ============================================================
-- dispatch.skill_versions
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatch.skill_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version         INTEGER NOT NULL,
  section_path    TEXT NOT NULL,
  content         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  project_id      UUID,
  published_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by    TEXT NOT NULL,
  is_current      BOOLEAN NOT NULL DEFAULT true,
  source          TEXT NOT NULL DEFAULT 'publish',

  CONSTRAINT uq_skill_version_section UNIQUE (version, section_path, project_id)
);

CREATE INDEX IF NOT EXISTS idx_skill_versions_current
  ON dispatch.skill_versions (is_current, section_path, project_id)
  WHERE is_current = true;

CREATE INDEX IF NOT EXISTS idx_skill_versions_project
  ON dispatch.skill_versions (project_id, is_current)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_skill_versions_version_desc
  ON dispatch.skill_versions (version DESC);

-- ============================================================
-- dispatch.project_skill_overrides
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatch.project_skill_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL,
  section_path    TEXT NOT NULL,
  content         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT NOT NULL,
  reason          TEXT,

  CONSTRAINT uq_project_override UNIQUE (project_id, section_path)
);

CREATE INDEX IF NOT EXISTS idx_project_overrides_lookup
  ON dispatch.project_skill_overrides (project_id, section_path);

-- ============================================================
-- Execution tracking columns (dispatch.executions)
-- ============================================================
ALTER TABLE dispatch.executions
  ADD COLUMN IF NOT EXISTS automation_id TEXT,
  ADD COLUMN IF NOT EXISTS automation_url TEXT,
  ADD COLUMN IF NOT EXISTS worker_prompt_hash TEXT,
  ADD COLUMN IF NOT EXISTS skill_version INTEGER,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS timeout_threshold_min INTEGER DEFAULT 45,
  ADD COLUMN IF NOT EXISTS last_known_phase TEXT,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_executions_heartbeat_stuck
  ON dispatch.executions (status, heartbeat_at)
  WHERE status = 'IN_PROGRESS';

-- ============================================================
-- Orchestration skill pinning (dispatch.orchestrations)
-- ============================================================
ALTER TABLE dispatch.orchestrations
  ADD COLUMN IF NOT EXISTS skill_version INTEGER;

-- ============================================================
-- RLS — dispatch.skill_versions
-- ============================================================
ALTER TABLE dispatch.skill_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.skill_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY skill_versions_select_policy ON dispatch.skill_versions
  FOR SELECT USING (true);

CREATE POLICY skill_versions_insert_policy ON dispatch.skill_versions
  FOR INSERT WITH CHECK (published_by = current_setting('app.user_identity', true));

CREATE POLICY skill_versions_update_policy ON dispatch.skill_versions
  FOR UPDATE USING (true) WITH CHECK (true);

-- ============================================================
-- RLS — dispatch.project_skill_overrides
-- ============================================================
ALTER TABLE dispatch.project_skill_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.project_skill_overrides FORCE ROW LEVEL SECURITY;

CREATE POLICY project_overrides_select_policy ON dispatch.project_skill_overrides
  FOR SELECT USING (true);

CREATE POLICY project_overrides_insert_policy ON dispatch.project_skill_overrides
  FOR INSERT WITH CHECK (updated_by = current_setting('app.user_identity', true));

CREATE POLICY project_overrides_update_policy ON dispatch.project_skill_overrides
  FOR UPDATE USING (true) WITH CHECK (updated_by = current_setting('app.user_identity', true));
`;

export const migration008SkillVersions: Migration = {
  version: 8,
  name: 'skill_versions',
  up: async (client: PoolClient): Promise<void> => {
    await client.query(UP_SQL);
  },
};
