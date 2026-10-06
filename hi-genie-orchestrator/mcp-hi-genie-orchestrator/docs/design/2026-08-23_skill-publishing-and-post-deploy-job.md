# Skill Publishing, Post-Deploy Job, and UC MCP Service Registration

**Date:** 2026-08-23  
**Status:** Proposal  
**Scope:** Migration 008, `get_skill_content` + `update_skill` tools, expanded post-deploy job, UC MCP Service registration task

## Summary

This document designs the end-to-end skill publishing flow:

1. A **Lakebase `skill_versions` table** (migration 008) stores versioned skill content
2. A **post-deployment job** publishes skill content from workspace fixtures on first deploy and as a reset mechanism
3. An **`update_skill` MCP tool** allows humans in interactive sessions to update individual skill sections without redeploying
4. The **`get_skill_content` MCP tool + REST endpoint** serve skill content to workers/dispatchers
5. A **UC MCP Service registration task** (in the same post-deploy job) ensures the service exists

---

## 1. Lakebase Schema: `dispatch.skill_versions`

### Table: `dispatch.skill_versions`

```sql
CREATE TABLE dispatch.skill_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version         INTEGER NOT NULL,
  section_path    TEXT NOT NULL,       -- e.g., 'core/state-machine', 'roles/worker', 'capabilities/error-handling'
  content         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,       -- SHA-256 of content (dedup on publish)
  project_id      UUID,               -- NULL = global (default skill); non-NULL = project override
  published_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by    TEXT NOT NULL,       -- identity of publisher (user email or 'deploy-job')
  is_current      BOOLEAN NOT NULL DEFAULT true,
  source          TEXT NOT NULL DEFAULT 'publish', -- 'publish' | 'interactive'

  CONSTRAINT uq_skill_version_section UNIQUE (version, section_path, project_id)
);

CREATE INDEX idx_skill_versions_current ON dispatch.skill_versions (is_current, section_path, project_id)
  WHERE is_current = true;

CREATE INDEX idx_skill_versions_project ON dispatch.skill_versions (project_id, is_current)
  WHERE project_id IS NOT NULL;
```

### Table: `dispatch.project_skill_overrides`

```sql
CREATE TABLE dispatch.project_skill_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL,
  section_path    TEXT NOT NULL,
  content         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT NOT NULL,
  reason          TEXT,               -- why this project diverges from global

  CONSTRAINT uq_project_override UNIQUE (project_id, section_path)
);
```

### Resolution Order

1. `project_skill_overrides` for the specific `(project_id, section_path)` — if exists, wins
2. `skill_versions` WHERE `is_current = true AND project_id = <project_id>` — project-specific published version
3. `skill_versions` WHERE `is_current = true AND project_id IS NULL` — global default

### Version Semantics

- `version` is a monotonically increasing integer (global counter)
- `publish_skill_version` bumps version for ALL sections atomically (full-skill publish)
- Orchestrations pin to a version at creation (`dispatch.orchestrations.skill_version`)
- Pinned workers always read from their pinned version, NOT `is_current`

---

## 2. Execution Tracking Extension (dispatch.executions)

Add columns to the existing `dispatch.executions` table:

```sql
ALTER TABLE dispatch.executions ADD COLUMN IF NOT EXISTS automation_id TEXT;
ALTER TABLE dispatch.executions ADD COLUMN IF NOT EXISTS automation_url TEXT;
ALTER TABLE dispatch.executions ADD COLUMN IF NOT EXISTS worker_prompt_hash TEXT;
ALTER TABLE dispatch.executions ADD COLUMN IF NOT EXISTS skill_version INTEGER;
ALTER TABLE dispatch.executions ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
ALTER TABLE dispatch.executions ADD COLUMN IF NOT EXISTS timeout_threshold_min INTEGER DEFAULT 45;
ALTER TABLE dispatch.executions ADD COLUMN IF NOT EXISTS last_known_phase TEXT;
ALTER TABLE dispatch.executions ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
```

---

## 3. Post-Deployment Job Design

### Job: `post_deploy` (expanded from `post_deploy_tests`)

Renamed from `post_deploy_tests` to `post_deploy` — it now does more than just tests.

```
┌─────────────────────────────────────────────────────────────┐
│ Job Parameter: first_run (default: "false")                 │
└─────────────────────────────────────────────────────────────┘

  Task DAG:

  validate_deployment (always runs)
       │
       ▼
  check_first_run (condition_task — evaluates {{job.parameters.first_run}} == "true")
       │
       ├── TRUE ──▶ publish_skill_version ──▶ register_uc_mcp_service
       │
       └── FALSE ─▶ (end — tests-only run)
```

### Task: `validate_deployment` (existing — no change)

Runs the existing 7-test validation suite. Always runs regardless of `first_run`.

### Task: `check_first_run` (condition_task)

```yaml
- task_key: check_first_run
  depends_on:
    - task_key: validate_deployment
  condition_task:
    op: EQUAL_TO
    left: "{{job.parameters.first_run}}"
    right: "true"
```

### Task: `publish_skill_version`

A Python notebook that:
1. Reads skill section files from `fixtures/skill-content/` (workspace path)
2. Computes SHA-256 hash per section
3. Compares hashes against current version in Lakebase
4. If any section changed (or first publish): bumps version, inserts all sections with new version, marks previous `is_current = false`
5. Reports summary: sections published, version number, any hash-unchanged skips

```yaml
- task_key: publish_skill_version
  depends_on:
    - task_key: check_first_run
      outcome: "true"
  notebook_task:
    notebook_path: ../src/deploy/publish_skill.py
    base_parameters:
      app_name: ${var.app_name}
      secret_scope_name: ${var.secret_scope_name}
      client_id_dbs_key: ${var.client_id_dbs_key}
      client_secret_dbs_key: ${var.client_secret_dbs_key}
      lakebase_project_id: ${var.lakebase_project_id}
      lakebase_branch: ${var.lakebase_branch}
      lakebase_database: databricks_postgres
      skill_fixtures_path: fixtures/skill-content
  environment_key: default
```

**Fixtures layout:**

```
fixtures/skill-content/
├── manifest.json           # Ordered list of section_path → relative file
├── core/
│   ├── state-machine.md
│   ├── decomposition.md
│   ├── dag-builder.md
│   └── prompt-synthesis.md
├── roles/
│   ├── supervisor.md
│   └── worker.md
├── capabilities/
│   ├── error-handling.md
│   ├── governance.md
│   └── detection-fallback.md
├── surfaces/
│   ├── mcp-tools.md
│   └── api-routes.md
└── examples/
    └── bootstrap-templates.md
```

`manifest.json`:
```json
{
  "sections": [
    { "path": "core/state-machine", "file": "core/state-machine.md" },
    { "path": "core/decomposition", "file": "core/decomposition.md" },
    { "path": "roles/worker", "file": "roles/worker.md" },
    ...
  ]
}
```

### Task: `register_uc_mcp_service`

A Python notebook that:
1. Checks if the UC MCP Service already exists (via Databricks SDK or SQL `SHOW SERVICES`)
2. If NOT registered:
   a. Creates the connection (`CREATE CONNECTION IF NOT EXISTS ...`)
   b. Creates the service (`CREATE OR REPLACE SERVICE ...`)
   c. Grants `EXECUTE` to the worker group
3. If already registered: validates tools are discoverable, logs version

```yaml
- task_key: register_uc_mcp_service
  depends_on:
    - task_key: publish_skill_version
  notebook_task:
    notebook_path: ../src/deploy/register_uc_mcp_service.py
    base_parameters:
      catalog: ${var.catalog}
      schema: ${var.schema}
      app_name: ${var.app_name}
      secret_scope_name: ${var.secret_scope_name}
      client_id_dbs_key: ${var.client_id_dbs_key}
      client_secret_dbs_key: ${var.client_secret_dbs_key}
  environment_key: default
```

### Standalone Execution

The `publish_skill_version` task can also be run standalone (without the full post-deploy job) by directly executing the notebook. This serves as the "reset" mechanism — re-read from git-controlled fixtures and republish.

---

## 4. `update_skill` MCP Tool (Interactive-Only)

### Purpose

Allow a human developer working in an interactive Genie Code session (via the UC MCP Service or direct App connection) to update a single skill section in-place, without redeploying or running the publish job.

### Design Constraints

- **MUST** only be callable during an interactive session (`session_type = 'interactive'`)
- **MUST NOT** be callable by automated dispatchers or workers
- **MUST** record provenance (`updated_by`, `source = 'interactive'`)
- **MUST** increment version (single-section update creates a new version)
- The publish job acts as a "reset" — re-running it from fixtures overwrites any interactive edits

### Tool Definition

```typescript
{
  name: 'update_skill',
  description: 'Update a skill section interactively. Only available in interactive human sessions.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', format: 'uuid', description: 'Project ID (null for global)' },
      section_path: { type: 'string', description: 'Section path (e.g., "roles/worker")' },
      content: { type: 'string', description: 'New content for the section' },
      reason: { type: 'string', description: 'Why this section is being updated' }
    },
    required: ['section_path', 'content', 'reason']
  }
}
```

### Enforcement Mechanism

The handler checks the current session's `session_type`:

```typescript
async function updateSkill(params, context) {
  // 1. Verify session is interactive
  const session = await getActiveSession(context.sessionId);
  if (session.session_type !== 'interactive') {
    return {
      error: 'FORBIDDEN',
      message: 'update_skill is only available in interactive sessions. '
             + 'Automated workers should use the skill version pinned at orchestration creation.'
    };
  }

  // 2. Compute content hash
  const contentHash = sha256(params.content);

  // 3. Get current max version
  const currentVersion = await getCurrentVersion(params.project_id);
  const newVersion = currentVersion + 1;

  // 4. Insert new version for this section only
  // (other sections remain at their current version — sparse versioning)
  await pool.query(`
    -- Mark previous as not current
    UPDATE dispatch.skill_versions
    SET is_current = false
    WHERE section_path = $1 AND (project_id = $2 OR (project_id IS NULL AND $2 IS NULL)) AND is_current = true;

    -- Insert new
    INSERT INTO dispatch.skill_versions (version, section_path, content, content_hash, project_id, published_by, is_current, source)
    VALUES ($3, $1, $4, $5, $2, $6, true, 'interactive');
  `, [params.section_path, params.project_id, newVersion, params.content, contentHash, context.identity]);

  return {
    success: true,
    version: newVersion,
    section_path: params.section_path,
    content_hash: contentHash,
    note: 'This update is live immediately. Running the publish job will overwrite with fixture content.'
  };
}
```

### AI Gateway Policy

`update_skill` is **DENIED** in the Worker and Reviewer policies. Only the Supervisor policy (and direct interactive connections) allow it. Since workers always connect via the UC MCP Service with Worker policy, they physically cannot call it.

### Role Access Matrix Update

| Tool | Worker | Reviewer | Supervisor | Interactive |
| --- | --- | --- | --- | --- |
| `get_skill_content` | ✓ | ✓ | ✓ | ✓ |
| `update_skill` | — | — | — | ✓ |

---

## 5. `get_skill_content` Implementation

### MCP Tool (`server/mcp/tools/skill.ts`)

```typescript
{
  name: 'get_skill_content',
  description: 'Load a versioned skill section. Composable — call multiple times for different sections.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', format: 'uuid' },
      role: { type: 'string', enum: ['worker', 'reviewer', 'supervisor'] },
      section: { type: 'string', description: 'Section path (e.g., "core/state-machine")' },
      orchestration_id: {
        type: 'string', format: 'uuid',
        description: 'If provided, loads the skill version pinned to this orchestration'
      }
    },
    required: ['project_id', 'section']
  }
}
```

### Resolution Logic

```typescript
async function getSkillContent(params, context) {
  let version: number | null = null;

  // 1. If orchestration_id provided, use pinned version
  if (params.orchestration_id) {
    const orch = await getOrchestration(params.orchestration_id);
    version = orch.skill_version;
  }

  // 2. Check project_skill_overrides first (always wins for that project)
  const override = await pool.query(`
    SELECT content, content_hash, updated_at
    FROM dispatch.project_skill_overrides
    WHERE project_id = $1 AND section_path = $2
  `, [params.project_id, params.section]);

  if (override.rows.length > 0) {
    return {
      content: override.rows[0].content,
      version: 'override',
      section_path: params.section,
      source: 'project_override',
      available_sections: await getAvailableSections(params.project_id)
    };
  }

  // 3. Load from skill_versions
  const query = version
    ? `SELECT * FROM dispatch.skill_versions WHERE section_path = $1 AND version = $2 AND (project_id = $3 OR project_id IS NULL) ORDER BY project_id NULLS LAST LIMIT 1`
    : `SELECT * FROM dispatch.skill_versions WHERE section_path = $1 AND is_current = true AND (project_id = $2 OR project_id IS NULL) ORDER BY project_id NULLS LAST LIMIT 1`;

  const result = await pool.query(query, version
    ? [params.section, version, params.project_id]
    : [params.section, params.project_id]
  );

  if (result.rows.length === 0) {
    return { error: 'NOT_FOUND', message: `No skill content for section '${params.section}'` };
  }

  return {
    content: result.rows[0].content,
    version: result.rows[0].version,
    section_path: params.section,
    source: result.rows[0].project_id ? 'project_version' : 'global_version',
    available_sections: await getAvailableSections(params.project_id)
  };
}
```

### REST Endpoint (`GET /api/v1/skills/content`)

Same logic, exposed as:
```
GET /api/v1/skills/content?project_id=<uuid>&section=<path>&orchestration_id=<uuid>
```

### REST Endpoint (`POST /api/v1/skills/publish`)

Called by the post-deploy job notebook:
```
POST /api/v1/skills/publish
Body: {
  sections: [
    { section_path: "core/state-machine", content: "...", content_hash: "..." },
    ...
  ],
  published_by: "deploy-job"
}
```

Atomically: bumps version, marks all previous `is_current = false`, inserts new rows.

---

## 6. UC MCP Service Registration Task

### Notebook: `src/deploy/register_uc_mcp_service.py`

Flow:
1. `%pip install --upgrade databricks-sdk` + restart
2. Read job parameters (catalog, schema, app_name, secret keys)
3. Resolve app URL from `w.apps.get(app_name)`
4. Check if connection exists: `SHOW CONNECTIONS LIKE 'hi_genie_orchestrator_conn'`
5. If not: `CREATE CONNECTION ... TYPE MCP URL '<app_url>/mcp' WITH CREDENTIAL (...)`
6. Check if service exists: `SHOW SERVICES IN <catalog>.<schema> LIKE 'orchestrator_mcp'`
7. If not: `CREATE SERVICE <catalog>.<schema>.orchestrator_mcp FROM CONNECTION hi_genie_orchestrator_conn`
8. Verify: list tools via service metadata
9. Grant `EXECUTE` to worker group (idempotent)

### Conditional Execution in Job

The `check_first_run` condition_task gates this. On subsequent deploys (where `first_run = false`), neither the skill publish nor the service registration runs — only the validation tests.

For ad-hoc re-registration or skill reset, either:
- Re-run the job with `first_run = true`
- Run the individual notebook tasks directly

---

## 7. Updated Role Access Matrix (25 tools)

| Tool | Worker | Reviewer | Supervisor | Interactive |
| --- | --- | --- | --- | --- |
| `get_skill_content` | ✓ | ✓ | ✓ | ✓ |
| `update_skill` | — | — | — | ✓ |

All other tools unchanged from `mcp-tools.md`.

---

## 8. Migration 008 Summary

File: `server/migrations/008_skill_versions.ts`

Creates:
- `dispatch.skill_versions` (versioned skill content store)
- `dispatch.project_skill_overrides` (per-project section overrides)
- Adds execution tracking columns to `dispatch.executions`
- RLS policies (INSERT: `published_by = current_setting('app.user_identity')`, SELECT: permissive)
- Indexes for current-version lookup and project scoping

---

## 9. Resolved Decisions

| # | Decision | Resolution |
| --- | --- | --- |
| 1 | `update_skill` creates a new **global version** | Project overrides are a separate mechanism for project-specific customization |
| 2 | Publish job uses **REST** (`POST /api/v1/skills/publish`) | Keeps app-layer validation; no direct Lakebase from notebook |
| 3 | `update_skill` infers session from MCP context | No explicit `session_id` parameter needed |
| 4 | `first_run` **job parameter** gates first-deploy tasks | Simpler, explicit, no file-system dependency |
| 5 | Same job (`post_deploy`) for all post-deploy tasks | Simpler DAG, shared auth context |
| 6 | `publish_skill_version` **always appends** a new version | No hash-based dedup — even duplicates get a new version row. Callable on-demand as a reset. |
| 7 | `publish_skill_version` and `register_uc_mcp_service` run **in parallel** | Both depend on `check_first_run = true`, but not on each other |
