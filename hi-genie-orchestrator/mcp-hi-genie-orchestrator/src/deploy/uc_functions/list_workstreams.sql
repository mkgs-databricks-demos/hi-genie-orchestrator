-- Template: UC Function DDL for Hi Genie Orchestrator
-- Substitution tokens: {{catalog}}, {{schema}}, {{connection_name}}
--
-- Function: list_workstreams
-- API endpoint: GET /v1/orchestrations/:orchId/workstreams (connection base_path: /api)
-- Role: Dispatcher
-- Description: Lists all workstreams for an orchestration

CREATE OR REPLACE FUNCTION {{catalog}}.{{schema}}.list_workstreams(
  orchestration_id STRING COMMENT 'UUID of the orchestration'
)
RETURNS STRING
COMMENT 'Lists all workstreams for an orchestration. Returns JSON array of workstream objects with status.'
RETURN (
  SELECT (http_request(
    conn => '{{connection_name}}',
    method => 'GET',
    path => concat('/v1/orchestrations/', orchestration_id, '/workstreams')
  )).text
);
