---
module: backends/pipeline
version: 1.0.0
purpose: Spark Declarative Pipelines (SDP) execution backend via pipeline editor handoff
depends_on: [core/state-machine]
consumed_by: [capabilities/prompt-synthesis]
---

# Backend: Pipeline Editor

## When to Use

Select this backend when the workstream's primary deliverable is a Spark
Declarative Pipeline (SDP) — streaming tables, materialized views, Auto CDC
flows, or data-quality expectations. Indicators:

- Workstream builds bronze/silver/gold pipeline using `@dp.table`, `@dp.materialized_view`
- Workstream spec mentions "pipeline", "streaming table", "materialized view", "CDC"
- A declared `output_artifact` has type `pipeline` or `streaming_table`

**Do NOT author SDP code directly.** The pipeline editor page owns specialized,
current tooling for `@dp.table`/`@dp.materialized_view`/Auto CDC. This backend
hands authoring off to that page and captures the result.

## Setup

1. **Check for existing pipeline** — Read plan for a `pipeline_id`.
2. **Read upstream notes** — Source tables, layering, data-quality rules.
3. **Read existing pipeline resources** in `resources/pipelines/*.yml`.
4. **Identify target catalog/schema** from plan-level config.

## Execute (Mandatory Handoff)

### Part 1: Author via Pipeline Editor

1. If no pipeline exists: `createAsset({ assetType: "pipeline", name: "..." })`
2. Navigate: `openAsset({ assetType: "pipeline-editor", assetId: "<id>",
   continueMessage: "<detailed authoring instructions>" })`
3. Wait for pipeline editor agent to complete authoring.
4. Verify pipeline update succeeds (check monitoring page).

### Part 2: Capture in Bundle (if applicable)

1. Add pipeline resource to `resources/pipelines/<name>.yml`.
2. Reference pipeline ID from the created asset.
3. Validate bundle includes the new resource.

## Validate (Gate Conditions)

- `pipeline_update_succeeds` — Latest update completes without error
- `streaming_table_has_rows` — Target tables populated
- `expectations_pass` — Data quality expectations not violated
- `resource_in_bundle` — Pipeline YAML exists in `resources/`

## MCP Tools

| Tool | Usage |
| --- | --- |
| `get_workstream_context` | Load source table paths, schema info |
| `update_workstream_status` | Transition through lifecycle |
| `append_workstream_notes` | Record pipeline_id for downstream |
| `get_skill_content` | Load SDP conventions |
