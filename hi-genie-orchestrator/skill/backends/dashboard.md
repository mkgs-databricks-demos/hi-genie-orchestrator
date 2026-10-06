---
module: backends/dashboard
version: 1.0.0
purpose: AI/BI Dashboard execution backend via dashboard draft-canvas editor handoff
depends_on: [core/state-machine]
consumed_by: [capabilities/prompt-synthesis]
---

# Backend: Dashboard Editor

## When to Use

Select this backend when the workstream's primary deliverable is an AI/BI
Dashboard. Indicators:

- Workstream spec mentions "dashboard", "visualization", "charts", "widgets"
- A declared `output_artifact` has type `dashboard`
- Deliverable presents metrics/data to end-users as an interactive visual layer

**Widget editing capabilities only exist on the dashboard draft-canvas page.**
This backend hands authoring off to that page and captures the result.

## Setup

1. **Check for existing dashboard** — Read plan for a `dashboard_id`.
2. **Read upstream notes** — Source tables, target metrics, layout requirements.
3. **Read existing dashboard resources** in `resources/dashboards/*.yml`.
4. **Identify target catalog/schema and SQL warehouse.**

## Execute (Mandatory Handoff)

### Part 1: Author via Dashboard Draft Canvas

1. If no dashboard exists: `createAsset({ assetType: "dashboard", name: "..." })`
2. Navigate: `openAsset({ assetType: "dashboard", assetId: "<id>",
   continueMessage: "<detailed widget/layout instructions>" })`
3. Wait for dashboard agent to complete widget creation.
4. Verify dashboard renders correctly.

### Part 2: Capture in Bundle (if applicable)

1. Read the `.lvdash.json` file from the created dashboard.
2. Add dashboard resource to `resources/dashboards/<name>.yml`.
3. Reference dashboard ID and warehouse.

## Validate (Gate Conditions)

- `dashboard_renders` — Dashboard loads without widget errors
- `widget_count_matches` — Expected number of widgets present
- `data_populates` — Widgets show data (not empty/error state)
- `resource_in_bundle` — Dashboard YAML exists in `resources/`

## MCP Tools

| Tool | Usage |
| --- | --- |
| `get_workstream_context` | Load source table names, metric definitions |
| `update_workstream_status` | Transition through lifecycle |
| `append_workstream_notes` | Record dashboard_id for downstream |
| `get_skill_content` | Load dashboard conventions |
