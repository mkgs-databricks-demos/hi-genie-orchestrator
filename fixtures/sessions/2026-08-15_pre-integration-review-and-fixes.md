# Session: Pre-Integration Review & Fixes

**Date:** 2026-08-15  
**Orchestration:** N/A (pre-integration prep)  
**Context:** Full project review + readiness checklist before first end-to-end integration test

---

## Problem

All skill modules (11 files, ~4,529 lines) and self-build orchestration are complete. Before running an integration test against a real architecture doc, needed to identify and resolve any gaps that could cause runtime failures.

## What Was Done

### 1. Full Project Review

Reviewed: PROJECT_MEMORY.md, README.md, SKILL.md, INTEGRATION_REPORT.md, SUMMARY.md, canary-results.md, scheduling-contract.md, ws-init-template.md, worker-prompt-template.md, prompt-synthesis.md, status-file-template.md, plan-schema.md.

Identified 4 critical items, 4 significant items, and 2 minor housekeeping items.

### 2. Item 1: Delete Stale Self-Build Tasks

**Finding:** 7 paused scheduled tasks from the self-build remained in the workspace (titled "Genie Orchestrator ws-*").

**Resolution:** Confirmed all 7 were already deleted (earlier manual run). Workspace has 0 scheduled tasks.

**Bonus discovery:** Task objects use `name` field (not `id`) — format `genie_code/users/{uid}/scheduled_insights/{uuid}`. The ID must be extracted via `name.split("/")[-1]`. The ws-init-template's API examples already use the correct format.

### 3. Item 2: Spot-Check prompt-synthesis.md File-Race Fix

**Finding:** PASS — All 3 state transitions emit single-field `editAsset` patches:

| Transition | Location (line) | Fix |
| --- | --- | --- |
| Claim (NOT_STARTED→IN_PROGRESS) | 322-348 | ⚠️ CRITICAL callout with JSON patch example |
| Validating (IN_PROGRESS→VALIDATING) | 516-519 | Explicit "single-field patch only" note |
| Complete (VALIDATING→COMPLETE) | 563-571 | Fallback: re-read actual status on race, retry |

Additionally, constraint #8 is emitted into every synthesized prompt's CONSTRAINTS section.

### 4. Item 3: Add automationId Parsing to ws-init-template

**Problem:** Step 4 said "Set `scheduled_task_id`" but gave no guidance on WHERE to get the value.

**Fix:** Added explicit extraction note after Step 4:
- Parse `automationId` query parameter from `scheduleAgentTool` response URL
- Fallback: list tasks via alerts-internal API, match by title

### 5. Item 4: Clarify Status-File Initialization Ownership

**Problem:** No explicit step for creating the worker's status file before the scheduled task. Without it, the worker's gate check would fail on first fire (no file to read).

**Fix:** Added new Step 3 ("Initialize status file / row") to CREATE_NEXT action:
- **File mode:** Create from `templates/status-file-template.md` at deterministic path
- **Lakebase mode:** INSERT row with NOT_STARTED status
- Explicitly states: "MUST exist before the scheduled task is created"

Steps renumbered: 1 (Gather) → 2 (Synthesize) → 3 (Init State) → 4 (Create Task) → 5 (Record ID)

## Key Decisions

- Integration test should use **file mode** first (zero infra). Lakebase is an upgrade path.
- **One-shot decomposition** recommended for the test (interactive can come later).
- The 7 remaining open design decisions (interactive decomp, Lakebase project scope, max workstreams cap, multi-modal input, cost attribution, MCP memory, programmatic sessions) are all deferrable — none block the integration test.

## Files Modified

| File | Action |
| --- | --- |
| `templates/ws-init-template.md` | Added Step 3 (status file init) + automationId extraction note in Step 4. Steps renumbered 1-5. |

## Open Items (Not Blocking)

- **Prompt size limit:** Unknown char limit on `scheduleAgentTool.instructions`. Self-build fit, but larger projects may hit it. Strategy B (context-by-reference) mitigates.
- **"Run Now" latency:** Integration test will require 3-4 manual "Run now" clicks for responsive execution.
- **Git commit:** Template change is uncommitted. Should push before integration test.

## Outcome

All 4 pre-integration items resolved. Workspace is clean (0 scheduled tasks). ws-init-template now has the correct 5-step CREATE_NEXT flow with no ambiguity on state initialization or ID extraction. Ready for integration test against a real architecture doc.
