# 005 — Four-Persona MCP Split: E2E Test Plan

**Date:** 2026-08-24
**Status:** Draft
**Prerequisite:** Design doc `004-four-persona-mcp-split.md` implemented and deployed
**Scope:** Dev target (`mcp-hi-genie-orchestrator-dev`)

---

## Overview

This test plan validates the 4-persona MCP split end-to-end: transport layer,
tool isolation, UC service discovery, tool execution, policy enforcement,
authentication, rate limits, permissions, cold-start recovery, and idempotency.

---

## Infrastructure Under Test

| Resource | Dev Value |
| --- | --- |
| App | `mcp-hi-genie-orchestrator-dev` |
| App URL | `https://mcp-hi-genie-orchestrator-dev-7474657291520070.aws.databricksapps.com` |
| Catalog | `hls_fde_dev` |
| Schema | `dev_matthew_giglia_hi_genie` |
| Architect service | `hi_genie_architect_dev` |
| Reviewer service | `hi_genie_reviewer_dev` |
| Worker service | `hi_genie_worker_dev` |
| Dispatcher service | `hi_genie_dispatcher_dev` |
| Workers group | `hi-genie-workers-dev` |
| Secret scope | `hi_genie_credentials` |
| SPN client_id key | `client_id_dev_matthew_giglia_hi_genie` |
| SPN client_secret key | `client_secret_dev_matthew_giglia_hi_genie` |
| OTel table | `hls_fde_dev.dev_matthew_giglia_hi_genie.hi_genie_otel_logs` |
| Post-deploy Job ID | `468754756167374` |

---

## Authentication Helper

All persona paths require SPN authentication. Token acquisition:

```python
import requests
from databricks.sdk import WorkspaceClient

w = WorkspaceClient()
scope = "hi_genie_credentials"
client_id = dbutils.secrets.get(scope, "client_id_dev_matthew_giglia_hi_genie")
client_secret = dbutils.secrets.get(scope, "client_secret_dev_matthew_giglia_hi_genie")

token_resp = requests.post(
    "https://fevm-hls-fde.cloud.databricks.com/oidc/v1/token",
    data={"grant_type": "client_credentials", "client_id": client_id,
          "client_secret": client_secret, "scope": "all-apis"}
)
access_token = token_resp.json()["access_token"]

headers = {
    "Authorization": f"Bearer {access_token}",
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream"
}
```

MCP protocol requires `initialize` before `tools/list` or `tools/call`:

```python
def mcp_initialize(url, headers):
    payload = {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "e2e-test", "version": "1.0"}
        }
    }
    r = requests.post(url, json=payload, headers=headers, timeout=15)
    session_id = r.headers.get("mcp-session-id", "")
    return session_id

def mcp_tools_list(url, headers, session_id):
    h = {**headers}
    if session_id:
        h["mcp-session-id"] = session_id
    payload = {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
    r = requests.post(url, json=payload, headers=h, timeout=15)
    return r.json().get("result", {}).get("tools", [])

def mcp_tools_call(url, headers, session_id, tool_name, arguments=None):
    h = {**headers}
    if session_id:
        h["mcp-session-id"] = session_id
    payload = {
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments or {}}
    }
    r = requests.post(url, json=payload, headers=h, timeout=30)
    return r.json()
```

---

## Test Cases

### 1. Transport Layer — Tool Counts

**Objective:** Each persona path responds to MCP protocol and reports the correct number of tools.

| Path | Expected Count |
| --- | --- |
| `/mcp/architect` | 13 |
| `/mcp/reviewer` | 14 |
| `/mcp/worker` | 17 |
| `/mcp/dispatcher` | 16 |
| `/mcp` (internal) | 39 |

**Procedure:**
1. Authenticate as SPN
2. For each path: `initialize` → `tools/list`
3. Assert `len(tools) == expected`

**Pass criteria:** All 5 paths return HTTP 200 with correct tool counts.

---

### 2. Tool Isolation — Persona Boundaries

**Objective:** A tool available on one persona is NOT callable from another.

| Caller Path | Forbidden Tool | Expected Error |
| --- | --- | --- |
| `/mcp/architect` | `record_session_summary` | Tool not found / method error |
| `/mcp/worker` | `create_plan` | Tool not found / method error |
| `/mcp/dispatcher` | `create_review` | Tool not found / method error |
| `/mcp/reviewer` | `orchestrate_plan` | Tool not found / method error |

**Procedure:**
1. For each row: `initialize` → `tools/call` with the forbidden tool
2. Assert response contains error (JSON-RPC error code or error field)

**Pass criteria:** All 4 cross-persona calls are rejected.

---

### 3. UC MCP Service Discovery

**Objective:** UC can discover tools from registered services.

**Procedure:**
```python
for svc in ["architect", "reviewer", "worker", "dispatcher"]:
    full = f"hls_fde_dev.dev_matthew_giglia_hi_genie.hi_genie_{svc}_dev"
    resp = w.api_client.do("GET", f"/api/2.1/unity-catalog/mcp-services/{full}/tools")
    tools = resp.get("tools", [])
    print(f"{svc}: {len(tools)} tools")
```

**Pass criteria:** UC reports same tool counts as transport layer (13/14/17/16).

---

### 4. Tool Execution — One Per Persona

**Objective:** Confirm tools execute successfully on each path.

| Persona | Tool | Arguments | Expected |
| --- | --- | --- | --- |
| Architect | `get_health` | `{}` | JSON with `status`, `version` |
| Reviewer | `get_health` | `{}` | JSON with `status`, `version` |
| Worker | `get_schema_version` | `{}` | String with version |
| Dispatcher | `list_workstreams` | `{"project_id": "test"}` | Array (possibly empty) or error (not tool-not-found) |

**Procedure:**
1. For each persona: `initialize` → `tools/call` with the test tool
2. Assert response has `result` (not `error`), or if error, it's a business error (not protocol/auth)

**Pass criteria:** All 4 tools return non-error protocol responses (business-level "not found" is OK).

---

### 5. ASK-Gate Policy

**Objective:** Tools require user approval when called via Genie (UC MCP Service).

**Procedure:**
1. Open a Genie session connected to one of the 4 services
2. Invoke any tool (e.g., `get_health`)
3. Verify the approve/deny prompt appears before execution

**Pass criteria:** Tool call is NOT auto-executed; user sees approval UX.

**Note:** This is a manual/interactive test — cannot be automated via SDK.

---

### 6. Connection Auth — SPN Credentials

**Objective:** All 4 connections authenticate via the same SPN and get valid tokens.

**Procedure:**
1. Verify SPN token acquisition succeeds (step 0 — auth helper)
2. Call `initialize` on all 4 paths — all return 200 (not 401/403)
3. Query OTel for auth success:

```sql
SELECT time, CAST(body AS STRING) as msg
FROM hls_fde_dev.dev_matthew_giglia_hi_genie.hi_genie_otel_logs
WHERE CAST(body AS STRING) LIKE '%auth%' OR CAST(body AS STRING) LIKE '%token%'
  AND time > current_timestamp() - INTERVAL 10 MINUTES
ORDER BY time DESC LIMIT 20
```

**Pass criteria:** No 401/403 errors; OTel shows successful token validation.

---

### 7. Rate Limits

**Objective:** All 4 services have rate limits configured.

**Procedure:**
```python
for svc in ["architect", "reviewer", "worker", "dispatcher"]:
    full = f"hls_fde_dev.dev_matthew_giglia_hi_genie.hi_genie_{svc}_dev"
    resp = w.api_client.do("GET", f"/api/2.1/unity-catalog/mcp-services/{full}/rate-limits")
    limits = resp.get("rate_limits", [])
    service_limit = next((l for l in limits if l.get("key") == "SERVICE"), None)
    user_limit = next((l for l in limits if l.get("key") == "USER"), None)
    print(f"{svc}: service={service_limit}, user={user_limit}")
```

**Pass criteria:**
- SERVICE rate limit = 120 QPM on all 4
- USER rate limit = 30 QPM on all 4

---

### 8. Permissions — Workers Group

**Objective:** `hi-genie-workers-dev` has EXECUTE + READ_METADATA on all 4 services.

**Procedure:**
```python
for svc in ["architect", "reviewer", "worker", "dispatcher"]:
    full = f"hls_fde_dev.dev_matthew_giglia_hi_genie.hi_genie_{svc}_dev"
    resp = w.api_client.do("GET", f"/api/2.1/unity-catalog/permissions/MCP_SERVICE/{full}")
    acls = resp.get("privilege_assignments", [])
    worker_acl = [a for a in acls if a.get("principal") == "hi-genie-workers-dev"]
    print(f"{svc}: {worker_acl}")
```

**Pass criteria:** Each service shows EXECUTE + READ_METADATA for `hi-genie-workers-dev`.

---

### 9. Cold-Start Recovery

**Objective:** After app restart, all persona paths come back healthy.

**Procedure:**
```python
w.apps.stop("mcp-hi-genie-orchestrator-dev")
# wait ~30s for stop
w.apps.start("mcp-hi-genie-orchestrator-dev")
# wait for RUNNING state
# Re-run Test 1 (transport layer tool counts)
```

**Pass criteria:** All 5 paths return correct tool counts after restart.

**Bonus:** Check OTel for the startup log:
```sql
SELECT time, CAST(body AS STRING) as msg
FROM hls_fde_dev.dev_matthew_giglia_hi_genie.hi_genie_otel_logs
WHERE CAST(body AS STRING) LIKE '%[mcp] Workstream MCP ready%'
  AND time > current_timestamp() - INTERVAL 5 MINUTES
ORDER BY time DESC LIMIT 1
```

---

### 10. Idempotent Re-Deploy

**Objective:** Running post-deploy again produces no errors and doesn't duplicate resources.

**Procedure:**
1. Run post-deploy job: `first_run=true`, `drop_connection=true`
2. Wait for completion
3. Re-run Test 1 (tool counts unchanged)
4. Re-run Test 3 (UC discovery unchanged)
5. Verify no duplicate services in catalog explorer

**Pass criteria:** All 10 tasks GREEN, tool counts unchanged, no duplicate services.

---

## Quick Smoke Test

Minimal pass/fail — covers transport, auth, filtering, and execution in ~16 requests:

```python
APP = "https://mcp-hi-genie-orchestrator-dev-7474657291520070.aws.databricksapps.com"
PERSONAS = {
    "/mcp/architect": (13, "get_health"),
    "/mcp/reviewer": (14, "get_health"),
    "/mcp/worker": (17, "get_schema_version"),
    "/mcp/dispatcher": (16, "list_workstreams"),
}

for path, (expected_count, test_tool) in PERSONAS.items():
    url = f"{APP}{path}"
    session_id = mcp_initialize(url, headers)
    tools = mcp_tools_list(url, headers, session_id)
    assert len(tools) == expected_count, f"{path}: got {len(tools)}, expected {expected_count}"
    result = mcp_tools_call(url, headers, session_id, test_tool)
    assert "error" not in result or result["error"].get("code") != -32601, \
        f"{path}/{test_tool}: method not found"
    print(f"✅ {path}: {len(tools)} tools, {test_tool} callable")

print("\n🎉 Smoke test PASSED")
```

---

## Test Execution Status

| # | Test | Status | Date | Notes |
| --- | --- | --- | --- | --- |
| 1 | Transport Layer | ✅ PASS | 2026-08-24 | OTel + live tools/list |
| 2 | Tool Isolation | ⬜ TODO | | |
| 3 | UC Service Discovery | ✅ PASS | 2026-08-24 | SDK GET /tools |
| 4 | Tool Execution | ⬜ TODO | | |
| 5 | ASK-Gate Policy | ⬜ TODO | | Manual test |
| 6 | Connection Auth | ✅ PASS | 2026-08-24 | SPN token → 200 on all paths |
| 7 | Rate Limits | ⬜ TODO | | |
| 8 | Permissions | ⬜ TODO | | |
| 9 | Cold-Start Recovery | ⬜ TODO | | |
| 10 | Idempotent Re-Deploy | ✅ PASS | 2026-08-24 | Run 755918384507973 all green |

---

## Future Enhancements

- Automated test notebook (pytest-style) for CI integration
- Load test: verify rate limits actually throttle at 120/30 QPM
- Multi-session concurrency: multiple SPN tokens hitting same path
- Negative auth test: expired token, wrong SPN, revoked permissions
- Tool response schema validation (JSON Schema per tool)
