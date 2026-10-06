# Session: MLflow 3 Trace Lifecycle & OBO Remediation Plan

**Date:** 2026-08-26  
**Branch:** `mg-genie-r2-mcp-consolidation`  
**Duration:** ~45 min  

---

## Problem Statement

The MLflow experiment (`[dev matthew_giglia] hi_genie_orchestr…`) showed 133
traces that were all identical and useless:
- State: "In progress" (never completed)
- Request: null, Response: null
- User: `84b365…` (App SPN UUID, not end user)
- Trace name: random UUIDs (not descriptive)

---

## Root Causes Identified

### 1. Incomplete trace lifecycle (`mlflow-tracer.ts:400–446`)

`exportTraceToMlflow` only calls `POST /api/2.0/mlflow/traces` to create the
trace. Never calls PATCH to end it. MLflow leaves it as "In progress" forever.
No request/response content sent. `execution_time_ms` hardcoded to 0.

### 2. Wrong API version

Current code uses `/api/2.0/mlflow/traces`. The correct MLflow 3 Traces API is
`/api/3.0/mlflow/traces` — different payload structure, uses `trace_id` (not
`request_id`) in URL paths.

### 3. SPN identity instead of user (`mlflow-tracer.ts:535–545`)

`getAuthHeadersAsync()` authenticates with `HI_GENIE_APP_CLIENT_ID` /
`HI_GENIE_APP_CLIENT_SECRET` (App SPN). MLflow records the authenticating
principal as the trace owner. User identity extracted from `x-forwarded-user`
but stored only as custom tag `hi_genie.user_identity` — not the standard
`mlflow.user` tag that the UI displays.

---

## Research Findings

### Q1: OBO token availability

**YES** — `x-forwarded-access-token` IS forwarded by the Databricks Apps auth
sidecar (Public Preview "user authorization" mode). App can read it per-request
and use it directly as a Bearer token for any Databricks API. No token exchange
needed.

Ref: https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth

### Q2: Correct API endpoints (MLflow 3)

| Operation | Method | Endpoint |
| --- | --- | --- |
| Start trace | POST | `/api/3.0/mlflow/traces` |
| End trace | PATCH | `/api/3.0/mlflow/traces/{trace_id}` |
| Set tag | PATCH | `/api/3.0/mlflow/traces/{trace_id}/tags` |

End trace uses `update_mask` with fields: `trace_info.state`,
`trace_info.execution_duration`, `trace_info.request_preview`,
`trace_info.response_preview`.

Ref: https://docs.databricks.com/api/workspace/mlflowexperimenttrace/endtracev3

### Q3: Trace hierarchy for MCP servers

MCP community consensus (Python SDK, maintainer meetings): full hierarchy with
request-scoped root span + child tool spans. OTel is canonical (UC tables);
MLflow is curated index (root + tool spans, not every DB query).

Ref: https://github.com/modelcontextprotocol/python-sdk/blob/main/docs/run/opentelemetry.md

### Q4: Stale trace cleanup

No batch "mark as ERROR" API. Only option: `MlflowClient.delete_traces()`.
Search by `trace.status = 'IN_PROGRESS'`, then delete by IDs.

Ref: https://mlflow.org/docs/latest/genai/tracing/observe-with-traces/delete-traces/

### Q5: Trace naming

Best practice: `mlflow.traceName` = operation type (`tool:get_project_context`).
Details in tags (`hi_genie.workstream_key`, `hi_genie.session_id`, `mcp.method`).
Keep names short for UI column scanning.

Ref: https://mlflow.org/docs/latest/genai/tracing/observe-with-traces/ui

---

## Deliverables

| File | Action |
| --- | --- |
| `docs/design/2026-08-26_mlflow-trace-lifecycle-and-obo-remediation.md` | Created — full remediation plan, all 5 questions resolved |
| `docs/design/INDEX.md` | Updated — new entry (status: Accepted) |

---

## Implementation Plan Summary

| Phase | Scope | Effort |
| --- | --- | --- |
| P1 — Trace lifecycle | Fix API version (2.0→3.0), two-phase export (POST+PATCH), request/response previews, span start tracking | ~1.5 hrs |
| P2 — OBO attribution | Extract `x-forwarded-access-token`, use as auth for MLflow calls, fallback to SPN for system traces, add `mlflow.user` tag | ~45 min |
| P3 — Naming & correlation | `tool:<name>` naming convention, structured tag schema, verify OTel correlation | ~35 min |
| P4 — Cleanup | Delete 133 stale IN_PROGRESS traces (notebook script), grant experiment CAN_READ | ~20 min |
| **Total** | | **~3.5 hrs** |

---

## Decisions Made

1. **True OBO preferred over tag-only** — `x-forwarded-access-token` is available;
   authenticate MLflow API as the user, not SPN. SPN remains fallback for system traces.
2. **API v3** — fix immediately (current v2 calls likely being silently rejected or
   creating malformed traces).
3. **Root + tool spans to MLflow** — OTel captures full tree; MLflow is curated.
4. **Delete stale traces** — no way to mark as ERROR after the fact.
5. **Short trace names + tags** — `tool:<name>` pattern, workstream/session in tags.

---

## Files Modified This Session

- `docs/design/2026-08-26_mlflow-trace-lifecycle-and-obo-remediation.md` (new)
- `docs/design/INDEX.md` (updated)
- `fixtures/sessions/2026-08-26_mlflow-trace-lifecycle-obo-remediation.md` (this file)
- `fixtures/sessions/INDEX.md` (updated)
- `PROJECT_MEMORY.md` (updated — next steps)
