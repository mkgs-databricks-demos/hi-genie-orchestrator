# Session: R1 MCP Findings — KI-19, KI-20, Defense-in-Depth Validation

**Date:** 2026-08-21  
**Branch:** `mg-genie-r1-mcp-findings`  
**Status:** Complete — deployed to dev, validated live

---

## Context

Addressed the open findings from the R1 MCP AI Playground testing session (2026-08-21 early morning). Three categories of work: test assertion fixes, idempotency guard, and handler-level enum validation.

---

## Changes Made

### 1. KI-20 Fix: `mcp-catalog.test.ts` Stale Assertions

**File:** `server/api/routes/mcp-catalog.test.ts`

- Line 121: `protocol_version` assertion `'2025-03-26'` → `'2025-11-25'`
- Line 141: Test description `'reports 22 tools total'` → `'reports 23 tools total'`
- Line 147: Count assertion `toBe(22)` → `toBe(23)`

**Also found:** `server/api/routes/mcp-catalog.ts` line 54 had a hardcoded `'2025-03-26'` that was missed during the protocol version bump (only the MCP transport was updated). Fixed to `'2025-11-25'`.

### 2. KI-19 Fix: `end_session` Idempotency Guard

**File:** `server/mcp/tools/state.ts`

Added pre-flight status check before `optimisticUpdate`:
1. SELECT current session status/version/ended_at
2. If `status === 'ENDED'`, return `{ updated: false, already_ended: true, session_id, status, ended_at, version }` — idempotent no-op
3. If not found, throw clear error
4. Otherwise proceed with the original optimistic update flow

Consistent with the write-once pattern used by `record_task_attempt` and `record_task_completion`.

### 3. Handler-Level Enum Validation (Defense in Depth)

**Files:** `server/mcp/tools/records.ts`, `server/mcp/tools/state.ts`

Added `validateEnum()` helper and validation calls in 4 handlers:

| Handler | Field | Valid Values |
| --- | --- | --- |
| `record_task_attempt` | `status` | `STARTED, SUCCEEDED, FAILED, RETRYABLE_FAILURE` |
| `record_task_completion` | `final_status` | `SUCCEEDED, FAILED, SKIPPED` |
| `update_workstream_status` | `status` | `NOT_STARTED, IN_PROGRESS, VALIDATING, READY_FOR_REVIEW, RETRYING, BLOCKED` |
| `update_task_status` | `status` | `RUNNING, SUCCEEDED, FAILED, RETRYABLE_FAILURE, EXPIRED, CANCELLED` |

Invalid values now return a clear MCP error content response (`isError: true`) with the message:
```
Invalid <field> "<value>" for <tool>: must be one of <valid_values>
```

This prevents raw Postgres CHECK constraint errors from bubbling up to LLM callers.

---

## Live Validation Results

| Test | Result |
| --- | --- |
| Deploy 1 (KI-19 + validation) | ✅ `01f19d28` SUCCEEDED |
| `end_session` on already-ENDED session | ✅ Returns `{ updated: false, already_ended: true }`, version unchanged (3) |
| `record_task_attempt` with `status: "running"` | ✅ `isError: true`, message: `Invalid status "running"...` |
| `record_task_completion` with `final_status: "completed"` | ✅ `isError: true`, message: `Invalid final_status "completed"...` |
| Deploy 2 (protocol version fix) | ✅ `01f19d29` SUCCEEDED |
| MCP catalog `protocol_version` | ✅ `2025-11-25` |
| MCP catalog `count` | ✅ `23` |
| Lakebase session version stability | ✅ Version 3 unchanged after idempotent `end_session` call |

---

## Files Modified

| File | Change |
| --- | --- |
| `server/api/routes/mcp-catalog.test.ts` | Tool count 22→23, protocol version assertion, test description |
| `server/api/routes/mcp-catalog.ts` | Hardcoded protocol_version `2025-03-26` → `2025-11-25` |
| `server/mcp/tools/state.ts` | KI-19 idempotency guard in `endSession`; `validateEnum()` + calls in `updateWorkstreamStatus`, `updateTaskStatus` |
| `server/mcp/tools/records.ts` | `validateEnum()` + calls in `recordTaskAttempt`, `recordTaskCompletion` |

---

## Known Issues Closed

- **KI-19:** `end_session` accepts repeated calls on ENDED sessions → RESOLVED
- **KI-20:** `mcp-catalog.test.ts` asserts 22 tools (should be 23) → RESOLVED
- **Protocol version in catalog route:** mcp-catalog.ts hardcoded `2025-03-26` → RESOLVED

---

## Decisions

1. **Validation throws Error (not return value):** Invalid enum values throw from the handler; the MCP transport catches and returns `isError: true` content. This is consistent with the existing error pattern and ensures LLM callers see a tool-level error, not an HTTP error.
2. **Enum constants co-located with handlers:** `VALID_*` arrays live in the same file as the handlers rather than a shared module — keeps the single-source-of-truth close to the tool definitions that declare the same enums.
3. **`end_session` returns success-shaped response for already-ended:** `isError: false` with `already_ended: true` — matches the idempotent insert pattern where a duplicate is a no-op success, not an error.
