# MCP Protocol Versioning Strategy — A/B Deployable Spec Variants

**Date:** 2026-08-20  
**Status:** Design exploration  
**Scope:** R1.1 / R2 candidate  
**Relates to:** MCP transport (`server/mcp/transport.ts`), DABs config, Lakebase branching

---

## Problem Statement

The MCP specification moved from `2025-11-25` (session-based) to `2026-07-28`
(stateless, extensions-enabled) in under 8 months. Databricks AI Playground
currently requires `2025-11-25`, but will likely adopt `2026-07-28` soon.

We need a deployment strategy that allows:
1. Both spec versions to run side-by-side for A/B testing
2. A single codebase with deployment-time selection
3. Independent schema evolution per spec version (if needed)
4. Clean rollback without data migration

---

## Protocol Differences That Affect Implementation

| Concern | `2025-11-25` | `2026-07-28` |
| --- | --- | --- |
| Handshake | `initialize` / `initialized` required | Removed — stateless |
| Session | `Mcp-Session-Id` header, server-managed | None — each request self-describing |
| Client identity | Extracted once at session creation | `_meta.io.modelcontextprotocol/clientInfo` per request |
| Protocol version | In `initialize` response | `MCP-Protocol-Version` header + `_meta` |
| Routing headers | None | `Mcp-Method`, `Mcp-Name` (gateway-friendly) |
| Capabilities discovery | Part of `initialize` response | `server/discover` RPC (optional) |
| List caching | Not specified | `ttlMs` + `cacheScope` in list responses |
| Extensions | Not supported | Formal extensions framework (MCP Apps, Tasks) |
| Elicitation/Sampling | Core protocol | Deprecated → Multi Round-Trip Requests (MRTR) |

---

## Proposed Architecture

### Bundle Variable: `mcp_spec_version`

```yaml
# databricks.yml — new variable
variables:
  mcp_spec_version:
    description: >
      MCP protocol version to deploy. Determines which transport
      implementation is active and is reflected in the app name
      for side-by-side A/B testing.
    default: "2025-11-25"
```

### App Naming Convention

The `mcp-` prefix is required by the platform for AI Playground discovery.
Append a short spec version tag for A/B disambiguation:

```yaml
variables:
  app_name_suffix:
    description: >
      Derived from mcp_spec_version. Maps spec dates to short tags
      for the app name. Computed by deploy.sh.
    # 2025-11-25 → "v25"  |  2026-07-28 → "v26"
```

| Spec Version | App Name (dev) | App Name (prod) |
| --- | --- | --- |
| `2025-11-25` | `mcp-hi-genie-orchestrator-dev-v25` | `mcp-hi-genie-orchestrator-v25` |
| `2026-07-28` | `mcp-hi-genie-orchestrator-dev-v26` | `mcp-hi-genie-orchestrator-v26` |

Both apps coexist in the workspace, both appear in AI Playground's tool picker
(because both start with `mcp-`), and testers can select which one to use.

### Target Matrix (dev example)

```yaml
targets:
  # Current stable — session-based transport
  dev:
    default: true
    variables:
      mcp_spec_version: "2025-11-25"
      app_name: mcp-hi-genie-orchestrator-dev-v25
      lakebase_branch: development

  # Experimental — stateless transport + extensions
  dev-v26:
    mode: development
    variables:
      mcp_spec_version: "2026-07-28"
      app_name: mcp-hi-genie-orchestrator-dev-v26
      lakebase_branch: development-v26
```

---

## Runtime Transport Selection

### Option A: Build-time selection (recommended)

Inject `MCP_SPEC_VERSION` as an env var in `app.yaml`. The server entry point
loads the correct transport module at startup:

```yaml
# app.yaml addition
env:
  - name: MCP_SPEC_VERSION
    value: "${var.mcp_spec_version}"  # Resolved by bundle deploy
```

```typescript
// server/mcp/index.ts — transport factory
export async function setupMcpRoutes(appkit: AppKitInstance): Promise<void> {
  const specVersion = process.env.MCP_SPEC_VERSION ?? '2025-11-25';

  if (specVersion === '2026-07-28') {
    const { createStatelessTransport } = await import('./transport-v26.js');
    // Stateless: no sessions, _meta extraction, server/discover
    const { mcpMiddleware } = createStatelessTransport({ pool, toolRegistry });
    appkit.server.extend((app) => app.use('/mcp', mcpMiddleware));
  } else {
    const { createMcpTransport } = await import('./transport.js');
    // Session-based: initialize/initialized, Mcp-Session-Id
    const { mcpMiddleware } = createMcpTransport({ pool, toolRegistry });
    appkit.server.extend((app) => app.use('/mcp', mcpMiddleware));
  }
}
```

**Pros:** Single codebase, no conditional logic in request path, dead code
elimination possible.  
**Cons:** Two transport files to maintain.

### Option B: Runtime negotiation (future)

A single transport that reads `MCP-Protocol-Version` from the request header
and dispatches accordingly. The TypeScript SDK v2 does this with
`createMcpHandler(factory)`. More complex but eliminates the need for two apps.

---

## File Structure

```
server/mcp/
├── index.ts                 # Transport factory (selects based on env)
├── transport.ts             # 2025-11-25 — session-based (current)
├── transport-v26.ts         # 2026-07-28 — stateless + _meta + server/discover
├── tools/                   # Shared — tool definitions + handlers (unchanged)
│   ├── context.ts
│   ├── records.ts
│   ├── state.ts
│   └── search.ts
└── extensions/              # 2026-07-28 only — MCP Apps extension
    └── apps.ts              # ui:// resource serving, postMessage bridge
```

Tool definitions and handlers are **shared** — both transports call into the
same `McpToolRegistry`. The transport layer only handles:
- Protocol framing (JSON-RPC)
- Identity extraction
- Session/stateless lifecycle
- Protocol-specific responses

---

## Lakebase Branching Strategy

### Do the schemas actually diverge?

**Current state:** MCP transport sessions are **in-memory only** (the `sessions`
Map in `transport.ts`). They are NOT stored in Lakebase. The `state.sessions`
table in Lakebase is for **application-level workstream sessions** — unrelated
to MCP protocol sessions.

So today, the protocol version has **zero Lakebase schema impact**. Both apps
can share the same Lakebase branch safely.

### When would schemas diverge?

Schemas could diverge if `2026-07-28` introduces:
1. **Request audit logging** — storing `_meta.clientInfo` per request (new table)
2. **MRTR state** — multi round-trip request correlation tracking (new table)
3. **MCP Apps state** — iframe session state, structured content cache (new table)
4. **Removed session tracking** — if we currently persisted sessions (we don't)

For (1-3), these are **additive** — new tables, no conflicts with existing.
A shared branch works fine because extra tables don't break the v25 app.

### Recommended Lakebase topology

```
Lakebase Project: hi-genie-orchestrator
│
├── production          ← hls_fde target (both versions share)
├── development         ← dev target, v25 app (current)
└── development-v26     ← dev target, v26 app (experimental)
```

**Rationale for separate dev branches:**
- Isolation during development — v26 migrations don't risk v25 stability
- Can run destructive experiments (drop/recreate tables) without affecting v25
- Cheap to create (Lakebase branches are CoW)
- Production stays shared — both versions write to the same dispatch/state tables
  (the business logic is identical; only transport framing differs)

### Creating the branch

```bash
# Create a new Lakebase branch from the current development state
databricks postgres create-branch \
  projects/hi-genie-orchestrator/branches/development-v26 \
  --json '{"parent_branch": "projects/hi-genie-orchestrator/branches/development"}'
```

---

## `transport-v26.ts` — Skeleton

```typescript
/**
 * MCP Transport — Protocol Version 2026-07-28 (Stateless)
 *
 * Key differences from 2025-11-25:
 * - No initialize/initialized handshake
 * - No Mcp-Session-Id header or server session state
 * - Client identity/capabilities in params._meta per request
 * - server/discover RPC for capability advertisement
 * - Mcp-Method + Mcp-Name headers for gateway routing
 * - List responses include cache hints (ttlMs, cacheScope)
 */

import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { McpToolRegistry, McpToolDefinition } from './transport.js';

const SERVER_INFO = {
  name: 'hi-genie-orchestrator',
  version: '1.1.0',
};

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

interface RequestMeta {
  'io.modelcontextprotocol/protocolVersion'?: string;
  'io.modelcontextprotocol/clientInfo'?: { name: string; version: string };
  'io.modelcontextprotocol/clientCapabilities'?: Record<string, unknown>;
}

function extractMeta(params: Record<string, unknown>): RequestMeta {
  return (params._meta as RequestMeta) ?? {};
}

function extractUserId(req: Request, meta: RequestMeta): string {
  // Prefer Databricks OBO headers (always present in Apps sidecar)
  const oboUser =
    (req.headers['x-forwarded-email'] as string) ??
    (req.headers['x-databricks-user'] as string);
  if (oboUser) return oboUser;

  // Fallback: clientInfo from _meta
  return meta['io.modelcontextprotocol/clientInfo']?.name ?? 'unknown';
}

export function createStatelessTransport(options: {
  pool: Pool;
  toolRegistry: McpToolRegistry;
}) {
  const { pool, toolRegistry } = options;

  async function handlePost(req: Request, res: Response): Promise<void> {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const requests = Array.isArray(body) ? body : [body];
    const responses = [];

    for (const request of requests) {
      if (request.jsonrpc !== '2.0' || !request.method) {
        responses.push({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32600, message: 'Invalid request' } });
        continue;
      }

      const params = request.params ?? {};
      const meta = extractMeta(params);
      const userId = extractUserId(req, meta);

      let response;
      switch (request.method) {
        case 'server/discover':
          response = handleDiscover(request.id);
          break;
        case 'tools/list':
          response = handleToolsList(request.id);
          break;
        case 'tools/call':
          response = await handleToolsCall(request.id, params, userId);
          break;
        default:
          response = { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Unknown method: ${request.method}` } };
      }

      if (response) responses.push(response);
    }

    // Single response or batch
    const result = responses.length === 1 ? responses[0] : responses;
    res.status(200).json(result);
  }

  function handleDiscover(id: string | number | null) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersions: SUPPORTED_VERSIONS,
        serverInfo: SERVER_INFO,
        capabilities: { tools: { listChanged: false } },
        instructions: 'Hi Genie Orchestrator — workstream dispatch, state, and review tools.',
      },
    };
  }

  function handleToolsList(id: string | number | null) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: toolRegistry.definitions,
        _meta: {
          'io.modelcontextprotocol/serverInfo': SERVER_INFO,
          ttlMs: 300_000,       // Cache for 5 minutes
          cacheScope: 'global', // Tools don't change per-user
        },
      },
    };
  }

  async function handleToolsCall(
    id: string | number | null,
    params: Record<string, unknown>,
    userId: string,
  ) {
    const toolName = params.name as string;
    const toolArgs = (params.arguments as Record<string, unknown>) ?? {};

    if (!toolName) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing tool name' } };
    }

    const handler = toolRegistry.handlers.get(toolName);
    if (!handler) {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Tool not found: ${toolName}` } };
    }

    try {
      // Create a minimal session-like object for handler compatibility
      const pseudoSession = { id: 'stateless', userId, createdAt: new Date(), lastActiveAt: new Date() };
      const result = await handler(toolArgs, pseudoSession as any, pool);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
          isError: true,
        },
      };
    }
  }

  // Express middleware
  function mcpMiddleware(req: Request, res: Response): void {
    if (req.method === 'POST') {
      handlePost(req, res).catch((err) => {
        console.error('[mcp-v26] Unhandled error:', err);
        res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
      });
    } else if (req.method === 'GET') {
      // In 2026-07-28, GET is no longer used for SSE — return method not allowed
      res.status(405).json({ error: 'Method not allowed. Use POST for all MCP requests.' });
    } else if (req.method === 'DELETE') {
      // Sessions don't exist — return success (idempotent)
      res.status(200).json({ status: 'ok' });
    } else {
      res.status(405).end();
    }
  }

  return { mcpMiddleware, basePath: '/mcp' };
}
```

---

## Bundle Configuration — Full Example

```yaml
# databricks.yml additions
variables:
  mcp_spec_version:
    description: >
      MCP protocol version to deploy. Drives transport selection and app name.
    default: "2025-11-25"

  app_name:
    description: >
      Platform app name. Includes spec version suffix for A/B coexistence.
      Computed by deploy.sh from mcp_spec_version.

targets:
  dev:
    default: true
    variables:
      mcp_spec_version: "2025-11-25"
      app_name: mcp-hi-genie-orchestrator-dev-v25
      lakebase_branch: development

  dev-v26:
    mode: development
    variables:
      mcp_spec_version: "2026-07-28"
      app_name: mcp-hi-genie-orchestrator-dev-v26
      lakebase_branch: development-v26
      # All other vars inherited/same as dev
      catalog: hls_fde_dev
      schema: dev_matthew_giglia_hi_genie
      lakebase_project_id: hi-genie-orchestrator
      run_as_user: matthew.giglia@databricks.com
      client_id_dbs_key: client_id_dev_matthew_giglia_hi_genie
      client_secret_dbs_key: client_secret_dev_matthew_giglia_hi_genie
      embedding_endpoint_key: embedding_endpoint_dev_matthew_giglia_hi_genie
      mlflow_experiment_id: "4038008988926083"
```

### `app.yaml` addition

```yaml
env:
  - name: MCP_SPEC_VERSION
    value: "${var.mcp_spec_version}"
```

### `deploy.sh` derivation

```bash
# Derive app name suffix from spec version
case "$MCP_SPEC_VERSION" in
  "2025-11-25") APP_SUFFIX="v25" ;;
  "2026-07-28") APP_SUFFIX="v26" ;;
  *)            APP_SUFFIX="v25" ;;  # Default to stable
esac

APP_NAME="mcp-hi-genie-orchestrator-${TARGET}-${APP_SUFFIX}"
```

---

## Lakebase Branch Topology — Visual

```
                    ┌─────────────────────────────────┐
                    │   Lakebase Project:             │
                    │   hi-genie-orchestrator         │
                    └─────────────────────────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
    ┌─────────▼─────────┐  ┌─────▼──────┐  ┌────────▼────────┐
    │   production      │  │development │  │development-v26  │
    │                   │  │            │  │                 │
    │ hls_fde target    │  │ dev target │  │ dev-v26 target  │
    │ (both versions    │  │ (v25 app)  │  │ (v26 app)       │
    │  share in prod)   │  │            │  │                 │
    └───────────────────┘  └────────────┘  └─────────────────┘
                                  │              │
                                  │   CoW fork ──┘
                                  │   (shared base schema,
                                  │    v26 adds new tables
                                  │    for MRTR/Apps state)
```

**Key insight:** Both apps share the SAME `dispatch.*` and `state.*` tables in
production — business logic is identical. The Lakebase branch split is only for
**development isolation** so v26 migrations can be tested without risking v25.

---

## When to Add `development-v26` Tables

New tables (v26-only, additive) might include:

| Table | Purpose | When |
| --- | --- | --- |
| `state.request_audit` | Store `_meta.clientInfo` per request for observability | If we want richer client analytics |
| `state.mrtr_correlations` | Track multi-round-trip request chains | If we adopt MRTR for interactive tools |
| `state.app_sessions` | MCP Apps iframe session state + structured content | If we implement MCP Apps extension |

None of these are needed for basic `2026-07-28` protocol compliance — they're
future extensions. The stateless transport works fine without any new tables.

---

## A/B Testing Workflow

```bash
# Deploy both versions side by side
databricks bundle deploy --target dev          # → v25 app
databricks bundle deploy --target dev-v26      # → v26 app

# Both appear in AI Playground:
#   Tools (2) → mcp-hi-genie-orchestrator-dev-v25
#             → mcp-hi-genie-orchestrator-dev-v26

# Testers select which app to use per conversation
# Compare: latency, tool discovery success, error rates
# OTel traces distinguish via SERVICE_NAME env var
```

### Observability differentiation

```yaml
# app.yaml — distinguish in OTel
env:
  - name: OTEL_SERVICE_NAME
    value: "hi-genie-orchestrator-${var.mcp_spec_version}"
```

This ensures traces in `hi_genie_otel_traces` are tagged with the spec version,
enabling side-by-side latency and error comparisons in the same table.

---

## Migration Path

1. **Now (R1):** Deploy with `2025-11-25` (just the version bump fix)
2. **R1.1:** Implement `transport-v26.ts`, add `dev-v26` target, create Lakebase branch
3. **R1.1 testing:** A/B test both versions in Playground
4. **R2:** When Databricks platform adopts `2026-07-28`, make it the default
5. **R2+:** Implement MCP Apps extension for interactive orchestration UIs

---

## Open Questions

1. **Will Databricks support version negotiation?** If the platform sends
   `MCP-Protocol-Version` in the request header, we could serve both from a
   single app (Option B runtime negotiation) rather than needing two apps.

2. **App SPN isolation:** Each app gets its own SPN. Do both need the same
   Lakebase permissions? (Yes — both write to the same dispatch schema.)

3. **Secret scope sharing:** Both apps need the same SPN credentials. The
   schema-qualified key convention already handles this — both targets read
   from the same keys.

4. **MCP Apps iframe hosting:** If we implement the MCP Apps extension, does
   the server need to serve HTML/JS for the `ui://` resources? Or can it
   point to the existing React client? (Likely needs a separate build artifact
   per app view — the React SPA is too heavy for inline tool results.)
