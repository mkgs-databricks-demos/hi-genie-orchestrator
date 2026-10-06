/**
 * Migration Runner Engine
 *
 * Provides ordered, versioned, idempotent schema migrations for the
 * Hi Genie Orchestrator App. Runs during App startup via onPluginsReady
 * using the AppKit service-principal Lakebase pool.
 *
 * Release 1: basic version tracking, ordered execution, transaction-per-migration.
 * Release 1.1: checksums, advisory locking, fail-closed readiness, registry validation.
 */

import type { Pool, PoolClient } from 'pg';

// ── Types ───────────────────────────────────────────────────────────────────

export interface Migration {
  /** Monotonically increasing version number. Must be unique across all migrations. */
  version: number;
  /** Human-readable name for logging and history. */
  name: string;
  /** Execute the migration DDL within the provided client (already in a transaction). */
  up: (client: PoolClient) => Promise<void>;
}

export interface MigrationResult {
  version: number;
  name: string;
  status: 'applied' | 'skipped' | 'failed';
  durationMs: number;
  error?: string;
}

export interface MigrationRunSummary {
  totalMigrations: number;
  applied: number;
  skipped: number;
  failed: number;
  results: MigrationResult[];
  durationMs: number;
}

// ── Migration History Table ─────────────────────────────────────────────────

const HISTORY_TABLE = 'state._migration_history';

const CREATE_HISTORY_SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS state;`;

const CREATE_HISTORY_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
  id              SERIAL PRIMARY KEY,
  version         INTEGER NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms     INTEGER NOT NULL,
  checksum        TEXT,
  status          TEXT NOT NULL DEFAULT 'applied'
);
`;

// ── Runner Implementation ───────────────────────────────────────────────────

async function ensureHistoryTable(pool: Pool): Promise<void> {
  await pool.query(CREATE_HISTORY_SCHEMA_SQL);
  await pool.query(CREATE_HISTORY_TABLE_SQL);
}

async function getAppliedVersions(pool: Pool): Promise<Set<number>> {
  const result = await pool.query<{ version: number }>(
    `SELECT version FROM ${HISTORY_TABLE} WHERE status = 'applied' ORDER BY version ASC`
  );
  return new Set(result.rows.map((r) => r.version));
}

async function recordMigration(
  client: PoolClient,
  version: number,
  name: string,
  durationMs: number,
  status: 'applied' | 'failed',
  checksum?: string
): Promise<void> {
  await client.query(
    `INSERT INTO ${HISTORY_TABLE} (version, name, duration_ms, status, checksum)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (version) DO NOTHING`,
    [version, name, durationMs, status, checksum ?? null]
  );
}

/**
 * Execute a list of migrations in order against the provided pool.
 * Each migration runs in its own transaction. Already-applied migrations are skipped.
 * Returns a summary of the run.
 */
export async function executeMigrations(
  pool: Pool,
  migrations: Migration[]
): Promise<MigrationRunSummary> {
  const runStart = Date.now();
  const results: MigrationResult[] = [];

  // Ensure history tracking exists
  await ensureHistoryTable(pool);

  // Get already-applied versions
  const appliedVersions = await getAppliedVersions(pool);

  // Sort migrations by version (defensive)
  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  // Validate no duplicate versions
  const versionSet = new Set<number>();
  for (const m of sorted) {
    if (versionSet.has(m.version)) {
      throw new Error(
        `[migrations] Duplicate migration version ${m.version}: "${m.name}"`
      );
    }
    versionSet.add(m.version);
  }

  for (const migration of sorted) {
    // Skip already-applied
    if (appliedVersions.has(migration.version)) {
      results.push({
        version: migration.version,
        name: migration.name,
        status: 'skipped',
        durationMs: 0,
      });
      continue;
    }

    // Execute in transaction
    const client = await pool.connect();
    const migrationStart = Date.now();

    try {
      await client.query('BEGIN');
      await migration.up(client);

      const durationMs = Date.now() - migrationStart;
      await recordMigration(client, migration.version, migration.name, durationMs, 'applied');
      await client.query('COMMIT');

      results.push({
        version: migration.version,
        name: migration.name,
        status: 'applied',
        durationMs,
      });

      console.log(
        `[migrations] Applied v${migration.version} "${migration.name}" (${durationMs}ms)`
      );
    } catch (err) {
      const durationMs = Date.now() - migrationStart;
      await client.query('ROLLBACK').catch(() => {});

      // Record failure outside the rolled-back transaction
      try {
        await pool.query(
          `INSERT INTO ${HISTORY_TABLE} (version, name, duration_ms, status)
           VALUES ($1, $2, $3, 'failed')
           ON CONFLICT (version) DO NOTHING`,
          [migration.version, migration.name, durationMs]
        );
      } catch {
        // Best-effort failure recording
      }

      const errorMessage = err instanceof Error ? err.message : String(err);
      results.push({
        version: migration.version,
        name: migration.name,
        status: 'failed',
        durationMs,
        error: errorMessage,
      });

      console.error(
        `[migrations] FAILED v${migration.version} "${migration.name}":`,
        errorMessage
      );

      // Fail fast — do not continue past a failed migration
      throw new Error(
        `Migration v${migration.version} "${migration.name}" failed: ${errorMessage}`
      );
    } finally {
      client.release();
    }
  }

  const summary: MigrationRunSummary = {
    totalMigrations: sorted.length,
    applied: results.filter((r) => r.status === 'applied').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
    durationMs: Date.now() - runStart,
  };

  console.log(
    `[migrations] Complete: ${summary.applied} applied, ${summary.skipped} skipped (${summary.durationMs}ms)`
  );

  return summary;
}
