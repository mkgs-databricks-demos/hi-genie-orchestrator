# 2026-08-19 — Lakebase Extensions Self-Healing + UC Setup Job

## Summary

Added self-healing Lakebase extension installation to both the app bundle
(migration v3 runtime) and the infra bundle (UC Setup job at deploy time).
Both layers are idempotent defense-in-depth. Also documented Lakebase Search
enablement (manual toggle, no DABs method) and fixed several deployment issues.

## Problems Encountered

| # | Problem | Root Cause | Fix |
| --- | --- | --- | --- |
| 1 | Migration v3 failed: "required extension 'vector' is not installed" | `lakebase_vector` extension not installed in database (project-level Search toggle was off) | User enabled Search toggle; added `CASCADE` to `CREATE EXTENSION` |
| 2 | Migration v3 failed: "functions in index predicate must be marked IMMUTABLE" | Partial index used `now()` which is not IMMUTABLE | Removed WHERE clause, made it a full index on `expires_at` |
| 3 | Migration v3 not running ("0 applied, 2 skipped") | Multi-content editAsset only applied first patch — MIGRATIONS array still had v3 commented out | Applied second patch in separate editAsset call |
| 4 | Bundle validate: "notebook not found" | Notebook created as workspace notebook (no extension); bundle CLI needs `.py` extension | Used `.py` path (filesystem confirms `.py` format) |
| 5 | `LakebasePool` vs `pg.Pool` type mismatch (prior session) | AppKit's pool type doesn't extend full pg EventEmitter interface | Deferred to module enablement phase (tsconfig narrowed) |

## Changes Made

### App Bundle (`mcp-hi-genie-orchestrator`)

| File | Change |
| --- | --- |
| `server/migrations/003_memory_tables.ts` | Added `CASCADE` to `lakebase_vector`; added `lakebase_text`; removed non-IMMUTABLE partial index |
| `server/migrations/index.ts` | Re-enabled v3 in imports + MIGRATIONS array |
| `README.md` | Documented Lakebase Search, health endpoint, AppKit convention |
| `PROJECT_MEMORY.md` | Updated deploy state, added Lakebase Search section, architecture decisions 10–12, known issues 5–6 |

### Infra Bundle (`hi-genie-infra`)

| File | Change |
| --- | --- |
| `src/lakebase_platform_setup.py` (NEW) | 5-cell notebook: SDK install, config, search-check + extension install, verify, summary |
| `resources/uc_setup.job.yml` (NEW) | On-demand job with parameters inherited from bundle resources |

## Deployment Results

| Bundle | Target | Status | Notes |
| --- | --- | --- | --- |
| mcp-hi-genie-orchestrator | dev (app deploy) | ✓ SUCCEEDED | Migration v3 applied (669ms); all 3 migrations green |
| hi-genie-infra | dev (bundle deploy) | ✓ SUCCEEDED | 10 resources deployed (added uc_setup job) |
| hi-genie-infra | dev (job run) | ✓ SUCCEEDED | UC Setup job ran in ~30s, extensions verified |

## Key Decisions

1. **Self-healing at BOTH layers** — app migration v3 installs extensions at runtime; infra job installs at deploy time. Both idempotent (`IF NOT EXISTS`). Infra is authoritative; app is fallback.
2. **Job parameters from bundle resources** — `${resources.postgres_projects.hi_genie_lakebase.project_id}`, `${resources.schemas.hi_genie_schema.*}`. Never from loose variables.
3. **Lakebase Search pre-flight check** — notebook raises with admin remediation steps if Search toggle isn't enabled.
4. **Full index for TTL cleanup** — replaced partial index with `now()` predicate; Lakebase requires IMMUTABLE functions in index predicates.
5. **Use AppKit plugin modules for Lakebase** — convention established. Avoid direct `pg` pool access unless absolutely necessary.

## Git Commits (branch: `mg-genie-server-modules-r1`)

1. `docs: update README and PROJECT_MEMORY for current deploy state`
2. `feat: self-healing extensions in migration v3 + re-enable memory tables`
3. `fix: actually enable migration003 in MIGRATIONS array (patch issue)`
4. `fix: remove non-IMMUTABLE now() from partial index predicate`
5. `docs: update PROJECT_MEMORY — all 3 migrations applied, self-healing confirmed`
6. `feat(infra): add UC Setup job for Lakebase extension provisioning`

## Files Modified (full paths)

### App Bundle
- `mcp-hi-genie-orchestrator/server/migrations/003_memory_tables.ts`
- `mcp-hi-genie-orchestrator/server/migrations/index.ts`
- `mcp-hi-genie-orchestrator/README.md`
- `mcp-hi-genie-orchestrator/PROJECT_MEMORY.md`

### Infra Bundle
- `hi-genie-infra/src/lakebase_platform_setup.py` (NEW)
- `hi-genie-infra/resources/uc_setup.job.yml` (NEW)

## Next Steps

1. Enable next app module (telemetry) — fix OTel semantic conventions + mlflow types
2. Consider adding UC grants task to the UC Setup job (second task_key)
3. Deploy infra to `hls_fde` target for production readiness
4. Run post-deploy validation job on app bundle to confirm end-to-end
