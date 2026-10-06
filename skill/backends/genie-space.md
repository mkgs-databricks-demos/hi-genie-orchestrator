---
module: backends/genie-space
version: 1.0.0
purpose: Genie Space / Agent execution backend via the Genie editor — setup, execute, validate, teardown
depends_on: [core/state-machine]
consumed_by: [core/prompt-synthesis]
---

# Backend: Genie Space Editor

## When to Use

Select this backend when the workstream's primary deliverable is a Genie space (AI-powered natural-language analytics interface over Unity Catalog tables). Indicators:

- Workstream spec mentions "Genie space", "Genie agent", "NL-to-SQL", "conversational analytics", or "ask questions about your data"
- A declared `output_artifact` has type `genie_space`
- The deliverable lets end-users query data using natural language without writing SQL

**Genie space instruction and benchmark tuning is most effective from the Genie editor page.** While `createAsset` can produce the initial space, configuring sample questions, curated SQL instructions, trust filters, and verified answers works best from the Genie space's own editor, which has specialized configuration tools. This backend hands instruction/benchmark authoring off to that page.

> **Bundle engine requirement:** The `genie_spaces` bundle resource type requires the *direct deployment engine*. Add `engine: direct` to the `bundle:` block in `databricks.yml` before deploying any genie space resource.

## Setup Operation

**State transition triggered:** None — setup is pre-claim context gathering.

### Steps

1. **Check for an existing Genie space.** Read upstream notes / plan.json for a `genie_space_id`. If none, this workstream creates one.
2. **Collect table identifiers** from upstream notes or the workstream spec — each table must be fully qualified `catalog.schema.table` and accessible via Unity Catalog.
3. **Read existing Genie space resource files** in `resources/genie_spaces/*.yml` (if any) for naming conventions in this project.
4. **Identify the SQL warehouse** (from plan-level backend config or workstream spec) — required by the bundle resource definition.
5. **Confirm the direct deployment engine** is declared in `databricks.yml` — if not, add it before proceeding.

## Execute Operation

**State: IN_PROGRESS throughout.**

This backend's Execute phase has two parts that MUST happen in order.

### Part 1: Create the Space and Hand Off Configuration (mandatory handoff)

1. Create the Genie space:
   ```
   createAsset({
     asset: {
       assetType: "genie",
       name: "<space name>",
       tableIdentifiers: [
         "catalog.schema.table1",
         "catalog.schema.table2"
       ]
     }
   })
   ```
   Note the returned space ID.

2. Hand off instruction / benchmark tuning to the Genie space editor:
   ```
   openAsset({
     assetType: "genie",
     assetId: "<genie_space_id>",
     navigate: true,
     continueMessage: "<intent and context>"
   })
   ```
   The `continueMessage` should describe: the business domain, which tables and columns are most important, the kinds of questions end-users will ask, desired sample questions to seed, and any curated SQL patterns or trust filters to configure. The Genie editor agent can configure these interactively.

3. The Genie editor session configures sample questions, instructions, and curated SQL. This workstream's session cannot configure Genie space internals remotely.

### Part 2: Capture in the Bundle (still required)

4. Write the Genie space resource to `resources/genie_spaces/*.yml`. The space definition (including its configuration) lives in a `.geniespace.json` file:
   ```yaml
   resources:
     genie_spaces:
       my_space:
         title: "My Analytics Space"
         description: "Ask questions about my project's data in natural language"
         warehouse_id: ${var.warehouse_id}
         file_path: ../src/genie_spaces/my_space.geniespace.json
         permissions:
           - level: CAN_RUN
             group_name: users
   ```
   If the space was created ad hoc, use `bundle generate genie-space --existing-id <id>` (via `runDatabricksCli`) to export its configuration to the `.geniespace.json` file and generate resource YAML, then bind it:
   ```
   runDatabricksCli("bundle generate genie-space --existing-id <genie_space_id>")
   runDatabricksCli("bundle deployment bind genie_spaces.my_space <genie_space_id>")
   ```
5. Confirm `engine: direct` is present in the `bundle:` block of `databricks.yml` — `genie_spaces` resources only deploy with the direct engine.
6. Run `databricks bundle validate --target ${bundle_target}` and `databricks bundle deploy --target ${bundle_target}` via `runDatabricksCli`.

### Tool Usage Patterns

| Action | Tool | Key Parameters |
| --- | --- | --- |
| Create Genie space | `createAsset` | `{assetType: "genie", tableIdentifiers: [...]}` |
| Hand off instruction tuning | `openAsset` | `{assetType: "genie", assetId, continueMessage}` |
| Capture existing space into bundle | `runDatabricksCli` | `bundle generate genie-space --existing-id <id>` |
| Bind to bundle | `runDatabricksCli` | `bundle deployment bind genie_spaces.<key> <id>` |
| Validate / deploy | `runDatabricksCli` | `bundle validate` / `bundle deploy --target X` |

## Validate Operation

**State transition: IN_PROGRESS → VALIDATING** (set via editAsset on status file).

### Checks

1. `bundle validate` exits clean (confirms `engine: direct` is present and resource YAML is valid).
2. Genie space is accessible: `readAssetById(assetType: "dataroom", assetId: "<genie_space_id>")` returns the space.
3. Space has at least one data source (table) configured — verify via the returned dataroom metadata.
4. At least one sample question exists (non-empty configuration — indicates the handoff session completed its tuning step).

### Validation Decision

- ALL checks pass → transition to COMPLETE
- Genie editor session still configuring → RETRYING (allow handoff session to finish)
- `bundle validate` fails with engine error → add `engine: direct` to `databricks.yml`, re-validate
- Space not found → verify `genie_space_id`, re-search with `searchAssets`

## Teardown Operation

**State: Only on failure path.**

1. **Failed configuration:** Leave the partially configured space in place — it is harmless and the next attempt can resume tuning via the Genie editor.
2. **Failed bundle capture:** Safe to retry `bundle generate` / `bundle deployment bind` — idempotent.
3. **Engine misconfiguration:** Fix `databricks.yml` to add `engine: direct`, then re-deploy. Do not destroy.

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
| Handoff not yet resolved | Space has no sample questions / tuning not done | RETRYING — re-check on next tick | Yes |
| Wrong deployment engine | `genie_spaces requires direct engine` | Add `engine: direct` to `databricks.yml`, re-validate | Yes (self-correct) |
| Table not accessible | Table not found in Unity Catalog | Verify table path, ensure grants; update `tableIdentifiers` | Yes (self-correct) |
| Permission denied | `PERMISSION_DENIED: cannot create genie space` | Set BLOCKED with grant instructions | No |
| Bundle generate fails | Space ID not found | Verify `genie_space_id` from `createAsset` result | Yes (self-correct) |

### Self-Correction Protocol

1. Engine / YAML errors: fix `databricks.yml` or resource YAML, re-validate (up to 2 attempts).
2. Tuning/configuration issues: re-route to the Genie space editor via `openAsset`.
3. If still failing → BLOCKED with context.

## Prompt Injection Template

The following text is injected into the worker prompt's EXECUTE section when this backend is selected:

```
### Execution Backend: genie-space-editor

You are building a Genie Space. You create the space and then hand off instruction/benchmark tuning:

1. Create the Genie space: createAsset (assetType: "genie", name: "${workstream_name}",
   tableIdentifiers: <list of fully-qualified catalog.schema.table names from workstream spec>).
2. Hand off configuration: openAsset (assetType: "genie", assetId: <id>, continueMessage:
   describing the domain, key columns, expected question types, desired sample questions,
   and any curated SQL patterns or trust filters — intent and data context only).
3. Once the Genie editor session reports the space is configured, capture it into the bundle:
   `bundle generate genie-space --existing-id <id>` + `bundle deployment bind genie_spaces.<key> <id>`.
   Write resources/genie_spaces/*.yml and ensure `databricks.yml` has `engine: direct` under `bundle:`.
   Then `bundle validate --target ${bundle_target}` and `bundle deploy --target ${bundle_target}`.
4. Validate: space is accessible, has data sources and sample questions, bundle validate exits clean.

Critical: genie_spaces resources require `engine: direct` in databricks.yml. If missing, add it before
bundle deploy.

On error: if the failure is a configuration/tuning issue, re-route to the Genie editor.
For bundle-capture errors, self-correct up to 2 times.
```
