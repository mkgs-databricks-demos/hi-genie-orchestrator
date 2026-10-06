---
module: capabilities/prompt-synthesis
version: 1.0.0
purpose: Synthesize self-contained worker prompts from workstream definitions at dispatch time
depends_on: [core/state-machine, roles/architect]
consumed_by: [roles/supervisor]
---

# Prompt Synthesis

Transform a workstream definition into a fully self-contained scheduled-task
instruction set. The synthesized prompt carries everything a fresh Genie Code
session needs — concrete file paths, explicit tool calls, numbered steps, and
MCP connection details. No persona assignment, no protocol framing.

## When Used

The Supervisor invokes prompt synthesis at dispatch time — when a workstream
transitions from NOT_STARTED → GATED → IN_PROGRESS and a new scheduled task
must be created.

## Critical Constraints

> **Platform Constraint — Prompt Tone:**
> Synthesized prompts MUST read as concrete Databricks workspace tasks.
> They MUST NOT:
> - Assign a persona or identity ("You are WS-X", "As the worker...")
> - Frame instructions as an operating protocol or state machine
> - Use possessive language ("your status file", "your workstream")
> - Include lifecycle/protocol vocabulary ("gate check", "claim", "lifecycle")
>
> The platform rejects prompts that appear to override the agent's identity.
> Lead with `Task: [description]` and use `## Step N:` headers throughout.

## Template Selection

Select based on workstream `type`:

```
workstream.type == "supervisor"?
  YES → ws-init-template (8-priority tick-based decision tree)
  NO  → workstream.type == "final"?
    YES → ws-final-template (gates on ALL, summary only)
    NO  → worker-prompt-template (standard 5-step lifecycle)
```

| Template | Trigger | Key Behavior |
| --- | --- | --- |
| ws-init-template | `type: supervisor` | Tick-based: reads all states, evaluates priority tree, takes one action per tick |
| worker-prompt-template | `type: foundation \| standard \| batch` | 5-step lifecycle (Connect/Read/Build/Verify/Report); does real work |
| ws-final-template | `type: final` | Waits for ALL = COMPLETE; produces summary report |

## Worker Prompt Template (Standard)

Structure for standard workstreams:

```markdown
Task: [workstream name] — [one-line description]

## Context
- Orchestration ID: {orchestration_id}
- Workstream: {workstream_key}
- Backend: {backend}
- Attempt: {attempt_count} of {max_retries}
- Skill version: {skill_version}
{if retry: - Prior error: {last_error_message}}

## MCP Connection
Connect to the orchestrator MCP service before starting:
- Service: hls_fde.hi_genie_prod.orchestrator_mcp
- Use `get_workstream_context` to load full workstream state
- Use `get_skill_content` to load backend-specific guidance:
  - Section: "backends/{backend}"
  - Section: "core/state-machine" (for status transitions)

## Step 1: Read Context
Call `get_workstream_context` with orchestration_id and workstream_key.
Extract: upstream notes, output_artifacts, gate_conditions.
{if retry: Read error_history for prior failure context.}

## Step 2: Load Backend Guidance
Call `get_skill_content` with section="backends/{backend}".
Follow the Setup → Execute → Validate lifecycle from that module.

## Step 3: Execute
[Backend-specific steps synthesized from workstream config]
- Output artifacts: {output_artifacts}
- File scope: {file_scope}
- Key constraints: {constraints}

## Step 4: Validate
Verify all gate_conditions:
{for each gate_condition:}
- {condition_type}: {condition_spec}
{end}
If ALL pass: transition to COMPLETE.
If ANY fail: transition to BLOCKED with error details.

## Step 5: Report
Call `update_workstream_status` with:
- status: COMPLETE (or BLOCKED if validation failed)
- notes: Summary of what was produced

Call `append_workstream_notes` with downstream-relevant details:
- Artifact paths/IDs created
- Configuration values downstream workstreams will need
```

## Substitution Variables

All `{variable}` placeholders are resolved from:
- `dispatch.workstreams` row (workstream_key, config, status, attempt_count)
- `dispatch.orchestrations` row (orchestration_id, skill_version, project_id)
- Plan snapshot (output_artifacts, gate_conditions, depends_on)
- Upstream workstream notes (via `get_workstream_context`)

## Retry-Aware Synthesis

When `attempt_count > 1`, the prompt includes:
- Prior error message from `error_history`
- Explicit instruction to address the prior failure
- "Do NOT repeat the same approach that failed" directive
- Suggestion to load `capabilities/error-handling` section

## MCP Tool Bootstrapping

Every synthesized prompt includes the MCP connection preamble:

```
Connect to MCP service: hls_fde.hi_genie_prod.orchestrator_mcp
Available tools: get_workstream_context, update_workstream_status,
  append_workstream_notes, get_skill_content, search_decisions,
  get_project_context, search_memory, ...
```

This ensures workers can self-serve context without hardcoding it all
into the prompt. The prompt provides the "what" (task); MCP provides
the "how" (tools + runtime state).

## Prompt Size Budget

Target: 2,000–4,000 characters per synthesized prompt.
- Too short: worker lacks context, wastes tool calls re-discovering state
- Too long: platform truncation risk, slower token processing

The MCP-first pattern keeps prompts lean — static structure in the prompt,
dynamic state loaded at runtime via tool calls.
