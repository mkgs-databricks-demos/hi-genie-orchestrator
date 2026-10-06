---
workstream_key: ws-final
name: Integration Validation
status: COMPLETE
depends_on: [ws-0, ws-a, ws-b, ws-c, ws-d, ws-e, ws-f, ws-g]
scheduled_task_id: f430df5455d8459593c20ab18bdad9cd
task_paused: true
attempt_count: 2
max_retries: 5
started_at: "2026-08-18T16:45:00Z"
completed_at: "2026-08-18T16:55:00Z"
error_message: null
prior_error: "Attempt 1: server.ts wiring incomplete — 4/6 modules commented. Fixed in attempt 2."
prior_error: null
last_attempt_at: "2026-08-18T16:45:00Z"
---

# Workstream ws-final: Integration Validation and Summary

## Scope

Gate on ALL workstreams. Validate:
1. Both bundles pass `databricks bundle validate`
2. `server.ts` imports and wires all modules (mcp, api, dispatch, memory, telemetry)
3. Migration module runs cleanly against a disposable Lakebase branch
4. MCP tool catalog complete per Decisions 13-17
5. Python SDK installs and type-checks (`pip install -e . && mypy`)
6. Produce orchestration summary with artifact paths, durations, merge plan

## Notes for Downstream Sessions

### Final Validation Results (9/9 PASS)

All checks passed after server.ts integration fix (attempt 2). Full report in `orchestration-summary.md`.

### Integration Fix Applied

Uncommented 4 module imports/invocations in server.ts, corrected import paths to `.js` extensions, added `shutdownDispatch()` and `shutdownMemory()` to graceful shutdown handler. Established startup order: migrations > telemetry > memory > dispatch > health > MCP > API.

### Merge Plan

- Branch: `mg-genie-hi-genie-r1-build` > `main`
- PR: "feat: Hi Genie Orchestrator Release 1 - MCP server + infra bundles"
- Deploy: hi-genie-infra FIRST, then mcp-hi-genie-orchestrator
- Reviewer: matthew.giglia@databricks.com
