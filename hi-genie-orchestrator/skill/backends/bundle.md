---
module: backends/bundle
version: 1.0.0
purpose: Declarative Automation Bundle execution backend — setup, execute, validate
depends_on: [core/state-machine]
consumed_by: [capabilities/prompt-synthesis]
---

# Backend: Databricks Bundle

## When to Use

Select this backend when the workstream produces infrastructure-as-code via
Declarative Automation Bundles (`databricks.yml`). Indicators:

- Workstream creates or modifies `resources/*.yml` files
- Workstream writes notebook source in `src/` deployed as bundle resources
- Workstream produces a `deploy.sh` for multi-bundle orchestration
- Output includes bundle variable interpolation (`${var.*}`, `${resources.*}`)
- Project follows the tiered bundle pattern (infra → ai → app)

Do NOT use for one-off SQL execution (use `sql`), notebook cell runs without
deployment (use `notebook`), or authoring SDP/dashboard/Genie space content
(those have their own editor-handoff backends).

## Setup

1. **Identify bundle root.** Read `databricks.yml` to confirm bundle name,
   targets, variables, and resource includes.
2. **Read existing resources.** Scan `resources/` for naming conventions and
   cross-resource references (`${resources.schemas.<name>.*}`).
3. **Read existing source.** Scan `src/` for notebook patterns and conventions.
4. **Determine target.** Which bundle target does this workstream deploy to?
5. **Check conventions:**
   - All resources in `resources/*.yml` (never in `databricks.yml` directly)
   - Schema refs use `${resources.schemas.<name>.*}` (never raw `${var.schema}`)
   - Notebook paths use correct extensions (`.py` for serverless)

## Execute

1. **Author resource YAML** — Create/modify files in `resources/`.
2. **Author source notebooks** — Create/modify files in `src/`.
3. **Validate locally** — `databricks bundle validate --target <target>`.
4. **Deploy** — `databricks bundle deploy --target <target>` (or via deploy.sh).
5. **Run post-deploy jobs** — If the bundle defines post-deploy tasks.

## Validate (Gate Conditions)

- `bundle_validate_passes` — `databricks bundle validate` exits 0
- `resource_exists` — Named resource exists in deployed workspace
- `job_succeeds` — Post-deploy job completes without error
- `file_non_empty` — Source file exists and has content

## MCP Tools

| Tool | Usage |
| --- | --- |
| `get_workstream_context` | Load upstream notes for variable values |
| `update_workstream_status` | Transition IN_PROGRESS → VALIDATING → COMPLETE |
| `append_workstream_notes` | Record deployed resource paths for downstream |
| `get_skill_content` | Load conventions from `core/state-machine` |
