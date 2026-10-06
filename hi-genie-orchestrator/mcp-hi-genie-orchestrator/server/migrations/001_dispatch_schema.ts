/**
 * Migration 001 — Dispatch Schema
 *
 * Creates the `dispatch` schema owned by the Supervisor surface.
 * Tables: orchestrations, plans, plan_snapshots, workstreams, executions, review_tasks.
 *
 * All DDL is idempotent (IF NOT EXISTS). Columns, constraints, and indexes
 * follow the architectural decisions and requirements for Release 1.
 */

import type { PoolClient } from 'pg';
import type { Migration } from './runner.js';

const UP_SQL = `
-- ============================================================
-- Schema
-- ============================================================
CREATE SCHEMA IF NOT EXISTS dispatch;

-- ============================================================
-- dispatch.plans
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatch.plans (
  plan_id             UUID NOT NULL PRIMARY KEY,
  project_id          UUID NOT NULL,
  name                TEXT NOT NULL CHECK (char_length(name) > 0 AND char_length(name) <= 255),
  description         TEXT,
  source_ref          JSONB DEFAULT '{}',
  current_snapshot_id UUID,
  created_by          TEXT NOT NULL CHECK (char_length(created_by) > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plans_project_id
  ON dispatch.plans (project_id, created_at DESC);

-- ============================================================
-- dispatch.plan_snapshots
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatch.plan_snapshots (
  plan_snapshot_id    UUID NOT NULL PRIMARY KEY,
  plan_id             UUID NOT NULL REFERENCES dispatch.plans(plan_id) ON DELETE RESTRICT,
  version             INTEGER NOT NULL CHECK (version > 0),
  content_hash        TEXT NOT NULL CHECK (char_length(content_hash) > 0),
  content             JSONB NOT NULL,
  workstream_count    INTEGER NOT NULL CHECK (workstream_count >= 0),
  created_by          TEXT NOT NULL CHECK (char_length(created_by) > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version),
  UNIQUE (plan_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_plan_snapshots_plan_id
  ON dispatch.plan_snapshots (plan_id, version DESC);

-- ============================================================
-- dispatch.orchestrations
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatch.orchestrations (
  orchestration_id    UUID NOT NULL PRIMARY KEY,
  project_id          UUID NOT NULL,
  plan_id             UUID NOT NULL REFERENCES dispatch.plans(plan_id) ON DELETE RESTRICT,
  plan_snapshot_id    UUID NOT NULL REFERENCES dispatch.plan_snapshots(plan_snapshot_id) ON DELETE RESTRICT,
  status              TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','RUNNING','PAUSED','COMPLETE','FAILED','CANCELLED')),
  priority            SMALLINT NOT NULL DEFAULT 50 CHECK (priority >= 0 AND priority <= 100),
  correlation_id      UUID NOT NULL,
  configuration_version TEXT NOT NULL DEFAULT '1.0.0',
  created_by          TEXT NOT NULL CHECK (char_length(created_by) > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  CHECK (started_at IS NULL OR started_at >= created_at),
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_orchestrations_project_status
  ON dispatch.orchestrations (project_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orchestrations_correlation
  ON dispatch.orchestrations (correlation_id);

-- ============================================================
-- dispatch.workstreams
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatch.workstreams (
  workstream_id       UUID NOT NULL PRIMARY KEY,
  orchestration_id    UUID NOT NULL REFERENCES dispatch.orchestrations(orchestration_id) ON DELETE RESTRICT,
  project_id          UUID NOT NULL,
  workstream_key      TEXT NOT NULL CHECK (char_length(workstream_key) > 0 AND char_length(workstream_key) <= 128),
  name                TEXT NOT NULL CHECK (char_length(name) > 0 AND char_length(name) <= 255),
  status              TEXT NOT NULL DEFAULT 'NOT_STARTED'
                        CHECK (status IN (
                          'NOT_STARTED','IN_PROGRESS','VALIDATING','READY_FOR_REVIEW',
                          'RETRYING','BLOCKED','COMPLETE','CANCELLED'
                        )),
  execution_tier      SMALLINT NOT NULL DEFAULT 0 CHECK (execution_tier >= 0),
  depends_on          JSONB NOT NULL DEFAULT '[]',
  config              JSONB NOT NULL DEFAULT '{}',
  attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_retries         INTEGER NOT NULL DEFAULT 3 CHECK (max_retries >= 0),
  assigned_to         TEXT,
  priority            SMALLINT NOT NULL DEFAULT 50 CHECK (priority >= 0 AND priority <= 100),
  idempotency_key     TEXT NOT NULL CHECK (char_length(idempotency_key) > 0),
  correlation_id      UUID NOT NULL,
  created_by          TEXT NOT NULL CHECK (char_length(created_by) > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  UNIQUE (orchestration_id, workstream_key),
  UNIQUE (project_id, idempotency_key),
  CHECK (started_at IS NULL OR started_at >= created_at),
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_workstreams_project_status
  ON dispatch.workstreams (project_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workstreams_orchestration
  ON dispatch.workstreams (orchestration_id, execution_tier, priority DESC);

CREATE INDEX IF NOT EXISTS idx_workstreams_correlation
  ON dispatch.workstreams (correlation_id);

-- ============================================================
-- dispatch.executions
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatch.executions (
  execution_id        UUID NOT NULL PRIMARY KEY,
  workstream_id       UUID NOT NULL REFERENCES dispatch.workstreams(workstream_id) ON DELETE RESTRICT,
  project_id          UUID NOT NULL,
  attempt_number      INTEGER NOT NULL CHECK (attempt_number > 0),
  status              TEXT NOT NULL DEFAULT 'RUNNING'
                        CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','RETRYABLE_FAILURE','EXPIRED','CANCELLED')),
  worker_identity     TEXT NOT NULL CHECK (char_length(worker_identity) > 0),
  correlation_id      UUID NOT NULL,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at            TIMESTAMPTZ,
  outcome_summary     TEXT,
  error_class         TEXT,
  error_code          TEXT,
  error_summary       TEXT,
  artifacts_ref       JSONB DEFAULT '[]',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workstream_id, attempt_number),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_executions_workstream
  ON dispatch.executions (workstream_id, attempt_number DESC);

CREATE INDEX IF NOT EXISTS idx_executions_project_status
  ON dispatch.executions (project_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_executions_correlation
  ON dispatch.executions (correlation_id);

-- ============================================================
-- dispatch.review_tasks
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatch.review_tasks (
  review_task_id      UUID NOT NULL PRIMARY KEY,
  workstream_id       UUID NOT NULL REFERENCES dispatch.workstreams(workstream_id) ON DELETE RESTRICT,
  orchestration_id    UUID NOT NULL REFERENCES dispatch.orchestrations(orchestration_id) ON DELETE RESTRICT,
  project_id          UUID NOT NULL,
  execution_id        UUID NOT NULL REFERENCES dispatch.executions(execution_id) ON DELETE RESTRICT,
  status              TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','IN_PROGRESS','APPROVED','REJECTED','CANCELLED')),
  reviewer_identity   TEXT,
  checks_performed    JSONB DEFAULT '[]',
  artifact_refs       JSONB DEFAULT '[]',
  test_results        JSONB DEFAULT '[]',
  findings            JSONB DEFAULT '[]',
  outcome             TEXT CHECK (outcome IS NULL OR outcome IN ('PASS','FAIL','INCONCLUSIVE')),
  outcome_reason      TEXT,
  correlation_id      UUID NOT NULL,
  created_by          TEXT NOT NULL CHECK (char_length(created_by) > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_review_tasks_workstream
  ON dispatch.review_tasks (workstream_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_tasks_project_status
  ON dispatch.review_tasks (project_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_tasks_correlation
  ON dispatch.review_tasks (correlation_id);
`;

export const migration001DispatchSchema: Migration = {
  version: 1,
  name: 'dispatch_schema',
  up: async (client: PoolClient): Promise<void> => {
    await client.query(UP_SQL);
  },
};
