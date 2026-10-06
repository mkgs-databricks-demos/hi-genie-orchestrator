-- Template: UC Function DDL for Hi Genie Orchestrator
-- Substitution tokens: {{catalog}}, {{schema}}, {{connection_name}}
--
-- Function: get_plan
-- API endpoint: GET /v1/plans/:planId (connection base_path: /api)
-- Role: Architect
-- Description: Retrieves a plan by ID

CREATE OR REPLACE FUNCTION {{catalog}}.{{schema}}.get_plan(
  plan_id STRING COMMENT 'UUID of the plan to retrieve'
)
RETURNS STRING
COMMENT 'Retrieves a plan by ID from the Orchestrator API. Returns full JSON plan object.'
RETURN (
  SELECT (http_request(
    conn => '{{connection_name}}',
    method => 'GET',
    path => concat('/v1/plans/', plan_id)
  )).text
);
