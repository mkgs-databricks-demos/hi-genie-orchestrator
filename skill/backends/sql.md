---
module: backends/sql
version: 1.0.0
purpose: SQL execution backend — setup, execute, validate, teardown
depends_on: [core/state-machine]
consumed_by: [core/prompt-synthesis]
---

# Backend: SQL Execution

## When to Use

Select this backend when the workstream's deliverable is pure SQL — DDL, DML, or query objects. Indicators:

- Workstream creates tables, views, materialized views, or streaming tables
- Workstream defines GRANT statements for access control
- Workstream produces metric views or aggregation layers
- Workstream executes DDL for schema setup (CREATE SCHEMA, CREATE VOLUME)
- The logic is expressible entirely in SQL without Python orchestration

Do NOT use this backend when Python logic wraps the SQL (use notebook backend) or when SQL files are bundle-deployed resources (use bundle backend for the deployment, sql backend only for direct execution).

## Setup Operation

**State transition triggered:** None — setup is pre-claim context gathering.

### Steps

1. **Verify catalog and schema.** Confirm the target namespace exists:
   ```sql
   SELECT 1 FROM information_schema.schemata
   WHERE catalog_name = 'my_catalog' AND schema_name = 'my_schema'
   ```
   Execute via `executeCode` (language: sql). If not found, determine whether to create or BLOCK.

2. **Check existing objects.** Inventory what already exists in the target schema:
   ```sql
   SHOW TABLES IN catalog.schema;
   SHOW VIEWS IN catalog.schema;
   SHOW MATERIALIZED VIEWS IN catalog.schema;
   ```
   This prevents accidental overwrites and identifies naming conflicts.

3. **Verify warehouse/compute.** SQL execution requires:
   - Serverless compute (default, always available)
   - Or a specific SQL warehouse ID (for warehouse-bound operations)
   - Confirm via context or workstream spec

4. **Read existing SQL files (if modifying).** If workstream updates existing SQL:
   ```
   readAssetById(assetType: "file", assetId: "<path_to_sql_file>")
   ```
   Note current DDL patterns, naming conventions, comment styles.

5. **Plan execution order.** SQL statements have dependencies:
   - Schemas before tables
   - Tables before views (that reference them)
   - Tables before grants
   - Base tables before materialized views
   - Identify and order statements to avoid forward-reference errors.

## Execute Operation

**State: IN_PROGRESS throughout.**

### Direct SQL Execution

All SQL executes via `executeCode` with `language: "sql"`:

```sql
-- Always use CREATE OR REPLACE for idempotency
CREATE OR REPLACE TABLE catalog.schema.my_table (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  name STRING NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  metadata VARIANT
)
CLUSTER BY AUTO;
```

### Key Patterns

#### 1. Table Creation (Delta)

```sql
CREATE OR REPLACE TABLE catalog.schema.fact_events (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY,
  event_type STRING NOT NULL,
  payload VARIANT,
  event_ts TIMESTAMP NOT NULL,
  _ingested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
CLUSTER BY AUTO
TBLPROPERTIES (
  'delta.enableChangeDataFeed' = 'true'
);
```

#### 2. Materialized Views

```sql
CREATE OR REPLACE MATERIALIZED VIEW catalog.schema.mv_daily_summary
AS
SELECT
  DATE_TRUNC('DAY', event_ts) AS event_date,
  event_type,
  COUNT(*) AS event_count,
  COUNT(DISTINCT user_id) AS unique_users
FROM catalog.schema.fact_events
GROUP BY 1, 2;
```

#### 3. Streaming Tables

```sql
CREATE OR REPLACE STREAMING TABLE catalog.schema.raw_events
AS SELECT * FROM STREAM read_kafka(...);
```

#### 4. Views

```sql
CREATE OR REPLACE VIEW catalog.schema.v_active_users
AS
SELECT *
FROM catalog.schema.dim_users
WHERE status = 'active'
  AND last_login_at > CURRENT_DATE() - INTERVAL 30 DAYS;
```

#### 5. Grants

```sql
-- Schema-level access
GRANT USE SCHEMA ON SCHEMA catalog.schema TO `group_name`;
GRANT SELECT ON SCHEMA catalog.schema TO `group_name`;

-- Table-level access
GRANT SELECT ON TABLE catalog.schema.my_table TO `service_principal`;
GRANT MODIFY ON TABLE catalog.schema.my_table TO `etl_service_principal`;

-- All privileges (for service principals)
GRANT ALL PRIVILEGES ON SCHEMA catalog.schema TO `sp_name`;
```

#### 6. Schema and Volume Creation

```sql
CREATE SCHEMA IF NOT EXISTS catalog.schema
COMMENT 'Schema for workstream outputs';

CREATE VOLUME IF NOT EXISTS catalog.schema.my_volume
COMMENT 'Volume for file storage';
```

### Execution Rules

1. **Fully qualify ALL names.** Always `catalog.schema.object` — never bare `object` names.
2. **Use CREATE OR REPLACE** for idempotency (safe re-execution on retry).
3. **Use IF NOT EXISTS** for additive objects (schemas, volumes) that should not be replaced.
4. **Execute statements one at a time.** Each `executeCode` call contains ONE SQL statement. Multi-statement scripts are not supported.
5. **Execute in dependency order.** Schemas → Tables → Views/MVs → Grants.
6. **Check results after each statement.** Verify no errors before proceeding.

### Writing SQL Files (for persistence)

When the workstream must persist SQL as files (for bundle source or documentation):

```
editAsset(
  asset: {type: "file", id: "<workspace_path>.sql", name: "ddl.sql"},
  operation: "update",
  content: [{patches: [{old_text: "", new_text: "<sql_content>", replace_all: false}]}]
)
```

### Tool Usage Patterns

| Action | Tool | Key Parameters |
| --- | --- | --- |
| Execute SQL | `executeCode` | `language: "sql"`, single statement |
| Read existing SQL file | `readAssetById` (file) | Full workspace path |
| Write SQL file | `editAsset` (file) | Workspace path, patches |
| Verify table exists | `executeCode` (sql) | `DESCRIBE TABLE catalog.schema.t` |
| Check row counts | `executeCode` (sql) | `SELECT COUNT(*) FROM ...` |

## Validate Operation

**State transition: IN_PROGRESS → VALIDATING** (set via editAsset on status file).

### Checks

1. **Tables exist and are describable:**
   ```sql
   DESCRIBE TABLE EXTENDED catalog.schema.my_table;
   ```
   Must return schema information without error.

2. **Row counts meet expectations:**
   ```sql
   SELECT COUNT(*) AS cnt FROM catalog.schema.my_table;
   ```
   For DDL-only workstreams, `cnt >= 0` is sufficient (table exists, may be empty).
   For ETL workstreams, `cnt > 0` is required.

3. **Materialized views listed:**
   ```sql
   SHOW MATERIALIZED VIEWS IN catalog.schema;
   ```
   Verify expected MVs appear in the list.

4. **Grants applied:**
   ```sql
   SHOW GRANTS ON TABLE catalog.schema.my_table;
   ```
   Verify expected principals have expected privileges.

5. **Views queryable:**
   ```sql
   SELECT * FROM catalog.schema.v_my_view LIMIT 1;
   ```
   Must execute without error (confirms view definition is valid).

### Validation Decision

- ALL checks pass → transition to COMPLETE
- Table not found (but was just created) → likely eventual consistency, retry once
- Permission denied during validation → BLOCKED
- Syntax error in view (but DDL reported success) → fix view definition, RETRY

## Teardown Operation

**State: Only on failure path.**

SQL execution with `CREATE OR REPLACE` is inherently idempotent — teardown is rarely needed. However:

1. **Orphaned objects from partial execution:** If 3 of 5 tables were created before failure, do NOT drop them. The retry will `CREATE OR REPLACE` them.

2. **Broken views:** If a view was created with wrong logic:
   ```sql
   DROP VIEW IF EXISTS catalog.schema.v_broken_view;
   ```
   Then recreate on retry.

3. **General rule:** `CREATE OR REPLACE` handles its own cleanup. Only `DROP` when an object is fundamentally wrong (wrong name, wrong schema).

## State Transitions This Backend Triggers

| Phase | Transition | editAsset Pattern |
| --- | --- | --- |
| Claim | NOT_STARTED → IN_PROGRESS | `old: "status: NOT_STARTED"` → `new: "status: IN_PROGRESS"` |
| Post-execute | IN_PROGRESS → VALIDATING | `old: "status: IN_PROGRESS"` → `new: "status: VALIDATING"` |
| Validation pass | VALIDATING → COMPLETE | `old: "status: VALIDATING"` → `new: "status: COMPLETE"` |
| Unrecoverable error | IN_PROGRESS → BLOCKED | `old: "status: IN_PROGRESS"` → `new: "status: BLOCKED"` |

Never set: NOT_STARTED, GATED, RETRYING (per core/state-machine Backend Contract).

## Error Handling

| Error Category | Example | Response | Retriable? |
| --- | --- | --- | --- |
| Syntax error | `PARSE_SYNTAX_ERROR at line 5` | Fix SQL, re-execute | Yes (self-correct) |
| Schema not found | `SCHEMA_NOT_FOUND: catalog.bad_schema` | Verify schema, create if appropriate | Conditional |
| Table not found | `TABLE_OR_VIEW_NOT_FOUND` | Check dependency order, re-execute in order | Yes (self-correct) |
| Permission denied | `PERMISSION_DENIED: CREATE TABLE` | Set BLOCKED with GRANT instructions | No |
| Column type mismatch | `cannot cast STRING to INT` | Fix column definition or cast | Yes (self-correct) |
| Duplicate column | `Found duplicate column(s)` | Fix DDL, re-execute | Yes (self-correct) |
| Object already exists (no REPLACE) | `RESOURCE_ALREADY_EXISTS` | Add OR REPLACE, re-execute | Yes (self-correct) |
| Warehouse unavailable | `TEMPORARILY_UNAVAILABLE` | Retry after brief wait | Yes (1 retry) |

### Self-Correction Protocol

1. Parse the SQL error message and line number
2. Identify the specific issue (syntax, missing object, wrong type)
3. Fix the SQL statement
4. Re-execute the fixed statement
5. If same error after 2 fix attempts → search documentation for correct syntax
6. If still failing → set BLOCKED with full error and attempted fixes

## Prompt Injection Template

The following text is injected into the worker prompt's EXECUTE section when this backend is selected:

```
### Execution Backend: sql-execution

You are executing SQL statements against Databricks. Follow these steps:

1. Verify the target catalog and schema exist:
   `SELECT 1 FROM information_schema.schemata WHERE catalog_name = '...' AND schema_name = '...'`
2. Check what already exists: `SHOW TABLES IN catalog.schema`
3. Execute SQL statements ONE AT A TIME via executeCode (language: "sql").
4. Execute in dependency order: schemas → tables → views/MVs → grants.
5. After all statements execute, validate:
   - `DESCRIBE TABLE EXTENDED` for each table
   - `SELECT COUNT(*)` for expected data
   - `SHOW GRANTS` for access control verification

Conventions:
- ALWAYS fully qualify: catalog.schema.object (never bare names)
- ALWAYS use CREATE OR REPLACE for tables, views, MVs (idempotency)
- Use IF NOT EXISTS for schemas and volumes (additive, never replace)
- One SQL statement per executeCode call (multi-statement not supported)
- CLUSTER BY AUTO for all Delta tables
- Enable CDF where change tracking needed: TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true')

On error: self-correct up to 2 times per statement. If stuck, search docs for correct syntax. If still failing, set BLOCKED.
```
