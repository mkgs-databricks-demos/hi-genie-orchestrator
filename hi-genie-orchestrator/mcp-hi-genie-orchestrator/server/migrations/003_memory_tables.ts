/**
 * Migration 003 — Memory Tables
 *
 * Creates the three-tier memory model in the `state` schema:
 *   - short_term_memory: thread-scoped, TTL 1-7 days
 *   - episodic_memory: redacted session summaries (long-term)
 *   - semantic_memory: compacted facts with pgvector embeddings (long-term)
 *
 * Enables the `lakebase_vector` extension for vector columns and creates
 * a `lakebase_ann` index on the semantic_memory embedding column.
 *
 * Per Decision 18-20: embeddings are derived artifacts, generated
 * asynchronously. The embedding_status column tracks pending/ready/failed.
 */

import type { PoolClient } from 'pg';
import type { Migration } from './runner.js';

const UP_SQL = `
-- ============================================================
-- Self-healing: install required extensions (idempotent).
-- Requires Lakebase Search enabled at project level (manual toggle).
-- CASCADE installs the 'vector' (pgvector) dependency automatically.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS lakebase_vector CASCADE;
CREATE EXTENSION IF NOT EXISTS lakebase_text;

-- ============================================================
-- state.short_term_memory (session/thread-scoped, TTL-based)
-- ============================================================
CREATE TABLE IF NOT EXISTS state.short_term_memory (
  memory_id           UUID NOT NULL PRIMARY KEY,
  project_id          UUID NOT NULL,
  workstream_id       UUID,
  session_id          UUID NOT NULL,
  developer_id        TEXT NOT NULL CHECK (char_length(developer_id) > 0),
  memory_type         TEXT NOT NULL CHECK (
                        memory_type IN ('WORKING_CONTEXT','THREAD_SUMMARY','SCRATCH')
                      ),
  content             TEXT NOT NULL CHECK (char_length(content) > 0),
  metadata            JSONB DEFAULT '{}',
  ttl_days            SMALLINT NOT NULL DEFAULT 7 CHECK (ttl_days >= 1 AND ttl_days <= 30),
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_short_term_memory_session
  ON state.short_term_memory (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_short_term_memory_developer_project
  ON state.short_term_memory (developer_id, project_id, created_at DESC);

-- Full index on expires_at supports TTL cleanup queries efficiently.
-- Cannot use partial index with now() — not IMMUTABLE.
CREATE INDEX IF NOT EXISTS idx_short_term_memory_expires
  ON state.short_term_memory (expires_at ASC);

-- ============================================================
-- state.episodic_memory (redacted session summaries, append-only)
-- ============================================================
CREATE TABLE IF NOT EXISTS state.episodic_memory (
  memory_id           UUID NOT NULL PRIMARY KEY,
  project_id          UUID NOT NULL,
  workstream_id       UUID,
  session_id          UUID,
  developer_id        TEXT NOT NULL CHECK (char_length(developer_id) > 0),
  memory_type         TEXT NOT NULL CHECK (
                        memory_type IN ('SESSION_SUMMARY','EXECUTION_OUTCOME','ERROR_RECORD','BLOCKER_RECORD')
                      ),
  title               TEXT NOT NULL CHECK (char_length(title) > 0 AND char_length(title) <= 512),
  content             TEXT NOT NULL CHECK (char_length(content) > 0),
  source_ref          JSONB DEFAULT '{}',
  importance          SMALLINT NOT NULL DEFAULT 50 CHECK (importance >= 0 AND importance <= 100),
  tags                JSONB DEFAULT '[]',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_episodic_memory_developer_project
  ON state.episodic_memory (developer_id, project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_episodic_memory_workstream
  ON state.episodic_memory (workstream_id, created_at DESC)
  WHERE workstream_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_episodic_memory_importance
  ON state.episodic_memory (project_id, importance DESC, created_at DESC);

-- ============================================================
-- state.semantic_memory (compacted facts with embeddings)
-- ============================================================
CREATE TABLE IF NOT EXISTS state.semantic_memory (
  memory_id             UUID NOT NULL PRIMARY KEY,
  project_id            UUID NOT NULL,
  workstream_id         UUID,
  developer_id          TEXT NOT NULL CHECK (char_length(developer_id) > 0),
  memory_type           TEXT NOT NULL CHECK (
                          memory_type IN ('PATTERN','CONVENTION','LESSON','FACT')
                        ),
  content               TEXT NOT NULL CHECK (char_length(content) > 0),
  embedding             vector(1536),
  embedding_model       TEXT,
  embedding_model_version TEXT,
  embedding_status      TEXT NOT NULL DEFAULT 'pending'
                          CHECK (embedding_status IN ('pending','ready','failed')),
  embedding_generated_at TIMESTAMPTZ,
  source_episodic_ids   JSONB DEFAULT '[]',
  importance            SMALLINT NOT NULL DEFAULT 50 CHECK (importance >= 0 AND importance <= 100),
  access_count          INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  last_accessed_at      TIMESTAMPTZ,
  tags                  JSONB DEFAULT '[]',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_semantic_memory_developer_project
  ON state.semantic_memory (developer_id, project_id, importance DESC);

CREATE INDEX IF NOT EXISTS idx_semantic_memory_status
  ON state.semantic_memory (embedding_status, created_at ASC)
  WHERE embedding_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_semantic_memory_workstream
  ON state.semantic_memory (workstream_id, importance DESC)
  WHERE workstream_id IS NOT NULL;

-- ============================================================
-- Approximate Nearest Neighbor index for semantic search
-- Uses cosine similarity as specified in Decision 19.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_semantic_memory_embedding_ann
  ON state.semantic_memory
  USING lakebase_ann (embedding vector_cosine_ops);
`;

export const migration003MemoryTables: Migration = {
  version: 3,
  name: 'memory_tables',
  up: async (client: PoolClient): Promise<void> => {
    await client.query(UP_SQL);
  },
};
