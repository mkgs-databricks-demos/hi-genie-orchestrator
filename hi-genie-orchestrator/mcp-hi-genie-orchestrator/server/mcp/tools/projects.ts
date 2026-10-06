/**
 * MCP Tools — Project Lifecycle (Architect Persona)
 *
 * The entry point for all work in the Hi Genie Orchestrator. A project is the
 * root entity that plans, workstreams, sessions, decisions, and errors belong to.
 *
 * Persona: architect
 * Tools:
 *   - create_project — Create a new project (returns project_id for subsequent tools)
 *
 * Design notes:
 *   - This is intentionally the ONLY MCP tool for project management.
 *   - update_project, archive_project, transfer_ownership are REST API-only
 *     operations for the management UI (not part of the agent workflow).
 *   - The architect calls create_project as the first step when starting new work,
 *     then uses the returned project_id for create_plan, record_decision, etc.
 */

import type { Pool } from 'pg';
import type { McpToolDefinition, McpToolHandler } from '../transport.js';
import { createProject as createProjectService } from '../../services/projects.service.js';

// ── Tool Definitions ────────────────────────────────────────────────────────────

export const projectToolDefinitions: McpToolDefinition[] = [
  {
    name: 'create_project',
    description:
      'Create a new project. This is the first step when starting any new body of work. ' +
      'Returns the project_id UUID which is required by all subsequent tools ' +
      '(create_plan, record_decision, start_session, etc.). ' +
      'A project is the root scope for plans, workstreams, sessions, and decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable project name (1-255 chars). e.g. "Payment Gateway Migration"',
        },
        description: {
          type: 'string',
          description: 'Optional longer description of the project goals and scope',
        },
        tags: {
          type: 'object',
          description: 'Optional key-value tags for categorization (e.g. {"domain": "payments", "priority": "high"})',
        },
      },
      required: ['name'],
    },
  },
];

// ── Tool Handlers ───────────────────────────────────────────────────────────────

const handleCreateProject: McpToolHandler = async (params, session, pool) => {
  const { name, description, tags } = params as {
    name: string;
    description?: string;
    tags?: Record<string, unknown>;
  };

  const result = await createProjectService(pool as Pool, session.userId, {
    name,
    description,
    tags,
  });

  if (!result.ok) {
    throw new Error(`[${result.error}] ${result.message}`);
  }

  const project = result.data.project;
  return {
    project,
    message:
      `Project "${project.name}" created successfully. ` +
      `Use project_id: ${project.project_id} for all subsequent operations ` +
      `(create_plan, record_decision, start_session, etc.).`,
  };
};

// ── Export Handler Map ───────────────────────────────────────────────────────────

export const projectToolHandlers: Map<string, McpToolHandler> = new Map([
  ['create_project', handleCreateProject],
]);
