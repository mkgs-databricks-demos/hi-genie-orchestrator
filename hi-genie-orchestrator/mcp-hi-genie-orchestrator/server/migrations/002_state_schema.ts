/**
 * Migration 002 — State Schema
 *
 * Creates the `state` schema owned by the Workstream MCP surface.
 * Tables: sessions, decisions, errors, events, task_attempts,
 *         task_completions, workstream_events, recovery_state.
 *
 * All DDL is idempotent (IF NOT EXISTS). Append-only tables have no
 * UPDATE/DELETE in their design; mutable tables (sessions, recovery_state)
 * use optimistic concurrency via version columns.
 */

import type { PoolClient } from 'pg';
import type { Migration } from './runner.js';

const UP_SQL = `
-- ============================================================
-- Schema (state schema created by runner.ts for _migration_history;
-- this is a defensive re-creation)
-- ============================================================
CREATE SCHEMA IF NOT EXISTS state;

-- ============================================================
-- state.sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS state.sessions (
  session_id          UUID NOT NULL PRIMARY KEY,
  project_id          UUID NOT NULL,
  workstream_id       UUID NOT NULL,
  user_id             TEXT NOT NULL CHECK (char_length(user_id) > 0),
  status              TEXT NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE','ENDED','EXPIRED')),
  metadata            JSONB NOT NULL DEFAULT '{}',
  correlation_id      UUID NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at            TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_workstream
  ON state.sessions (project_id, workstream_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON state.sessions (user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_status
  ON state.sessions (status, started_at DESC);

-- ============================================================
-- state.decisions (append-only)
-- ============================================================
CREATE TABLE IF NOT EXISTS state.decisions (
  decision_id         UUID NOT NULL PRIMARY KEY,
  project_id          UUID NOT NULL,
  workstream_id       UUID NOT NULL,
  session_id          UUID,
  title               TEXT NOT NULL CHECK (char_length(title) > 0 AND char_length(title) <= 512),
  context             TEXT NOT NULL CHECK (char_length(context) > 0),
  decision            TEXT NOT NULL CHECK (char_length(decision) > 0),
  rationale           TEXT,
  alternatives_considered JSONB DEFAULT '[]',
  implications        JSONB DEFAULT '[]',
  tags                JSONB DEFAULT '[]',
  idempotency_key     TEXT NOT NULL CHECK (char_length(idempotency_key) > 0),
  correlation_id      UUID NOT NULL,
  created_by          TEXT NOT NULL CHECK (char_length(created_by) > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_decisions_project_workstream
  ON state.decisions (project_id, workstream_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decisions_correlation
  ON state.decisions (correlation_id);

-- ============================================================
-- state.errors (append-only)
-- ============================================================
CREATE TABLE IF NOT EXISTS state.errors (
  error_id            UUID NOT NULL PRIMARY KEY,
  project_id          UUID NOT NULL,
  workstream_id       UUID NOT NULL,
  session_id          UUID,
  error_class         TEXT NOT NULL CHECK (char_length(error_class) > 0 AND char_length(error_class) <= 128),
  error_code          TEXT CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  message             TEXT NOT NULL CHECK (char_length(message) > 0),
  stack_trace         TEXT,
  context             JSONB DEFAULT '{}',
  resolution          TEXT,
  is_blocking         BOOLEAN NOT NULL DEFAULT false,
  idempotency_key     TEXT NOT NULL CHECK (char_length(idempotency_key) > 0),
  correlation_id      UUID NOT NULL,
  created_by          TEXT NOT NULL CHECK (char_length(created_by) > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_errors_project_workstream
  ON state.errors (project_id, workstream_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_errors_blocking
  ON state.errors (project_id, is_blocking, created_at DESC)
  WHERE is_blocking = true;

CREATE INDEX IF NOT EXISTS idx_errors_correlation
  ON state.errors (correlation_id);

-- ============================================================
-- state.events (append-only, general domain events)
-- ============================================================
CREATE TABLE IF NOT EXISTS state.events (
  event_id            UUID NOT NULL PRIMARY KEY,
  project_id          UUID NOT NULL,
  workstream_id       UUID,
  session_id          UUID,
  event_type          TEXT NOT NULL CHECK (char_length(event_type) > 0 AND char_length(event_type) <= 128),
  payload             JSONB NOT NULL DEFAULT '{}',
  correlation_id      UUID NOT NULL,
  created_by          TEXT NOT NULL CHECK (char_length(created_by) > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_project_type
  ON state.events (project_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_workstream
  ON state.events (workstream_id, created_at DESC)
  WHERE workstream_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_correlation
  ON state.events (correlation_id);

-- ============================================================
-- state.task_attempts (append-only)
-- ============================================================
CREATE TABLE IF NOT EXISTS state.task_attempts (
  task_attempt_id     UUID NOT NULL PRIMARY KEY,
  project_id          UUID NOT NULL,
  workstream_id       UUID NOT NULL,
  session_id          UUID,
  task_key            TEXT NOT NULL CHECK (char_length(task_key) > 0 AND char_length(task_key) <= 128),
  attempt_number      INTEGER NOT NULL CHECK (attempt_number > 0),
  status              TEXT NOT NULL DEFAULT 'STARTED'
                        CHECK (status IN ('STARTED','SUCCEEDED','FAILED','RETRYABLE_FAILURE')),
  input_ref           JSONB DEFAULT '{}',
  output_ref          JSONB DEFAULT '{}',
  error_message       TEXT,
  duration_ms         INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  idempotency_key     TEXT NOT NULL CHECK (char_length(idempotency_key) > 0),
  correlation_id      UUID NOT NULL,
  created_by          TEXT NOT NULL CHECK (char_length(created_by) > 0),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at            TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, idempotency_key),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_task_attempts_workstream_task
  ON state.task_attempts (workstream_id, task_key, attempt_number DESC);

CREATE INDEX IF NOT EXISTS idx_task_attempts_correlation
  ON state.task_attempts (correlation_id);

-- ============================================================
-- state.task_completions (append-only)
-- ============================================================
CREATE TABLE IF NOT EXISTS state.task_completions (
  task_completion_id   UUID NOT NULL PRIMARY KEY,
  project_id           UUID NOT NULL,
  workstream_id        UUID NOT NULL,
  session_id           UUID,
  task_key             TEXT NOT NULL CHECK (char_length(task_key) > 0 AND char_length(task_key) <= 128),
  final_status         TEXT NOT NULL CHECK (final_status IN ('SUCCEEDED','FAILED','SKIPPED')),
  summary              TEXT NOT NULL CHECK (char_length(summary) > 0),
  artifacts_ref        JSONB DEFAULT '[]',
  total_attempts       INTEGER NOT NULL DEFAULT 1 CHECK (total_attempts > 0),
  idempotency_key      TEXT NOT NULL CHECK (char_length(idempotency_key) > 0),
  correlation_id       UUID NOT NULL,
  created_by           TEXT NOT NULL CHECK (char_length(created_by) > 0),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_task_completions_workstream_task
  ON state.task_completions (workstream_id, task_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_completions_correlation
  ON state.task_completions (correlation_id);

-- ============================================================
-- state.workstream_events (append-only, workstream-scoped log)
-- ============================================================
CREATE TABLE IF NOT EXISTS state.workstream_events (
  workstream_event_id  UUID NOT NULL PRIMARY KEY,
  project_id           UUID NOT NULL,
  workstream_id        UUID NOT NULL,
  session_id           UUID,
  event_type           TEXT NOT NULL CHECK (char_length(event_type) > 0 AND char_length(event_type) <= 128),
  previous_value       TEXT,
  new_value            TEXT,
  metadata             JSONB DEFAULT '{}',
  correlation_id       UUID NOT NULL,
  created_by           TEXT NOT NULL CHECK (char_length(created_by) > 0),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workstream_events_workstream
  ON state.workstream_events (workstream_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workstream_events_project_type
  ON state.workstream_events (project_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workstream_events_correlation
  ON state.workstream_events (correlation_id);

-- ============================================================
-- state.recovery_state (mutable, optimistic concurrency)
-- ============================================================
CREATE TABLE IF NOT EXISTS state.recovery_state (
  recovery_id          UUID NOT NULL PRIMARY KEY,
  project_id           UUID NOT NULL,
  workstream_id        UUID NOT NULL,
  checkpoint_key       TEXT NOT NULL CHECK (char_length(checkpoint_key) > 0 AND char_length(checkpoint_key) <= 128),
  state_data           JSONB NOT NULL DEFAULT '{}',
  version              INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  correlation_id       UUID NOT NULL,
  created_by           TEXT NOT NULL CHECK (char_length(created_by) > 0),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workstream_id, checkpoint_key)
);

CREATE INDEX IF NOT EXISTS idx_recovery_state_project_workstream
  ON state.recovery_state (project_id, workstream_id);
`;

export const migration002StateSchema: Migration = {
  version: 2,
  name: 'state_schema',
  up: async (client: PoolClient): Promise<void> => {
    await client.query(UP_SQL);
  },
};
