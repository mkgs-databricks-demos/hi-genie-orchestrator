# Session: Skill Publishing & Post-Deploy Job

**Date:** 2026-08-23  
**Branch:** `mg-genie-skill-publishing-and-post-deploy`  
**Scope:** Migration 008, skill tools (MCP + REST), expanded post-deploy job, UC MCP Service registration

## Problems Solved

1. **No persistent skill storage** — Workers had no way to load versioned skill content at runtime.
2. **No publish mechanism** — No path from git-controlled skill fixtures to Lakebase.
3. **No interactive skill editing** — Humans couldn't update a skill section without a full redeploy.
4. **No UC MCP Service registration automation** — Registration was documented but manual.
5. **No execution tracking** — Dispatcher couldn't record automation_id, heartbeat, skill_version on executions.

## Architectural Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | `publish_skill_version` always appends (no dedup) | Simpler versioning; each publish is an explicit reset point |
| 2 | `update_skill` also always appends a new version | Consistent semantics — every mutation creates an auditable version row |
| 3 | Publish job uses REST (`POST /api/v1/skills/publish`) | Keeps app-layer validation; no direct Lakebase from notebooks |
| 4 | `publish_skill_version` and `register_uc_mcp_service` run in parallel | Independent concerns; both gated by same `check_first_run` condition |
| 5 | `first_run` job parameter (not file-existence check) | Explicit, simple, callable on-demand as a reset |
| 6 | `update_skill` enforced via dual-layer: session_type + AI Gateway policy | Belt and suspenders |
| 7 | Version pinning at orchestration level (`dispatch.orchestrations.skill_version`) | Workers always read their pinned version |

## Files Created (7)

| File | Purpose |
| --- | --- |
| `docs/design/2026-08-23_skill-publishing-and-post-deploy-job.md` | Full design doc |
| `server/migrations/008_skill_versions.ts` | Migration: tables, columns, RLS, indexes |
| `server/mcp/tools/skill.ts` | `get_skill_content` + `update_skill` MCP tools |
| `server/api/routes/skills.ts` | `GET /content` + `POST /publish` REST endpoints |
| `src/deploy/publish_skill` (notebook) | Reads fixtures → publishes via REST |
| `src/deploy/register_uc_mcp_service` (notebook) | Creates UC Connection + Service + grants |
| `fixtures/sessions/2026-08-23_skill-publishing-post-deploy-job.md` | This file |

## Files Modified (3)

| File | Change |
| --- | --- |
| `server/migrations/index.ts` | Registered migration008SkillVersions |
| `resources/post_deploy_tests.job.yml` | Expanded to `post_deploy` with `first_run`, condition_task, parallel tasks |
| `docs/design/INDEX.md` | Added new design doc entry |

## Remaining Wiring (next in this session)

- Register skills router in `server/api/index.ts` (mount at `/api/v1/skills`)
- Register `get_skill_content` + `update_skill` in MCP server tool registry
- Update `mcp-catalog.test.ts` assertion count (23 → 25 tools)
- Rename `post_deploy_tests.job.yml` → `post_deploy.job.yml`

## Schema Changes (Migration 008)

**New tables:** `dispatch.skill_versions`, `dispatch.project_skill_overrides`

**Altered:** `dispatch.executions` (+8 cols), `dispatch.orchestrations` (+skill_version)

**RLS:** 4 new policies (SELECT permissive + INSERT write-integrity)

**Indexes:** 4 new (current lookup, project, version DESC, heartbeat stuck)
