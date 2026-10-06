/**
 * Unit Tests — MCP Tool Catalog Routes
 *
 * Tests GET /api/v1/mcp/tools and GET /api/v1/mcp/tools/:toolName
 * by directly invoking the Express router with mock req/res.
 */

import { describe, it, expect } from 'vitest';
import { createMcpCatalogRoutes } from './mcp-catalog.js';
import type { Request, Response } from 'express';
import type { McpToolDefinition } from '../../mcp/transport.js';

// ── Test Helpers ──────────────────────────────────────────────────────────

interface CatalogListBody {
  tools: McpToolDefinition[];
  count: number;
  categories: Record<string, string[]>;
  mcp_endpoint: string;
  protocol_version: string;
  transport: string;
}

interface CatalogDetailBody {
  tool: McpToolDefinition;
  category: string | undefined;
  mcp_endpoint: string;
  invocation_example: { jsonrpc: string; id: number; method: string; params: { name: string; arguments: Record<string, unknown> } };
}

interface CatalogNotFoundBody {
  error: string;
  message: string;
  available_tools: string[];
}

type MockResponse<Body> = Response & { statusCode: number; body: Body | null };

function createMockRes<Body>(): MockResponse<Body> {
  const res = {
    statusCode: 200,
    body: null as Body | null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: Body) {
      this.body = data;
      return this;
    },
  };
  return res as unknown as MockResponse<Body>;
}

function createMockReq(params: Record<string, string> = {}): Request {
  return { params } as unknown as Request;
}

// A route layer's `route` is only present on layers that wrap an actual
// route (as opposed to middleware); `handle` on those is the innermost
// handler function express-router registered for that method.
interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: Request, res: Response) => void }>;
  };
}

// We need to test the route handlers directly since we're not spinning up Express.
// The router handlers are at index 0 (GET /tools) and 1 (GET /tools/:toolName).

describe('MCP Catalog Routes', () => {
  const router = createMcpCatalogRoutes();

  // Extract route handlers from the router stack
  function getHandler(method: string, path: string): (req: Request, res: Response) => void {
    const stack = (router as unknown as { stack: RouteLayer[] }).stack;
    const layer = stack.find((l) => l.route?.path === path && l.route?.methods[method]);
    const handle = layer?.route?.stack[0]?.handle;
    if (!handle) {
      throw new Error(`No handler registered for ${method.toUpperCase()} ${path}`);
    }
    return handle;
  }

  describe('GET /tools', () => {
    it('returns 200 with tools array', () => {
      const handler = getHandler('get', '/tools');

      const req = createMockReq();
      const res = createMockRes<CatalogListBody>();
      handler(req, res);

      expect(res.statusCode).toBe(200);
      const body = res.body!;
      expect(body.tools).toBeDefined();
      expect(Array.isArray(body.tools)).toBe(true);
      expect(body.count).toBe(body.tools.length);
    });

    it('includes all 5 categories', () => {
      const handler = getHandler('get', '/tools');
      const res = createMockRes<CatalogListBody>();
      handler(createMockReq(), res);

      const body = res.body!;
      expect(body.categories).toHaveProperty('context');
      expect(body.categories).toHaveProperty('records');
      expect(body.categories).toHaveProperty('state');
      expect(body.categories).toHaveProperty('search');
      expect(body.categories).toHaveProperty('skill');
    });

    it('includes mcp_endpoint and protocol_version', () => {
      const handler = getHandler('get', '/tools');
      const res = createMockRes<CatalogListBody>();
      handler(createMockReq(), res);

      const body = res.body!;
      expect(body.mcp_endpoint).toBe('/mcp');
      expect(body.protocol_version).toBe('2025-11-25');
      expect(body.transport).toContain('Streamable HTTP');
    });

    it('each tool has name, description, and inputSchema', () => {
      const handler = getHandler('get', '/tools');
      const res = createMockRes<CatalogListBody>();
      handler(createMockReq(), res);

      const body = res.body!;
      for (const tool of body.tools) {
        expect(tool.name).toBeDefined();
        expect(typeof tool.name).toBe('string');
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe('string');
        expect(tool.inputSchema).toBeDefined();
        expect(typeof tool.inputSchema).toBe('object');
      }
    });

    it('reports 23 tools total', () => {
      const handler = getHandler('get', '/tools');
      const res = createMockRes<CatalogListBody>();
      handler(createMockReq(), res);

      const body = res.body!;
      expect(body.count).toBe(23);
    });
  });

  describe('GET /tools/:toolName', () => {
    it('returns 200 for a known tool', () => {
      const handler = getHandler('get', '/tools/:toolName');

      // Use the first tool from the catalog
      const catalogHandler = getHandler('get', '/tools');
      const catalogRes = createMockRes<CatalogListBody>();
      catalogHandler(createMockReq(), catalogRes);
      const firstTool = catalogRes.body!.tools[0];

      const res = createMockRes<CatalogDetailBody>();
      handler(createMockReq({ toolName: firstTool.name }), res);

      expect(res.statusCode).toBe(200);
      const body = res.body!;
      expect(body.tool.name).toBe(firstTool.name);
      expect(body.category).toBeDefined();
      expect(body.invocation_example).toBeDefined();
      expect(body.invocation_example.method).toBe('tools/call');
    });

    it('returns 404 for unknown tool', () => {
      const handler = getHandler('get', '/tools/:toolName');
      const res = createMockRes<CatalogNotFoundBody>();
      handler(createMockReq({ toolName: 'nonexistent_tool' }), res);

      expect(res.statusCode).toBe(404);
      const body = res.body!;
      expect(body.error).toBe('NOT_FOUND');
      expect(body.available_tools).toBeDefined();
      expect(Array.isArray(body.available_tools)).toBe(true);
    });

    it('includes invocation example with correct tool name', () => {
      const handler = getHandler('get', '/tools/:toolName');

      // Get a real tool name
      const catalogHandler = getHandler('get', '/tools');
      const catalogRes = createMockRes<CatalogListBody>();
      catalogHandler(createMockReq(), catalogRes);
      const toolName = catalogRes.body!.tools[0].name;

      const res = createMockRes<CatalogDetailBody>();
      handler(createMockReq({ toolName }), res);

      const body = res.body!;
      expect(body.invocation_example.params.name).toBe(toolName);
    });
  });
});
