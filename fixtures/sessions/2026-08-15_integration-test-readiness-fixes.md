# Session: Integration Test Readiness Fixes

**Date:** 2026-08-15
**User:** matthew.giglia@databricks.com
**Workspace:** fevm-hls-fde

---

## Problem

The skill was architecturally complete (11 modules, 6/6 cross-reference checks PASS)
but had 4 gaps that would break a live default-file-mode integration test:

1. **Status file format drift** — Template used empty strings for nullable fields;
   `editAsset` CAS patches in status-protocol referenced `null`. Mismatch = silent claim failures.
2. **Orchestration-status file location** — Template documented `state/` but self-build
   prototype put it at orchestration root. Inconsistency for WS-INIT state reconstruction.
3. **Bootstrapping gap** — No single document defined the plan.json → running-WS-INIT
   provisioning sequence. Scattered across modules.
4. **WS-INIT self-discovery** — Can't see own automationId from within a run.
   No documented workaround for SELF_COMPLETE self-pause.

---

## Root Causes

- Self-build was semi-manual (human acted as WS-INIT), so template instantiation
  was never tested end-to-end
- Status files were hand-created with minimal format (diverged from rich template)
- No explicit provisioning step existed — assumed tacit knowledge

---

## Changes Made

### templates/status-file-template.md
- Changed all nullable fields from empty to explicit `null`: `scheduled_task_id`,
  `started_at`, `completed_at`, `error_message`, `error_category`
- Added missing fields: `task_paused: false`, `prior_error: null`
- Rewrote "YAML Frontmatter Rules" section with null convention rule
- Rewrote "State Transitions" section with full multi-patch CAS examples

### templates/ws-init-template.md
- Step 3 (Initialize status file): Added complete field list with null convention warning
- Step 5 (Record task ID): Updated patch from empty to `scheduled_task_id: null`
- ACTION: SELF_COMPLETE: Added full self-discovery protocol (title-match API pattern,
  alternative via orchestration-status.md `ws_init_task_id`, graceful fallback)

### templates/orchestration-status-template.md
- Changed `completed_at:` → `completed_at: null`
- Changed `ws_init_task_id:` → `ws_init_task_id: null`

### templates/provisioning-protocol.md (NEW)
- Complete 6-step bootstrap: create state dir → instantiate orchestration-status →
  transition PROVISIONED → synthesize WS-INIT prompt → schedule WS-INIT → activate
- Includes state reconstruction block template for WS-INIT
- Includes conditional block resolution rules
- Includes provisioning checklist
- Documents canonical file location (`state/orchestration-status.md`)
- Covers Lakebase alternative

### skill/tracking/status-protocol.md
- Updated Atomic Claim: multi-patch with `started_at` + `attempt_count`
- Updated Retry Claim: read-then-patch pattern with current value lookup
- Updated COMPLETE transition: includes `completed_at` patch
- Updated BLOCKED transition: includes `error_category` patch
- Added null convention warning

### skill/SKILL.md
- Rewrote Quick Start from 5 vague steps to 5 precise steps referencing
  provisioning-protocol.md, plan-schema.md, and the monitor workflow

### PROJECT_MEMORY.md
- Updated directory tree to include provisioning-protocol.md (7 template files)

---

## Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | All nullable YAML fields use explicit `null` | `editAsset` CAS patches need exact string match. Empty vs null breaks atomicity. |
| 2 | orchestration-status.md lives in `state/` (not root) | Consistent with WS-INIT reading all state from one directory. Self-build was an exception. |
| 3 | Provisioning is a separate template (not inline in SKILL.md) | Too complex for Quick Start. Needs its own step-by-step with code examples. |
| 4 | WS-INIT self-pause uses `ws_init_task_id` from orchestration-status + title-match fallback | Primary path avoids API list call. Fallback handles cases where ID wasn't recorded. |

---

## Files Modified

- `templates/status-file-template.md`
- `templates/ws-init-template.md`
- `templates/orchestration-status-template.md`
- `templates/provisioning-protocol.md` (NEW)
- `skill/tracking/status-protocol.md`
- `skill/SKILL.md`
- `PROJECT_MEMORY.md`
- `fixtures/sessions/INDEX.md` (pending)
- `fixtures/sessions/2026-08-15_integration-test-readiness-fixes.md` (this file)

---

## Status

All 4 gaps resolved. Skill is now at 100% readiness for default file-mode integration test.
Next step: Run a fresh orchestration on a simple 2-3 workstream project to validate end-to-end.
