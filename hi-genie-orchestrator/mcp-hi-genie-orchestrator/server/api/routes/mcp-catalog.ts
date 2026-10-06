/**
 * MCP Tool Catalog — REST Discovery Endpoint
 *
 * Exposes GET /api/v1/mcp/tools as a standard REST route that returns
 * the same tool definitions available via the JSON-RPC `tools/list`
 * method on /mcp. This enables:
 *   - Non-MCP consumers (dashboards, SDK generators) to discover tools
 *   - OpenAPI-based documentation of the MCP surface
 *   - Health/readiness checks on tool registration
 *
 * Best practice: the MCP protocol owns tool execution (POST /mcp),
 * but discovery is a read-only operation that benefits from REST
 * accessibility. This avoids requiring JSON-RPC for simple catalog queries.
 */

import { Router, type Request, type Response } from 'express';

// Import tool definitions from MCP tool groups
import { contextToolDefinitions } from '../../mcp/tools/context.js';
import { recordToolDefinitions } from '../../mcp/tools/records.js';
import { stateToolDefinitions } from '../../mcp/tools/state.js';
import { searchToolDefinitions } from '../../mcp/tools/search.js';
import { skillToolDefinitions } from '../../mcp/tools/skill.js';

/**
 * Creates the MCP catalog router.
 * Mounted at /api/v1/mcp by the API index.
 */
export function createMcpCatalogRoutes(): Router {
  const router = Router();

  // Assemble full catalog from all tool groups
  const allTools = [
    ...contextToolDefinitions,
    ...recordToolDefinitions,
    ...stateToolDefinitions,
    ...searchToolDefinitions,
  ];

  // Group tools by category for structured response
  const toolsByCategory: Record<string, string[]> = {
    context: contextToolDefinitions.map((t) => t.name),
    records: recordToolDefinitions.map((t) => t.name),
    state: stateToolDefinitions.map((t) => t.name),
    search: searchToolDefinitions.map((t) => t.name),
  };

  // ── GET /api/v1/mcp/tools — Full tool catalog ────────────────────────────
  router.get('/tools', (_req: Request, res: Response): void => {
    res.status(200).json({
      tools: allTools,
      count: allTools.length,
      categories: toolsByCategory,
      mcp_endpoint: '/mcp',
      protocol_version: '2025-11-25',
      transport: 'Streamable HTTP (JSON-RPC 2.0)',
      usage_hint:
        'For tool execution, use POST /mcp with JSON-RPC: ' +
        '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<tool>","arguments":{...}}}',
    });
  });

  // ── GET /api/v1/mcp/tools/:toolName — Single tool detail ─────────────────
  router.get('/tools/:toolName', (req: Request<{ toolName: string }>, res: Response): void => {
    const toolName = req.params.toolName;
    const tool = allTools.find((t) => t.name === toolName);

    if (!tool) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: `Tool '${toolName}' not found`,
        available_tools: allTools.map((t) => t.name),
      });
      return;
    }

    // Determine which category this tool belongs to
    const categoryEntry = Object.entries(toolsByCategory).find(([, names]) =>
      (names as string[]).includes(toolName),
    );

    res.status(200).json({
      tool,
      category: categoryEntry ? categoryEntry[0] : undefined,
      mcp_endpoint: '/mcp',
      invocation_example: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: {} },
      },
    });
  });

  return router;
}
