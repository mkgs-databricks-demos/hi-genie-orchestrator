---
module: backends/sql
version: 1.0.0
purpose: SQL execution backend — setup, execute, validate
depends_on: [core/state-machine]
consumed_by: [capabilities/prompt-synthesis]
---

# Backend: SQL Execution

## When to Use

Select this backend when the workstream's deliverable is pure SQL — DDL, DML,
or query objects. Indicators:

- Workstream creates tables, views, materialized views, or streaming tables
- Workstream defines GRANT statements for access control
- Workstream produces metric views or aggregation layers
- Workstream executes DDL for schema setup (CREATE SCHEMA, CREATE VOLUME)
- Logic is expressible entirely in SQL without Python orchestration

Do NOT use when Python wraps the SQL (use `notebook`) or when SQL files are
bundle-deployed resources (use `bundle` for deployment, `sql` for direct execution).

## Setup

1. **Verify catalog and schema** — Confirm target namespace exists.
2. **Check existing objects** — Inventory tables/views in target schema.
3. **Identify dependencies** — Source tables that must exist, permissions needed.
4. **Determine execution method** — `executeCode` (language: sql) or SQL query asset.

## Execute

1. **Write DDL/DML statements** — Author SQL via `executeCode` or saved queries.
2. **Execute in order** — Tables before views, views before grants.
3. **Handle idempotency** — Use `CREATE OR REPLACE` / `CREATE IF NOT EXISTS`.
4. **Verify execution** — Each statement completes without error.

## Validate (Gate Conditions)

- `table_exists` — `SELECT 1 FROM information_schema.tables WHERE ...`
- `table_has_rows` — `SELECT COUNT(*) > 0 FROM target_table`
- `view_compiles` — View definition resolves without error
- `grant_applied` — `SHOW GRANTS ON table` shows expected permissions
- `column_exists` — Schema matches expected column set

## MCP Tools

| Tool | Usage |
| --- | --- |
| `get_workstream_context` | Load upstream schema/catalog names |
| `update_workstream_status` | Transition through lifecycle |
| `append_workstream_notes` | Record created object paths for downstream |
| `get_skill_content` | Load SQL conventions, governance rules |
