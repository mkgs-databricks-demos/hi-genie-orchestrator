/**
 * Supervisor API — Skill Routes
 *
 * REST endpoints for skill content management:
 *   GET  /api/v1/skills/content   — Load a skill section (same logic as MCP tool)
 *   POST /api/v1/skills/publish   — Publish all skill sections as a new version
 *
 * The GET endpoint is the REST equivalent of the `get_skill_content` MCP tool,
 * used by dispatchers and external harnesses that speak REST instead of MCP.
 *
 * The POST endpoint is called by the post-deploy job notebook to publish
 * skill content from workspace fixtures into Lakebase. It always appends a
 * new version unconditionally (no dedup).
 *
 * Design doc: docs/design/2026-08-23_skill-publishing-and-post-deploy-job.md
 */

import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import type { Pool, PoolClient } from 'pg';

// ── Types ────────────────────────────────────────────────────────────────────

interface PublishSection {
  section_path: string;
  content: string;
}

interface PublishBody {
  sections: PublishSection[];
  published_by?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Extract verified identity from request (set by requireVerifiedIdentity middleware).
 */
function getUserIdentity(req: Request): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const identity = (req as any).verifiedIdentity;
  if (!identity) {
    throw new Error('UNVERIFIED_IDENTITY');
  }
  return identity;
}

// ── Route Factory ─────────────────────────────────────────────────────────────

export function createSkillRoutes(pool: Pool): Router {
  const router = Router();

  // ============================================================
  // GET /api/v1/skills/content
  // ============================================================
  router.get('/content', async (req: Request, res: Response) => {
    try {
      const { project_id, section, orchestration_id } = req.query;

      if (!project_id || !section) {
        res.status(400).json({
          error: 'BAD_REQUEST',
          message: 'Required query parameters: project_id, section',
        });
        return;
      }

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

      // 2. Check project_skill_overrides first
      const overrideResult = await pool.query(
        `SELECT content, content_hash, updated_at, updated_by
         FROM dispatch.project_skill_overrides
         WHERE project_id = $1 AND section_path = $2`,
        [project_id, section]
      );

      if (overrideResult.rows.length > 0) {
        const availableSections = await getAvailableSections(pool, project_id as string);
        res.json({
          content: overrideResult.rows[0].content,
          version: 'override',
          section_path: section,
          source: 'project_override',
          updated_at: overrideResult.rows[0].updated_at,
          available_sections: availableSections,
        });
        return;
      }

      // 3. Load from skill_versions
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
          `SELECT version, section_path, content, content_hash, published_at, published_by, source, project_id
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
        const availableSections = await getAvailableSections(pool, project_id as string);
        res.status(404).json({
          error: 'NOT_FOUND',
          message: `No skill content found for section '${section}'.`,
          available_sections: availableSections,
        });
        return;
      }

      const row = result.rows[0];
      const availableSections = await getAvailableSections(pool, project_id as string);

      res.json({
        content: row.content,
        version: row.version,
        section_path: row.section_path,
        source: row.project_id ? 'project_version' : 'global_version',
        published_at: row.published_at,
        published_by: row.published_by,
        available_sections: availableSections,
      });
    } catch (err) {
      console.error('[skills] GET /content error:', err);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load skill content.' });
    }
  });

  // ============================================================
  // POST /api/v1/skills/publish
  // ============================================================
  router.post('/publish', async (req: Request, res: Response) => {
    try {
      const identity = getUserIdentity(req);
      const body = req.body as PublishBody;

      if (!body.sections || !Array.isArray(body.sections) || body.sections.length === 0) {
        res.status(400).json({
          error: 'BAD_REQUEST',
          message: 'Request body must include a non-empty "sections" array.',
        });
        return;
      }

      // Validate each section
      for (const s of body.sections) {
        if (!s.section_path || !s.content) {
          res.status(400).json({
            error: 'BAD_REQUEST',
            message: 'Each section must have "section_path" and "content".',
          });
          return;
        }
      }

      const publishedBy = body.published_by || identity;

      // Always append a new version unconditionally
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.user_identity', $1, true)`, [publishedBy]);

        // Get next version
        const versionResult = await client.query(
          `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM dispatch.skill_versions`
        );
        const newVersion: number = versionResult.rows[0].next_version;

        // Mark all previous current rows as not-current (global only)
        await client.query(
          `UPDATE dispatch.skill_versions
           SET is_current = false
           WHERE is_current = true AND project_id IS NULL`
        );

        // Insert all sections at the new version
        for (const section of body.sections) {
          const contentHash = sha256(section.content);
          await client.query(
            `INSERT INTO dispatch.skill_versions
               (version, section_path, content, content_hash, project_id, published_by, is_current, source)
             VALUES ($1, $2, $3, $4, NULL, $5, true, 'publish')`,
            [newVersion, section.section_path, section.content, contentHash, publishedBy]
          );
        }

        await client.query('COMMIT');

        res.status(201).json({
          success: true,
          version: newVersion,
          sections_published: body.sections.length,
          published_by: publishedBy,
          published_at: new Date().toISOString(),
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((err as any)?.code === '42501') {
        res.status(403).json({
          error: 'FORBIDDEN',
          message: 'RLS policy violation: identity mismatch on INSERT.',
        });
        return;
      }
      console.error('[skills] POST /publish error:', err);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to publish skill version.' });
    }
  });

  return router;
}

// ── Shared Helpers ────────────────────────────────────────────────────────────

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
