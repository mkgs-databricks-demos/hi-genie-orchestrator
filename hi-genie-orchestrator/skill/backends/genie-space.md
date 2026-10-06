---
module: backends/genie-space
version: 1.0.0
purpose: Genie Space execution backend via Genie editor handoff
depends_on: [core/state-machine]
consumed_by: [capabilities/prompt-synthesis]
---

# Backend: Genie Space Editor

## When to Use

Select this backend when the workstream's primary deliverable is a Genie space
(AI-powered natural-language analytics interface). Indicators:

- Workstream spec mentions "Genie space", "NL-to-SQL", "conversational analytics"
- A declared `output_artifact` has type `genie_space`
- Deliverable lets end-users query data using natural language

**Genie space instruction tuning is most effective from the Genie editor page.**
This backend hands instruction/benchmark authoring off to that page.

> **Bundle engine requirement:** Genie space resources require the direct
> deployment engine. Add `engine: direct` to `databricks.yml`.

## Setup

1. **Check for existing Genie space** — Read plan for a `genie_space_id`.
2. **Collect table identifiers** — Fully qualified `catalog.schema.table` names.
3. **Read existing Genie space resources** in `resources/genie_spaces/*.yml`.
4. **Identify SQL warehouse** from plan-level config.
5. **Confirm direct deployment engine** in `databricks.yml`.

## Execute (Mandatory Handoff)

### Part 1: Create and Configure

1. Create: `createAsset({ assetType: "genie", name: "...", tableIdentifiers: [...] })`
2. Navigate: `openAsset({ assetType: "genie", assetId: "<id>",
   continueMessage: "<instructions for sample questions, SQL guidance, trust filters>" })`
3. Wait for Genie editor agent to configure instructions and benchmarks.

### Part 2: Capture in Bundle (if applicable)

1. Add Genie space resource to `resources/genie_spaces/<name>.yml`.
2. Include table references and warehouse ID.
3. Ensure `engine: direct` is set in bundle config.

## Validate (Gate Conditions)

- `space_responds` — Genie space answers a sample question correctly
- `tables_accessible` — All referenced tables queryable from the space
- `instructions_present` — Sample questions and SQL guidance configured
- `resource_in_bundle` — Genie space YAML exists in `resources/`

## MCP Tools

| Tool | Usage |
| --- | --- |
| `get_workstream_context` | Load table names, sample questions from upstream |
| `update_workstream_status` | Transition through lifecycle |
| `append_workstream_notes` | Record genie_space_id for downstream |
| `get_skill_content` | Load Genie space best practices |
