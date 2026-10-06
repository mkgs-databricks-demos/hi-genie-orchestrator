/**
 * Migration Module — Barrel Export
 *
 * Entry point for the startup migration system. Registers all migration
 * definitions in order and exposes `runMigrations` for invocation from
 * the App's `onPluginsReady` hook.
 *
 * Usage in server.ts:
 *   import { runMigrations } from './migrations';
 *   await runMigrations(appkit.lakebase);
 */

import { executeMigrations } from './runner.js';
import { migration001DispatchSchema } from './001_dispatch_schema.js';
import { migration002StateSchema } from './002_state_schema.js';
import { migration003MemoryTables } from './003_memory_tables.js';
import { migration004WorkstreamColumns } from './004_workstream_columns.js';
import { migration005RowLevelSecurityPlans } from './005_row_level_security_plans.js';
import { migration006RowLevelSecurityWorkstreamsReviews } from './006_row_level_security_workstreams_reviews.js';
import { migration007RowLevelSecurityState } from './007_row_level_security_state.js';
import { migration008SkillVersions } from './008_skill_versions.js';
import { migration009ProjectsTable } from './009_projects_table.js';

// Re-export types for downstream consumers
export type { Migration, MigrationResult, MigrationRunSummary } from './runner.js';
export { executeMigrations } from './runner.js';

// ── Migration Registry ─────────────────────────────────────────────────────
// Add new migrations here in version order.
// Convention: version numbers are monotonically increasing integers.
// Never reuse or reorder a version number after deployment.
//
// NOTE: migration003 self-heals by installing lakebase_vector CASCADE
// (which pulls in pgvector). Requires Lakebase Search enabled at project
// level (manual toggle in Lakebase UI — no DABs method yet).

const MIGRATIONS = [
  migration001DispatchSchema,
  migration002StateSchema,
  migration003MemoryTables,
  migration004WorkstreamColumns,
  migration005RowLevelSecurityPlans,
  migration006RowLevelSecurityWorkstreamsReviews,
  migration007RowLevelSecurityState,
  migration008SkillVersions,
  migration009ProjectsTable,
] as const;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * AppKit Lakebase plugin interface (subset used by migrations).
 * AppKit's LakebasePool is structurally compatible with pg.Pool at runtime
 * but has a different TS type. Accept `any` to avoid incompatibility.
 */
interface LakebasePlugin {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pool: any;
}

/**
 * Run all registered migrations against the AppKit Lakebase pool.
 * Idempotent: safe to call on every App startup.
 * Fails fast on any migration error (App should not serve traffic).
 */
export async function runMigrations(lakebase: LakebasePlugin): Promise<void> {
  console.log('[migrations] Starting migration run...');

  const summary = await executeMigrations(lakebase.pool, [...MIGRATIONS]);

  if (summary.failed > 0) {
    throw new Error(
      `[migrations] ${summary.failed} migration(s) failed. App startup aborted.`
    );
  }

  console.log(
    `[migrations] All migrations complete. ` +
    `Applied: ${summary.applied}, Skipped: ${summary.skipped}, ` +
    `Total time: ${summary.durationMs}ms`
  );
}
