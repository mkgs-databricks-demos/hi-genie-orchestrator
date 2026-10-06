-- Template: UC Function DDL for Hi Genie Orchestrator
-- This file is read by the register_uc_function runner notebook,
-- which substitutes {{catalog}}, {{schema}}, {{connection_name}}
-- before executing via EXECUTE IMMEDIATE.
--
-- Function: create_plan
-- API endpoint: POST /v1/plans (connection base_path: /api)
-- Role: Architect
-- Description: Creates a new execution plan for a project

CREATE OR REPLACE FUNCTION {{catalog}}.{{schema}}.create_plan(
  project_id STRING COMMENT 'UUID of the project to create a plan for',
  plan_name STRING COMMENT 'Human-readable name for the plan',
  plan_body STRING COMMENT 'JSON body of the plan content'
)
RETURNS STRING
COMMENT 'Creates a new execution plan via the Orchestrator API. Returns JSON response with plan_id and status.'
RETURN (
  SELECT (http_request(
    conn => '{{connection_name}}',
    method => 'POST',
    path => '/v1/plans',
    json => to_json(named_struct(
      'project_id', project_id,
      'name', plan_name,
      'body', parse_json(plan_body)
    ))
  )).text
);
