-- Template: UC Function DDL
-- Tokens: {{catalog}}, {{schema}}, {{connection_name}}
-- Function: publish_plan | Endpoint: POST /v1/plans/:planId/publish
-- Role: Architect

CREATE OR REPLACE FUNCTION {{catalog}}.{{schema}}.publish_plan(
  plan_id STRING COMMENT 'UUID of the plan to publish'
)
RETURNS STRING
COMMENT 'Publishes a plan, making it immutable and available for orchestration. Returns JSON.'
RETURN (
  SELECT (http_request(
    conn => '{{connection_name}}',
    method => 'POST',
    path => concat('/v1/plans/', plan_id, '/publish')
  )).text
);
