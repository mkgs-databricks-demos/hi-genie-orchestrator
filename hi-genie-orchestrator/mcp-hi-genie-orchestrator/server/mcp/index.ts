/**
 * Workstream MCP — Barrel Export
 *
 * Registers the MCP Streamable HTTP transport on five paths:
 *   /mcp/architect  — 14 tools (projects, plans, skills, design decisions)
 *   /mcp/reviewer   — 14 tools (reviews, quality gates, broad read)
 *   /mcp/worker     — 17 tools (records, sessions, task execution)
 *   /mcp/dispatcher — 16 tools (orchestration, workstream lifecycle)
 *   /mcp            — all 40 tools (internal only — NOT a UC MCP Service)
 *
 * UC MCP Service limit = 20 tools. Each persona path is registered as its
 * own UC MCP Service. The full /mcp path is for direct app-to-app calls only.
 *
 * See docs/design/004-four-persona-mcp-split.md for rationale.
 *
 * Import pattern:
 *   import { setupMcpRoutes } from './mcp';
 *
 * Invocation in server.ts onPluginsReady:
 *   await setupMcpRoutes(appkit);
 */

// AppKit type not exported in 0.38.1 — use structural interface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AppKitInstance = any;
import { createMcpTransport } from './transport.js';
import type { McpToolDefinition, McpToolHandler, McpToolRegistry } from './transport.js';

// Tool group imports
import { contextToolDefinitions, contextToolHandlers } from './tools/context.js';
import { recordToolDefinitions, recordToolHandlers } from './tools/records.js';
import { stateToolDefinitions, stateToolHandlers } from './tools/state.js';
import { searchToolDefinitions, searchToolHandlers } from './tools/search.js';
import { skillToolDefinitions, skillToolHandlers } from './tools/skill.js';
import { planToolDefinitions, planToolHandlers } from './tools/plans.js';
import { orchestrationToolDefinitions, orchestrationToolHandlers } from './tools/orchestration.js';
import { reviewToolDefinitions, reviewToolHandlers } from './tools/reviews.js';
import { projectToolDefinitions, projectToolHandlers } from './tools/projects.js';

// ---------------------------------------------------------------------------
// Persona tool sets — authoritative source of truth for the 4-persona split.
// Each set is an INCLUDE list (tools ON that persona's path).
// UC MCP Service max = 20 tools per service.
// ---------------------------------------------------------------------------

/** Architect: projects + plans + skills + design decisions (14 tools) */
const ARCHITECT_TOOLS = new Set([
  'create_project',
  'create_plan', 'get_plan', 'publish_plan',
  'get_skill_content', 'update_skill',
  'record_decision',
  'list_projects', 'get_project_context', 'get_workstream_context',
  'search_decisions', 'get_recent_session_summaries',
  'get_health', 'get_schema_version',
]);

/** Reviewer: review lifecycle + broad read access (14 tools) */
const REVIEWER_TOOLS = new Set([
  'create_review', 'get_review', 'deliver_remediation', 'approve_review',
  'list_projects', 'get_project_context', 'get_workstream_context',
  'search_decisions', 'get_recent_session_summaries',
  'get_relevant_errors', 'get_task_history', 'get_execution_summary',
  'get_health', 'get_schema_version',
]);

/** Worker: task execution + recording + session management (17 tools) */
const WORKER_TOOLS = new Set([
  'record_decision', 'record_session_summary', 'record_error',
  'record_workstream_event', 'record_task_attempt', 'record_task_completion',
  'start_session', 'end_session', 'update_recovery_state',
  'search_context', 'get_session_context',
  'get_skill_content',
  'get_project_context', 'get_workstream_context',
  'get_relevant_errors', 'get_task_history',
  'get_schema_version',
]);

/** Dispatcher: orchestration + workstream/task lifecycle (16 tools) */
const DISPATCHER_TOOLS = new Set([
  'orchestrate_plan', 'materialize_workstreams', 'list_workstreams',
  'dispatch_workstream', 'retry_workstream', 'pause_workstream', 'unpause_workstream',
  'update_workstream_status', 'update_task_status',
  'list_projects', 'get_project_context', 'get_workstream_context',
  'get_task_history', 'get_execution_summary',
  'get_health', 'get_schema_version',
]);

// ---------------------------------------------------------------------------
// Registry builders
// ---------------------------------------------------------------------------

/** All handler maps merged in order */
function mergeAllHandlers(): Map<string, McpToolHandler> {
  const handlers = new Map<string, McpToolHandler>();
  for (const [name, handler] of contextToolHandlers) handlers.set(name, handler);
  for (const [name, handler] of recordToolHandlers) handlers.set(name, handler);
  for (const [name, handler] of stateToolHandlers) handlers.set(name, handler);
  for (const [name, handler] of searchToolHandlers) handlers.set(name, handler);
  for (const [name, handler] of skillToolHandlers) handlers.set(name, handler);
  for (const [name, handler] of planToolHandlers) handlers.set(name, handler);
  for (const [name, handler] of orchestrationToolHandlers) handlers.set(name, handler);
  for (const [name, handler] of reviewToolHandlers) handlers.set(name, handler);
  for (const [name, handler] of projectToolHandlers) handlers.set(name, handler);
  return handlers;
}

/** All tool definitions concatenated */
function allDefinitions(): McpToolDefinition[] {
  return [
    ...contextToolDefinitions,
    ...recordToolDefinitions,
    ...stateToolDefinitions,
    ...searchToolDefinitions,
    ...skillToolDefinitions,
    ...planToolDefinitions,
    ...orchestrationToolDefinitions,
    ...reviewToolDefinitions,
    ...projectToolDefinitions,
  ];
}

/**
 * Builds the full tool registry (all tools — internal /mcp path).
 */
function buildFullRegistry(): McpToolRegistry {
  return { definitions: allDefinitions(), handlers: mergeAllHandlers() };
}

/**
 * Builds an include-based registry: only tools in the given set.
 */
function buildIncludeRegistry(includeSet: Set<string>): McpToolRegistry {
  const defs = allDefinitions().filter((d) => includeSet.has(d.name));
  const allHandlers = mergeAllHandlers();
  const handlers = new Map<string, McpToolHandler>();
  for (const d of defs) {
    const h = allHandlers.get(d.name);
    if (h) handlers.set(d.name, h);
  }
  return { definitions: defs, handlers };
}

/**
 * Sets up the MCP endpoints on the AppKit Express server.
 * Mounts five transports (4 persona paths + 1 internal full path):
 *   /mcp/architect  — 14 tools
 *   /mcp/reviewer   — 14 tools
 *   /mcp/worker     — 17 tools
 *   /mcp/dispatcher — 16 tools
 *   /mcp            — 40 tools (internal, no UC service)
 */
export async function setupMcpRoutes(appkit: AppKitInstance): Promise<void> {
  const pool = appkit.lakebase.pool;

  // Build registries
  const fullRegistry = buildFullRegistry();
  const architectRegistry = buildIncludeRegistry(ARCHITECT_TOOLS);
  const reviewerRegistry = buildIncludeRegistry(REVIEWER_TOOLS);
  const workerRegistry = buildIncludeRegistry(WORKER_TOOLS);
  const dispatcherRegistry = buildIncludeRegistry(DISPATCHER_TOOLS);

  console.log(`[mcp] Full registry: ${fullRegistry.definitions.length} tools`);
  console.log(
    `[mcp] Architect: ${architectRegistry.definitions.length}, ` +
    `Reviewer: ${reviewerRegistry.definitions.length}, ` +
    `Worker: ${workerRegistry.definitions.length}, ` +
    `Dispatcher: ${dispatcherRegistry.definitions.length}`,
  );

  // Create transports
  const full = createMcpTransport({ pool, toolRegistry: fullRegistry, basePath: '/mcp' });
  const architect = createMcpTransport({ pool, toolRegistry: architectRegistry, basePath: '/mcp/architect' });
  const reviewer = createMcpTransport({ pool, toolRegistry: reviewerRegistry, basePath: '/mcp/reviewer' });
  const worker = createMcpTransport({ pool, toolRegistry: workerRegistry, basePath: '/mcp/worker' });
  const dispatcher = createMcpTransport({ pool, toolRegistry: dispatcherRegistry, basePath: '/mcp/dispatcher' });

  appkit.server.extend((app: AppKitInstance['server']['app']) => {
    // Order matters: more-specific paths first to avoid prefix conflicts
    app.use(architect.basePath, architect.mcpMiddleware);
    app.use(reviewer.basePath, reviewer.mcpMiddleware);
    app.use(worker.basePath, worker.mcpMiddleware);
    app.use(dispatcher.basePath, dispatcher.mcpMiddleware);
    app.use(full.basePath, full.mcpMiddleware);
  });

  console.log(
    `[mcp] Workstream MCP ready: /mcp/architect (${architectRegistry.definitions.length}), ` +
    `/mcp/reviewer (${reviewerRegistry.definitions.length}), ` +
    `/mcp/worker (${workerRegistry.definitions.length}), ` +
    `/mcp/dispatcher (${dispatcherRegistry.definitions.length}), ` +
    `/mcp (${fullRegistry.definitions.length} internal)`,
  );
}

// Re-export types for downstream consumers
export type { McpToolDefinition, McpToolHandler, McpToolRegistry, McpSession } from './transport.js';
export { createMcpTransport } from './transport.js';
