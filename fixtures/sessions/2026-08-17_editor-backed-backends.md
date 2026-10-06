# Session: Add Editor-Backed Backends (Pipeline, Dashboard, Genie Space)

**Date:** 2026-08-17  
**Branch:** `mg-genie-hi-genie-r1`  
**Duration:** ~60 min (build ~40 min + verification pass ~20 min)

## Problem

The skill's 4 execution backends (`bundle`, `notebook`, `sql`, `custom`) didn't explicitly cover the rich Databricks editor surfaces available in Genie Code context: the AI/BI Dashboard draft canvas, the Genie Space/Agent instruction-tuning editor, and the Spark Declarative Pipelines (SDP) pipeline editor. These surfaces expose specialized tools (live schema inference, widget authoring, benchmark configuration) not available through generic `createAsset`/`editAsset` flows, but the skill gave backends no guidance on when or how to hand off to them — or, critically, that doing so does not exempt the resulting artifacts from landing in the Declarative Automation Bundle.

## Solution

Added 3 new backend modules and updated 4 existing modules to route workstreams that produce dashboards, Genie Spaces, or SDP pipelines through the matching editor, while making the bundle-capture step mandatory and explicit in every one.

## Approach

1. Confirmed via `docSearch` that Declarative Automation Bundles support `dashboard`, `genie_spaces`, and `pipeline` as first-class resource types (alongside `alert`, `app`, `catalog`, `job`, `schema`, etc.).
2. Read `backends/custom.md` and `backends/bundle.md` in full to find existing (incomplete) coverage: Genie/Dashboard/App patterns in `custom.md` had no bundle-capture step; `bundle.md` covered pipeline resources only as generic YAML with no pipeline-editor handoff.
3. Authored 3 new backend files, each with the same 3-step shape: (1) create the resource via `createAsset`/bundle YAML, (2) hand off to the specialized editor via `openAsset` + `continueMessage`, (3) capture the result into the bundle via `databricks bundle generate --existing-id <id> --type <resource_type>`.
4. Trimmed `backends/custom.md`'s Genie/Dashboard/App patterns to remove now-duplicated guidance and point at the new files; clarified the App pattern's own bundle requirement; updated the prompt injection template.
5. Extended `core/decomposition.md`'s Backend Inference table with detection rules for pipeline/dashboard/genie-space workstreams.
6. Updated `core/prompt-synthesis.md` backend variable resolution and instruction blocks to reference the 3 new backends.
7. Updated `SKILL.md`'s Execution Backends table and module count (4 → 7 backends).

## Key Design Principle (stated in all 3 new files)

> The editor-backed workflow is a development efficiency pattern, not a bypass of the bundle. Files, configs, and resource definitions produced by or extracted from the editor must ultimately be captured into the Declarative Automation Bundle for version control, deployment reproducibility, and promotion across targets (dev → staging → prod). Use `databricks bundle generate` to extract resource config from an existing workspace asset.

## New Backend Files

### `backends/pipeline.md`
* When to use: workstream creates an SDP pipeline (`@dp.table`, `@dp.materialized_view`, `@dp.temporary_view`, `dp.create_auto_cdc_flow`)
* Flow: bundle YAML `resources/pipelines.yml` → source notebook(s) in `src/` → `openAsset(pipeline-editor)` + `continueMessage` for live-schema-inference authoring/debugging
* Critical: `from pyspark import pipelines as dp`, never `import dlt`
* Validation: `databricks bundle summary` → pipeline state IDLE/RUNNING

### `backends/dashboard.md`
* When to use: workstream produces an AI/BI Dashboard
* Flow: `createAsset(dashboard)` → `openAsset(dashboard)` + `continueMessage` for widget/query authoring in the draft canvas → `databricks bundle generate --existing-id <id> --type dashboard`
* Bundle resource: `dashboard` in `resources/dashboards.yml`
* Validation: `readAssetById(assetType:"dashboard")` — assert exists + published

### `backends/genie-space.md`
* When to use: workstream produces a Genie Space / AI Agent
* Flow: `createAsset(genie, tableIdentifiers:[...])` → `openAsset(dataroom)` + `continueMessage` for instruction tuning, benchmark configuration, SQL tool setup → `databricks bundle generate --existing-id <id> --type genie_space`
* Bundle resource: `genie_spaces` in `resources/genie-spaces.yml`
* Validation: `readAssetById(assetType:"dataroom")` — assert exists

## Files Modified/Created

**Created (3 files):**
* `skill/backends/pipeline.md`
* `skill/backends/dashboard.md`
* `skill/backends/genie-space.md`

**Modified (4 files):**
* `skill/backends/custom.md` — trimmed Genie/Dashboard/App patterns, clarified bundle-capture requirement, updated prompt injection template
* `skill/core/decomposition.md` — Backend Inference table extended with pipeline/dashboard/genie-space detection
* `skill/core/prompt-synthesis.md` — backend variable resolution + instruction blocks for new backends
* `skill/SKILL.md` — Execution Backends table and module count updated

## Related Work (same commit)

This commit also included the previously-uncommitted File-Mode-only annotation pass on `tracking/status-protocol.md`, `tracking/lakebase-schema.md`, and `tracking/observability.md` (Lakebase sections retained as reference-only, banners added clarifying this project runs File Mode exclusively).

## Platform Gotcha: Sparse-Checkout Cone

The git folder's sparse-checkout cone only included `genie-workstream-orchestrator/hi-genie-orchestrator`. The `skill/` directory (this session's work) and `fixtures/` directory (this summary) were outside the cone, causing `runGit commit_and_push` to fail with "paths matched outside of your sparse-checkout definition." Fixed with `git sparse-checkout add genie-workstream-orchestrator/skill` and `git sparse-checkout add genie-workstream-orchestrator/fixtures` (CLI-enabled folder, cone mode) before retrying the commit.

## Commit 1: Backend Build

```
Add editor-backed backends (pipeline, dashboard, genie-space) and file-mode annotations
```

10 files (3 created + 7 modified).

## Follow-Up: Final Verification Pass

After the build commit, did a dedicated read-through pass across all touched/created files to confirm internal consistency — the last open TODO item from the original plan ("verify all edits and summarize").

### What Was Checked

1. Read `backends/pipeline.md`, `backends/dashboard.md`, `backends/genie-space.md` in full.
2. Read `core/decomposition.md`'s Backend Inference table + Inference Decision Tree.
3. Read `core/prompt-synthesis.md`'s Backend-Specific Instruction Blocks and Per-Artifact-Type Validation table.
4. Read `SKILL.md`'s Execution Backends table, module count, and Key Concepts section.
5. Read `core/dag-builder.md` and `backends/bundle.md` for any other stale backend-enum references not caught in the original build pass.

### Confirmed Consistent

* All 3 new backend files' step sequences (create → editor handoff via `openAsset` + `continueMessage` → bundle capture via `bundle generate`/`bundle deployment bind` → `bundle validate`/`deploy`) match `core/prompt-synthesis.md`'s Backend-Specific Instruction Blocks for `pipeline-editor`, `dashboard-editor`, `genie-space-editor` 1:1 by name.
* `core/decomposition.md`'s Backend Inference table and Inference Decision Tree route to all 3 new backends using the same identifiers.
* `SKILL.md`'s Execution Backends table links resolve correctly to all 7 backend files.

### 4 Stale-Reference Gaps Found and Fixed

| File | Gap | Fix |
| --- | --- | --- |
| `core/decomposition.md` | Candidate Structure schema's `inferred_backend` enum comment still listed only the original 4 backends | Added `pipeline-editor \| dashboard-editor \| genie-space-editor` to the enum |
| `core/dag-builder.md` | Same stale `inferred_backend` enum comment in the DAG builder's Input schema | Same fix |
| `SKILL.md` | Key Concepts "Execution backend" bullet described only 4 backends (bundle deploy, notebook run, SQL, custom) | Rewrote to distinguish in-session backends from the 3 editor-handoff backends |
| `backends/bundle.md` | "When to Use" listed "pipelines" as a bundle-backend signal with no redirect, unlike `custom.md`'s existing Genie/dashboard redirects | Added a pointer to `backends/pipeline.md`/`dashboard.md`/`genie-space.md` for SDP/dashboard/Genie *authoring*; clarified `bundle.md` still applies once those resources need declaring/redeploying |

## Commit 2: Verification Fixes

```
fix: close consistency gaps found in final verification pass on editor-backed backends
```

4 files modified (`SKILL.md`, `backends/bundle.md`, `core/dag-builder.md`, `core/decomposition.md`).
