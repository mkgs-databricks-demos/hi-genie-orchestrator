---
module: backends/pipeline
version: 1.0.0
purpose: Spark Declarative Pipelines (SDP) execution backend via the pipeline editor — setup, execute, validate, teardown
depends_on: [core/state-machine]
consumed_by: [core/prompt-synthesis]
---

# Backend: Pipeline Editor

## When to Use

Select this backend when the workstream's primary deliverable is a Spark Declarative Pipeline (SDP) — streaming tables, materialized views, Auto CDC flows, or data-quality expectations. Indicators:

- Workstream builds a bronze/silver/gold pipeline using `@dp.table`, `@dp.materialized_view`, or Auto CDC
- Workstream spec mentions "pipeline", "streaming table", "materialized view", "expectations", "CDC apply"
- A declared `output_artifact` has type `pipeline` (or a `streaming_table`/`materialized_view` produced by one)

**Do not author SDP code from this workstream's own session.** A generic session's Spark Declarative Pipeline knowledge can be stale, and the pipeline editor page owns the specialized, current tooling for `@dp.table`/`@dp.materialized_view`/Auto CDC/expectations. This backend's job is to hand authoring off to that page and then fold the result into the bundle — not to write `@dp.*` decorators directly.

## Setup Operation

**State transition triggered:** None — setup is pre-claim context gathering.

### Steps

1. **Check for an existing pipeline.** Read upstream notes / plan.json for a `pipeline_id`. If none exists, this workstream creates one.
2. **Read upstream notes** for source table names, bronze/silver/gold layering, and any data-quality rules referenced in the architecture doc.
3. **Read existing pipeline resource files** in `resources/pipelines/*.yml` (if any) for naming conventions this project already uses.
4. **Identify the target catalog/schema** the pipeline will write to (from plan-level backend config).

## Execute Operation

**State: IN_PROGRESS throughout.**

This backend's Execute phase has two parts that MUST happen in order — authoring is delegated, deployment capture is not.

### Part 1: Author via the Pipeline Editor (mandatory handoff)

1. If no pipeline exists yet:
   ```
   createAsset({asset: {assetType: "pipeline", name: "<pipeline name>"}})
   ```
   This creates an empty SDP pipeline.

2. Hand off authoring to the pipeline editor:
   ```
   openAsset({
     assetType: "pipeline-editor",
     assetId: "<pipeline_id>",
     navigate: true,
     continueMessage: "<requirements only>"
   })
   ```
   The `continueMessage` MUST describe *what* the pipeline should do — source tables, target tables, bronze/silver/gold layering, streaming vs. batch, data-quality requirements — and MUST NOT prescribe `@dp.*` decorators, function signatures, or step-by-step SDP implementation. The pipeline editor's agent owns all syntax and implementation decisions.
   Include enough self-contained context that the destination session needs no further back-and-forth: source table names, target schema, upstream artifact paths, and this workstream's `done_signal`.

3. The pipeline editor session authors the pipeline files and runs an update to confirm it works. This workstream's session cannot execute code on another pipeline remotely — the SDP source files are the artifact of that handoff, not something this session edits further.

### Part 2: Capture the Result in the Bundle (still required)

4. Once the pipeline has been authored and runs cleanly, declare it in `resources/pipelines/*.yml` so `bundle deploy` manages it going forward:
   ```yaml
   resources:
     pipelines:
       my_pipeline:
         name: ${var.catalog}_my_pipeline
         catalog: ${var.catalog}
         schema: ${resources.schemas.my_schema.name}
         libraries:
           - notebook:
               path: ../src/pipelines/my_pipeline.ipynb
   ```
   If the pipeline was created ad hoc outside the bundle, pull its configuration in instead of duplicating it:
   ```
   runDatabricksCli("bundle generate pipeline --existing-pipeline-id <id>")
   runDatabricksCli("bundle deployment bind pipelines.my_pipeline <id>")
   ```
5. Run `databricks bundle validate --target ${bundle_target}` and `databricks bundle deploy --target ${bundle_target}` via `runDatabricksCli` to confirm the resource is captured correctly.

### Tool Usage Patterns

| Action | Tool | Key Parameters |
| --- | --- | --- |
| Create empty pipeline | `createAsset` | `{assetType: "pipeline", name: ...}` |
| Hand off SDP authoring | `openAsset` | `{assetType: "pipeline-editor", assetId, continueMessage}` |
| Check pipeline health (read-only) | `openAsset` | `{assetType: "pipeline-monitoring", assetId}` |
| Capture existing pipeline into bundle | `runDatabricksCli` | `bundle generate pipeline --existing-pipeline-id <id>` |
| Bind to bundle (avoid duplicate) | `runDatabricksCli` | `bundle deployment bind pipelines.<key> <id>` |
| Validate / deploy | `runDatabricksCli` | `bundle validate` / `bundle deploy --target X` |

## Validate Operation

**State transition: IN_PROGRESS → VALIDATING** (set via editAsset on status file).

### Checks

1. Pipeline resource is declared in `resources/pipelines/*.yml` and `bundle validate` exits clean.
2. Pipeline state is healthy: check via `pipeline-monitoring` or `runDatabricksCli("pipelines get --pipeline-id <id>")` — expect `IDLE` after a successful update, not `FAILED`.
3. Declared target tables exist and are queryable: `SELECT COUNT(*) FROM catalog.schema.table` for each.
4. Data-quality expectations (if any) show no unexpected drop/fail rates in the latest update's event log.

### Validation Decision

- ALL checks pass → transition to COMPLETE
- Pipeline editor session still authoring / update in progress → RETRYING (not a failure — give the handoff session time to finish)
- Pipeline update FAILED with a real SDP bug → BLOCKED with the pipeline's error message. Do not attempt to fix SDP code from this session — note in `error_message` that the pipeline editor must be used to resolve it.
- Bundle capture missing or invalid → fix `resources/pipelines/*.yml`, re-validate

## Teardown Operation

**State: Only on failure path.**

1. **Failed pipeline authoring:** Leave the empty/partial pipeline in place — the next attempt resumes via the pipeline editor, not by recreating.
2. **Failed bundle capture:** Safe to retry `bundle generate` / `bundle deployment bind` — idempotent.
3. **General rule:** Do NOT `bundle destroy` a pipeline resource to "fix" an SDP bug — that only removes the deployment wrapper, not the code issue.

## State Transitions This Backend Triggers

| Phase | Transition | editAsset Pattern |
| --- | --- | --- |
| Claim | NOT_STARTED → IN_PROGRESS | `old: "status: NOT_STARTED"` → `new: "status: IN_PROGRESS"` |
| Post-execute | IN_PROGRESS → VALIDATING | `old: "status: IN_PROGRESS"` → `new: "status: VALIDATING"` |
| Validation pass | VALIDATING → COMPLETE | `old: "status: VALIDATING"` → `new: "status: COMPLETE"` |
| Unrecoverable error | IN_PROGRESS → BLOCKED | `old: "status: IN_PROGRESS"` → `new: "status: BLOCKED"` |

Never set: NOT_STARTED, GATED, RETRYING (per core/state-machine Backend Contract) — RETRYING here specifically means "give the pipeline editor handoff more time", set by the supervisor, not this backend directly.

## Error Handling

| Error Category | Example | Response | Retriable? |
| --- | --- | --- | --- |
| Handoff not yet resolved | Pipeline editor session hasn't reported back / pipeline still empty | RETRYING — re-check on next tick | Yes |
| SDP syntax/logic error | Pipeline update `FAILED` with a Python/SQL error | BLOCKED — route back to the pipeline editor; do not patch SDP code here | No (needs a pipeline editor session) |
| Bundle capture conflict | `bundle generate` finds an existing resource with a different name | Rename or `bundle deployment bind` instead of duplicating | Yes (self-correct) |
| Permission denied | `PERMISSION_DENIED: cannot create pipeline` | Set BLOCKED with grant instructions | No |

### Self-Correction Protocol

1. Identify the error category from the error message.
2. Bundle-capture errors: fix YAML, re-validate (up to 2 attempts).
3. Any error rooted in the pipeline's own SDP code: do not self-correct here — set BLOCKED and note that resolution requires the pipeline editor.
4. If still failing after self-correction attempts → BLOCKED with context.

## Prompt Injection Template

The following text is injected into the worker prompt's EXECUTE section when this backend is selected:

```
### Execution Backend: pipeline-editor

You are building a Spark Declarative Pipeline. You do NOT author SDP code yourself:

1. If no pipeline exists: createAsset (assetType: "pipeline", name: "${workstream_name}").
2. Hand off authoring: openAsset (assetType: "pipeline-editor", assetId: <id>, continueMessage: describing
   source tables, target tables, layering, and data-quality requirements — requirements only, never SDP syntax).
3. Once the pipeline editor session reports the pipeline is authored and running cleanly, capture it into the
   bundle: write resources/pipelines/*.yml (or `bundle generate pipeline --existing-pipeline-id <id>` +
   `bundle deployment bind`), then `bundle validate --target ${bundle_target}` and
   `bundle deploy --target ${bundle_target}`.
4. Validate: pipeline state is IDLE (not FAILED), target tables are queryable, resource is captured in the bundle.

On error: if the failure is an SDP authoring/logic issue, do not fix it here — set BLOCKED noting the pipeline
editor must be used. For bundle-capture errors, self-correct up to 2 times.
```
