# Design Documents — mcp-hi-genie-orchestrator

Forward-looking research, architecture explorations, RFCs, and potential roadmap items.

## Purpose

This directory captures ideas, investigations, and design considerations that are **not yet committed to implementation**. It complements:

| Resource | Purpose | Orientation |
| --- | --- | --- |
| `fixtures/sessions/` | What happened (session summaries) | Past |
| `PROJECT_MEMORY.md` | Operational context (IDs, conventions, current state) | Present |
| `docs/design/` | Where we might go (research, RFCs, roadmap) | **Future** |

## Naming Convention

`YYYY-MM-DD_<topic-slug>.md` — date reflects when the investigation was conducted.

## Documents (reverse-chronological)

| Date | Document | Status | Summary |
| --- | --- | --- | --- |
| 2026-10-30 | [mcp-apps-adoption-research](./2026-10-30_mcp-apps-adoption-research.md) | Proposal | What is needed to serve MCP Apps (`io.modelcontextprotocol/ui`): resources capability, `ui://` views, `_meta.ui.resourceUri`, single-file view build, ext-apps 2.0.4 on SDK v2; Genie One on `fevm-hls-fde` proven by Semantic Ground Truth; first view = reviewer review card; D-A-1..4 open |
| 2026-10-30 | [mcp-transport-sdk-adoption-plan](./2026-10-30_mcp-transport-sdk-adoption-plan.md) | Accepted | Transport execution plan: audit (0 of 12 issues implemented); **D-T-1** target 2026-07-28 dual-era and **D-T-2** official SDK (v2 `@modelcontextprotocol/server` `createMcpHandler`, low-level `Server`, registry kept), both owner-accepted 2026-10-30; all paths stateless; Phase 0 prerequisites, verification gates |
| 2026-08-26 | [mlflow-trace-lifecycle-and-obo-remediation](./2026-08-26_mlflow-trace-lifecycle-and-obo-remediation.md) | Accepted | Fix MLflow 3 traces: API v3 two-phase lifecycle, request/response previews, true OBO via x-forwarded-access-token, MCP-aligned trace hierarchy, structured naming |
| 2026-08-25 | [transport-2025-11-25-compliance-plan](./2026-08-25_transport-2025-11-25-compliance-plan.md) | Accepted | 12-issue remediation plan for MCP Streamable HTTP spec compliance; 3 phases (protocol correctness, streaming/progress, hardening); scoped to current 2025-11-25 transport. Implementation sketches superseded by Decision 4 (official SDK) and Decisions 1/3 by Decision 5 (2026-07-28 target), both 2026-10-30; issue list and Decision 2 still apply |
| 2026-08-24 | [004-four-persona-mcp-split](./004-four-persona-mcp-split.md) | Accepted | 4-persona MCP services (architect:13, reviewer:14, worker:17, dispatcher:16) under UC 20-tool limit; validated with OTel + live MCP tools/list |
| 2026-08-24 | [005-four-persona-e2e-test-plan](./005-four-persona-e2e-test-plan.md) | Draft | E2E test plan for 4-persona split: transport isolation, UC service discovery, policy enforcement, rate limits, cold-start recovery |
| 2026-08-23 | [r2-mcp-consolidation-plan](./2026-08-23_r2-mcp-consolidation-plan.md) | Partially implemented | Unify all persona interactions onto MCP; service layer extraction; persona_tool_policy gating; UC function deprecation. Connection consolidation + persona selectors + projects done; UC function deprecation pending |
| 2026-08-23 | [skill-publishing-and-post-deploy-job](./2026-08-23_skill-publishing-and-post-deploy-job.md) | Implemented | Migration 008 (skill_versions table), expanded post-deploy job with first_run gating, `update_skill` interactive-only MCP tool, `get_skill_content` on both surfaces, UC MCP Service registration task |
| 2026-08-20 | [mcp-protocol-versioning-strategy](./2026-08-20_mcp-protocol-versioning-strategy.md) | Superseded (A/B variants) 2026-10-30 by D-T-1 dual-era SDK v2 | A/B deployable MCP spec variants (2025-11-25 vs 2026-07-28) via bundle variable; dual app naming; Lakebase branch isolation; transport-v26 skeleton |
| 2026-08-19 | [sandbox-api-exploration](./2026-08-19_sandbox-api-exploration.md) | Research complete | Undocumented `/api/2.0/sandboxes` REST API; Omnigent auto-provisioning; exec gap analysis; r1.2 candidate for npm test runner |

## Lifecycle

1. **Research** — investigation in progress, findings accumulating
2. **Proposal** — concrete design with trade-offs articulated
3. **Draft** — structured plan (e.g., test plan) awaiting prerequisite implementation
4. **Accepted** — decision made, implementation planned (moves to PROJECT_MEMORY Architecture Decisions)
5. **Partially implemented** — core items shipped, remaining items tracked in Next Steps
6. **Implemented** — fully shipped and validated in production
7. **Superseded** — replaced by a later design doc (link to successor)
