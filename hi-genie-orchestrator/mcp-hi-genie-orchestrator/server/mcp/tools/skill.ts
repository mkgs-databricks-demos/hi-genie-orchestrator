/**
 * Skill Tools — get_skill_content + update_skill
 *
 * Standard MCP tool group (McpToolHandler signature).
 *
 * Resolution order for get_skill_content:
 *   1. project_skill_overrides (project_id + section_path) — wins if exists
 *   2. skill_versions WHERE pinned version (from orchestration_id) or is_current
 *   3. Falls back to global (project_id IS NULL)
 *
 * update_skill is protected by:
 *   1. AI Gateway policy deny-list (primary enforcement — blocks worker/reviewer SPNs)
 *   2. In-handler check: verifies caller is NOT a known worker SPN (belt-and-suspenders)
 *
 * Design doc: docs/design/2026-08-23_skill-publishing-and-post-deploy-job.md
 */

import { createHash } from 'crypto';
import type { Pool } from 'pg';
import type { McpToolDefinition, McpToolHandler, McpSession } from '../transport.js';
import { withIdentity } from './identity.js';

// ── Tool Definitions ─────────────────────────────────────────────────────────

export const skillToolDefinitions: McpToolDefinition[] = [
  {
    name: 'get_skill_content',
    description:
      'Load a versioned skill section for this project/role. Composable — call ' +
      'multiple times to load different sections on demand. Returns content, ' +
      'version, source, and available_sections for discovery.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          format: 'uuid',
          description: 'Project ID to scope the skill content lookup.',
        },
        role: {
          type: 'string',
          enum: ['worker', 'reviewer', 'supervisor'],
          description: 'Caller role (informational — does not filter content).',
        },
        section: {
          type: 'string',
          description:
            'Section path to load (e.g., "core/state-machine", "roles/worker").',
        },
        orchestration_id: {
          type: 'string',
          format: 'uuid',
          description:
            'If provided, loads the skill version pinned to this orchestration ' +
            'rather than the current version.',
        },
      },
      required: ['project_id', 'section'],
    },
  },
  {
    name: 'update_skill',
    description:
      'Update a skill section interactively. Only available in interactive ' +
      'human sessions. Automated workers and dispatchers cannot call this tool — ' +
      'calls from worker/reviewer SPNs are rejected. ' +
      'Running the publish job resets to fixture content.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: ['string', 'null'],
          format: 'uuid',
          description:
            'Project ID (null for global). Updates the global skill version ' +
            'visible to all projects without an override.',
        },
        section_path: {
          type: 'string',
          description: 'Section path to update (e.g., "roles/worker").',
        },
        content: {
          type: 'string',
          description: 'New content for the section (full replacement).',
        },
        reason: {
          type: 'string',
          description: 'Why this section is being updated.',
        },
      },
      required: ['section_path', 'content', 'reason'],
    },
  },
];

// ── Handlers ─────────────────────────────────────────────────────────────────

const getSkillContent: McpToolHandler = async (
  params: Record<string, unknown>,
  _session: McpSession,
  pool: Pool,
) => {
  const project_id = params.project_id as string;
  const section = params.section as string;
  const orchestration_id = params.orchestration_id as string | undefined;

  // 1. If orchestration_id provided, resolve pinned version
  let pinnedVersion: number | null = null;
  if (orchestration_id) {
    const orchResult = await pool.query(
      `SELECT skill_version FROM dispatch.orchestrations WHERE orchestration_id = $1`,
      [orchestration_id]
    );
    if (orchResult.rows.length > 0 && orchResult.rows[0].skill_version != null) {
      pinnedVersion = orchResult.rows[0].skill_version;
    }
  }

  // 2. Check project_skill_overrides first (always wins for that project)
  const overrideResult = await pool.query(
    `SELECT content, content_hash, updated_at, updated_by
     FROM dispatch.project_skill_overrides
     WHERE project_id = $1 AND section_path = $2`,
    [project_id, section]
  );

  if (overrideResult.rows.length > 0) {
    const availableSections = await getAvailableSections(pool, project_id);
    return {
      content: overrideResult.rows[0].content,
      version: 'override',
      section_path: section,
      source: 'project_override',
      updated_at: overrideResult.rows[0].updated_at,
      available_sections: availableSections,
    };
  }

  // 3. Load from skill_versions (pinned or current)
  let result;
  if (pinnedVersion !== null) {
    result = await pool.query(
      `SELECT version, section_path, content, content_hash, published_at, published_by, source, project_id
       FROM dispatch.skill_versions
       WHERE section_path = $1
         AND version = $2
         AND (project_id = $3 OR project_id IS NULL)
       ORDER BY project_id NULLS LAST
       LIMIT 1`,
      [section, pinnedVersion, project_id]
    );
  } else {
    result = await pool.query(
      `SELECT id, version, section_path, content, content_hash, published_at, published_by, source
       FROM dispatch.skill_versions
       WHERE section_path = $1
         AND is_current = true
         AND (project_id = $2 OR project_id IS NULL)
       ORDER BY project_id NULLS LAST
       LIMIT 1`,
      [section, project_id]
    );
  }

  if (result.rows.length === 0) {
    const availableSections = await getAvailableSections(pool, project_id);
    return {
      error: 'NOT_FOUND',
      message: `No skill content found for section '${section}'.`,
      available_sections: availableSections,
    };
  }

  const row = result.rows[0];
  const availableSections = await getAvailableSections(pool, project_id);

  return {
    content: row.content,
    version: row.version,
    section_path: row.section_path,
    source: row.project_id ? 'project_version' : 'global_version',
    published_at: row.published_at,
    published_by: row.published_by,
    available_sections: availableSections,
  };
};

/**
 * Known worker/reviewer SPN prefixes — calls from these identities are blocked.
 * Primary enforcement is the AI Gateway deny-list; this is defense-in-depth.
 */
const DENIED_IDENTITY_PREFIXES = [
  'spn-worker-',
  'spn-reviewer-',
  'spn-dispatcher-',
];

function isAutomatedIdentity(userId: string): boolean {
  return DENIED_IDENTITY_PREFIXES.some((prefix) => userId.startsWith(prefix));
}

const updateSkill: McpToolHandler = async (
  params: Record<string, unknown>,
  session: McpSession,
  pool: Pool,
) => {
  const identity = session.userId;

  // 1. Defense-in-depth: reject known automated identities
  if (isAutomatedIdentity(identity)) {
    return {
      error: 'FORBIDDEN',
      message:
        'update_skill is only available in interactive sessions. ' +
        'Automated workers should use the skill version pinned at orchestration creation.',
    };
  }

  const section_path = params.section_path as string;
  const content = params.content as string;
  const reason = params.reason as string;
  const project_id = (params.project_id as string | null) ?? null;
  const contentHash = createHash('sha256').update(content).digest('hex');

  // 2. Get next version number + write in a single identity-scoped transaction
  const newVersion = await withIdentity(pool, identity, async (client) => {
    const versionResult = await client.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM dispatch.skill_versions`
    );
    const version: number = versionResult.rows[0].next_version;

    // Mark previous current for this section as not-current
    await client.query(
      `UPDATE dispatch.skill_versions
       SET is_current = false
       WHERE section_path = $1
         AND is_current = true
         AND (project_id = $2 OR ($2 IS NULL AND project_id IS NULL))`,
      [section_path, project_id]
    );

    // Insert new version (always appends — no dedup)
    await client.query(
      `INSERT INTO dispatch.skill_versions
         (version, section_path, content, content_hash, project_id, published_by, is_current, source)
        VALUES ($1, $2, $3, $4, $5, $6, true, 'interactive')`,
      [version, section_path, content, contentHash, project_id, identity]
    );

    return version;
  });

  return {
    success: true,
    version: newVersion,
    section_path,
    content_hash: contentHash,
    reason,
    note: 'This update is live immediately. Running the publish job will overwrite with fixture content.',
  };
};

// ── Registry ─────────────────────────────────────────────────────────────────

export const skillToolHandlers = new Map<string, McpToolHandler>([
  ['get_skill_content', getSkillContent],
  ['update_skill', updateSkill],
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getAvailableSections(
  pool: Pool,
  projectId: string | null
): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT section_path
     FROM dispatch.skill_versions
     WHERE is_current = true
       AND (project_id = $1 OR project_id IS NULL)
     ORDER BY section_path`,
    [projectId]
  );
  return result.rows.map((r: { section_path: string }) => r.section_path);
}
