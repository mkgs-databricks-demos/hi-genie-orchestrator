# Hi Genie Orchestrator — Requirements

## Project Vision

Build a lightweight, first-party Hi Genie Orchestrator App hosted as a
Databricks App. The App provides a supervisor dispatch API and typed Python SDK
alongside a Workstream MCP that allows Genie workers and authorized clients to
retrieve and persist durable orchestration context through Lakebase.

The service is intended to reduce repeated prompt context while preserving
project decisions, workstream state, execution history, and recovery details.

The Supervisor API and Workstream MCP are separate surfaces in one production
App. The dispatch surface owns asynchronous `LISTEN/NOTIFY` handling, job
triggering, scheduling, review orchestration, and completion approval. The MCP
surface owns worker-visible context, bounded state, and memory. Neither surface
exposes the other surface's unrestricted database operations.

## Product Scope

### Included

- Read relevant project, workstream, session, and architecture context.
- Record architecture and requirements decisions.
- Persist session summaries and execution notes.
- Record errors, blockers, and recovery details.
- Update bounded workstream and task state.
- Provide structured search over authorized records.
- Provide Lakebase short-term session memory and in-project developer long-term
  memory over sanitized and distilled records.
- Enforce user-level access to projects, workstreams, sessions, and records.
- Preserve provenance, timestamps, actor identity, and correlation identifiers.

### Excluded from the Initial Release

- Job triggering or orchestration scheduling.
- Arbitrary SQL execution.
- General-purpose Lakebase administration.
- Unbounded database CRUD.
- Automatic prompt synthesis inside the MCP server.
- Cross-project developer memory; this is targeted for Release 1.1 after
  explicit authorization and privacy review.

## MCP Application

**Product name:** `Hi Genie Orchestrator`

**Application name:** `mcp-hi-genie-orchestrator`

The application must be deployed as a Databricks App with an HTTP-compatible
MCP transport and a `/mcp` endpoint. The `mcp-` prefix is required for the
Databricks custom MCP App integration path.

The Supervisor API and SDK must be versioned and typed. The initial MCP tool
surface must be domain-specific and controlled. Neither surface may expose raw
SQL, unrestricted table access, or arbitrary Lakebase commands.

## Identity and Authorization

- Use Databricks Apps on-behalf-of-user authorization.
- Preserve the authenticated Databricks user for user-scoped operations.
- Enforce permissions at project, workstream, session, and record boundaries.
- Record the acting user in audit metadata for every read and write.
- Use the App identity only for explicitly approved shared or background work.
- Treat forwarded user access tokens as request-scoped secrets.
- Never persist, log, trace, or return OAuth access tokens.

Dynamic client registration is deferred until Databricks-hosted MCP endpoints
support it natively. The first release uses manually registered Databricks
OAuth clients.

## Persistence and Write Semantics

### Append-First Records

The following records are append-only:

- Decisions
- Session summaries
- Errors and blockers
- Workstream events
- Architecture and requirements outcomes

Historical records must not be overwritten.

### Limited Mutable State

The following records may be updated through explicit, validated operations:

- Workstream status
- Task status
- Active session metadata
- Retry and recovery state

Mutable updates must be auditable and must preserve the acting user, timestamp,
correlation identifier, and reason for the change.

### Reliability

- Retry-safe writes must accept idempotency keys.
- Duplicate requests must not create duplicate domain records.
- Every record must include project, workstream, and session context where
  applicable.
- Database access must use parameterized operations and bounded queries.

## Lakebase Environment

- Use one Lakebase project for the production application.
- Treat the `production` branch as the protected durable baseline.
- Use schema feature branches while iterating on the data model.
- Keep `dispatch` and `state` as separate schemas with separate ownership and
  migration namespaces.
- The Dispatcher owns `dispatch`; the Workstream MCP owns `state`.
- Cross-schema coordination uses shared identifiers, read-only views, or
  explicit integration events rather than direct cross-owner writes.
- Promote migrations through review and validation before applying them to
  `production`.
- Keep application state, migration history, and compatibility rules explicit.
- Avoid destructive migrations that cannot be rolled forward or rolled back
  safely.

### Migration Strategy

AppKit's Lakebase Plugin provides connection pooling, OAuth credential
refresh, and a service-principal pool for DDL/admin operations. It does not
provide a versioned migration engine. The guarded
`CREATE SCHEMA/TABLE IF NOT EXISTS` checks that AppKit sample apps run during
`onPluginsReady` are a startup-bootstrap convenience, not checksum/version/lock
migration management, and must not be relied on as the production migration
authority.

- The application defines an authoritative TypeScript migration module/file
  that is the only schema-change boundary for the App.
- The App invokes the migration module during startup, before serving traffic,
  using AppKit's Lakebase service-principal pool for the underlying DDL/admin
  connection.
- Release 1 stores ordered, versioned migration definitions with the
  application and records basic applied migration history/version state.
- Apply Release 1 migrations to disposable Lakebase child branches before the
  same reviewed migration definitions are deployed to protected `production`.
- Promote the same reviewed, immutable migration artifacts to the protected
  `production` branch through the production DAB target; the App's next
  startup on that target applies them.
- Guarded, versioned, idempotent migration DDL is permitted only inside the
  startup migration module. Never execute DDL from MCP requests or any other
  request-path code, and never run destructive, unversioned, or ad hoc DDL
  anywhere, including at startup.
- Release 1.1 adds checksum verification, Postgres advisory locking,
  fail-closed readiness, migration-registry validation, a dedicated migration
  session, transactional migration-history writes, rejection of future schema
  versions, comprehensive migration tests, expand-and-contract compatibility,
  and post-migration schema verification.
- Release 1.1 runs large data backfills as Databricks-native Lakeflow Jobs;
  startup migrations remain bounded schema changes and must not hold App
  startup open for large backfill work.
- Keep exact package, runner, migration-directory names, registry shape,
  advisory-lock key, and hardening implementation details as implementation or
  deployment choices; the startup migration boundary itself is not optional
  (see `OPEN_QUESTIONS.md`).

## Deployment

- Deploy the production App through a Databricks Declarative Automation Bundle.
- Maintain a production-only deployment target for the initial release.
- Keep environment-specific values in bundle configuration rather than source
  code.
- Require reviewed bundle changes for production deployment.
- Configure the App, Lakebase connection, scheduled cleanup, and observability
  resources from the bundle.
- Deploy one production App resource named `mcp-hi-genie-orchestrator`.
- Keep Supervisor API authorization distinct from user-level MCP authorization,
  even though both surfaces share the App deployment.

## Observability

OpenTelemetry and MLflow 3 tracing are required for the initial release.

### OpenTelemetry

- Enable Databricks App telemetry for request spans, logs, and metrics.
- Instrument MCP request handling and downstream database operations.
- Propagate request and trace correlation across tool and storage calls.

### MLflow 3

- Store MLflow 3 traces in Unity Catalog-backed trace storage.
- Create one root span per MCP request or tool invocation.
- Create a `TOOL` span for each executed MCP tool.
- Create child spans for Lakebase, SQL, and other downstream operations.
- Correlate traces with MCP session, request, project, and workstream IDs.
- Capture a pseudonymous user identifier where required for investigation.
- Enable MLflow dual export when App telemetry configures OTLP export, so
  traces remain available in both the MLflow backend and OpenTelemetry tables.

### Trace Data Protection

Trace inputs and outputs must use explicit allowlists and redaction. Do not
capture:

- OAuth access tokens or authorization headers
- App client secrets or database credentials
- Raw request headers
- Unrestricted Lakebase records or memory content
- Sensitive SQL literals
- Unclassified prompt or response payloads

Safe trace attributes include tool name and version, status, latency, request
ID, session ID, workstream ID, record counts, payload sizes, and sanitized error
classes.

## Trace Retention

The retention period must be configurable through a Declarative Automation
Bundle variable.

**Bundle variable:** `mlflow_trace_retention_days`

**Default:** `90`

Requirements:

- Interpret the value as days.
- Reject zero, negative, or non-numeric values during deployment validation.
- Pass the resolved value to the scheduled trace-cleanup job or SQL task.
- Do not hard-code the retention period in application code.
- Retain only redacted traces beyond the raw-trace retention window unless a
  stricter compliance policy applies.
- Document that 90 days is the current operational default and may be changed
  by the production deployment configuration.

## Release 1 Tool Surface

Release 1 provides a focused, domain-specific MCP catalog:

### Context Retrieval

- `get_project_context`
- `get_workstream_context`
- `search_decisions`
- `get_recent_session_summaries`
- `get_relevant_errors`
- `get_session_context`

### Append-First Records

- `record_decision`
- `record_session_summary`
- `record_error`
- `record_workstream_event`
- `record_task_attempt`
- `record_task_completion`

### Mutable State

- `update_workstream_status`
- `update_task_status`
- `update_recovery_state`
- `start_session`
- `end_session`

### Search and Operations

- `search_context`
- `get_task_history`
- `get_execution_summary`
- `get_health`
- `get_schema_version`

All tools require explicit scope, authorization filtering, bounded results, and
correlation metadata. Append-first writes require idempotency keys. Mutable
state requires validated transitions and optimistic concurrency control.

## Lakebase Memory Model

Use Databricks' self-managed Lakebase memory pattern with three distinct
layers:

### Short-Term Memory

Short-term memory is session- or thread-scoped working context. It supports
continuity during an active interaction and is keyed by an application
`thread_id` or session identifier. It may include checkpoint metadata and
bounded recent context, but must not become the durable source for reusable
project knowledge.

Short-term memory requirements:

- Scope records to one session or thread.
- Apply a short configurable TTL, initially targeted at 1–7 days.
- Keep payloads bounded and redacted.
- Allow expiration without affecting durable summaries or semantic memory.
- Support retry and resume behavior without storing raw conversation history by
  default.

### Long-Term Episodic Memory

Episodic memory consists of redacted session summaries, execution outcomes,
errors, and other durable records describing what happened. It remains linked
to the originating project, workstream, session, and developer.

Episodic memory requirements:

- Keep the canonical summary record separate from its embedding.
- Retain provenance, timestamps, actor identity, and source scope.
- Support semantic retrieval within the current authorized project in Release 1.
- Use configurable retention and compaction rather than unbounded growth.

### Long-Term Semantic Memory

Semantic memory consists of compacted, deduplicated, reusable facts, design
patterns, conventions, and recurring lessons distilled from episodic records.
It is not a copy of raw session history. A scheduled promotion/compaction
process may create semantic records when importance, repetition, or explicit
approval warrants durable reuse.

Release 1 includes in-project developer semantic memory. Cross-project
developer memory is deferred to Release 1.1 and requires explicit developer
scope or consent, authorization mapping for every project, and audited
source-project attribution.

### Embeddings and Lakebase Search

The storage path is ordinary PostgreSQL/pgvector-compatible Lakebase storage
behind a retrieval abstraction. Lakebase Search may be enabled as a
project-wide Beta optimization, but it is optional to the Release 1 baseline
because enablement is irreversible and can restart project compute. Structured
relational search must remain available without the Beta feature. Databricks
Vector Search is the fully native fallback if the workspace declines Lakebase
Search.

Requirements:

- Store `developer_id`, `project_id`, `workstream_id`, `session_id`, and
  `memory_type` (`short_term`, `episodic`, or `semantic`) with embedded records.
- Generate embeddings only from redacted, approved memory content.
- Use cosine similarity as the initial distance strategy.
- Generate embeddings asynchronously with `pending`, `ready`, and `failed`
  states so summary writes remain fast and retryable.
- Keep source records canonical; embeddings are derived artifacts.
- Use a Databricks-hosted embedding endpoint selected through a DAB bundle
  variable rather than embedding model calls inside MCP requests.
- Store the model identifier, model version, vector dimensions, and generation
  timestamp with every embedding record.
- Treat model or dimension changes as new embedding versions and re-embed in
  the background without replacing canonical memory records.
- Retry transient generation failures with bounded exponential backoff and
  preserve terminal status for operator review.
- Fall back to structured relational search whenever semantic indexing is
  pending or unavailable.
- Enforce Lakebase row-level security for memory retrieval and writes.
- Resolve the authenticated user into the Lakebase authorization context before
  applying RLS; the exact token-to-session identity bridge remains an open
  implementation decision.
- Apply structured scope filters before similarity ranking or result return.
- Never expose raw prompts, secrets, tokens, or unrestricted project content
  through memory results.
- Configure short-term TTL and episodic retention through bundle-managed values.
- Compact and deduplicate episodic records into semantic records without
  overwriting historical source records.

## Review-Gated Completion

- Workers must transition successful self-validation to `READY_FOR_REVIEW`, not
  directly to `COMPLETE`.
- Supervisor or delegated review processes must independently validate required
  artifacts, tests, acceptance criteria, and output references.
- Only the supervisor-authorized dispatch/state path may set `COMPLETE`.
- Review failures must transition to `RETRYING` or `BLOCKED` according to
  retryability and retry limits.
- Review records must be immutable, auditable, and linked to the reviewed
  workstream attempt and artifact/version identifiers.
- Review dispatch must be idempotent and track an explicit `review_task_id`.

## Lakebase-Referenced Remediation

- Lakebase must be the authoritative source for review findings, remediation
  details, acceptance criteria, evidence, and review history.
- Reviewers must persist structured, immutable findings before remediation is
  dispatched.
- The Supervisor should send a bounded remediation envelope to the originating
  workstream by default rather than duplicating the full finding payload.
- The envelope must include the finding and review identifiers, required action,
  severity, affected attempt or artifact, correlation metadata, and the MCP
  retrieval scope.
- The workstream must retrieve the authoritative finding through MCP, then
  acknowledge, remediate, validate, and resubmit evidence.
- A separate remediation workstream is required when the original workstream
  cannot continue, lacks the required authorization or capability, requires
  independent ownership, or would conflict with another change.
- Prompt delivery, retrieval failures, stale references, and remediation
  acknowledgements must be auditable.
- Changes to the reviewed artifact, acceptance contract, or source version
  invalidate the finding reference and require a new remediation request and
  review.

## Review Evidence Freshness

- Review evidence must be bound to the exact source commit, artifact digest,
  deployed version, deployment target, dependency versions, and validation
  configuration that produced it.
- Changes to acceptance criteria, the review-contract version, test/build/lint/
  type-check configuration, or security and authorization configuration must
  invalidate affected evidence.
- The Supervisor must fail closed when evidence is stale and must not authorize
  `COMPLETE` from stale evidence.
- The affected workstream returns to `VALIDATING` when evidence must be
  regenerated, or to `READY_FOR_REVIEW` when an authoritative freshness check
  permits resubmission without new worker validation.
- Every invalidated review requires a new review task and immutable review
  record linked to the current attempt and artifact versions.

## Review Retry, Lease, and Escalation

- The system must maintain separate retry budgets for review infrastructure,
  initial implementation, and remediation attempts.
- Default budgets are three automatic review attempts per submission, three
  initial implementation attempts, and three remediation attempts per grouped
  finding and artifact.
- Review retries must use bounded exponential backoff with jitter: one minute
  before the first retry, five minutes before the second, and no individual
  delay longer than fifteen minutes.
- Review tasks must use a fifteen-minute durable lease with renewal for
  long-running reviews.
- Expired leases must be reclaimable by WS-INIT; only one active lease may
  exist for a workstream attempt.
- Lease recovery must not consume an implementation or remediation attempt.
- Reviewer outages, timeouts, and crashes must keep the workstream in
  `READY_FOR_REVIEW`; reviewer unavailability alone must not create `BLOCKED`.
- After the review retry budget is exhausted, the Supervisor must escalate the
  review while allowing unrelated workstreams to continue.
- Three failed remediation attempts for the same finding group must transition
  the workstream to `BLOCKED` unless an authorized human decision changes the
  disposition.
- Unsafe, unauthorized, destructive, ambiguous, or unverifiable conditions may
  transition directly to `BLOCKED`.
- Human approval is required for security or authorization changes, destructive
  operations, production policy exceptions, acceptance waivers, ambiguous
  requirements, scope changes, new sub-workstreams, terminal blocked resets,
  exhausted retry budgets, and unresolved reviewer disagreement.
- `LISTEN/NOTIFY` must accelerate evaluation without replacing persisted state,
  lease recovery, idempotency, or scheduled-tick fallback.

## Remediation State Separation

- Workstream lifecycle state and review-finding state must be stored and
  evaluated separately.
- Workstreams must support `READY_FOR_REVIEW`, `UNDER_REVIEW`, `FIX_REQUIRED`,
  `VALIDATING`, and `COMPLETE` transitions for the review loop.
- Findings must support `OPEN`, `ACKNOWLEDGED`, `IN_REMEDIATION`,
  `RESUBMITTED`, and `VERIFIED` states.
- Findings may become `BLOCKED` only when remediation cannot proceed and may
  become `WAIVED` only through an authorized, immutable exception.
- `COMPLETE` is prohibited while any blocking finding is not `VERIFIED`.
- Advisory findings may remain open only with an assigned owner and documented
  disposition.
- Every remediation attempt must create new evidence and review records.
- A workstream status update must not silently close, waive, or replace a
  review finding.

## Review Finding Dependency Impact

- `REQUIRED_FIX` findings must block completion of the affected workstream and
  block downstream workstreams that directly depend on it.
- Unrelated workstreams and workstreams with independently satisfied
  dependencies may continue.
- `BLOCKING` findings must block direct dependents and may block broader plan
  progress when the affected workstream is critical to the dependency graph.
- `ADVISORY` findings must not block completion or downstream execution, but
  require an owner and documented disposition.
- Dependency impact must be derived from persisted `depends_on` relationships,
  not manually maintained status flags.
- When a finding is verified, the Dispatcher must re-evaluate affected
  dependents on the next event-driven or scheduled tick.

## Dependency-Blocked State

- Direct dependents held by unresolved required or blocking findings must enter
  `BLOCKED_BY_DEPENDENCY`, not generic `BLOCKED`.
- The Dispatcher must not dispatch work while a workstream is
  `BLOCKED_BY_DEPENDENCY`.
- `BLOCKED_BY_DEPENDENCY` must retain the upstream workstream, finding, and
  dependency context that caused the hold.
- After the upstream finding is verified, WS-INIT must automatically re-evaluate
  the dependent on the next event-driven or scheduled tick.
- A dependent remains `BLOCKED_BY_DEPENDENCY` when another dependency or local
  readiness condition still prevents execution.
- Generic `BLOCKED` is reserved for terminal, unsafe, unauthorized, or other
  conditions requiring supervisor or human intervention.

## Remediation Finding Grouping

- The Supervisor may group findings into one remediation prompt or workstream
  when they share an artifact or component, worker capability, dependency,
  validation boundary, and compatible execution ownership.
- Findings must remain separate when they involve different owners, artifacts,
  security boundaries, execution tiers, or independent review gates.
- Grouped remediation must preserve every individual finding identifier and
  verification result.
- Resolving one grouped finding must not implicitly close the others.

## Dispatcher Event Triggering

- The Dispatcher must react to Lakebase `LISTEN/NOTIFY` events for low-latency
  response to state changes such as `READY_FOR_REVIEW`.
- Notifications are wakeup hints only; persisted Lakebase state and the WS-INIT
  priority tree remain authoritative.
- Each notification-triggered evaluation must re-read state, acquire the
  appropriate dispatch lock, and perform at most one authoritative action.
- Scheduled ticks remain the recovery mechanism for missed, duplicated, or
  delayed notifications.

## Runtime Configuration and Administration

- Release 1 must support globally scoped runtime configuration for review,
  implementation, and remediation retry budgets; review lease and renewal
  durations; and review backoff, multiplier, and jitter settings.
- Lakebase `dispatch` configuration is the authoritative runtime source.
- DAB variables must provide bootstrap defaults and immutable safety bounds, but
  deployments must not overwrite existing operator-managed values.
- Configuration keys must come from an application-owned allowlist with typed
  values, allowed ranges or enums, mutability metadata, and cross-field
  validation.
- Configuration mutations must require an authorized Supervisor Admin API,
  optimistic concurrency, an idempotency key, a reason, and immutable audit
  history containing actor, scope, previous value, new value, timestamp,
  request ID, and correlation ID.
- The Workstream MCP must not expose configuration administration tools.
- Every new review, lease, implementation attempt, and remediation attempt must
  snapshot the effective configuration version used for its policy decisions.
- Changes must apply to new operations and must not retroactively alter active
  retry budgets or leases.
- Release 1 configuration writes must be restricted to the dedicated
  `hi-genie-config-admins` role.
- The Release 1 React frontend may display effective configuration and change
  history, but must not edit mutable configuration.
- Project-scoped overrides target Release 1.1; developer-scoped overrides are
  deferred until a later release. Configuration resolution must preserve the
  planned project, developer, global, DAB bootstrap, and emergency-fallback
  precedence model.
- The `dispatch` schema must define `config_definitions`, `config_values`, and
  immutable `config_change_events` tables for the Release 1 global contract.
- The Supervisor Admin API must expose `GET /api/v1/admin/config`,
  `GET /api/v1/admin/config/{key}`, `PUT /api/v1/admin/config/{key}`, and
  `GET /api/v1/admin/config/history`.
- Configuration updates must require an expected version, typed allowlisted
  value, idempotency key, explicit reason, and authorized admin identity.
- The API must reject unknown keys, stale versions, invalid safety bounds, and
  unsafe cross-setting combinations before writing the new value.
- The typed Python SDK may wrap the Admin API, but must not duplicate policy
  resolution or validation logic.
- Each new review, implementation attempt, remediation attempt, and lease must
  persist the effective configuration version used for its decisions.
- React configuration editing is not part of Release 1; the frontend may show
  effective values and immutable change history through a read-only API.

## Review Schema Requirements

- The `dispatch` schema must own mutable `review_tasks` records for review
  dispatch, leases, retries, escalation, idempotency, and configuration
  snapshots.
- The `state` schema must own append-only `review_results`,
  `remediation_attempts`, and `review_events` records, plus validated-mutable
  `review_findings` state with immutable transition events.
- `review_tasks` must enforce one active review lease per workstream attempt,
  reclaim expired leases, and preserve retry and escalation history.
- Review results must be immutable and tied to the exact workstream attempt,
  source commit, artifact digest, deployment target, acceptance-contract
  version, dependency versions, validation configuration, and reviewer
  implementation version.
- Findings must preserve severity, acceptance-criterion linkage, evidence,
  remediation ownership, dependency impact, disposition, and verification
  history.
- Remediation attempts must preserve every grouped finding identifier and link
  the remediation envelope, workstream, attempt, evidence, and re-review.
- Review events must be append-only, bounded, redacted, correlated, and
  sufficient to reconstruct finding, remediation, evidence, escalation, and
  waiver transitions.
- Dispatcher lease, retry, reclaim, and escalation history must be stored in
  `dispatch.review_task_events`; state-owned evidence and finding transitions
  must remain in `state.review_events`.
- Physical review tables must use UUID keys, scoped idempotency constraints,
  optimistic versions for mutable rows, and indexes for lease reclaim,
  dependency impact, parent lookups, and chronological audit reads.
- Cross-schema references must use shared immutable identifiers and explicit
  integration boundaries; direct cross-owner writes and cross-schema foreign
  keys are prohibited.
- AppKit v1 must provide the supported Lakebase connection pooling, OAuth
  credential refresh, and service-principal pool for DDL/admin operations.
  Schema migrations must use the application's own TypeScript startup
  migration module (Decision 24); AppKit must not be treated as an
  undocumented migration runner, and its `onPluginsReady` bootstrap schema
  checks must not be treated as the migration authority.
- Release 1 validates ordered migration definitions on a disposable Lakebase
  child branch, applies the reviewed definitions to protected `production`
  through the startup migration module, and records basic migration
  history/version state. Lakebase branches are not merged or promoted like Git
  branches.
- Checksums, advisory locking, fail-closed readiness, registry validation, a
  dedicated migration session, transactional history, future-schema rejection,
  comprehensive migration tests, and Lakeflow Jobs for large backfills are
  Release 1.1 hardening unless another requirement independently requires them.
- App request-path code (including MCP requests) must never execute DDL; only
  the startup migration module may run guarded, versioned, idempotent migration
  DDL, and destructive or unversioned DDL is prohibited everywhere.

## Surface and Deployment Requirements

- The production App must expose `/mcp`, versioned Supervisor routes under
  `/api/v1/`, and same-origin read-only UI routes under `/api/v1/ui/`.
- Supervisor routes must require Supervisor authorization; the Workstream MCP
  must use user-level Databricks OAuth and on-behalf-of-user authorization.
- The typed Python SDK must remain a thin versioned wrapper over Supervisor
  routes and must not reimplement scheduling, retry, authorization, or
  configuration policy.
- The React backend-for-frontend must return bounded, authorization-filtered
  graph, workstream, review, finding, and session-summary read models.
- The React frontend must not access Lakebase, MCP, Jobs, or workspace APIs
  directly and must not expose dispatch actions in Release 1.
- The production bundle must deploy only Databricks-native resources,
  including the App, Lakeflow Jobs and tasks, permissions, secret references,
  cleanup tasks, and Lakebase configuration.
- Use separate `dev`, `staging`, and `prod` bundle targets/workspaces. Lakebase
  child branches do not replace workspace-level validation of App permissions,
  OAuth scopes, Unity Catalog, Jobs, or preview settings.
- CI/CD must pin the Databricks CLI version, run bundle validation/deploy, and
  explicitly run the App resource so the deployed version is active.
- Lakebase `LISTEN/NOTIFY` must be treated as an advisory acceleration path;
  scheduled ticks must recover missed notifications and all actions must
  re-read authoritative persisted state.
- Memory compaction, asynchronous embedding, re-embedding, cleanup,
  reconciliation, and trace retention must run as Databricks-native Lakeflow
  Jobs rather than durable loops in App process memory. Schema migration is
  the one exception: it runs from the App's own startup migration module (see
  "Migration Strategy" above), not from a Lakeflow Job, so the App never
  serves traffic against an unmigrated or incompatible schema.
- DAB variables must configure memory TTLs, embedding settings, trace cleanup,
  and retention values; `mlflow_trace_retention_days` must default to `90` and
  reject non-positive values.
- MLflow 3 traces must use Unity Catalog-backed storage and OpenTelemetry
  export with pre-export redaction and correlation metadata.

## React Operations UI

- The combined App may provide a React frontend for read-only orchestration
  visibility.
- The UI must render dependency graphs from persisted `depends_on` relations,
  workstream status, completion percentage, blockers, attempts, timing, and
  review state.
- Users may view bounded workstream summaries and drill into authorized session
  summaries and review history.
- The frontend must use a same-origin read-only backend-for-frontend API; it
  must not access Lakebase, MCP tools, or Jobs APIs directly.
- Initial UI responses must be authorization-filtered, RLS-protected, bounded,
  and redacted. Exclude raw prompts, conversations, secrets, tokens,
  unrestricted errors, and sensitive internal paths.
- The initial UI must not expose retry, reset, dispatch, or job-triggering
  actions.
- Define the read-model/API contract in the initial architecture; target the
  full React DAG and drill-down experience for Release 1.1.

## Non-Functional Requirements

- User authorization failures must fail closed.
- Tool inputs must be schema-validated before execution.
- Tool outputs must be bounded and support pagination where appropriate.
- Writes must be observable without exposing sensitive payloads.
- Normal MCP reads and writes must remain available when no dispatch action is
  pending; dispatch availability must not grant workers dispatch privileges.
- Production configuration must be reproducible from the Declarative
  Automation Bundle.
- Schema changes must be compatible with active clients during rollout.

## Open Design Items

- Workspace-specific identity, endpoint, catalog, and service-level values.
- Physical DDL details, migration filenames, and final index tuning.
- Final embedding endpoint, model identifier, and vector dimensions.
- Token-to-Lakebase-user/session identity bridge for RLS.
- Short-term TTL, episodic retention, and memory compaction bundle variables.
- Promotion criteria from episodic to semantic memory.
- Detailed project and workstream permission model.
- Trace catalog and schema names.
- Cleanup job implementation and schedule.
- Redaction rules for each domain record type and embedding input.
- Availability, latency, and scale-to-zero targets.
- React backend-for-frontend response contract and graph payload shape.
- Review checklist and supervisor approval evidence contract.

## Omnigent Agent Profile Requirements

Release 1 shall optionally provide a read-only Worker Insight sub-agent. It
shall use the Workstream MCP to summarize active workstreams, progress,
blockers, dependencies, validation evidence, session summaries, and next
actions. It shall never implement work, call Supervisor API tools, modify
dispatch state, review artifacts, approve completion, or replace WS-INIT.

Release 1 Worker Insight shall use existing Release 1 MCP read tools and shall
not require handoff tables, planning-research provenance tables, privileged
API credentials, or new Lakebase schema. It shall use the existing Hi Genie
authorization, redaction, telemetry, and retention policies.

Release 1.1 shall provide the full parent Hi Genie Omnigent Agent with
Planning Research A and B, Supervisor, Reviewer, and Worker Insight sub-agents.
The parent shall coordinate and synthesize results without replacing WS-INIT,
directly accessing Lakebase, or bypassing the Hi Genie API and MCP boundaries.

The Supervisor sub-agent shall be the only agent role permitted to call Supervisor API tools. The Reviewer shall use a distinct execution identity or context from the producing Worker and shall not mark workstreams complete. Worker Insight shall observe and report on workstreams but shall never perform their implementation work.

Routing shall be deterministic for privileged roles. Two independent planning research passes shall be required for architectural, security, persistence, deployment, authorization, release-scope, and potential-blocker questions. One research pass may be used for low-risk informational questions.

Supervisor actions shall be classified as automatic, policy-approved, interactive-confirmation, or human-only. The Supervisor API shall enforce the classification, scope, authorization, idempotency, and audit requirements; agent prompts shall not be the sole enforcement mechanism.

Sub-agent handoffs shall use typed, minimal envelopes with role, scope, correlation, requested action, Lakebase references, required outputs, authorization, policy, and idempotency metadata. Full planning, review, and remediation details shall remain in Lakebase.

The system shall preserve independent research results, surface disagreement explicitly, retry only classified transient failures, fail closed on authorization or evidence failures, and persist handoffs before follow-up dispatch. Parent-agent recovery shall resume from durable Lakebase state rather than in-memory conversation state.

## Omnigent Agent Persistence Requirements

### Release 1 compatibility fields

Existing Release 1 planning, execution, review, remediation, and memory records
shall support `correlation_id`, `session_id`, `project_id`, `workstream_id`,
actor or execution identity, timestamps, provenance, and idempotency metadata
where the operation can be retried. These fields are required for future agent
handoffs but do not introduce handoff tables into Release 1.

### Release 1.1 handoffs

The `dispatch.agent_handoffs` table shall persist each typed handoff before a
sub-agent is invoked. It shall include source and target role, execution
identity, requested action, authorized scope, referenced Lakebase records,
required outputs, policy level, idempotency key, expiry, configuration version,
correlation identifiers, and lifecycle status.

The `dispatch.agent_handoff_attempts` table shall preserve every delivery
attempt, lease, retry classification, execution identity, timestamps, result
reference, and trace correlation. Handoff delivery shall be idempotent and
reclaimable after lease expiry.

Handoff envelopes shall contain identifiers and bounded fallback context only.
Full review findings, remediation instructions, planning records, and evidence
remain authoritative in Lakebase and are retrieved through the authorized MCP
or Supervisor API surface. Handoffs shall fail closed for unauthorized scope,
stale references, expired requests, invalid policy context, or missing required
records.

### Release 1.1 planning research provenance

The `state.planning_research_runs` table shall track the question or planning
record under investigation, context snapshot, researcher profiles, run status,
and correlation metadata. The `state.planning_research_reports` table shall
store each independent report separately, including assumptions, evidence,
options, recommendation, risks, release implications, and uncertainty. The
`state.planning_research_synthesis` table shall store the parent synthesis,
agreement or disagreement classification, unresolved issues, and any linked
proposal or decision.

Planning Research A and B shall run with equivalent inputs and independent
execution contexts. The parent shall preserve both reports and explicitly
surface `AGREEMENT`, `PARTIAL_AGREEMENT`, `DISAGREEMENT`, or
`INSUFFICIENT_EVIDENCE`. Disputed recommendations shall not be promoted
silently.

Handoff and research records shall use the existing Hi Genie telemetry,
redaction, authorization, retention, and audit requirements. Secrets, tokens,
raw headers, unrestricted prompts, raw SQL literals, and unrestricted memory
payloads shall not be persisted in handoffs or research reports.

## Omnigent Handoff and Research Schema Requirements

### Common contract

The Release 1.1 tables shall use UUID primary keys, immutable creation
metadata, project-scoped authorization, `correlation_id`, optional
`workstream_id` and `session_id`, actor or execution identity, contract and
configuration versions, timestamps, and idempotency metadata where retries are
possible. JSON columns shall contain bounded, typed structures validated by the
application contract; they shall not become an arbitrary workflow engine.

### `dispatch.agent_handoffs`

The table shall persist a handoff before sub-agent invocation and include:
`handoff_id`, project/workstream/session scope, source and target roles,
execution identifiers, target profile, requested action, priority, bounded
context references, required outputs, authorization scope, policy level and
version, correlation identifiers, parent handoff, idempotency key, status,
attempt count, expiry, configuration version, creator, and timestamps.

Allowed lifecycle states are `CREATED`, `DISPATCHED`, `CLAIMED`,
`ACKNOWLEDGED`, `COMPLETED`, `RETRYABLE_FAILURE`, `EXPIRED`, and `FAILED`.
Only Supervisor-authorized operations may dispatch, retry, expire, or fail a
handoff. Claim and acknowledgment operations cannot alter target or authority.
Completion shall be idempotent and reference a bounded result record.

### `dispatch.agent_handoff_attempts`

The append-only attempt table shall include attempt identity and ordering,
parent handoff, lease owner and expiry, claim/start/end timestamps, execution
identity, profile, configuration version, status, failure classification and
code, bounded failure summary, result reference, trace ID, correlation ID, and
creation timestamp. Lease expiry shall allow Supervisor recovery without
rewriting prior attempts.

### `state.planning_research_runs`

The research-run table shall include project scope, optional requirement,
question, decision, or blocker references, the bounded research question,
context snapshot reference and hash, researcher A/B profiles and execution
identities, contract version, status, disagreement status, creator,
correlation ID, and start/completion timestamps.

Allowed lifecycle states are `REQUESTED`, `RUNNING`, `REPORTS_READY`,
`SYNTHESIZED`, `FAILED`, and `EXPIRED`. Both independent reports are required
before synthesis unless an explicit insufficient-evidence disposition is
recorded.

### `state.planning_research_reports`

Each report shall be immutable after submission and include report identity,
research run, researcher slot, execution identity, assumptions, evidence
references, options, recommendation, risks, release implications,
uncertainties, report hash, contract version, status, and timestamps. The two
researcher slots shall be distinct. Corrections create successor reports linked
to the original; they do not overwrite history.

### `state.planning_research_synthesis`

The synthesis table shall include synthesis identity, research run,
synthesizer execution identity, classification, common findings, differences,
recommendation, risks, required follow-up, linked proposal or decision
references, contract version, creator, correlation ID, and timestamp.
Classification shall be one of `AGREEMENT`, `PARTIAL_AGREEMENT`,
`DISAGREEMENT`, or `INSUFFICIENT_EVIDENCE`.

A synthesis may recommend a planning action but shall not accept decisions,
publish plans, materialize workstreams, dispatch execution, or mark completion.
Disagreement shall remain visible until a follow-up research pass, tie-breaker,
or authorized human disposition resolves it.

### Indexing and authorization

Indexes shall support project and source-record lookups, lifecycle status,
expiry and lease recovery, correlation, idempotency, and recent activity.
Foreign keys may be used within the owning schema where lifecycle ordering is
safe. Cross-schema references shall use stable identifiers with
application-enforced authorization. All handoff and research reads and writes
shall use existing Hi Genie RLS, redaction, telemetry, audit, and retention
policies.

## Omnigent PostgreSQL Physical Contract

The five Release 1.1 tables shall implement the physical contract in
`architecture/omnigent-postgresql-contract.md`. PostgreSQL UUID primary keys,
`timestamptz` audit fields, bounded typed `jsonb` envelopes, same-schema
foreign keys with restrictive deletes, idempotency and successor uniqueness,
lifecycle and timestamp `CHECK` constraints, project/status/correlation/
recovery indexes, forced RLS, and owner-specific write boundaries are
normative. Cross-schema references remain stable application-authorized
identifiers rather than direct foreign keys.

Migration order shall create schemas, handoffs, attempts, research runs,
reports, and synthesis in dependency order, then indexes, RLS, validation, and
checksum registration. Dedicated-session execution, advisory locking,
transactional history, future-schema rejection, and fail-closed readiness are
Release 1.1 requirements. These tables are not created in Release 1.
