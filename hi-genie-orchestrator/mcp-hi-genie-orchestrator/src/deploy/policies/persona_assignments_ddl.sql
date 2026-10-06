-- Persona Assignments Table
--
-- Maps service principal IDs to their Hi Genie persona.
-- Used by the persona_tool_policy function to enforce role-based tool access.
--
-- Substitution tokens: {{catalog}}, {{schema}}
--
-- To add a new agent:
--   INSERT INTO {{catalog}}.{{schema}}.persona_assignments
--   VALUES ('<spn_application_id>', 'architect', 'My Architect Agent');
--
-- Valid personas: 'architect', 'dispatcher', 'worker'
-- A principal can have multiple personas (multiple rows).

CREATE TABLE IF NOT EXISTS {{catalog}}.{{schema}}.persona_assignments (
  principal_id STRING NOT NULL
    COMMENT 'Service principal application ID or user email',
  persona STRING NOT NULL
    COMMENT 'Role: architect, dispatcher, or worker',
  description STRING
    COMMENT 'Human-readable label for this assignment',
  created_at TIMESTAMP DEFAULT current_timestamp()
    COMMENT 'When this assignment was created'
)
COMMENT 'Maps principals to Hi Genie personas for service policy enforcement.'
TBLPROPERTIES (
  'delta.enableChangeDataFeed' = 'true'
);
