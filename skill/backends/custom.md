---
module: backends/custom
version: 1.0.0
purpose: Custom execution backend — setup, execute, validate, teardown
depends_on: [core/state-machine]
consumed_by: [core/prompt-synthesis]
---

# Backend: Custom

## When to Use

Select this backend when the workstream does not fit neatly into bundle, notebook, or SQL patterns. Indicators:

- Workstream creates Databricks Apps (use `backends/genie-space.md` for Genie spaces, `backends/dashboard.md` for dashboards, `backends/pipeline.md` for SDP pipelines instead)
- Workstream produces documentation or configuration files
- Workstream makes API calls via the Databricks SDK
- Workstream is the final orchestration summary (WS-FINAL pattern)
- Workstream combines multiple backend types in phases (composite)
- Workstream performs workspace management (secrets, permissions, file organization)

This is the catch-all backend. Genie spaces, dashboards, and SDP pipelines each have their own dedicated backend modules with full editor-handoff + bundle-capture lifecycles — use those instead of this backend for those asset types. If none of the other six backends apply, use custom.

## Setup Operation

**State transition triggered:** None — setup is pre-claim context gathering.

### Steps

1. **Identify output artifacts.** Read the workstream spec to determine:
   - What files, resources, or objects must be produced
   - Verification criteria for each artifact (file_non_empty, resource_exists, etc.)
   - Dependencies on upstream workstream outputs

2. **Read upstream notes.** For each dependency in `depends_on`:
   - Read the upstream status file's "Notes for Downstream Sessions" section
   - Extract paths, IDs, or values this workstream needs

3. **Inventory existing state.** Check what already exists:
   - Search for existing assets that might conflict
   - Read existing configuration files that will be modified
   - Note any resources this workstream will interact with

4. **Determine sub-phases (for composite workstreams).** If the workstream combines multiple backend types:
   - Phase 1: SQL (schema setup)
   - Phase 2: Notebook (ETL execution)
   - Phase 3: Custom (Genie space creation)
   - Plan execution order and inter-phase dependencies

5. **Identify tools needed.** Map each artifact to the primary tool:
   - Genie space → use `backends/genie-space.md` (createAsset + editor handoff + bundle capture)
   - Dashboard → use `backends/dashboard.md` (createAsset + editor handoff + bundle capture)
   - App → `createAsset` (type: "app") + `openAsset` + continueMessage (AppsAgent scaffolds) + bundle capture in `resources/apps/*.yml`
   - Documentation → `createAsset` (type: "file") + `editAsset`
   - API calls → `executeCode` (language: python) with Databricks SDK
   - CLI operations → `runDatabricksCli`

## Execute Operation

**State: IN_PROGRESS throughout.**

### Common Patterns

#### Pattern 1: Genie Space Creation

> **Use `backends/genie-space.md` instead.** That module provides the full lifecycle: `createAsset(genie)` + Genie editor handoff for instruction/benchmark tuning + `bundle generate genie-space` + `genie_spaces` bundle resource capture + `engine: direct` requirement. See `backends/genie-space.md`.

#### Pattern 2: Dashboard Creation

> **Use `backends/dashboard.md` instead.** That module provides the full lifecycle: `createAsset(dashboard)` + dashboard draft-canvas handoff for widget authoring + `bundle generate dashboard` + `.lvdash.json` capture + `sync.exclude` requirement. See `backends/dashboard.md`.

#### Pattern 3: App Scaffold

```
createAsset(asset: {
  assetType: "app",
  name: "my-app-name"
})
```

Then navigate with `openAsset` and `continueMessage` for AppsAgent to scaffold source files.

> **Bundle capture (required):** The app must still be declared in `resources/apps/*.yml` as a bundle resource so `bundle deploy` provisions and manages it. After the AppsAgent page completes, write or confirm the `app` resource entry in the bundle:
> ```yaml
> resources:
>   apps:
>     my_app:
>       name: "my-app-name"
>       description: "My workstream deliverable app"
> ```
> Then `bundle validate --target ${bundle_target}` and `bundle deploy --target ${bundle_target}`.

#### Pattern 4: Documentation / Configuration Files

```
createAsset(asset: {
  assetType: "file",
  name: "path/to/output/README.md"
})

editAsset(
  asset: {type: "file", id: "<path>", name: "README.md"},
  operation: "update",
  content: [{patches: [{old_text: "", new_text: "<content>", replace_all: false}]}]
)
```

#### Pattern 5: API Calls via Databricks SDK

```python
from databricks.sdk import WorkspaceClient

w = WorkspaceClient()

# Example: Create a secret scope
w.secrets.create_scope(scope="my-scope")
w.secrets.put_secret(scope="my-scope", key="api-key", string_value="value")

# Example: List serving endpoints
endpoints = list(w.serving_endpoints.list())
```

Execute via `executeCode` (language: python).

#### Pattern 6: CLI Operations

```
runDatabricksCli(command: "secrets put-secret my-scope my-key --string-value 'value'")
runDatabricksCli(command: "serving-endpoints get my-endpoint")
```

#### Pattern 7: WS-FINAL (Orchestration Summary)

The final workstream in any orchestration DAG. It:
1. Reads ALL upstream workstream status files
2. Collects all artifact paths and verification results
3. Produces a summary document with:
   - Orchestration metadata (ID, start time, duration)
   - Per-workstream: status, artifacts, key decisions
   - Overall success/failure assessment
   - Any manual follow-up items
4. Writes to `orchestration/state/orchestration-summary.md`

```
createAsset(asset: {assetType: "file", name: "path/to/orchestration-summary.md"})
editAsset(...summary content...)
```

#### Pattern 8: Composite (Multi-Backend within Single Workstream)

When a single workstream needs multiple backend types:

```
## Phase 1: SQL Setup
- Execute DDL via executeCode (language: sql)
- Follow sql backend conventions (fully qualified, CREATE OR REPLACE)

## Phase 2: Notebook Execution  
- Create/edit notebook via createAsset/editAsset
- Execute via executeCode (language: python)
- Follow notebook backend conventions

## Phase 3: Custom Resources
- Create Genie space / dashboard / app
- Follow custom backend patterns
```

For composite workstreams, validate ALL phases before transitioning to VALIDATING.

### Tool Usage Patterns

| Action | Tool | Key Parameters |
| --- | --- | --- |
| Create Genie space | See `backends/genie-space.md` | Full editor-handoff backend |
| Create dashboard | See `backends/dashboard.md` | Full editor-handoff backend |
| Create app | `createAsset` + `openAsset` | `{assetType: "app", name: ...}` + AppsAgent handoff |
| Create file | `createAsset` | `{assetType: "file", name: ...}` |
| Write file content | `editAsset` (file) | Workspace path, patches |
| Python SDK call | `executeCode` | `language: "python"` |
| CLI operation | `runDatabricksCli` | Command string |
| Navigate + handoff | `openAsset` | assetType, assetId, continueMessage |
| Search existing | `searchAssets` | Query, asset types |

## Validate Operation

**State transition: IN_PROGRESS → VALIDATING** (set via editAsset on status file).

### Checks

Validation is artifact-type-specific. For each declared output artifact, verify based on its type:

1. **file_non_empty** — File exists and has substantive content:
   ```
   readAssetById(assetType: "file", assetId: "<path>")
   ```
   Verify: file returns content, content length > minimum threshold (e.g., > 50 characters for docs, > 10 lines for code).

2. **resource_exists** — A created resource is accessible:
   - Genie space: see `backends/genie-space.md` Validate section
   - Dashboard: see `backends/dashboard.md` Validate section
   - App: `runDatabricksCli(command: "apps get <name>")`

3. **api_response_valid** — An API call returns expected result:
   ```python
   # Verify via SDK
   result = w.serving_endpoints.get("my-endpoint")
   assert result.state.ready == "READY"
   ```

4. **config_applied** — Configuration was persisted:
   ```python
   # Verify secret exists
   secrets = w.secrets.list_secrets(scope="my-scope")
   assert any(s.key == "my-key" for s in secrets)
   ```

5. **composite_all_pass** — For composite workstreams, ALL sub-phase validations must pass.

### Validation Decision

- ALL artifact checks pass → transition to COMPLETE
- Resource not found but creation reported success → retry check (eventual consistency)
- Permission error during validation read → BLOCKED
- File exists but is empty/stub → RETRY (content generation likely failed)

## Teardown Operation

**State: Only on failure path.**

Custom backend teardown is artifact-specific:

1. **Failed Genie space:** See `backends/genie-space.md` Teardown section.
2. **Failed dashboard:** See `backends/dashboard.md` Teardown section.
3. **Failed app:** May need `apps stop` or `apps delete` if in broken state.
4. **Failed secrets:** Remove with:
   ```
   runDatabricksCli(command: "secrets delete-secret <scope> <key>")
   ```
5. **Failed file creation:** Orphaned empty files are harmless. Leave for retry.
6. **General rule:** Custom resources are typically safe to leave. Only clean up if the resource is in a broken/conflicting state that would prevent retry.

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
| Resource conflict | `RESOURCE_ALREADY_EXISTS: space 'x'` | Use existing or rename | Conditional |
| API rate limit | `429 Too Many Requests` | Wait and retry | Yes (1 retry) |
| SDK version error | `AttributeError: 'WorkspaceClient' has no attribute 'x'` | Upgrade SDK, use correct method | Yes (self-correct) |
| Permission denied | `PERMISSION_DENIED: cannot create app` | Set BLOCKED with required permissions | No |
| Asset not found | `Asset not found: <id>` | Verify ID, search for correct asset | Yes (self-correct) |
| Timeout | CLI/API call exceeds timeout | Retry once with higher timeout | Yes (1 retry) |
| Invalid configuration | `Invalid parameter: 'x' is not a valid option` | Fix config, re-apply | Yes (self-correct) |
| Navigation failure | `openAsset` returns error | Verify asset ID and type | Yes (self-correct) |

### Self-Correction Protocol

1. Identify the error category from the error message
2. For retriable errors: apply the specific fix
3. For API/SDK errors: check Databricks documentation for current correct approach
4. For resource conflicts: decide whether to reuse existing or create with new name
5. If same error after 2 attempts → search documentation
6. If still failing → set BLOCKED with context

### Composite Workstream Error Handling

For composite workstreams with multiple phases:
- If Phase 1 fails: stop immediately, do not attempt Phase 2+
- If Phase 2 fails: Phase 1 artifacts remain (they were validated before Phase 2 started)
- Error in any phase → apply the error handling rules of THAT phase's backend type
- BLOCKED in any phase → entire workstream is BLOCKED

## Prompt Injection Template

The following text is injected into the worker prompt's EXECUTE section when this backend is selected:

```
### Execution Backend: custom

You are executing a custom workstream. The specific work is defined by your workstream spec.
Follow these general steps:

1. Read upstream workstream notes for any values/paths you depend on.
2. For each declared output artifact, determine the correct tool:
   - Genie space: use backends/genie-space.md (full editor-handoff + bundle capture lifecycle)
   - Dashboard: use backends/dashboard.md (full editor-handoff + bundle capture lifecycle)
   - SDP pipeline: use backends/pipeline.md (full editor-handoff + bundle capture lifecycle)
   - App: createAsset (type: "app") + openAsset with continueMessage + bundle resource in resources/apps/*.yml
   - File/docs: createAsset (type: "file") + editAsset to write content
   - API calls: executeCode (language: python) with Databricks SDK
   - CLI ops: runDatabricksCli
3. Execute in dependency order (if multiple artifacts depend on each other).
4. After producing all artifacts, validate each one exists and has expected content.

For composite workstreams (multi-phase):
- Execute phases in order. Do not start Phase N+1 until Phase N validates.
- Within each phase, follow the conventions of that phase's backend type:
  - SQL phases: fully qualify names, CREATE OR REPLACE, one statement at a time
  - Notebook phases: createAsset + editAsset + executeCode
  - Bundle phases: write resources + validate + deploy

For WS-FINAL (orchestration summary):
- Read ALL upstream status files
- Collect all artifacts and their verification status
- Produce a comprehensive summary document
- This workstream COMPLETES the orchestration

On error: self-correct up to 2 times per error type. If stuck, search docs. If still failing, set BLOCKED.
```
