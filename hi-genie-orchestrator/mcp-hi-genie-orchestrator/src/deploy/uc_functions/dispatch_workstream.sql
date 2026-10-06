-- Template: UC Function DDL for Hi Genie Orchestrator
-- Substitution tokens: {{catalog}}, {{schema}}, {{connection_name}}
--
-- Function: dispatch_workstream
-- API endpoint: POST /v1/orchestrations/:orchId/workstreams/:wsKey/dispatch (connection base_path: /api)
-- Role: Dispatcher
-- Description: Dispatches a workstream for execution by a worker agent

CREATE OR REPLACE FUNCTION {{catalog}}.{{schema}}.dispatch_workstream(
  orchestration_id STRING COMMENT 'UUID of the orchestration',
  workstream_key STRING COMMENT 'Key of the workstream to dispatch'
)
RETURNS STRING
COMMENT 'Dispatches a workstream for worker execution. Returns JSON with dispatch status and session details.'
RETURN (
  SELECT (http_request(
    conn => '{{connection_name}}',
    method => 'POST',
    path => concat('/v1/orchestrations/', orchestration_id, '/workstreams/', workstream_key, '/dispatch')
  )).text
);
