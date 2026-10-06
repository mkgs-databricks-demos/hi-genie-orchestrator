# MLflow 3 Trace Lifecycle & OBO Identity — Remediation Plan

**Date:** 2026-08-26  
**Status:** Accepted — all questions researched and resolved (2026-08-26)  
**Scope:** `server/telemetry/mlflow-tracer.ts`  
**Relates to:** `docs/design/2026-08-25_transport-2025-11-25-compliance-plan.md` (shared telemetry infra)  
**Experiment:** `[dev matthew_giglia] hi_genie_orchestr…` (MLFLOW_EXPERIMENT_ID injected via `app.yaml`)

---

## Executive Summary

The MLflow 3 trace integration has two critical defects visible in the experiment
UI (133 traces, all identical):

| # | Issue | Symptom in UI | Root Cause |
| --- | --- | --- | --- |
| 1 | **Traces never completed** | State = "In progress", Request = null, Response = null, Execution time blank | `exportTraceToMlflow` only calls `POST /api/2.0/mlflow/traces` (creates trace). Never calls `PATCH` to end it with status + data. |
| 2 | **SPN identity instead of end user** | User column = `84b365…` (App SPN UUID) for every trace | Auth to MLflow API uses App SPN credentials (`HI_GENIE_APP_CLIENT_ID`). User identity extracted from `x-forwarded-user` but stored as custom tag `hi_genie.user_identity` — MLflow UI shows authenticating principal, not custom tags. |

Both issues make the experiment useless for debugging: you can't tell who did
what, traces carry no payload, and the "In progress" state prevents cleanup.

---

## Current Architecture (What Exists)

```
┌────────────────────────────────────────────────────────────────┐
│  createTracingMiddleware()          [mlflow-tracer.ts:205]     │
│                                                                │
│  1. Extract requestId, userIdentity from headers               │
│  2. Start OTel span (SpanKind.SERVER)                          │
│  3. On response finish:                                        │
│     a. Set http.status_code on span                            │
│     b. span.end()                                              │
│     c. exportTraceToMlflow(span, requestId, userIdentity)      │
│        └─ POST /api/2.0/mlflow/traces  {                       │
│             experiment_id, request_id, timestamp_ms,            │
│             execution_time_ms: 0,  ← HARDCODED                 │
│             tags: [mlflow.traceName, mlflow.source.type,        │
│                    otel.trace_id, otel.span_id,                 │
│                    hi_genie.user_identity]                      │
│           }                                                    │
│        └─ NEVER calls PATCH to end trace                       │
│        └─ NEVER sends request/response content                 │
└────────────────────────────────────────────────────────────────┘

Auth path (getAuthHeadersAsync, line 535):
  1. Check DATABRICKS_TOKEN env var → use if set
  2. Else: getSpnToken() → client_credentials grant with
     HI_GENIE_APP_CLIENT_ID / HI_GENIE_APP_CLIENT_SECRET
  → All MLflow API calls authenticate as the App SPN
  → MLflow records authenticating principal as trace owner
```

---

## Fix Plan

### Phase 1 — Complete Trace Lifecycle (Critical)

**Goal:** Traces show request/response content, correct execution time, and
terminal status (OK/ERROR) instead of perpetual "In progress".

#### 1.1 Implement two-phase trace export

The MLflow 3 Traces REST API requires a lifecycle:

| Step | Method | Purpose | Current | Fix |
| --- | --- | --- | --- | --- |
| Start | `POST /api/2.0/mlflow/traces` | Creates trace in "In progress" | ✅ Done | Keep |
| End | `PATCH /api/2.0/mlflow/traces/{request_id}` | Sets status, execution_time, request/response | ❌ Missing | **Add** |

**Proposed implementation:**

```typescript
interface TraceStartPayload {
  experiment_id: string;
  timestamp_ms: number;
  request_id: string;
  tags: Array<{ key: string; value: string }>;
}

interface TraceEndPayload {
  request_id: string;
  timestamp_ms: number;           // end time
  status: 'OK' | 'ERROR';
  request_metadata: Array<{ key: string; value: string }>;
  // Note: MLflow 3 trace model uses these fields
  // for the Request/Response columns:
  tags: Array<{ key: string; value: string }>;
}
```

**Refactored `exportTraceToMlflow`:**

```typescript
async function exportTraceToMlflow(
  span: Span,
  requestId: string,
  userIdentity: string,
  requestSummary: string,   // NEW: sanitized request info
  responseSummary: string,  // NEW: sanitized response info
  startTimeMs: number,      // NEW: from span start
  endTimeMs: number,        // NEW: from span end (Date.now())
  statusOk: boolean,        // NEW: derived from HTTP status
): Promise<void> {
  try {
    const spanContext = span.spanContext?.();
    if (!spanContext?.traceId) return;

    // ── Step 1: Start trace ──────────────────────────────────────────────
    const startPayload: TraceStartPayload = {
      experiment_id: experimentId!,
      timestamp_ms: startTimeMs,
      request_id: requestId,
      tags: [
        { key: 'mlflow.traceName', value: requestSummary.slice(0, 200) },
        { key: 'mlflow.source.type', value: 'APP' },
        { key: 'mlflow.user', value: userIdentity },  // ← FIX #2
        { key: 'otel.trace_id', value: spanContext.traceId },
        { key: 'otel.span_id', value: spanContext.spanId },
        { key: 'hi_genie.user_identity', value: userIdentity },
        { key: 'hi_genie.service', value: 'mcp-hi-genie-orchestrator' },
      ],
    };

    await mlflowApiCall('/api/2.0/mlflow/traces', 'POST', startPayload);

    // ── Step 2: End trace ────────────────────────────────────────────────
    const endPayload: TraceEndPayload = {
      request_id: requestId,
      timestamp_ms: endTimeMs,
      status: statusOk ? 'OK' : 'ERROR',
      request_metadata: [
        { key: 'request_summary', value: requestSummary.slice(0, 2000) },
        { key: 'response_summary', value: responseSummary.slice(0, 2000) },
        { key: 'execution_time_ms', value: String(endTimeMs - startTimeMs) },
      ],
      tags: [
        { key: 'mlflow.traceName', value: requestSummary.slice(0, 200) },
      ],
    };

    await mlflowApiCall(
      `/api/2.0/mlflow/traces/${requestId}`,
      'PATCH',
      endPayload,
    );
  } catch (err) {
    console.warn('[mlflow-tracer] Trace export failed:', err instanceof Error ? err.message : err);
  }
}
```

#### 1.2 Capture request/response summaries

The middleware must capture meaningful content without logging sensitive data.

**For MCP requests (`/mcp/*`):**
- Request summary: JSON-RPC method name + tool name (e.g., `tools/call: get_project_context`)
- Response summary: result type + truncated content or error code

**For API requests (`/api/v1/*`):**
- Request summary: `METHOD /path` (e.g., `POST /api/v1/plans`)
- Response summary: HTTP status + content-length

**Implementation in middleware (response finish handler):**

```typescript
res.on('finish', () => {
  span.setAttribute('http.status_code', res.statusCode);
  const statusOk = res.statusCode < 400;

  // Sanitized summaries (NEVER log full bodies — secrets, PII)
  const requestSummary = buildRequestSummary(req);
  const responseSummary = buildResponseSummary(res, statusOk);

  span.setStatus({
    code: statusOk ? SpanStatusCode.OK : SpanStatusCode.ERROR,
    message: statusOk ? undefined : `HTTP ${res.statusCode}`,
  });
  span.end();

  if (experimentId) {
    exportTraceToMlflow(
      span, requestId, userIdentity,
      requestSummary, responseSummary,
      spanStartTimeMs, Date.now(), statusOk,
    );
  }
});
```

**Summary builders (sanitized — no raw bodies):**

```typescript
function buildRequestSummary(req: Request): string {
  const base = `${req.method} ${req.path}`;

  // For MCP: extract JSON-RPC method + tool name
  if (req.path.startsWith('/mcp') && req.body) {
    const body = Array.isArray(req.body) ? req.body[0] : req.body;
    const method = body?.method ?? 'unknown';
    const toolName = body?.params?.name ?? '';
    return toolName ? `${method}: ${toolName}` : method;
  }

  return base;
}

function buildResponseSummary(res: Response, statusOk: boolean): string {
  const status = `${res.statusCode} ${res.statusMessage ?? ''}`;
  if (!statusOk) {
    return `ERROR ${status}`;
  }
  return `OK ${status}`;
}
```

#### 1.3 Track span start time

Currently the middleware doesn't capture the span start time for later use.
Add it to the request context:

```typescript
const spanStartTimeMs = Date.now();
(req as RequestWithTrace).__traceStartTimeMs = spanStartTimeMs;
```

Extend `RequestWithTrace`:
```typescript
export interface RequestWithTrace extends Request {
  __traceSpan?: Span;
  __traceRequestId?: string;
  __traceUserIdentity?: string;
  __traceStartTimeMs?: number;  // NEW
}
```

---

### Phase 2 — OBO User Attribution (High)

**Goal:** The "User" column and "Principal" column in the experiment UI show the
actual end user (e.g., `matthew.giglia@databricks.com`), not the App SPN.

#### 2.1 True OBO via `x-forwarded-access-token` (RECOMMENDED — full fix)

**Research confirmed:** The Databricks Apps auth sidecar DOES forward the user's
access token as `x-forwarded-access-token` on every request (Public Preview,
"user authorization" mode).

Ref: [Configure authorization in a Databricks app](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth)

**Implementation:**

```typescript
// In createTracingMiddleware() — extract user token alongside identity
const userToken = req.headers['x-forwarded-access-token'] as string | undefined;
(req as RequestWithTrace).__traceUserToken = userToken;

// In exportTraceToMlflow() — use user token for MLflow API calls
async function getAuthHeadersForTrace(
  userToken?: string,
): Promise<Record<string, string>> {
  // Prefer user's forwarded token (true OBO) — per-request, never cache
  if (userToken) {
    return { Authorization: `Bearer ${userToken}` };
  }
  // Fallback: SPN for background/system traces (no user context)
  return getAuthHeadersAsync();
}
```

**Effects:**
- User column: shows end user (via authenticating principal)
- Principal column: shows end user (same — they ARE the principal)
- The user must have at least `CAN_READ` on the experiment (or grant via
  workspace group)

**Caveats:**
- Token is per-request and short-lived — MUST NOT be cached
- Background operations (dispatch ticks, scheduled cleanup) have no user
  context → fall back to SPN
- If `x-forwarded-access-token` is absent (e.g., internal health checks),
  fall through to SPN

#### 2.2 Redundant `mlflow.user` tag (belt-and-suspenders)

Always set `mlflow.user` tag regardless of auth method:

```typescript
tags: [
  { key: 'mlflow.user', value: userIdentity },  // Always set
  // ...
]
```

This ensures the User column is correct even if:
- OBO token was expired/invalid and we fell back to SPN
- The MLflow UI reads the tag for display regardless of principal

#### 2.3 Extend `RequestWithTrace` for token pass-through

```typescript
export interface RequestWithTrace extends Request {
  __traceSpan?: Span;
  __traceRequestId?: string;
  __traceUserIdentity?: string;
  __traceStartTimeMs?: number;
  __traceUserToken?: string;  // OBO: x-forwarded-access-token
}
```

**Permissions prerequisite:** Users need at least `CAN_READ` on the MLflow
experiment. Options:
- Grant via workspace group (all Hi Genie users)
- Grant to `users` group (all workspace members)
- Platform already does this if the experiment is UC-backed and the user has
  schema USE permission

---

### Phase 3 — OTel Dual-Export Correlation (Medium)

**Goal:** MLflow traces and OTel traces (in `hi_genie_otel_traces` UC table)
are correlated by trace ID so you can jump between them.

#### 3.1 Ensure OTel trace_id is set as tag

Already done in the current code (`otel.trace_id` tag). Just verify it survives
the PATCH call.

#### 3.2 Set `mlflow.source.name` for filtering

Add a source name tag so these traces are filterable in experiments with
multiple trace producers:

```typescript
{ key: 'mlflow.source.name', value: 'hi-genie-orchestrator' },
```

#### 3.3 Differentiate traces by content

With Phase 1 fix, the `mlflow.traceName` will contain the actual request
summary (e.g., `tools/call: orchestrate_plan`) instead of the UUID request_id.
This makes traces distinguishable in the UI.

---

## Implementation Details

### Files Modified

| File | Changes |
| --- | --- |
| `server/telemetry/mlflow-tracer.ts` | Refactor `exportTraceToMlflow` to two-phase; add summary builders; add `mlflow.user` tag; track span start time |
| `server/telemetry/mlflow-tracer.ts` | Extend `RequestWithTrace` interface |

### Files NOT Modified

| File | Why |
| --- | --- |
| `app.yaml` | No new env vars needed — identity comes from existing headers |
| `otel-setup.ts` | OTel pipeline is independent; no changes needed |
| `sanitizer.ts` | Summaries are pre-sanitized by builders (no raw bodies) |

---

## MLflow 3 Traces REST API Reference (v3 — Corrected)

**Important:** The current code incorrectly uses `/api/2.0/`. The correct
MLflow 3 Traces API is `/api/3.0/`.

Docs:
- [Start Trace v3](https://docs.databricks.com/api/workspace/mlflowexperimenttrace/starttracev3)
- [End Trace v3](https://docs.databricks.com/api/workspace/mlflowexperimenttrace/endtracev3)
- [Set Tag v3](https://docs.databricks.com/api/workspace/mlflowexperimenttrace/settracetagv3)

### Start a trace

```http
POST {host}/api/3.0/mlflow/traces
Authorization: Bearer {token}
Content-Type: application/json

{
  "experiment_id": "12345",
  "trace": {
    "trace_info": {
      "request_preview": "tool:get_project_context({project_id: 'prj-abc'})",
      "trace_metadata": [
        {"key": "mcp.method", "value": "tools/call"},
        {"key": "hi_genie.session_id", "value": "sess-xyz"}
      ],
      "tags": [
        {"key": "mlflow.traceName", "value": "tool:get_project_context"},
        {"key": "mlflow.user", "value": "matthew.giglia@databricks.com"},
        {"key": "mlflow.source.type", "value": "APP"},
        {"key": "mlflow.source.name", "value": "hi-genie-orchestrator"},
        {"key": "otel.trace_id", "value": "abc123def456"}
      ]
    }
  }
}
```

Response: 200 with trace object (state = `IN_PROGRESS`). Returns `trace_id`.

### End a trace

```http
PATCH {host}/api/3.0/mlflow/traces/{trace_id}
Authorization: Bearer {token}
Content-Type: application/json

{
  "trace": {
    "trace_info": {
      "state": "OK",
      "execution_duration": 892,
      "request_preview": "tool:get_project_context({project_id: 'prj-abc'})",
      "response_preview": "OK: {name: 'Hi Genie', workstreams: 7}"
    }
  },
  "update_mask": "trace_info.state,trace_info.execution_duration,trace_info.request_preview,trace_info.response_preview"
}
```

Response: 200 with trace object (state = `OK` or `ERROR`)

**Mutable fields via `update_mask`:**
- `trace_info.request_preview`
- `trace_info.response_preview`
- `trace_info.execution_duration`
- `trace_info.state`
- `trace_info.trace_metadata`
- `trace_info.assessments`
- `trace_info.tags`

### Set trace tag

```http
PATCH {host}/api/3.0/mlflow/traces/{trace_id}/tags
Authorization: Bearer {token}
Content-Type: application/json

{"key": "mlflow.user", "value": "user@example.com"}
```

Note: Tags are mutable. Can be set/updated at any point after trace creation.

---

## Verification Checklist

After implementation, the experiment UI should show:

| Column | Before (broken) | After (fixed) |
| --- | --- | --- |
| Trace ID | `tr-…` | `tr-…` (unchanged) |
| Request | `null` | `tools/call: get_project_context` |
| Response | `null` | `OK 200` |
| User | `84b365…` (SPN UUID) | `matthew.giglia@databricks.com` |
| Trace name | UUID | `tools/call: get_project_context` |
| Tokens | blank | populated if available |
| Execution time | blank | `892ms` |
| State | "In progress" (forever) | "OK" or "ERROR" |

---

## Implementation Order & Effort

```
Phase 1 — Trace Lifecycle (immediate)
  1.1  Fix API version (2.0 → 3.0)              ~10 min
  1.2  Two-phase export (POST + PATCH)           ~45 min
  1.3  Request/response preview builders         ~30 min
  1.4  Track span start time                     ~10 min

Phase 2 — User Attribution (OBO)
  2.1  Extract x-forwarded-access-token          ~10 min
  2.2  Use user token for MLflow API calls       ~20 min
  2.3  Fallback to SPN for system traces         ~10 min
  2.4  Add mlflow.user tag (redundant safety)    ~5 min

Phase 3 — Correlation & Naming
  3.1  Trace name convention (tool:<name>)       ~15 min
  3.2  Structured tag schema                     ~15 min
  3.3  Verify otel.trace_id survives PATCH       ~5 min

Phase 4 — Cleanup
  4.1  Delete 133 stale IN_PROGRESS traces       ~15 min (notebook script)
  4.2  Grant experiment CAN_READ to users group  ~5 min

Total: ~3.5 hours (all questions resolved, no remaining research)
```

---

## Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| MLflow Traces API rejects PATCH if request_id unknown | POST must succeed before PATCH; add retry logic or combine into single error handler |
| Race condition: PATCH arrives before POST completes (async) | Serialize: await POST, then PATCH (both in same async function) |
| Request body not available in `res.finish` handler | Capture from `req.body` at middleware entry (Express already parsed JSON body) |
| Sanitizer misses sensitive data in summaries | Summary builders never log raw bodies — only method names, paths, status codes |
| `mlflow.user` tag doesn't update Principal column | Expected — documented as limitation. Principal = authenticating entity (SPN). User column = `mlflow.user` tag. Acceptable. |
| High-volume traces overwhelm MLflow API (133 in 7 days, scaling up) | Existing concurrency limit (maxConcurrency: 10) + fire-and-forget pattern sufficient for current scale |
| Experiment MLFLOW_EXPERIMENT_ID not set during local dev | Existing guard (`if (experimentId)`) prevents export — OTel-only in that case |

---

## Open Questions — Researched & Resolved

### Q1: Does the Databricks Apps auth sidecar forward `x-forwarded-access-token`?

**RESOLVED: YES.** Databricks Apps documentation confirms that in "user
authorization" mode (Public Preview), the platform forwards the user's access
token to the app as the `x-forwarded-access-token` HTTP header on every request.

Sources:
- [Configure authorization in a Databricks app](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth)
- [Databricks Community: App OBO User Authorization](https://community.databricks.com/t5/data-engineering/databricks-app-obo-user-authorization/td-p/119957)

**Key details:**
- The header is present alongside `x-forwarded-user` / `x-forwarded-email`
- Token is per-request (short-lived); must NOT be cached
- Express pattern: `const userToken = req.header('x-forwarded-access-token');`
- The token can be passed directly as `Authorization: Bearer {userToken}` to
  any Databricks API, and permissions are enforced as the user

**Impact on Phase 2:** True OBO is achievable. The `getAuthHeadersAsync` function
should accept an optional `userToken` parameter and prefer it over SPN credentials
when available. This means:
1. MLflow traces will be created **as the user** → Principal column shows user
2. User must have at least `CAN_READ` on the experiment
3. Fallback to SPN for background/system traces (no user context)

**Updated recommendation:**
- **Primary path:** Use `x-forwarded-access-token` for MLflow trace creation
- **Fallback:** SPN token for system-initiated traces (scheduled ticks, etc.)
- **Always set** `mlflow.user` tag as a redundant safety net

```typescript
// Updated auth strategy in mlflow-tracer.ts
async function getAuthHeadersForTrace(
  req?: Request,
): Promise<Record<string, string>> {
  // Prefer user's forwarded token (true OBO)
  const userToken = req?.headers?.['x-forwarded-access-token'] as string | undefined;
  if (userToken) {
    return { Authorization: `Bearer ${userToken}` };
  }

  // Fallback: SPN for background/system operations
  return getAuthHeadersAsync();
}
```

---

### Q2: What is the correct PATCH endpoint for MLflow 3 traces?

**RESOLVED.** The Databricks MLflow 3 Traces API uses `/api/3.0/` (NOT 2.0):

Sources:
- [Start Trace (POST)](https://docs.databricks.com/api/workspace/mlflowexperimenttrace/starttracev3)
- [End Trace (PATCH)](https://docs.databricks.com/api/workspace/mlflowexperimenttrace/endtracev3)
- [Set Tag (PATCH)](https://docs.databricks.com/api/workspace/mlflowexperimenttrace/settracetagv3)

| Operation | Method | Endpoint | Key Fields |
| --- | --- | --- | --- |
| Start trace | `POST` | `/api/3.0/mlflow/traces` | `experiment_id`, `trace.trace_info` |
| End trace | `PATCH` | `/api/3.0/mlflow/traces/{trace_id}` | `trace.trace_info.state` (OK/ERROR), `execution_duration`, `request_preview`, `response_preview` |
| Set tag | `PATCH` | `/api/3.0/mlflow/traces/{trace_id}/tags` | `key`, `value` |

**Critical corrections to current code:**
1. **API version:** Must be `/api/3.0/` (current code uses `/api/2.0/`)
2. **Identifier:** Uses `trace_id` (not `request_id`) in the URL path
3. **End payload:** Uses `update_mask` with fields like:
   - `trace_info.request_preview`
   - `trace_info.response_preview`
   - `trace_info.execution_duration`
   - `trace_info.state`
   - `trace_info.trace_metadata`
   - `trace_info.tags`

**Updated `exportTraceToMlflow` sketch:**

```typescript
// Step 1: Start trace
const startResponse = await mlflowApiCall('/api/3.0/mlflow/traces', 'POST', {
  experiment_id: experimentId,
  trace: {
    trace_info: {
      // start fields — state defaults to IN_PROGRESS
    },
  },
});

const traceId = startResponse.trace?.trace_info?.trace_id;

// Step 2: End trace (after tool completes)
await mlflowApiCall(`/api/3.0/mlflow/traces/${traceId}`, 'PATCH', {
  trace: {
    trace_info: {
      state: statusOk ? 'OK' : 'ERROR',
      execution_duration: endTimeMs - startTimeMs,
      request_preview: requestSummary.slice(0, 2000),
      response_preview: responseSummary.slice(0, 2000),
    },
  },
  update_mask: 'trace_info.state,trace_info.execution_duration,trace_info.request_preview,trace_info.response_preview',
});

// Step 3: Set tags (can be done at any time)
await mlflowApiCall(`/api/3.0/mlflow/traces/${traceId}/tags`, 'PATCH', {
  key: 'mlflow.user',
  value: userIdentity,
});
```

---

### Q3: Should we log spans (child tool/DB spans) to MLflow or just the root SERVER span?

**RESOLVED: Full hierarchy (root + children).** The MCP protocol community has
converged on hierarchical tracing as the standard pattern for MCP servers.

Sources:
- [MCP Python SDK OTel docs](https://github.com/modelcontextprotocol/python-sdk/blob/main/docs/run/opentelemetry.md)
- [MCP Core Maintainer Meeting Feb 2026](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2204)
- [OTel Trace Support Proposal](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/269)

**Best practice for MCP servers (per SDK + maintainer guidance):**

```
MCP Request (SERVER span)          ← root, per inbound JSON-RPC message
  └─ Tool Execution (TOOL span)    ← per tools/call
      └─ DB/API Call (CLIENT span)  ← per downstream operation
```

**Recommended attributes (per MCP OTel spec):**
- `mcp.method.name` — the JSON-RPC method (e.g., `tools/call`)
- `mcp.protocol.version` — `2025-11-25`
- `gen_ai.operation.name` — `execute_tool` for tool calls
- `gen_ai.tool.name` — the specific tool (e.g., `get_project_context`)
- `mcp.session.id` — session correlation

**However, for MLflow traces specifically:**

The MCP community guidance is OTel-first. The recommendation is:
1. **OTel captures the full hierarchy** → exports to `hi_genie_otel_traces` UC table
2. **MLflow traces capture the root + tool spans** (not every DB query)
3. **Correlation** via `otel.trace_id` tag on the MLflow trace

Rationale:
- OTel is the canonical trace store (full fidelity, UC table queryable)
- MLflow traces are the debugging/UI index (summaries, previews, user attribution)
- Exporting every DB span to MLflow would be noisy (10-20 spans per tool call)
- MLflow's `request_preview`/`response_preview` already summarize the tool I/O

**Updated architecture:**

```
OTel (full fidelity, automatic):
  SERVER → TOOL → DB → DB → DB
                 → TOOL → DB

MLflow (curated, explicit export):
  One trace per request, containing:
    - Root span: request summary, user, duration
    - Tool span(s): tool name, args summary, result summary
  NOT exported to MLflow:
    - Individual DB queries (too granular)
    - Internal middleware spans
```

**Implementation:** Add a `withToolSpan` export path that creates MLflow child
spans within the parent trace. Defer to Phase 2 once root trace lifecycle is
working correctly.

---

### Q4: Cleanup existing 133 "In progress" traces?

**RESOLVED: Delete them.** The MLflow API does NOT support batch status updates
(marking traces as ERROR after the fact). The only cleanup path is deletion.

Sources:
- [MLflow Delete Traces](https://mlflow.org/docs/latest/genai/tracing/observe-with-traces/delete-traces/)
- [MLflow Search Traces](https://mlflow.org/docs/latest/genai/tracing/search-traces/)

**Available operations:**
- `MlflowClient.delete_traces(experiment_id, max_timestamp_millis=...)` — bulk delete by age
- `MlflowClient.delete_traces(experiment_id, request_ids=[...])` — delete specific traces
- `mlflow.search_traces(filter_string="trace.status = 'IN_PROGRESS'")` — find stale traces

**Cleanup script (run from notebook):**

```python
import mlflow
import time

client = mlflow.MlflowClient()
experiment_id = "<MLFLOW_EXPERIMENT_ID>"  # from app.yaml

# Option A: Delete all traces older than now (nuclear for this experiment)
client.delete_traces(
    experiment_id=experiment_id,
    max_timestamp_millis=int(time.time() * 1000),
)

# Option B: Search and delete only IN_PROGRESS traces
stale_traces = mlflow.search_traces(
    experiment_ids=[experiment_id],
    filter_string="trace.status = 'IN_PROGRESS'",
)
if len(stale_traces) > 0:
    trace_ids = stale_traces["trace_id"].tolist()
    client.delete_traces(
        experiment_id=experiment_id,
        trace_ids=trace_ids,
    )
    print(f"Deleted {len(trace_ids)} stale IN_PROGRESS traces.")
```

**Recommendation:** Use Option B (targeted delete of IN_PROGRESS only). Run once
after deploying the fix. Consider adding to the post-deploy job as a one-time
cleanup task.

---

### Q5: Should the `mlflow.traceName` use the tool name or request path?

**RESOLVED: Use operation type as trace name; put details in tags.** MLflow best
practice is concise trace names + structured tags for filtering.

Sources:
- [MLflow View Traces UI](https://mlflow.org/docs/latest/genai/tracing/observe-with-traces/ui)
- [MLflow Trace Structure](https://github.com/mlflow/skills/blob/main/analyze-mlflow-trace/references/trace-structure.md)
- [MLflow Trace Tags Discussion](https://github.com/mlflow/mlflow/discussions/12927)

**Convention for this app:**

| Request Type | `mlflow.traceName` | Tags |
| --- | --- | --- |
| MCP tool call | `tool:<tool_name>` | `mcp.method=tools/call`, `hi_genie.workstream_key`, `hi_genie.session_id` |
| MCP tools/list | `mcp:tools/list` | `mcp.persona=architect` |
| MCP initialize | `mcp:initialize` | `mcp.protocol_version` |
| API route | `api:<method> <path>` | `http.method`, `http.route` |
| System tick | `system:dispatch_tick` | `hi_genie.tick_type` |

**Examples in the UI:**
- `tool:get_project_context`
- `tool:orchestrate_plan`
- `mcp:tools/list`
- `api:POST /api/v1/plans`

**Why NOT include workstream in the name:**
- High cardinality (workstream keys change per session)
- Makes the UI column noisy and hard to scan
- Tags are searchable and filterable — use them for grouping
- Trace name should answer "what kind of operation" not "which instance"

**Tag schema:**

```typescript
const traceTags = [
  { key: 'mlflow.traceName', value: traceName },
  { key: 'mlflow.user', value: userIdentity },
  { key: 'mlflow.source.type', value: 'APP' },
  { key: 'mlflow.source.name', value: 'hi-genie-orchestrator' },
  { key: 'hi_genie.workstream_key', value: workstreamKey ?? '' },
  { key: 'hi_genie.session_id', value: sessionId ?? '' },
  { key: 'hi_genie.mcp_persona', value: persona ?? 'full' },
  { key: 'mcp.method', value: rpcMethod },
  { key: 'otel.trace_id', value: otelTraceId },
];
```

Also set `request_preview` and `response_preview` (MLflow 3 first-class fields)
for the Request/Response columns — these are more visible than tags in the list
view:

```typescript
// request_preview: what went in (truncated, sanitized)
// response_preview: what came out (truncated, sanitized)
mlflow.update_current_trace(
  request_preview: "get_project_context({project_id: 'prj-abc'})",
  response_preview: "OK: {name: 'Hi Genie', workstreams: 7}",
)
```

---

## Appendix: Current Code References

| Location | What |
| --- | --- |
| `mlflow-tracer.ts:400–446` | `exportTraceToMlflow` — only POST, never PATCH |
| `mlflow-tracer.ts:497–533` | `getSpnToken` — authenticates as App SPN |
| `mlflow-tracer.ts:535–545` | `getAuthHeadersAsync` — token selection logic |
| `mlflow-tracer.ts:557–563` | `extractUserIdentity` — reads `x-forwarded-user` |
| `mlflow-tracer.ts:411–423` | Trace tags — missing `mlflow.user` |
| `app.yaml:10–13` | SPN credential injection (`HI_GENIE_APP_CLIENT_ID`) |
| `app.yaml:19–21` | MLflow experiment ID injection |
| `identity.ts:41–54` | Verified identity middleware (same header extraction) |
