# Session: PROJECT_MEMORY & Documentation Audit

**Date:** 2026-08-27  
**Branch:** `mg-genie-r2-mcp-consolidation`  
**Duration:** ~45 min  

---

## Problem Statement

PROJECT_MEMORY.md had fallen behind the active feature branch by several sessions.
Multiple commits (20+) on `mg-genie-r2-mcp-consolidation` since the last memory
update introduced new features, architectural changes, and bug fixes that were
only captured in session summaries — not in the operational reference.

---

## Audit Scope

| Source | Reviewed |
| --- | --- |
| `PROJECT_MEMORY.md` | Full file (40K chars) |
| `fixtures/sessions/` | All summaries from 2026-08-25 through 2026-08-27 |
| `docs/design/INDEX.md` | All entries |
| `databricks.yml` | Variables and connection config |
| `resources/post_deploy.job.yml` | Task DAG and parameters |
| `README.md` | Architecture tree, MCP tools reference, SDK examples |
| `.review-protocol/debate_state.json` | Debate statuses |
| Git log | 20 most recent commits on branch |
| `git status` | Clean (no uncommitted changes) |

---

## Findings & Fixes

### PROJECT_MEMORY.md (11 patches)

| Section | Issue | Fix |
| --- | --- | --- |
| Last validated | 2026-08-24, "awaiting redeploy" | → 2026-08-27, head `f76e475`, 7 successful deploys |
| Migrations row | "v1-v8 applied" | → v1-v9 (009 = dispatch.projects + FK constraints) |
| MCP module | "39 tools across 3 transports" (old 2-persona paths) | → single `/mcp` endpoint + 4-persona UC MCP Service selectors |
| API module | No mention of projects routes | → Added `/api/v1/projects` (2026-08-26) |
| MLflow module | Missing partial fix context | → Added: reserved tag fix (`c43e5be`), exports now HTTP 200 |
| Dispatch architecture | No `materialize` fix | → Added title fallback (`ws.name ?? ws.title ?? ws.workstream_key`) |
| Developer Experience | "23 MCP tools" | → 39 |
| UC Connections | Old name `hi_genie_orchestrator_mcp_conn_dev` | → `hi_genie_mcp_conn_dev` (single conn for all 5 services) |
| MCP Services row | Single service entry | → 5 services with persona counts |
| Persona Tool Mapping | Old 2-persona table (worker:20, supervisor:20) | → 5-persona table with UC MCP Service selectors |
| Implementation note | Old `transport.ts` code reference | → `register_mcp_service.py` YAML selectors + legacy code (Issue #11) |

### New sections added to PROJECT_MEMORY.md

| Section | Content |
| --- | --- |
| **Projects (Migration 009)** | `dispatch.projects` table, FK constraints, `create_project` tool, REST routes, FK violation handling |
| **Dispatch Dependency Gate** | `dispatch_workstream` upstream dep check, AI Playground validation, tick reconciliation note |
| **Next Steps #7-10** | validate_deployment FK ordering, tick+gate reconciliation, `withToolSpan` read-only tools, PR merge |
| **Architecture Decisions #12-14** | Single MCP connection, dependency gate, projects as top-level entity |

### README.md (4 patches)

| Location | Issue | Fix |
| --- | --- | --- |
| Architecture tree | "23 tools" | → 39 |
| Architecture tree | "v1-v7" | → v1-v9 |
| MCP Tools Reference heading | "23 JSON-RPC tools" | → 39 + persona selector note |
| SDK MCP discovery example | "23 registered" | → 39 |

### docs/design/INDEX.md (2 patches)

| Issue | Fix |
| --- | --- |
| Missing 004 and 005 design docs | Added entries (4-persona split: Accepted, E2E test plan: Draft) |
| Stale statuses | R2 consolidation → "Partially implemented", Skill publishing → "Implemented" |
| Incomplete lifecycle definitions | Added: Draft, Partially implemented, Implemented |

### 2026-08-25_transport-compliance-plan.md (2 patches)

| Issue | Fix |
| --- | --- |
| Executive summary says "10 areas" | → 12 (Issues #11 and #12 were added post-creation) |
| P1 issues list missing #12 | → Added #12 to P1 phase row |

---

## Noted but NOT Changed

| Item | Reason |
| --- | --- |
| `.review-protocol/debate_state.json` — `001_release-1-readiness` shows `IN_PROGRESS` | Polly protocol — update belongs to a collaboration round |
| `004-four-persona-mcp-split.md` — says "Architect: 13 tools" | Design docs are point-in-time decisions; current state lives in PROJECT_MEMORY |
| Supervisor/Architect tool list shows 21 items but split is now 4-persona | The listed tools serve as a full inventory reference; persona-specific subsets are in the table above |

---

## Files Modified

| File | Change Type |
| --- | --- |
| `PROJECT_MEMORY.md` | 11 section updates + 4 new sections |
| `README.md` | 4 stale count fixes |
| `docs/design/INDEX.md` | 2 missing entries + status corrections + lifecycle expansion |
| `docs/design/2026-08-25_transport-2025-11-25-compliance-plan.md` | Issue count + phase table consistency |
| `fixtures/sessions/2026-08-27_project-memory-and-docs-audit.md` | This file (new) |
| `fixtures/sessions/INDEX.md` | New entry (below) |

---

## Decisions

1. **Design doc statuses track implementation reality** — "Proposal" upgraded to "Partially implemented" or "Implemented" when session summaries confirm shipping.
2. **PROJECT_MEMORY is the single source of current state** — Design docs are point-in-time; SESSION files are historical. Only PROJECT_MEMORY gets retroactive updates when the branch advances.
3. **README tool counts should match PROJECT_MEMORY** — README is the public-facing quickstart; its numbers must stay synchronized.

---

## Next Steps

1. Commit these documentation updates to `mg-genie-r2-mcp-consolidation`
2. Proceed with implementation work (MLflow P1 or transport P1)
3. PR merge when items #7-8 from Next Steps are addressed
