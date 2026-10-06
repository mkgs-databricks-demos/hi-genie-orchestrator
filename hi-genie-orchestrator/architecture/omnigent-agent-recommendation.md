Release 1.1 Omnigent Agent Recommendation

**Status:** Revised for review
**Date:** 2026-08-16
**Scope:** Hi Genie Orchestrator Release 1.1, with a limited Release 1 Worker Insight slice

## Recommendation

Create a dedicated Omnigent Agent as a **role-aware orchestration assistant** for Hi Genie Orchestrator. Release 1 should include only the optional read-only Worker Insight slice. Release 1.1 should add the parent agent and specialized sub-agents for planning research, Supervisor operations, independent review, and workstream observation.

The parent agent improves the conversational planning and supervision experience, but the Hi Genie App and WS-INIT remain authoritative for persisted state, scheduling, dependency evaluation, review-gated completion, and dispatch execution.

The recommended posture is **policy-controlled assisted execution**:

- The agent may capture and revise planning records.
- The planning sub-agent may research open questions and recommend best practices through two independent harnesses.
- The Supervisor sub-agent is the only sub-agent granted Supervisor API access.
- The reviewer sub-agent may independently inspect attempts and produce findings, but may not complete work directly.
- The worker sub-agent provides insight into active workstreams through the Workstream MCP; it does not perform the work itself.
- Low-risk actions may use pre-approved Supervisor policies; high-impact actions require explicit confirmation.

## Product Role

The Hi-Genie Omnigent Agent is a conversational control and insight layer over the Hi Genie planning, supervision, review, and workstream-state surfaces. It is comparable to Polly-style orchestration: it routes work to specialized sub-agents, gathers evidence, synthesizes recommendations, and invokes the authoritative Hi Genie APIs and MCP tools.

### Primary responsibilities

- Capture requirements, constraints, assumptions, and acceptance criteria.
- Record open questions and track ownership and resolution.
- Propose architecture and implementation decisions.
- Decompose accepted requirements into features, release items, and workstream specifications.
- Route difficult planning questions to two independent research harnesses and synthesize their recommendations.
- Inspect published plans, DAGs, summaries, review findings, remediation state, and workstream progress.
- Prepare validation, publication, dispatch, and remediation proposals for Supervisor authorization.
- Route review work to an independent reviewer sub-agent.
- Explain why workstreams are blocked, ready, under review, or complete.

### Explicit non-responsibilities

- Replacing WS-INIT's authoritative scheduling and dependency engine.
- Running independent scheduling logic in the agent.
- Direct Lakebase access or arbitrary SQL.
- Allowing a sub-agent to bypass the Hi Genie App authorization boundary.
- Marking workstreams `COMPLETE` outside the Supervisor-authorized review path.
- Waiving blocking findings or acceptance criteria without the required approval policy.
- Changing security, identity, RLS, or production configuration without required approval.
- Storing raw conversations as the project memory system.

## Parent Agent and Sub-Agent Model

Use one Hi-Genie Omnigent Agent configuration with specialized sub-agents rather than separate top-level agent products in Release 1.1. The parent agent owns routing, context assembly, provenance, and user-facing explanation. Each sub-agent receives a narrowly scoped task, role, identity, and tool allowlist.

```text
Hi-Genie Omnigent Agent
├── Planning Research sub-agents (two independent harnesses)
├── Supervisor sub-agent (only Supervisor API access)
├── Reviewer sub-agent (independent review context)
└── Worker Insight sub-agent (Workstream MCP, read/report only)
```

The sub-agents must not share unbounded conversation state or silently inherit one another's permissions. The parent records the sub-agent identity, harness, role, prompt version, tool calls, and resulting evidence.

### Planning Research sub-agents

For an open question, requirement, or potential blocker requiring architectural refinement, the parent launches **two independent planning research sub-agents** using separate harnesses or execution contexts. They should:

- Inspect the authorized project context and relevant documentation.
- Produce separate findings, tradeoffs, risks, and recommendations.
- Avoid coordinating with each other before producing their independent reports.
- Identify disagreements and unresolved assumptions.
- Return a structured recommendation for the parent to synthesize into Lakebase planning records.

The parent may record the resulting draft recommendation without human review before it enters `UNDER_REVIEW`. Acceptance of decisions, publication, and dispatch remain separate privileged actions.

### Supervisor sub-agent

The Supervisor sub-agent is the **only role within the Hi-Genie Omnigent Agent that may access the Supervisor API tools**. It may:

- Validate planning completeness.
- Prepare publication and activation requests.
- Prepare materialization, dispatch, retry, pause, unpause, and remediation requests.
- Resolve review findings into remediation envelopes.
- Read and report effective runtime configuration.

It must not implement a second scheduler. All scheduling and state transitions remain authoritative in the Hi Genie Supervisor API and WS-INIT Dispatcher. The sub-agent may effectively act as the conversational supervisor interface, but it does not replace WS-INIT.

### Reviewer sub-agent

The Reviewer sub-agent is an independent review worker, similar to Polly's use of a separate review harness such as Pi for code review. It may:

- Inspect the assigned workstream attempt, artifact versions, evidence, acceptance criteria, and relevant project context.
- Run or request the applicable validation and testing checks through approved tools.
- Produce structured review evidence, findings, severity, remediation guidance, and a final verdict.
- Use a distinct reviewer identity, harness, prompt context, or execution lease from the producing worker.

It may not mark a workstream complete, modify the producing worker's evidence, approve its own work, or access Supervisor API tools unless it is separately authorized through the Supervisor role boundary.

### Worker Insight sub-agent

The Worker Insight sub-agent gives the parent agent an accurate view of what Genie Code Workstreams are doing. It is an observer and context assistant, **not an implementation worker**. It may:

- Use the Workstream MCP to retrieve project, workstream, task, session, decision, summary, error, review, and remediation context.
- Explain current progress, blockers, dependencies, evidence gaps, and next actions.
- Summarize what a coding workstream reported and whether its validation evidence is complete.
- Prepare a context package or remediation reference for another authorized workstream.

It does not take over coding, documentation, testing, deployment, or other workstream execution. Actual work remains assigned to the Genie Code Workstream or other explicitly dispatched worker.

## Role and Tool Boundaries

The parent configuration declares the active sub-agent role for every delegated task. Role changes require a new authenticated execution context or explicit Supervisor authorization. A shared model or harness does not grant shared privileges.

### Release 1 Worker Insight slice

Release 1 may include Worker Insight as an optional read-only capability. It
uses the Workstream MCP to explain what Genie Code Workstreams are doing and
never performs implementation work. It has no Supervisor API access, does not
write dispatch state, and does not require durable agent handoffs.

### Planning and read tools

The Release 1.1 profile should enable all planning and review tools that are part of the approved release, including:

- Requirements, open questions, decisions, features, release plans, and workstream specifications.
- Append-first planning drafts, proposals, resolutions, revisions, and links.
- Structured planning search within the authorized project scope.
- Read-only execution summaries, DAGs, session summaries, review results, findings, and remediation history.
- Health and schema-version queries.

### Supervisor API tools

Only the Supervisor sub-agent may call the versioned Supervisor API. The initial profile may include all Release 1.1 Supervisor API operations, subject to authorization and policy checks:

- Validate planning coverage and dependencies.
- Publish immutable plan snapshots.
- Approve or activate releases.
- Materialize workstreams.
- Dispatch, retry, pause, and unpause work.
- Create or route remediation work.
- Change global runtime configuration.
- Waive findings or reset terminal `BLOCKED` state.
- Mark a workstream complete only after the review contract passes.

The Supervisor API remains the only authority for these actions; the agent never writes dispatch tables directly.

## Approval and Auto-Approval Policy

Use the same policy-based approval model as other Omnigent orchestration agents where available, while keeping Hi Genie authorization authoritative.

### No confirmation required

These actions may proceed automatically when the caller is authorized and the operation is within policy:

- Reading authorized context.
- Recording planning drafts, proposed questions, proposed decisions, and session summaries.
- Running the two independent planning research sub-agents.
- Preparing review, publication, dispatch, or remediation proposals without executing them.
- Routing a worker-insight request to inspect current state.

Drafts do not require human review before becoming `UNDER_REVIEW`; the normal planning and review lifecycle remains authoritative.

### Pre-approved Supervisor policy

A workspace administrator may pre-approve bounded, reversible actions through the Supervisor policy layer, such as:

- Validating a plan.
- Dispatching an already approved plan within an allowed project, environment, and execution tier.
- Retrying a failed review or worker attempt within configured limits.
- Sending a remediation envelope that references immutable Lakebase findings.
- Pausing or unpausing an allowed workstream.

The policy must specify actor, project/environment scope, operation, maximum impact, retry limits, and audit requirements. The Supervisor API evaluates the policy on every request; agent instructions alone are never sufficient.

### Interactive confirmation required

Require explicit human or Supervisor confirmation for:

- Publishing or activating a new plan or release.
- Production dispatch outside a pre-approved policy.
- Changing global runtime configuration or safety limits.
- Security, identity, permission, or RLS changes.
- Destructive or irreversible actions.
- Acceptance-criteria waivers, finding waivers, or terminal-blocked resets.
- Scope changes, new sub-workstreams, or changes to protected dependencies.
- Marking work complete when a human-only acceptance criterion is present.

The confirmation should identify the exact operation, scope, plan or artifact version, expected side effects, and policy or human authorizer. Every approval is recorded in Lakebase audit metadata.

## Interaction Pattern

```text
Conversation
  → planning drafts
  → two independent research reports when refinement is needed
  → synthesized recommendations and open questions
  → accepted requirements and decisions
  → release items and workstream specifications
  → Supervisor validation
  → policy approval or interactive confirmation
  → immutable plan publication
  → WS-INIT materialization and dispatch
  → Worker Insight monitoring
  → independent Reviewer sub-agent
  → remediation routing or Supervisor-authorized completion
```

The parent agent must clearly distinguish preparation from execution and show which sub-agent is acting. It should identify whether an action is a draft, a recommendation, a policy-approved operation, or an interactive-confirmation request.

## Deployment and Identity

The agent is a client of the Databricks-native `mcp-hi-genie-orchestrator` App rather than a second orchestration service.

- Use the Hi Genie MCP endpoint for planning, workstream state, review context, and worker insight operations.
- Use OAuth2 User-to-Machine (U2M) for the Omnigent Agent's user-authorized connection to the Hi Genie App.
- Preserve the authenticated Databricks user for user-scoped MCP operations.
- Grant Supervisor API access only to the Supervisor sub-agent through a separately authenticated and authorized API context.
- Record parent-agent identity, sub-agent identity, harness, effective role, human authorizer or policy ID, session ID, request ID, and correlation ID.
- Keep agent configuration and prompt policy separate from production App code and Lakebase schema ownership.
- Any deployable supporting resource must be Databricks-native; the agent may be hosted by Omnigent, but the Hi Genie application, data, authorization, and orchestration authority remain in Databricks.

The agent may use the MCP or Supervisor API according to role. It must not use arbitrary database credentials or direct Lakebase connections.

## Memory and Context

Use the existing Hi Genie memory model with the same OpenTelemetry and MLflow 3 tracing, redaction, and retention defaults as the Hi Genie App:

- Short-term context remains session-scoped.
- Episodic memory stores redacted planning and execution summaries.
- Semantic memory stores approved, sanitized design patterns and recurring lessons.
- Cross-project developer memory remains subject to its existing authorization and privacy controls.
- Raw prompts, credentials, tokens, unrestricted SQL, and sensitive payloads are excluded from durable memory and traces.
- Agent and sub-agent provenance is attached to planning records, reviews, approvals, and summaries.

## Release Phasing

### Release 1.1

Implement the single parent agent and specialized sub-agents:

- Planning Research sub-agents using two independent harnesses.
- Supervisor sub-agent as the sole Supervisor API caller.
- Reviewer sub-agent with a distinct review context.
- Worker Insight sub-agent that observes workstreams without performing their work.
- All approved Release 1.1 planning, review, remediation, and read tools.
- OAuth2 U2M access to the Hi Genie App.
- Policy-based auto-approval for bounded low-risk operations and explicit confirmation for high-impact actions.
- Same telemetry, redaction, memory, and audit defaults as the Hi Genie App.

### Later releases

Consider:

- More autonomous but still policy-bounded dispatch and remediation routing.
- Rich React planning and agent-activity views.
- Project-level and developer-level policy overrides.
- Cross-project design-pattern retrieval with explicit consent.
- Additional specialized sub-agents for deployment validation or cost analysis.
- Separate top-level agent configurations if operational isolation proves necessary.

### Do not make initial goals

- Fully autonomous replacement of WS-INIT.
- Unreviewed architecture acceptance.
- Automatic production dispatch from conversational intent alone.
- Autonomous completion or waiver of review findings.
- Direct mutation of dispatch state outside the Supervisor API.
- Giving the Worker Insight sub-agent implementation authority.

## Safety and Audit Requirements

Every agent or sub-agent action that reads or changes durable state includes:

- Authenticated user and effective role.
- Parent-agent and sub-agent identity.
- Harness and prompt-policy version.
- Tool or API operation.
- Project and workstream scope.
- Session, request, and correlation identifiers.
- Policy decision or human authorization record for privileged actions.
- Idempotency key for writes.
- Before/after references for state changes.

The agent fails closed when it cannot verify authorization, scope, plan version, review evidence, artifact freshness, or approval policy. It explains the required next approval or remediation step rather than attempting a bypass.

## Open Questions

1. Which Omnigent packaging and configuration convention should be used for the first implementation?
2. Which two independent harnesses should be selected for Planning Research, and which harness should be selected for the Reviewer sub-agent?
3. What exact OAuth2 U2M client registration, scopes, and token-forwarding configuration are required for the Omnigent surface and Hi Genie App?
4. Which bounded Supervisor operations should be placed in the initial pre-approved policy, and what project/environment limits apply?
5. Which Release 1.1 review and planning tools require additional workspace-specific permissions beyond the approved release contract?
6. Whether separate top-level agent configurations are needed later for stronger operational isolation; Release 1.1 starts with one parent agent and specialized sub-agents.

## Decision Request

Approve or revise the following direction:

> Hi Genie Release 1.1 should include one dedicated Omnigent Agent with specialized Planning Research, Supervisor, Reviewer, and Worker Insight sub-agents. The Planning Research sub-agents independently investigate design questions, the Supervisor sub-agent is the only role with Supervisor API access, the Reviewer sub-agent produces independent review evidence, and the Worker Insight sub-agent reports on workstreams without performing their work. The agent uses OAuth2 U2M with the Hi Genie App, applies policy-based approval for bounded operations, and preserves WS-INIT and the Hi Genie App as the authoritative orchestration and state boundaries.

## Approved Profile and Routing Contract

The proposed Release 1.1 profile is approved. Hi Genie uses one parent Omnigent Agent with five specialized profiles: Planning Research A, Planning Research B, Supervisor, Reviewer, and Worker Insight.

The parent coordinates intent, routing, policy evaluation, correlation, and synthesis. WS-INIT remains the authoritative Dispatcher. Planning Research uses two independent contexts for architectural and potentially blocking questions. The Supervisor profile is the only profile permitted to call Supervisor API tools. The Reviewer uses a distinct execution context from the producing Worker and produces evidence and findings without marking completion. Worker Insight observes workstreams through MCP and never performs their implementation work.

The profile uses deterministic routing, typed minimal handoff envelopes, Lakebase references as the source of detailed context, policy-based approval levels, durable escalation, and fail-closed behavior. Bounded low-risk operations may be automatically approved by explicit policy. Publication, materialization, dispatch, global configuration changes, and new remediation workstreams require confirmation. Completion approval, waivers, security changes, destructive operations, production exceptions, blocked resets, and unresolved reviewer disagreement remain human-only.

Release 1.1 includes this profile, its routing and handoff contract, independent research, reviewer isolation, and durable recovery. Later releases may add specialized reviewer fleets, quorum review, dynamic cost-aware routing, project/developer policy overrides, and broader autonomous remediation without replacing WS-INIT.
