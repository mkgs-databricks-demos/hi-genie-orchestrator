---
module: backends/dashboard
version: 1.0.0
purpose: AI/BI Dashboard execution backend via the dashboard draft-canvas editor — setup, execute, validate, teardown
depends_on: [core/state-machine]
consumed_by: [core/prompt-synthesis]
---

# Backend: Dashboard Editor

## When to Use

Select this backend when the workstream's primary deliverable is an AI/BI Dashboard. Indicators:

- Workstream spec mentions "dashboard", "visualization", "charts", "widgets", or "BI report"
- A declared `output_artifact` has type `dashboard`
- The deliverable presents metrics/data to end-users as an interactive visual layer

**Widget editing capabilities only exist on the dashboard draft-canvas page.** A generic session cannot add, configure, or lay out widgets. This backend's job is to hand authoring off to that page and then fold the resulting `.lvdash.json` file into the bundle — not to construct dashboard JSON directly.

## Setup Operation

**State transition triggered:** None — setup is pre-claim context gathering.

### Steps

1. **Check for an existing dashboard.** Read upstream notes / plan.json for a `dashboard_id`. If none, this workstream creates one.
2. **Read upstream notes** for source tables, target metrics, and visual layout requirements from the architecture doc or workstream spec.
3. **Read existing dashboard resource files** in `resources/dashboards/*.yml` (if any) for naming conventions in this project.
4. **Identify the target catalog/schema and SQL warehouse** (from plan-level backend config) — both are required by the bundle resource definition.

## Execute Operation

**State: IN_PROGRESS throughout.**

This backend's Execute phase has two parts that MUST happen in order.

### Part 1: Author via the Dashboard Draft Canvas (mandatory handoff)

1. If no dashboard exists yet:
   ```
   createAsset({asset: {assetType: "dashboard", name: "<dashboard name>"}})
   ```
   Do not open this asset to edit it here — widget creation is not available in a generic session.

2. Hand off widget authoring to the dashboard draft canvas:
   ```
   openAsset({
     assetType: "dashboard",
     assetId: "<dashboard_id>",
     navigate: true,
     continueMessage: "<intent and context>"
   })
   ```
   The `continueMessage` should describe: what the dashboard should show (metrics, dimensions, time ranges), which tables/views to query, and the desired layout/widget types. The destination agent has specialized widget-creation tools unavailable here.
   Include the workstream's `done_signal` so the dashboard agent knows what "done" means.

3. The dashboard editor session adds datasets and widgets. This workstream's session cannot edit dashboard widgets remotely.

### Part 2: Export and Capture in the Bundle (still required)

4. After the dashboard editor session is done, export the dashboard definition as a `.lvdash.json` file and add it to the bundle at `src/<name>.lvdash.json` (via `runDatabricksCli`):
   ```
   runDatabricksCli("bundle generate dashboard --existing-id <dashboard_id>")
   ```
   This writes the `.lvdash.json` to the source tree and creates the corresponding resource YAML. Verify the generated file exists and is non-empty.

5. If you must declare the resource manually (e.g., the generated file needs adjusting), the resource shape is:
   ```yaml
   resources:
     dashboards:
       my_dashboard:
         display_name: "My Dashboard"
         file_path: ../src/my_dashboard.lvdash.json
         warehouse_id: ${var.warehouse_id}
         dataset_catalog: ${var.catalog}
         dataset_schema: ${var.schema}
   ```
   > **Important:** Add the `.lvdash.json` to the bundle `sync.exclude` list to prevent it being synced as a raw file (which would conflict with the `dashboards` resource):
   > ```yaml
   > sync:
   >   exclude:
   >     - src/*.lvdash.json
   > ```

6. Run `databricks bundle validate --target ${bundle_target}` and `databricks bundle deploy --target ${bundle_target}` via `runDatabricksCli` to confirm the resource is captured.

7. **UI edits after bundle deploy:** If the dashboard is later edited via the UI, the local `.lvdash.json` will diverge. Use `bundle generate dashboard --existing-id <id> --watch` to continuously sync UI changes back to the file. Alert the workstream's notes so downstream editors know this.

### Tool Usage Patterns

| Action | Tool | Key Parameters |
| --- | --- | --- |
| Create empty dashboard | `createAsset` | `{assetType: "dashboard", name: ...}` |
| Hand off widget authoring | `openAsset` | `{assetType: "dashboard", assetId, continueMessage}` |
| Export definition to bundle | `runDatabricksCli` | `bundle generate dashboard --existing-id <id>` |
| Validate / deploy | `runDatabricksCli` | `bundle validate` / `bundle deploy --target X` |
| Verify file exists | `readAssetById` | `{assetType: "file", assetId: "<lvdash.json path>"}` |

## Validate Operation

**State transition: IN_PROGRESS → VALIDATING** (set via editAsset on status file).

### Checks

1. `src/<name>.lvdash.json` exists and is non-empty: `readAssetById(assetType: "file", assetId: "<path>")`.
2. Dashboard resource is declared in `resources/dashboards/*.yml` and `bundle validate` exits clean.
3. Dashboard is accessible: `readAssetById(assetType: "dashboard", assetId: "<dashboard_id>")` returns the dashboard.
4. Dashboard has at least one dataset and one widget (non-empty canvas — verify via the returned dashboard's widget/dataset counts if available).

### Validation Decision

- ALL checks pass → transition to COMPLETE
- Dashboard editor session still authoring → RETRYING (allow handoff session to finish)
- `.lvdash.json` is empty or missing after `bundle generate` → BLOCKED with error: dashboard may not have been fully authored
- Bundle validate error referencing dashboard resource → fix YAML, re-validate

## Teardown Operation

**State: Only on failure path.**

1. **Failed dashboard authoring:** Leave the empty dashboard in place — empty dashboards are harmless; retry via a new editor handoff.
2. **Stale `.lvdash.json`:** Run `bundle generate` again to re-export. Do not manually edit the JSON.
3. **General rule:** Dashboard resources are safe to leave on failure; they are non-destructive.

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
| Handoff not yet resolved | Dashboard still empty / no widgets | RETRYING — re-check on next tick | Yes |
| Missing `.lvdash.json` after export | `bundle generate` finds no matching dashboard | Verify dashboard_id is correct; re-export | Yes (self-correct) |
| Local/remote divergence | Deploy fails because UI edited after deploy | Re-export with `bundle generate`, then redeploy | Yes (self-correct) |
| Permission denied | `PERMISSION_DENIED: cannot create dashboard` | Set BLOCKED with grant instructions | No |
| Warehouse not found | `warehouse_id` not accessible | Set BLOCKED with required warehouse details | No |

### Self-Correction Protocol

1. For export/YAML errors: fix and re-run `bundle generate` + `bundle validate` (up to 2 attempts).
2. For widget/content issues: re-route to the dashboard editor via `openAsset`.
3. If still failing → BLOCKED with context.

## Prompt Injection Template

The following text is injected into the worker prompt's EXECUTE section when this backend is selected:

```
### Execution Backend: dashboard-editor

You are building an AI/BI Dashboard. You do NOT author widgets yourself:

1. If no dashboard exists: createAsset (assetType: "dashboard", name: "${workstream_name}").
2. Hand off widget authoring: openAsset (assetType: "dashboard", assetId: <id>, continueMessage:
   describing the metrics to show, source tables/views, and desired layout — intent only, no JSON or
   widget-spec details).
3. Once the dashboard editor session reports widgets are complete, export and capture it into the bundle:
   `bundle generate dashboard --existing-id <id>` (writes src/*.lvdash.json), then add that file to the
   dashboard resource in resources/dashboards/*.yml, add src/*.lvdash.json to sync.exclude, then
   `bundle validate --target ${bundle_target}` and `bundle deploy --target ${bundle_target}`.
4. Validate: .lvdash.json exists and is non-empty, bundle validate exits clean, dashboard is accessible.

Convention: sync.exclude must list src/*.lvdash.json to prevent raw-file sync conflicting with the
dashboards resource. warehouse_id is required in the resource definition.

On error: if the failure is a widget/content issue, re-route to the dashboard editor. For bundle-capture
errors, self-correct up to 2 times.
```
