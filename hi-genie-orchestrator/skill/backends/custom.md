---
module: backends/custom
version: 1.0.0
purpose: Custom/catch-all execution backend for non-standard workstreams
depends_on: [core/state-machine]
consumed_by: [capabilities/prompt-synthesis]
---

# Backend: Custom

## When to Use

Select this backend when the workstream does not fit neatly into bundle,
notebook, sql, pipeline, dashboard, or genie-space patterns. Indicators:

- Workstream creates Databricks Apps
- Workstream produces documentation or configuration files
- Workstream makes API calls via the Databricks SDK
- Workstream is the final orchestration summary (ws-final pattern)
- Workstream combines multiple backend types in phases (composite)
- Workstream performs workspace management (secrets, permissions)

This is the catch-all backend. If none of the other six backends apply, use custom.

## Setup

1. **Identify output artifacts** — What files/resources/objects must be produced.
2. **Read upstream notes** — Extract paths, IDs, values from dependencies.
3. **Inventory existing state** — Check what already exists to avoid conflicts.
4. **Determine tools needed** — Which Databricks tools/APIs are required.

## Execute

1. **Follow workstream spec** — Execute the custom logic described in the plan.
2. **Use appropriate tools** — `executeCode`, `createAsset`, `editAsset`, SDK calls.
3. **Record progress** — Use `append_workstream_notes` for key decisions/outputs.
4. **Handle errors** — Load `capabilities/error-handling` if issues arise.

## Validate (Gate Conditions)

- `file_non_empty` — Output file exists and has content
- `resource_exists` — Named resource/app/endpoint is accessible
- `api_responds` — Service endpoint returns expected response
- `custom_check` — Workstream-specific validation logic (defined in plan)

## ws-final Pattern

The `ws-final` workstream always uses the custom backend with special behavior:
- Depends on ALL other workstreams
- Waits for all to reach COMPLETE
- Produces an orchestration summary report
- Marks the orchestration as COMPLETED
- Never creates tables/resources/code

## MCP Tools

| Tool | Usage |
| --- | --- |
| `get_workstream_context` | Load all upstream notes and state |
| `update_workstream_status` | Transition through lifecycle |
| `append_workstream_notes` | Record outputs for downstream |
| `get_skill_content` | Load any relevant capability modules |
| `search_decisions` | Find prior decisions affecting this work |
