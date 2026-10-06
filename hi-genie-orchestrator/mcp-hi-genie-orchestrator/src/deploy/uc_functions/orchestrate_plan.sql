-- Template: UC Function DDL
-- Tokens: {{catalog}}, {{schema}}, {{connection_name}}
-- Function: orchestrate_plan | Endpoint: POST /v1/plans/:planId/orchestrate
-- Role: Dispatcher

CREATE OR REPLACE FUNCTION {{catalog}}.{{schema}}.orchestrate_plan(
  plan_id STRING COMMENT 'UUID of the published plan to orchestrate'
)
RETURNS STRING
COMMENT 'Creates an orchestration from a published plan. Returns JSON with orchestration_id and workstreams.'
RETURN (
  SELECT (http_request(
    conn => '{{connection_name}}',
    method => 'POST',
    path => concat('/v1/plans/', plan_id, '/orchestrate')
  )).text
);
