-- Service Policy: ASK Gates for Destructive Operations
--
-- Tool VISIBILITY is pre-filtered by persona-specific MCP Services:
--   hi_genie_architect_*  → 13 tools (plans, skills, decisions)
--   hi_genie_reviewer_*   → 14 tools (reviews, quality gates, broad read)
--   hi_genie_worker_*     → 17 tools (records, sessions, execution)
--   hi_genie_dispatcher_* → 16 tools (orchestration, lifecycle)
--
-- This policy does NOT enforce persona-tool alignment (the service boundary
-- handles that). It ONLY adds ASK gates for high-impact / irreversible
-- operations to give the human a confirmation prompt before execution.
--
-- Substitution tokens: {{catalog}}, {{schema}}
-- Registered by: src/deploy/register_mcp_policy.py
--
-- CONSTRAINT: Function must transpile to CEL (Common Expression Language).
-- Only a single WHEN/ELSE branch with simple expressions is supported.
-- Multi-branch CASE, nested argument access, and table lookups are NOT
-- supported by the CEL transpiler.
--
-- ASK-gated tools:
--   publish_plan, dispatch_workstream, approve_review

CREATE OR REPLACE FUNCTION {{catalog}}.{{schema}}.persona_tool_policy(
  event VARIANT
)
RETURNS VARIANT
LANGUAGE SQL
COMMENT 'Service policy: ASK gates on destructive/irreversible MCP tool calls. Tool visibility is pre-filtered by persona-specific MCP Services.'
RETURN
  CASE
    WHEN event:type::string = 'request'
      AND event:context.tool.name::string IN ('publish_plan', 'dispatch_workstream', 'approve_review')
    THEN to_variant_object(named_struct(
      'result', 'ASK',
      'reason', CONCAT(event:context.tool.name::string, ' is an irreversible operation. Please confirm.')
    ))
    ELSE to_variant_object(named_struct('result', 'ALLOW', 'reason', ''))
  END;
