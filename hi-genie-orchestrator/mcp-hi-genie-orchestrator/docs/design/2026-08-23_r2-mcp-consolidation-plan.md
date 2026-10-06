# R2 → R1 MCP Consolidation Plan

**Date:** 2026-08-23  
**Status:** Proposal  
**Branch:** `mg-genie-r2-mcp-consolidation` (to be created)  
**Goal:** Unify all persona interactions (architect, dispatcher, reviewer, worker, human) onto the single MCP service, gated by `persona_tool_policy`. Deprecate UC SQL function wrappers.

---

## 1. Current State

### MCP Service (25 tools — worker/human-facing)

| Module | Tools | Persona |
| --- | --- | --- |
| `context.ts` | `list_projects`, `get_project_context`, `get_workstream_context`, `search_decisions`, `get_recent_session_summaries`, `get_relevant_errors`, `get_session_context` | worker / ALL |
| `state.ts` | `update_workstream_status`, `update_task_status`, `update_recovery_state`, `start_session`, `end_session` | worker |
| `records.ts` | `record_decision`, `record_session_summary`, `record_error`, `record_workstream_event`, `record_task_attempt`, `record_task_completion` | worker |
| `search.ts` | `search_context`, `get_task_history`, `get_execution_summary`, `get_health`, `get_schema_version` | worker / ALL |
| `skill.ts` | `get_skill_content`, `update_skill` | worker / supervisor |

### Supervisor REST API (separate HTTP routes, NOT on MCP)

| Route File | Endpoints | Persona |
| --- | --- | --- |
| `plans.ts` | `POST /plans`, `GET /plans/:id`, `POST /plans/:id/publish` | architect |
| `workstreams.ts` | `POST /plans/:id/orchestrate`, `POST /orchestrations/:id/materialize`, `GET /orchestrations/:id/workstreams`, `POST /.../dispatch`, `POST /.../retry`, `POST /.../pause`, `POST /.../unpause` | dispatcher |
| `reviews.ts` | `POST /reviews`, `GET /reviews/:id`, `POST /reviews/:id/remediation`, `POST /reviews/:id/approve` | reviewer / supervisor |

### UC SQL Functions (6 — thin HTTP wrappers via Connection Proxy)

`create_plan`, `get_plan`, `publish_plan`, `orchestrate_plan`, `list_workstreams`, `dispatch_workstream`

These exist solely because architect/dispatcher agent SPNs call via SQL (UC functions) rather than MCP. Once those personas move to MCP, these become dead code.

---

## 2. Target State

A single MCP service endpoint (`/mcp`) with **~39 tools** covering ALL personas:

| Module | New Tools | Persona | Source |
| --- | --- | --- | --- |
| `plans.ts` (new MCP) | `create_plan`, `get_plan`, `publish_plan` | architect | Wraps existing `plans.ts` route logic |
| `orchestration.ts` (new MCP) | `orchestrate_plan`, `materialize_workstreams`, `list_workstreams`, `dispatch_workstream`, `retry_workstream`, `pause_workstream`, `unpause_workstream` | dispatcher | Wraps existing `workstreams.ts` route logic |
| `reviews.ts` (new MCP) | `create_review`, `get_review`, `deliver_remediation`, `approve_review` | reviewer | Wraps existing `reviews.ts` route logic |

**Access control:** `persona_tool_policy` (already deployed) gates tool invocation by principal type:
- `USER` → full access (ASK on `publish_plan` and `approve_review`)
- `SERVICE_PRINCIPAL` → checks `persona_assignments` table for tool alignment

**Existing worker tools remain unchanged** — they already work on MCP.

---

## 3. Architecture Decisions

### 3.1 Thin MCP wrappers, shared business logic

Do NOT duplicate the plan/workstream/review business logic. Extract the core logic from each REST route into a **service layer** (`server/services/`), then:
- REST routes call the service (for backwards compat during transition)
- MCP tool handlers call the same service

This prevents drift and ensures RLS, idempotency, and validation stay in one place.

### 3.2 REST routes remain (not removed)

The `/api/v1` REST surface stays live for:
- Swagger UI documentation
- Direct HTTP testing / integration
- Future external consumers

Only the UC SQL function wrappers are deprecated.

### 3.3 Identity flows unify

MCP tools get identity from the MCP session (`McpSession.userId`), which is already populated by `requireVerifiedIdentity`. The service layer accepts `userId: string` — same source whether called from REST (`req.verifiedIdentity`) or MCP (`session.userId`).

### 3.4 Policy registration at MCP service level

The `persona_tool_policy` is registered as the AI Gateway service policy on the MCP service via the `register_mcp_service` notebook. It fires ON_CALL for every tool invocation — no per-tool wiring needed.

---

## 4. Phased Implementation

### Phase 1: Service Layer Extraction (foundation)

**Files to create:**
- `server/services/plans.service.ts`
- `server/services/orchestration.service.ts`
- `server/services/reviews.service.ts`

**Pattern:**
```typescript
// server/services/plans.service.ts
export interface CreatePlanInput {
  project_id: string;
  name: string;
  description?: string;
  source_ref?: Record<string, unknown>;
}

export async function createPlan(pool: Pool, userId: string, input: CreatePlanInput) {
  // Business logic extracted from plans.ts route handler
  // Returns { plan_id, ... }
}
```

**Refactor existing REST routes** to call service functions instead of inline SQL.

**Deliverable:** Zero behavior change — routes pass through to services. Validated by existing Vitest + Playwright tests.

### Phase 2: New MCP Tool Modules

**Files to create:**
- `server/mcp/tools/plans.ts` — architect tools (3)
- `server/mcp/tools/orchestration.ts` — dispatcher tools (7)
- `server/mcp/tools/reviews.ts` — reviewer tools (4)

**Each tool follows the existing pattern:**
1. `McpToolDefinition` with JSON Schema `inputSchema` (including proper `enum` arrays)
2. `McpToolHandler` calling the service layer
3. Identity sourced from `McpSession`
4. Wrapped in `withIdentity()` for RLS `set_config`

**Register in `server/mcp/index.ts`** tool registry.

**Deliverable:** 14 new MCP tools (total: 39). Testable via AI Playground.

### Phase 3: Policy Integration

**Update `persona_tool_policy.sql`:**
- Add new tool names to the persona→tool mapping CASE branches
- Add `reviewer` persona with: `create_review`, `get_review`, `deliver_remediation`, `approve_review`
- Validate that existing `worker` tools (context/state/records/search/skill) fall through to ALLOW for any authenticated caller

**Update `persona_assignments_ddl.sql`:**
- Add `reviewer` to the allowed persona values (CHECK constraint or enum)

**Re-register policy:**
- Run `register_mcp_service` notebook (or post-deploy job with `drop_connection=true`)

**Deliverable:** Policy correctly gates architect/dispatcher/reviewer tools. Human callers unaffected.

### Phase 4: UC Function Deprecation

**Mark as deprecated (not remove):**
- Add `COMMENT 'DEPRECATED — use MCP service tool <name> instead'` to each UC function
- Remove from post-deploy `register_uc_function` forEach discovery
- Remove `discover_uc_functions` notebook task from job DAG

**After validation period (1 sprint):**
- `DROP FUNCTION` all 6
- Remove `src/deploy/uc_functions/` directory
- Remove `hi_genie_orchestrator_conn_dev` connection (keep only MCP connection)

**Deliverable:** Single MCP surface is the only active interface. UC functions gone.

### Phase 5: Persona Tool Mapping Update in PROJECT_MEMORY

Update the persona→tool table to reflect the full 39-tool surface:

| Persona | Tools |
| --- | --- |
| architect | `create_plan`, `get_plan`, `publish_plan` + all read-only context/search tools |
| dispatcher | `orchestrate_plan`, `materialize_workstreams`, `list_workstreams`, `dispatch_workstream`, `retry_workstream`, `pause_workstream`, `unpause_workstream` + all read-only context/search tools |
| reviewer | `create_review`, `get_review`, `deliver_remediation`, `approve_review` + all read-only context/search tools |
| worker | All state/records/session tools + context/search tools |
| human | ALL 39 tools (ASK gates on `publish_plan` + `approve_review`) |

---

## 5. Testing Strategy

| Phase | Test Type | What |
| --- | --- | --- |
| 1 | Unit (Vitest) | Service functions return correct results; existing route tests still pass |
| 1 | Integration (Playwright) | E2E flows unbroken |
| 2 | Unit (Vitest) | Each new MCP tool handler validates input, calls service, returns structured output |
| 2 | AI Playground | Manual: invoke each new tool as human, verify response shape |
| 3 | AI Playground | Invoke as SPN without matching persona → expect DENY; with matching persona → ALLOW |
| 3 | Unit | Policy function unit test (mock event variants) |
| 4 | Post-deploy | Verify UC functions no longer in catalog; MCP tools still work |

---

## 6. Migration Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| Service extraction introduces regression | Phase 1 is pure refactor — no new functionality. Run full test suite before proceeding. |
| MCP tool schema drift from REST validation | Both share the same Zod schemas (imported from service layer). Single source of truth. |
| Policy blocks legitimate callers | Phase 3 deploys policy but keeps UC functions alive (fallback). Only Phase 4 removes them. |
| Agent SPNs not yet configured in `persona_assignments` | Deferred (see PROJECT_MEMORY note). Policy ALLOWS all non-architect/non-dispatcher tools for any authenticated caller. |
| Tool count increase hits AI Gateway limits | Current limit is 50 tools per service. 39 is well within. |

---

## 7. Dependencies

- **persona_tool_policy.sql** — DONE (deployed today)
- **persona_assignments_ddl.sql** — DONE (deployed today)
- **MCP service registration** — DONE (post-deploy job ran successfully)
- **AI Gateway service policy attachment** — TODO (register_mcp_service notebook needs policy param)
- **Service layer pattern** — New (no existing `server/services/` directory)

---

## 8. Effort Estimate

| Phase | Effort | Dependencies |
| --- | --- | --- |
| Phase 1: Service extraction | 1 session | None |
| Phase 2: MCP tool modules | 1-2 sessions | Phase 1 |
| Phase 3: Policy integration | 0.5 session | Phase 2 |
| Phase 4: UC deprecation | 0.5 session | Phase 3 validated |
| Phase 5: Documentation | 0.25 session | Phase 4 |

**Total:** ~3-4 sessions

---

## 9. Resolved Questions

1. **Should `materialize_workstreams` be an architect or dispatcher tool?**
   **Decision: DISPATCHER.** Publishing a plan is the architect's boundary (they define and freeze intent). Materialization is the first step of turning an approved snapshot into executable orchestration state — operational dispatch behavior, not plan authoring. Clean handoff: architect ends at `publish_plan`, dispatcher begins at `orchestrate_plan` / `materialize_workstreams`.

2. **Should `approve_review` be reviewer-only or supervisor-only?**
   **Decision: REVIEWER (no separate supervisor persona).** All 4 review tools stay under one `reviewer` persona. The dispatch engine handles approval logic server-side (not via MCP) — it doesn't need persona assignment. A human overriding manually gets it through ALL-access with an ASK gate. Adding a `supervisor` persona for a single tool with no current SPN consumer is premature. If an automated supervisor SPN emerges later, splitting `approve_review` into its own persona is a one-line policy change.

3. **Do we need an `ASK` gate on `approve_review` for humans?**
   **Decision: YES.** Same irreversibility principle as `publish_plan` — once approved, the workstream's completion state is locked. Two ASK-gated tools total (`publish_plan`, `approve_review`). Consistent, symmetric, predictable. The policy CASE branch becomes: `event:context.tool.name::string IN ('publish_plan', 'approve_review')`.
