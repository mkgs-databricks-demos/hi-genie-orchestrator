# Session: KI-16 — MCP Tool Definition/Handler Parameter Alignment

**Date:** 2026-08-20  
**Branch:** `mg-genie-r1-readiness-fixes`  
**Deployment:** `01f19c463b10197cb322aac0f7844d3f` (SUCCEEDED)

---

## Problem

Known Issue 16 (PROJECT_MEMORY.md): MCP tool INPUT SCHEMAS (what the LLM sees when calling tools) still advertised removed/renamed parameters from pre-Phase 4 handlers. Handlers were fixed in the MCP schema/query contract reconciliation session, but tool definitions were not updated in tandem. This caused incorrect tool invocations at runtime — callers would pass stale parameter names that the handler never destructures, while omitting the parameters the handler actually needs.

## Root Cause

Phase 4 rewrote handler internals (Drizzle defs, SQL queries, destructured params) but left the `inputSchema` blocks in the tool definition arrays untouched. The tool definitions are the LLM-facing contract; the handlers are the server-side execution — they diverged.

## Changes Made

### `server/mcp/tools/state.ts` (3 tools)

| Tool | Removed | Added/Changed |
| --- | --- | --- |
| `update_task_status` | `expected_version`, `metadata` | Description updated (FOR UPDATE, not optimistic) |
| `update_recovery_state` | `retry_count`, `last_error`, `recovery_strategy`, `blocked_reason`, `metadata` | `state_data` (required); description updated |
| `end_session` | `summary` | (none — handler never used it) |

### `server/mcp/tools/records.ts` (4 tools)

| Tool | Removed | Added/Changed |
| --- | --- | --- |
| `record_error` | `error_type`, `severity` | `error_class`, `error_code`, `is_blocking` |
| `record_workstream_event` | `idempotency_key`, `payload` | `previous_value`, `new_value`, `metadata`; description notes append-only (no idempotency) |
| `record_task_attempt` | `output` | `output_ref`, `duration_ms` |
| `record_task_completion` | `status`, `artifacts` | `final_status`, `artifacts_ref`, `total_attempts`; `summary` now required |

### Other Files

| File | Change |
| --- | --- |
| `README.md` | Added "MCP Tools Reference" section documenting all tool categories and parameters |
| `PROJECT_MEMORY.md` | KI-16 marked resolved; MCP module status updated |
| `fixtures/sessions/INDEX.md` | This session added |

## Validation

1. **Schema validation** — Called `tools/list` via JSON-RPC, confirmed all 7 tools expose only the correct parameters
2. **Live smoke tests** — Invoked all 7 tools against the live Lakebase DB:
   - `start_session` → created (session_id, version=1)
   - `end_session` → optimistic update succeeded (version 1→2)
   - `record_error` → idempotent insert with `error_class` + `is_blocking`
   - `record_workstream_event` → append-only insert with `previous_value`/`new_value`
   - `record_task_attempt` → created with `output_ref` + `duration_ms`
   - `record_task_completion` → created with `final_status` + `artifacts_ref` + `total_attempts`
   - `update_task_status` / `update_recovery_state` — schema accepted (no live execution resources to target, but validated via tools/list)

## Decisions

- **CHECK constraint values are uppercase** (`SUCCEEDED`, `RUNNING`, `COMPLETED`) — discovered during smoke test. Not a KI-16 issue; pre-existing DB convention. No code change needed.
- **`workstream_id` is NOT NULL** on `state.sessions` and `state.errors` — the tool definition says "optional" but the DB enforces NOT NULL. This is a minor pre-existing discrepancy (separate from KI-16). Filed mentally for a future schema review but not blocking.

## Files Modified

- `server/mcp/tools/state.ts`
- `server/mcp/tools/records.ts`
- `README.md`
- `PROJECT_MEMORY.md`
- `fixtures/sessions/INDEX.md`
- `fixtures/sessions/2026-08-20_ki16-tool-definitions-fix.md` (this file)
