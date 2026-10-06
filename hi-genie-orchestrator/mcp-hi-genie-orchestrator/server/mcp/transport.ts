/**
 * MCP Transport Layer — Streamable HTTP
 *
 * Implements the MCP Streamable HTTP transport protocol:
 * - POST /mcp for JSON-RPC 2.0 request/response
 * - GET /mcp for server-initiated SSE notifications
 * - Session management via Mcp-Session-Id header
 * - DELETE /mcp for session termination
 *
 * All requests are user-authorized via OBO (Databricks Apps sidecar).
 */

import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';

// ── Types ───────────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpSession {
  id: string;
  userId: string;
  createdAt: Date;
  lastActiveAt: Date;
  sseResponse?: Response;
  initialized?: boolean;
  methodsReceived?: string[];
}

/**
 * Persona identifies which curated tool subset this transport endpoint exposes.
 * UC MCP Service enforces a max of 20 enabled tools across all servers per user.
 * Each persona endpoint exposes exactly the tools needed for that role.
 * undefined = legacy /mcp endpoint returning all tools.
 */
export type Persona = 'worker' | 'supervisor';

// ── Persona Tool Sets ──────────────────────────────────────────────────────

/**
 * Worker persona (20 tools).
 * Executes workstream tasks: reads context, records events/decisions, manages
 * session and task state, searches prior work for context and precedent.
 * Does NOT need list_projects (dispatcher supplies project_id at assignment)
 * or get_health (connectivity is self-evident from successful tool calls).
 */
const WORKER_TOOLS = new Set<string>([
  // Core context (3)
  'get_project_context',
  'get_workstream_context',
  'get_session_context',
  // Records (6)
  'record_decision',
  'record_session_summary',
  'record_error',
  'record_workstream_event',
  'record_task_attempt',
  'record_task_completion',
  // State (5)
  'update_workstream_status',
  'update_task_status',
  'update_recovery_state',
  'start_session',
  'end_session',
  // Search / research (5)
  'search_context',
  'get_task_history',
  'get_relevant_errors',
  'get_recent_session_summaries',
  'search_decisions',
  // Skill (1)
  'get_skill_content',
]);

/**
 * Supervisor persona (20 tools).
 * Plans, orchestrates, reviews, and monitors. Discovers projects, checks system
 * health, controls workstream lifecycle, and manages the review gate.
 */
const SUPERVISOR_TOOLS = new Set<string>([
  // Context (4)
  'list_projects',
  'get_project_context',
  'get_workstream_context',
  'get_execution_summary',
  // Plans (3)
  'create_plan',
  'get_plan',
  'publish_plan',
  // Orchestration (7)
  'orchestrate_plan',
  'materialize_workstreams',
  'list_workstreams',
  'dispatch_workstream',
  'retry_workstream',
  'pause_workstream',
  'unpause_workstream',
  // Reviews (4)
  'create_review',
  'get_review',
  'deliver_remediation',
  'approve_review',
  // Utility (2)
  'get_skill_content',
  'get_health',
]);

const PERSONA_TOOLS: Record<Persona, Set<string>> = {
  worker: WORKER_TOOLS,
  supervisor: SUPERVISOR_TOOLS,
};

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpToolHandler = (
  params: Record<string, unknown>,
  session: McpSession,
  pool: Pool,
) => Promise<unknown>;

export interface McpToolRegistry {
  definitions: McpToolDefinition[];
  handlers: Map<string, McpToolHandler>;
}

// ── Constants ───────────────────────────────────────────────────────────────

const SESSION_HEADER = 'mcp-session-id';
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SSE_KEEPALIVE_MS = 15_000;
const MAX_SESSIONS = 1000;

const SERVER_INFO = {
  name: 'hi-genie-orchestrator',
  version: '1.0.0',
};

const PROTOCOL_VERSION = '2025-11-25';

// ── JSON-RPC Error Codes ────────────────────────────────────────────────────

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

// ── Session Store ───────────────────────────────────────────────────────────

const sessions = new Map<string, McpSession>();

function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActiveAt.getTime() > SESSION_TTL_MS) {
      if (session.sseResponse) {
        session.sseResponse.end();
      }
      sessions.delete(id);
    }
  }
}

function getOrCreateSession(sessionId: string | undefined, userId: string): McpSession {
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.lastActiveAt = new Date();
    return session;
  }

  // Clean up if at capacity
  if (sessions.size >= MAX_SESSIONS) {
    cleanExpiredSessions();
    if (sessions.size >= MAX_SESSIONS) {
      throw new Error('Maximum session limit reached');
    }
  }

  const newSession: McpSession = {
    id: randomUUID(),
    userId,
    createdAt: new Date(),
    lastActiveAt: new Date(),
  };
  sessions.set(newSession.id, newSession);
  return newSession;
}

function destroySession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (session.sseResponse) {
    session.sseResponse.end();
  }
  sessions.delete(sessionId);
  return true;
}

// ── Transport Helpers ───────────────────────────────────────────────────────

function makeErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

function makeSuccessResponse(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function extractUserId(req: Request): string {
  // Databricks Apps auth sidecar injects x-forwarded-email with the
  // authenticated principal's applicationId (UUID for SPNs, email for humans).
  // UC MCP Service traffic authenticates as the Connection SPN → sidecar
  // resolves to the SPN's applicationId. Per-user OAuth (U2M Per User) on
  // the connection would resolve to the human caller's email instead.
  const identity =
    (req.headers['x-forwarded-email'] as string) ??
    (req.headers['x-forwarded-user'] as string) ??
    'unknown';
  return identity;
}

// ── Protocol Handlers ───────────────────────────────────────────────────────

function handleInitialize(
  requestId: string | number | null,
  _params: Record<string, unknown>,
  session: McpSession,
  _toolRegistry: McpToolRegistry,
): JsonRpcResponse {
  return makeSuccessResponse(requestId, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: SERVER_INFO,
    sessionId: session.id,
  });
}

// ── Caller Identity Injection ────────────────────────────────────────────────
// All tools receive an optional `_caller_identity` parameter at the transport
// level. When the AI Gateway calls tools on behalf of a human user, the model
// passes the caller's email here. The server uses it for RLS (app.user_identity)
// instead of the connection-level SPN identity.
//
// Trust model: acceptable for this system because the MCP Service is only
// reachable via the UC HTTP Connection (requires USE CONNECTION grant to the
// hi-genie-workers-dev group). No unauthenticated path exists.
//
// When account-level Per-user OAuth (U2M) becomes available, this parameter
// becomes redundant and can be removed — the connection will natively forward
// the human's identity via x-forwarded-email.

const CALLER_IDENTITY_PROPERTY = {
  _caller_identity: {
    type: 'string',
    description: 'The email of the human user on whose behalf this tool is being called. Pass the current user\'s email for RLS attribution. Omit only if unknown.',
  },
} as const;

function injectCallerIdentity(definitions: McpToolDefinition[]): McpToolDefinition[] {
  return definitions.map((def) => ({
    ...def,
    inputSchema: {
      ...def.inputSchema,
      properties: {
        ...(def.inputSchema.properties as Record<string, unknown> ?? {}),
        ...CALLER_IDENTITY_PROPERTY,
      },
    },
  }));
}

function handleToolsList(
  requestId: string | number | null,
  _params: Record<string, unknown>,
  toolRegistry: McpToolRegistry,
  allowedTools: Set<string> | null,
): JsonRpcResponse {
  const definitions = allowedTools
    ? toolRegistry.definitions.filter((d) => allowedTools.has(d.name))
    : toolRegistry.definitions;
  return makeSuccessResponse(requestId, {
    tools: injectCallerIdentity(definitions),
  });
}

async function handleToolsCall(
  requestId: string | number | null,
  params: Record<string, unknown>,
  session: McpSession,
  pool: Pool,
  toolRegistry: McpToolRegistry,
  allowedTools: Set<string> | null,
): Promise<JsonRpcResponse> {
  const toolName = params.name as string;
  const toolArgs = (params.arguments as Record<string, unknown>) ?? {};

  if (!toolName) {
    return makeErrorResponse(requestId, RPC_INVALID_PARAMS, 'Missing tool name');
  }

  // Persona enforcement: reject tools not in this endpoint's allowed set.
  // Returns METHOD_NOT_FOUND (same as unknown tool) to avoid leaking tool names.
  if (allowedTools && !allowedTools.has(toolName)) {
    return makeErrorResponse(requestId, RPC_METHOD_NOT_FOUND, `Tool not found: ${toolName}`);
  }

  const handler = toolRegistry.handlers.get(toolName);
  if (!handler) {
    return makeErrorResponse(requestId, RPC_METHOD_NOT_FOUND, `Tool not found: ${toolName}`);
  }

  // ── Caller Identity Override ────────────────────────────────────────────────
  // If the model passes _caller_identity, use it for RLS instead of the
  // connection-level SPN identity. Strip it from args before forwarding to
  // the handler so tool logic doesn't see the transport-level param.
  let effectiveSession = session;
  if (typeof toolArgs._caller_identity === 'string' && toolArgs._caller_identity.length > 0) {
    effectiveSession = { ...session, userId: toolArgs._caller_identity };
  }
  const { _caller_identity: _stripped, ...cleanArgs } = toolArgs;

  try {
    const result = await handler(cleanArgs, effectiveSession, pool);
    return makeSuccessResponse(requestId, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return makeSuccessResponse(requestId, {
      content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
      isError: true,
    });
  }
}

// ── Transport Factory ───────────────────────────────────────────────────────

export interface McpTransportOptions {
  pool: Pool;
  toolRegistry: McpToolRegistry;
  basePath?: string;
  /** Persona-based tool filtering. Omit for the legacy /mcp endpoint (all 39 tools). */
  persona?: Persona;
}

/**
 * Creates the MCP Streamable HTTP transport middleware.
 * Handles POST (JSON-RPC), GET (SSE), and DELETE (session termination).
 */
export function createMcpTransport(options: McpTransportOptions) {
  const { pool, toolRegistry, basePath = '/mcp', persona } = options;
  // null = all tools (legacy endpoint); Set = persona-filtered endpoint
  const allowedTools: Set<string> | null = persona ? PERSONA_TOOLS[persona] : null;

  // Periodic session cleanup
  const cleanupInterval = setInterval(cleanExpiredSessions, SESSION_TTL_MS / 2);
  cleanupInterval.unref();

  /**
   * POST /mcp — JSON-RPC 2.0 request handler
   */
  async function handlePost(req: Request, res: Response): Promise<void> {
    const userId = extractUserId(req);
    const sessionId = req.headers[SESSION_HEADER] as string | undefined;

    const body: JsonRpcRequest | JsonRpcRequest[] = req.body;
    if (!body || typeof body !== 'object') {
      res.status(400).json(makeErrorResponse(null, RPC_PARSE_ERROR, 'Invalid JSON'));
      return;
    }

    const requests = Array.isArray(body) ? body : [body];
    const responses: JsonRpcResponse[] = [];

    let session: McpSession;
    try {
      session = getOrCreateSession(sessionId, userId);
    } catch {
      res.status(503).json(
        makeErrorResponse(null, RPC_INTERNAL_ERROR, 'Session limit reached'),
      );
      return;
    }

    for (const request of requests) {
      if (request.jsonrpc !== '2.0' || !request.method) {
        responses.push(
          makeErrorResponse(request.id ?? null, RPC_INVALID_REQUEST, 'Invalid JSON-RPC request'),
        );
        continue;
      }

      const requestId = request.id ?? null;
      let response: JsonRpcResponse;

      switch (request.method) {
        case 'initialize':
          response = handleInitialize(requestId, request.params ?? {}, session, toolRegistry);
          break;

        case 'initialized':
          // Notification — no response
          continue;

        case 'tools/list':
          response = handleToolsList(requestId, request.params ?? {}, toolRegistry, allowedTools);
          break;

        case 'tools/call':
          response = await handleToolsCall(
            requestId, request.params ?? {}, session, pool, toolRegistry, allowedTools,
          );
          break;

        case 'ping':
          response = makeSuccessResponse(requestId, {});
          break;

        default:
          response = makeErrorResponse(
            requestId, RPC_METHOD_NOT_FOUND, `Method not found: ${request.method}`,
          );
      }

      responses.push(response);
    }

    // Session header on response
    res.setHeader(SESSION_HEADER, session.id);

    if (responses.length === 0) {
      res.status(202).end();
    } else if (responses.length === 1) {
      res.status(200).json(responses[0]);
    } else {
      res.status(200).json(responses);
    }
  }

  /**
   * GET /mcp — SSE endpoint for server-initiated notifications
   */
  function handleGet(req: Request, res: Response): void {
    const sessionId = req.headers[SESSION_HEADER] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: 'Valid Mcp-Session-Id header required' });
      return;
    }

    const session = sessions.get(sessionId)!;
    session.lastActiveAt = new Date();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      [SESSION_HEADER]: session.id,
    });

    session.sseResponse = res;

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keepalive\n\n');
      }
    }, SSE_KEEPALIVE_MS);

    req.on('close', () => {
      clearInterval(keepAlive);
      if (session.sseResponse === res) {
        session.sseResponse = undefined;
      }
    });
  }

  /**
   * DELETE /mcp — Session termination
   */
  function handleDelete(req: Request, res: Response): void {
    const sessionId = req.headers[SESSION_HEADER] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'Mcp-Session-Id header required' });
      return;
    }

    const destroyed = destroySession(sessionId);
    if (destroyed) {
      res.status(200).json({ status: 'session_terminated' });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  }

  /**
   * Express middleware routing by HTTP method.
   */
  function mcpMiddleware(req: Request, res: Response, next: NextFunction): void {
    switch (req.method) {
      case 'POST':
        handlePost(req, res).catch((err) => {
          console.error('[mcp/transport] POST error:', err);
          if (!res.headersSent) {
            res.status(500).json(
              makeErrorResponse(null, RPC_INTERNAL_ERROR, 'Internal server error'),
            );
          }
        });
        break;
      case 'GET':
        handleGet(req, res);
        break;
      case 'DELETE':
        handleDelete(req, res);
        break;
      default:
        res.status(405).json({ error: 'Method not allowed' });
    }
  }

  return { mcpMiddleware, basePath };
}
