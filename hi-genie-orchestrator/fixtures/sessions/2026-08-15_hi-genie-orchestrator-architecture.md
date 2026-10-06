# Session Summary — Hi Genie Orchestrator Architecture

**Date:** 2026-08-15
**Status:** Architecture baseline accepted

## Summary

The planned standalone `GenieState MCP` was reconciled into one production
Databricks App: `mcp-hi-genie-orchestrator`. The App contains a supervisor
API/typed Python SDK and a worker-facing `/mcp` endpoint. Both surfaces use one
Lakebase project while retaining separate `dispatch` and `state` schemas,
authorization policies, migration namespaces, and ownership boundaries.

## Decisions Captured

- WS-INIT remains the centralized, stateless supervisor control plane.
- Lakebase `LISTEN/NOTIFY` events wake the Dispatcher for low-latency ticks;
  scheduled ticks remain the recovery path.
- Workers transition to `READY_FOR_REVIEW`; only the supervisor/reviewer may
  mark a workstream `COMPLETE` after independent validation.
- The React frontend is a read-only operations surface that renders the DAG,
  completion state, summaries, session details, blockers, and review history.
- OpenTelemetry and MLflow 3 tracing are required, with Unity Catalog-backed
  trace storage and DAB-configured `90`-day default retention.
- Lakebase short-term, episodic, and semantic memory is required, including
  in-project developer semantic search in Release 1 and cross-project memory
  in Release 1.1.
- Databricks AppKit methods are the required migration boundary for Lakebase
  schema changes.

## Follow-Up Work

1. Define Supervisor API and Python SDK contracts.
2. Define MCP input/output schemas, pagination, and idempotency behavior.
3. Design `dispatch` and `state` logical schemas and AppKit migrations.
4. Resolve the Lakebase RLS identity bridge.
5. Define the review checklist and evidence required for completion.
6. Define DAB variables, cleanup jobs, and production runbooks.

## Related Artifacts

- `../README.md`
- `../PROJECT_MEMORY.md`
- `../OPEN_QUESTIONS.md`
- `../architecture/requirements.md`
- `../architecture/decisions.md`
