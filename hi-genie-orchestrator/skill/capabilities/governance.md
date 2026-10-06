# Governance & Cross-Workspace Access

Unity AI Gateway provides governed, auditable access to the Hi Genie MCP server
across workspaces. This document covers registration, service policies, grants,
and the access model.

## Architecture Overview

```text
Worker (any workspace on the metastore)
  → EXECUTE grant on UC MCP Service
  → AI Gateway (routes, authenticates, enforces policies)
  → Hi Genie App /mcp (Streamable HTTP, JSON-RPC 2.0)
```

Workers never handle raw credentials. AI Gateway manages the connection to the
App and enforces tool-level policies based on the caller's identity.

## UC MCP Service Registration (5 steps)

### 1. Create a UC Connection

The connection stores the App's MCP endpoint URL and authentication method.

```sql
CREATE CONNECTION hi_genie_orchestrator_conn
  TYPE MCP
  URL 'https://mcp-hi-genie-orchestrator-prod-7474657291520070.aws.databricksapps.com/mcp'
  WITH CREDENTIAL (
    AUTH_TYPE = 'OAUTH_M2M',
    CLIENT_ID = '<spn_client_id>',
    CLIENT_SECRET = '<spn_client_secret>',
    TOKEN_URL = 'https://fevm-hls-fde.cloud.databricks.com/oidc/v1/token'
  );
```

### 2. Create the MCP Service

```sql
CREATE SERVICE hls_fde.hi_genie_prod.orchestrator_mcp
  FROM CONNECTION hi_genie_orchestrator_conn;
```

### 3. Verify tools are discoverable

AI Gateway inspects the MCP server's `tools/list` response to populate the
service's tool catalog.

### 4. Configure Service Policies

Restrict which tools are callable per role (see Service Policies below).

### 5. Grant Access

```sql
-- Workers and reviewers
GRANT EXECUTE ON SERVICE hls_fde.hi_genie_prod.orchestrator_mcp
  TO `hi-genie-workers-group`;

-- Prerequisite catalog/schema access
GRANT USE CATALOG ON CATALOG hls_fde TO `hi-genie-workers-group`;
GRANT USE SCHEMA ON SCHEMA hls_fde.hi_genie_prod TO `hi-genie-workers-group`;
```

## Service Policies (Tool-Level Access Control)

AI Gateway service policies enforce role boundaries at the infrastructure level.
Even if a worker's LLM hallucinates a restricted tool call, the Gateway blocks it.

### Worker Policy

Allowed tools:
- All Context Retrieval tools (7)
- All Records tools (6)
- State: `start_session`, `end_session`, `update_workstream_status`, `update_task_status`
- Search: `search_context`, `get_task_history`, `get_execution_summary`, `get_health`
- Skill: `get_skill_content`

Denied tools:
- `update_recovery_state` (admin-only)
- `get_schema_version` (admin-only)

### Reviewer Policy

Allowed tools:
- All Context Retrieval tools (7)
- Records: `record_workstream_event` only (for findings)
- State: `start_session`, `end_session`
- Search: `search_context`, `get_task_history`, `get_execution_summary`, `get_health`
- Skill: `get_skill_content`

Denied tools:
- All other Records tools (decisions, errors, attempts, completions)
- All mutable State tools (`update_workstream_status`, `update_task_status`, `update_recovery_state`)

### Supervisor Policy

All tools allowed. The Supervisor connects via direct REST (Python SDK),
not through the UC MCP Service, so this policy is informational only.

## Audit Logging

Every MCP tool call through AI Gateway is logged in Unity Catalog audit tables:

| Field | Value |
| --- | --- |
| `principal` | Caller identity (user email or SPN) |
| `service_name` | `hls_fde.hi_genie_prod.orchestrator_mcp` |
| `tool_name` | e.g., `get_workstream_context` |
| `timestamp` | UTC call time |
| `workspace_id` | Calling workspace |
| `request_id` | Correlation ID |

This provides a complete audit trail of who accessed what, from which workspace,
at what time — without any custom instrumentation.

## Cross-Workspace Access Model

| Scenario | How It Works | Prerequisites |
| --- | --- | --- |
| Same workspace, same user | Custom MCP connector (direct) | App deployed in workspace |
| Same workspace, via UC | UC MCP Service | `EXECUTE` grant |
| Different workspace | UC MCP Service (required) | Same metastore + `EXECUTE` grant |
| External (non-Databricks) | Not via UC MCP Service | Use REST SDK + M2M OAuth2 directly |

### Key Constraint

The UC MCP Service requires all participating workspaces to be on the **same
Unity Catalog metastore**. Cross-metastore access is not supported.

For external consumers (Claude CLI, CI/CD pipelines, non-Databricks agents):
- Use the REST Supervisor API directly (`/api/v1`)
- Authenticate via M2M OAuth2 client_credentials
- Call `GET /api/v1/skills/content` for skill loading (REST equivalent of the MCP tool)

## Rate Limiting

AI Gateway rate limits protect the MCP server from runaway workers:

| Dimension | Suggested Limit | Rationale |
| --- | --- | --- |
| Per-principal requests/min | 120 | ~2 tool calls/sec during active work |
| Per-workspace requests/min | 600 | Support 5 concurrent workers per workspace |
| Total service requests/min | 3000 | App capacity (adjust based on load testing) |

## Credential Isolation

- Workers see ONLY the UC MCP Service name (e.g., `hls_fde.hi_genie_prod.orchestrator_mcp`)
- The underlying connection (App URL, SPN credentials) is hidden from consumers
- Only admins with `MANAGE` on the connection can see/rotate credentials
- Rotating the App SPN credentials updates the connection only — consumers are unaffected

## Disaster Recovery

| Scenario | Impact | Recovery |
| --- | --- | --- |
| App goes down | Workers get MCP errors | Dispatcher detects via health check; workers fail gracefully via heartbeat timeout |
| AI Gateway outage | Workers can't reach MCP | Same-workspace workers can fall back to direct app connection (if policy allows) |
| Connection credentials expire | All MCP calls fail | Rotate SPN secret in the UC connection; no consumer changes needed |
| Metastore failover | UC MCP Service temporarily unavailable | Wait for metastore recovery; persisted state in Lakebase is safe |
