/**
 * Migration 009 — Projects Table
 *
 * Introduces `dispatch.projects` as the explicit root entity for all work.
 * Previously, `project_id` was an implicit UUID correlation key with no
 * dedicated table — projects were "discovered" by querying distinct
 * project_id values from dispatch.plans.
 *
 * This migration:
 *   1. Creates dispatch.projects with name, description, owner, status, tags
 *   2. Backfills from existing dispatch.plans (one row per distinct project_id)
 *   3. Adds FK constraints from dispatch.plans and dispatch.orchestrations
 *   4. Enables RLS (write-integrity: created_by must match app.user_identity)
 *
 * Design decisions:
 *   - FK enforced: create_plan will reject unknown project_id values
 *   - Status enum: active | archived | locked (extensible via ALTER CHECK)
 *   - Owner = created_by at creation time (transferable via update_project API)
 *   - tags JSONB for flexible categorization (no schema enforcement)
 *   - Backfill uses first plan name as project name (best available heuristic)
 *
 * NOTE: update_project and archive/lock operations are REST API-only for now.
 * The MCP surface exposes only create_project (architect persona). UI-driven
 * project management (rename, archive, transfer ownership, tag editing) will
 * be added as REST endpoints when the management UI is built.
 */

import type { PoolClient } from 'pg';
import type { Migration } from './runner.js';

const UP_SQL = `
-- ============================================================
-- dispatch.projects
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatch.projects (
  project_id    UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL CHECK (char_length(name) > 0 AND char_length(name) <= 255),
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'archived', 'locked')),
  owner         TEXT NOT NULL CHECK (char_length(owner) > 0),
  tags          JSONB NOT NULL DEFAULT '{}',
  created_by    TEXT NOT NULL CHECK (char_length(created_by) > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_owner
  ON dispatch.projects (owner, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_projects_status
  ON dispatch.projects (status, updated_at DESC);

-- ============================================================
-- Backfill: create project rows from existing plans
-- Uses the earliest plan per project_id as the "seed" record.
-- ============================================================
INSERT INTO dispatch.projects (project_id, name, description, owner, created_by, created_at, updated_at)
SELECT DISTINCT ON (p.project_id)
  p.project_id,
  p.name,                         -- plan name as project name (best heuristic)
  'Auto-created from existing plan: ' || p.name,
  p.created_by,                   -- plan creator becomes project owner
  p.created_by,
  p.created_at,
  p.updated_at
FROM dispatch.plans p
ORDER BY p.project_id, p.created_at ASC
ON CONFLICT (project_id) DO NOTHING;

-- ============================================================
-- Foreign key: dispatch.plans.project_id → dispatch.projects
-- ============================================================
ALTER TABLE dispatch.plans
  ADD CONSTRAINT fk_plans_project_id
  FOREIGN KEY (project_id) REFERENCES dispatch.projects(project_id)
  ON DELETE RESTRICT;

-- ============================================================
-- Foreign key: dispatch.orchestrations.project_id → dispatch.projects
-- ============================================================
ALTER TABLE dispatch.orchestrations
  ADD CONSTRAINT fk_orchestrations_project_id
  FOREIGN KEY (project_id) REFERENCES dispatch.projects(project_id)
  ON DELETE RESTRICT;

-- ============================================================
-- Row-Level Security (write-integrity)
-- Same pattern as migration 005: INSERT checks created_by,
-- SELECT/UPDATE permissive (no project-membership ACL yet).
-- ============================================================
ALTER TABLE dispatch.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.projects FORCE ROW LEVEL SECURITY;

CREATE POLICY projects_select_policy ON dispatch.projects
  FOR SELECT USING (true);

CREATE POLICY projects_insert_policy ON dispatch.projects
  FOR INSERT WITH CHECK (created_by = current_setting('app.user_identity', true));

CREATE POLICY projects_update_policy ON dispatch.projects
  FOR UPDATE USING (true) WITH CHECK (true);
`;

export const migration009ProjectsTable: Migration = {
  version: 9,
  name: '009_projects_table',
  up: async (client: PoolClient): Promise<void> => {
    await client.query(UP_SQL);
  },
};
