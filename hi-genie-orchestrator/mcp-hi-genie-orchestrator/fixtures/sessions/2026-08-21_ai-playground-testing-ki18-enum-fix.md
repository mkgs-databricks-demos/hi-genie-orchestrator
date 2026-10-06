# Session: AI Playground Live Testing & KI-18 Enum Fix

**Date:** 2026-08-21 (early morning)  
**Branch:** `mg-genie-mcp-protocol-version`  
**Commit:** `c72f2cb`  
**Status:** Complete — deployed to dev, validated in AI Playground

---

## Context

Continued AI Playground integration testing of the MCP server (protocol version `2025-11-25`) using GLM 5.2. Discovered and fixed a systemic tool definition issue where status enum values in JSON Schema descriptions were stale/wrong, causing LLMs to produce values rejected by Postgres CHECK constraints.

---

## Testing Observations

### GLM 5.2 Behavioral Notes

1. **Open-ended prompt ("list your tools"):** Model ignored the instruction and launched an autonomous 7-step E2E test workflow (self-labeled `MCPLT-2026-08-21-01`). Called `get_project_context` → `get_workstream_context` → `search_context` → `start_session` → `get_session_context` → `record_workstream_event` → `record_task_attempt` (failed).
2. **Constrained prompt ("list names, nothing else"):** Model correctly listed all 23 tool names without executing any.
3. **Explicit parameters prompt:** Model followed instructions exactly when given precise parameter values.

**Implication:** System prompt design for agentic models with MCP tools must be explicit and constrained to prevent autonomous execution when introspection is desired.

### Identity Observed

- **AI Playground SPN:** `1081964970114387@7474657291520070` (platform relay identity)
- **App SPN:** `77145947608610@7474657291520070` (appears in `created_by` for app-initiated writes)
- **User identity:** `matthew.giglia@databricks.com` (passed through for session `user_id`)

---

## Bug Found: KI-18 — Stale Enum Values in Tool Definitions

### Symptom

GLM 5.2 called `record_task_attempt` with `"status": "running"` → Postgres rejected:
```
new row for relation "task_attempts" violates check constraint "task_attempts_status_check"
```

### Root Cause

4 tool definitions had wrong/missing enum values in their `inputSchema` descriptions:

| Tool | Field | Description Said | DB Accepts |
| --- | --- | --- | --- |
| `record_task_attempt` | `status` | `"running, succeeded, failed, timed_out"` | `'STARTED','SUCCEEDED','FAILED','RETRYABLE_FAILURE'` |
| `record_task_completion` | `final_status` | `"completed, failed, skipped"` | `'SUCCEEDED','FAILED','SKIPPED'` |
| `update_workstream_status` | `status` | `"New status value"` | 6 MCP-reachable states |
| `update_task_status` | `status` | `"New execution status"` | `'RUNNING','SUCCEEDED','FAILED','RETRYABLE_FAILURE','EXPIRED','CANCELLED'` |

Handlers pass values straight through to INSERT — no normalization, no validation.

### Fix Applied

Added proper JSON Schema `enum` arrays to all 4 tool definitions. The `enum` constraint surfaces in the `tools/list` response, guiding LLMs to produce only valid values.

---

## Validation Results

| Test | Result |
| --- | --- |
| `record_task_attempt` with `"running"` (before fix) | ❌ Constraint violation |
| `record_task_attempt` with `"STARTED"` (manual) | ✅ Created `11d46adc-...` |
| Deploy with enum fix | ✅ `01f19d1f...` SUCCEEDED |
| GLM 5.2 picks status from schema (post-fix) | ⏳ Prompt sent, awaiting response |

---

## OTel Trace Observations

- All MCP requests land as `POST /mcp` spans with `STATUS_CODE_OK` / HTTP 200
- MCP-level errors (constraint violations) are returned as tool content, NOT as HTTP errors — traces show success even when the tool operation failed
- Background `tool:dispatch_tick` and `db:SELECT semantic_memory pending` spans confirm healthy server operation
- Spans clustered at `04:50:23Z`–`04:50:26Z` for the 7-tool autonomous flow

---

## Files Modified

| File | Change |
| --- | --- |
| `server/mcp/tools/records.ts` | Added `enum` to `record_task_attempt.status` and `record_task_completion.final_status` |
| `server/mcp/tools/state.ts` | Added `enum` to `update_workstream_status.status` and `update_task_status.status` |
| `README.md` | Tool count 22 → 23 (reflects `list_projects` from prior session) |

---

## Decisions

1. **Enum in JSON Schema (not just description text):** Use `enum: [...]` property so LLMs with schema-aware tool calling automatically constrain output.
2. **Supervisor-only states excluded from MCP enum:** `update_workstream_status` enum excludes `COMPLETE` and `CANCELLED` per Decision 21 (review-gated completion).
3. **No handler-level normalization:** Decided against adding lowercase→uppercase mapping in handlers — better to fix at the schema level so all callers get correct guidance.

---

## Next Steps

1. Confirm GLM 5.2 respects the enum in the redeployed version (prompt already sent)
2. Merge `mg-genie-mcp-protocol-version` → `main` (now 4 commits: protocol version, list_projects, design doc, KI-18 enum fix)
3. Consider adding handler-level validation that returns a clear MCP error message (defense in depth) rather than letting Postgres constraint errors bubble up raw

---

## Post-Test Review Findings

### end_session Double-Call Bug (KI-19)

**Observed:** `end_session` accepted a second call on an already-ENDED session, incrementing version `2 → 3` and re-stamping `ended_at`. GLM 5.2 called `end_session` first (v1→v2), then our explicit test prompt called it again (v2→v3).

**Root cause:** `optimisticUpdate` helper checks only `WHERE version = $expected` — it never verifies `status != 'ENDED'` before applying the update. As long as the caller passes the correct current version, the UPDATE succeeds regardless of terminal state.

**Recommended fix:** Add a pre-flight status guard in `endSession` handler: if session is already `ENDED`, return `{ updated: false, session_id, status: 'ENDED', ended_at: <existing> }` — idempotent no-op, consistent with the write-once pattern used by `record_task_attempt` and `record_task_completion`.

**File:** `server/mcp/tools/state.ts`, lines 404–435.

### mcp-catalog.test.ts Stale Assertion

**File:** `server/api/routes/mcp-catalog.test.ts`, lines 141 and 147  
**Problem:** Test still asserts `expect(body.count).toBe(22)` — should be `23` after `list_projects` was added.  
**Impact:** Vitest will fail on this branch.

### Lakebase Connection Details (discovered during session)

- **Host:** `ep-blue-block-d204ny6i.database.us-east-1.cloud.databricks.com`
- **Pooled host:** `ep-blue-block-d204ny6i-pooler.database.us-east-1.cloud.databricks.com`
- **Database:** `databricks_postgres` (underscore, not hyphen)
- **Endpoint ID:** `primary`
- **Status:** ACTIVE, last active 2026-08-21T05:28:58Z
- **CLI discovery:** `databricks postgres list-endpoints projects/hi-genie-orchestrator/branches/development`

---

## Updated Next Steps

1. ~~Confirm GLM 5.2 respects the enum in the redeployed version~~ — ✅ CONFIRMED (selected `STARTED` correctly)
2. **Fix `mcp-catalog.test.ts`:** Update assertion on lines 141/147 from 22 → 23
3. **Fix KI-19 (`end_session` idempotency):** Add status guard in `endSession` handler
4. **Run full test suite:** `npm test` (Vitest + Playwright smoke) — expected to fail on mcp-catalog assertion until fixed
5. Merge `mg-genie-mcp-protocol-version` → `main` (now 5 commits + pending fixes)
6. Consider adding handler-level validation for `record_task_attempt` and `record_task_completion` that returns a clear MCP error message (defense in depth) rather than letting Postgres constraint errors bubble up raw
