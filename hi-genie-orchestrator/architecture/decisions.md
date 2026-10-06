# Hi Genie Orchestrator — Architecture Decisions

This document records decisions accepted during the initial design review.

## Decision 1 — Product Scope

**Status:** Accepted

Hi Genie Orchestrator combines two bounded surfaces in one production App:
the Supervisor API/typed Python SDK for dispatch control-plane operations and
the Workstream MCP for worker-facing durable context. The MCP does not trigger
jobs, schedule work, execute arbitrary SQL, or expose dispatch controls.

## Decision 2 — Write Model

**Status:** Accepted

Use an append-first model with limited mutable state. Decisions, summaries,
errors, blockers, and events are immutable. Workstream status, task status,
active session metadata, and retry state may be updated through explicit,
validated, auditable operations. Idempotency keys are required for retry-safe
writes.

## Decision 3 — Identity Model

**Status:** Accepted

Use Databricks Apps on-behalf-of-user authorization and user-level permissions
from the first release. User context must be preserved through user-scoped
Lakebase operations and recorded in audit metadata.

## Decision 4 — OAuth Client Registration

**Status:** Accepted with deferral

Use manually registered Databricks OAuth clients initially. Dynamic client
registration is a future compatibility target and is not a launch dependency
until Databricks-hosted MCP supports it natively.

## Decision 5 — MCP Hosting and Naming

**Status:** Accepted

Host one production App named `mcp-hi-genie-orchestrator`. Expose the native
Workstream MCP endpoint at `/mcp` and versioned Supervisor API routes under
`/api/v1`. The App is a Databricks-hosted custom MCP server, not a Unity
Catalog MCP Service.

## Decision 6 — Unity AI Gateway

**Status:** Deferred

Unity AI Gateway is not required as an ingress proxy for the initial release.
It may be evaluated later for supported monitoring or governance use cases.

## Decision 7 — Durable Storage

**Status:** Accepted

Use one Lakebase project with a protected `production` branch. Maintain
separate `dispatch` and `state` schemas, owned by the Supervisor/Dispatcher
surface and Workstream MCP respectively. Schema feature branches are used
during iteration and are promoted through reviewed, version-tracked
migrations applied by the application's startup migration module (see
Decision 24). Shared identifiers and explicit integration events are
preferred over cross-schema direct writes.

## Decision 8 — Production Deployment

**Status:** Accepted

Deploy only the production App through a Databricks Declarative Automation
Bundle. Production configuration, resource wiring, cleanup jobs, and
observability settings are bundle-managed.

## Decision 9 — Observability

**Status:** Accepted

Enable both Databricks App OpenTelemetry telemetry and MLflow 3 tracing. MCP
tool calls require explicit manual tracing with `TOOL` spans. Dual export is
required when App telemetry supplies OTLP configuration.

## Decision 10 — MLflow Trace Storage

**Status:** Accepted

Store MLflow 3 traces in Unity Catalog-backed trace storage using a dedicated
production catalog and schema with least-privilege access.

## Decision 11 — Trace Retention

**Status:** Accepted

Make retention configurable through the Declarative Automation Bundle variable
`mlflow_trace_retention_days`, with an explicit default of `90` days. The
cleanup mechanism consumes the resolved bundle value; application code does
not hard-code the retention period.

Raw trace payloads are retained only for the configured raw-trace window after
pre-export redaction. Longer-term retention applies to redacted traces and
metadata under the workspace’s compliance policy.

## Decision 12 — Security of Telemetry Data

**Status:** Accepted

Trace and log data must be sanitized before export. Tokens, secrets, raw
authorization headers, unrestricted memory records, sensitive SQL literals,
and unclassified prompt or response payloads are excluded by default.

## Decision 13 — Release 1 Tool Catalog

**Status:** Accepted

Release 1 uses a focused domain catalog covering context retrieval,
append-first records, bounded mutable state, structured search, execution
summaries, health, and schema compatibility. The MCP server does not expose
scheduling, arbitrary SQL, unrestricted CRUD, notifications, or administrative
maintenance operations.

## Decision 14 — Context Retrieval Tools

**Status:** Accepted

Release 1 includes `get_project_context`, `get_workstream_context`,
`search_decisions`, `get_recent_session_summaries`, `get_relevant_errors`, and
`get_session_context`. Results are structured, authorization-filtered, bounded,
and must not return raw conversation history or unrestricted memory payloads.

## Decision 15 — Append-First Record Tools

**Status:** Accepted

Release 1 includes `record_decision`, `record_session_summary`, `record_error`,
`record_workstream_event`, `record_task_attempt`, and
`record_task_completion`. These records are immutable after creation and use
idempotency keys for retry-safe writes.

## Decision 16 — Mutable State Tools

**Status:** Accepted

Release 1 includes `update_workstream_status`, `update_task_status`,
`update_recovery_state`, `start_session`, and `end_session`. Updates require
validated transitions, optimistic concurrency control, and immutable audit or
state-change events. Historical records cannot be deleted or overwritten.

## Decision 17 — Search and Operational Tools

**Status:** Accepted

Release 1 includes `search_context`, `get_task_history`,
`get_execution_summary`, `get_health`, and `get_schema_version`. Search is
structured and relational in the initial implementation, with bounded results
and authorization applied before ranking or return. Semantic memory is covered
by Decision 18.

## Decision 18 — Lakebase Memory Model

**Status:** Accepted

Use Databricks' self-managed Lakebase memory pattern with three layers:

- **Short-term memory:** session- or thread-scoped working context with a short
  configurable TTL, initially targeted at 1–7 days.
- **Long-term episodic memory:** redacted session summaries, execution outcomes,
  errors, and other durable records describing what happened.
- **Long-term semantic memory:** compacted, deduplicated facts, design patterns,
  conventions, and recurring lessons distilled from episodic records.

Short-term memory must remain bounded and must not become the durable source for
reusable project knowledge. Episodic records remain canonical; semantic records
are derived and may be promoted through scheduled compaction when importance,
repetition, or explicit approval warrants durable reuse.

## Decision 19 — Lakebase Embeddings and Semantic Memory

**Status:** Accepted with phased rollout

Release 1 includes in-project developer semantic memory over sanitized episodic
and semantic records. Retrieval is restricted to the current authorized project
and uses explicit metadata such as `developer_id`, `project_id`,
`workstream_id`, `session_id`, and `memory_type`.

The implementation is Lakebase-native vector search using the
PostgreSQL-compatible `lakebase_vector` extension and `lakebase_ann` index.
This decision assumes that all Databricks beta and public-preview capabilities
required by the architecture are enabled, including Lakebase Search. Lakebase
Search enablement is still a project-wide, irreversible operation that may
restart active computes and drop connections; production provisioning must
therefore execute it deliberately and capture the procedure in the deployment
runbook. Databricks AI Search is not required as a fallback for the initial
architecture.

Embeddings are derived artifacts, not canonical records. Generate them
asynchronously from redacted content, track `pending`, `ready`, and `failed`
states, use cosine similarity initially, and protect retrieval and writes with
Lakebase row-level security. The authenticated user must be resolved into the
Lakebase authorization context before RLS is applied.

Cross-project developer memory is targeted for Release 1.1. It requires
explicit developer scope or consent, an authorization mapping for every
project, audited source-project attribution, and a separate privacy review. It
must not be enabled implicitly based only on shared developer identity.

## Decision 20 — Embedding Generation and Indexing

**Status:** Accepted

Embedding generation is asynchronous. Recording a session summary or promoting
episodic content must not wait for an embedding request. A background job
consumes approved memory records, generates embeddings through a
Databricks-hosted model endpoint, and updates the derived embedding record.

The endpoint and model configuration are deployment settings supplied through
the Declarative Automation Bundle. Each embedding stores the model identifier,
model version, vector dimensions, generation timestamp, and indexing status.
Model changes create a new embedding version and trigger background
re-embedding; canonical episodic and semantic records are never overwritten.

Generation uses bounded retries with exponential backoff and records terminal
failures for operator review. Retrieval falls back to authorization-filtered
structured search whenever semantic indexing is pending or unavailable.
Embeddings are created only from redacted, approved memory content and remain
subject to Lakebase row-level security.

## Decision 21 — Review-Gated Completion

**Status:** Accepted

Workers must not self-complete a workstream. A worker may transition from
`VALIDATING` to `READY_FOR_REVIEW` after its self-checks pass. An independent
supervisor or review process must validate the required artifacts, tests, and
acceptance criteria before transitioning the workstream to `COMPLETE`.

Review failures transition to `RETRYING` when recoverable and within retry
limits, or to `BLOCKED` when permanently failed or exhausted. Review results
are immutable and auditable, including reviewer identity, checks performed,
artifact/version references, test results, timestamp, and outcome.

`COMPLETE` is supervisor-owned state. The review task is tracked separately
from worker execution with an idempotent `review_task_id` so WS-INIT cannot
dispatch duplicate reviews across stateless ticks.

## Decision 22 — Dispatcher Event Triggering

**Status:** Accepted

The Dispatcher reacts to Lakebase `LISTEN/NOTIFY` events. Persisted Lakebase
state remains authoritative, while notifications provide low-latency wakeups
for the stateless WS-INIT evaluation cycle.

Notifications must not independently perform scheduling decisions or replace
the priority tree. A notification causes the Dispatcher to run or request an
early tick; the tick re-reads current state, obtains the required lock, and
performs the single authoritative action. Scheduled ticks remain as the
reliability fallback for missed, delayed, or duplicated notifications.

## Decision 23 — React Operations UI

**Status:** Accepted for phased delivery

The combined Databricks App may include a React frontend for read-only
orchestration visibility. It will render dependency DAGs, completion status,
workstream summaries, bounded session summaries, blockers, attempts, and
review history.

The frontend uses a same-origin read-only backend-for-frontend API. It does
not access Lakebase, MCP tools, or Jobs APIs directly, and it does not expose
retry, reset, dispatch, or job-triggering actions in the initial UI.

All responses are user-authorized, RLS-filtered, bounded, and redacted. Raw
prompts, conversations, secrets, tokens, unrestricted error payloads, and
sensitive internal paths are excluded. The DAG is derived from persisted
`depends_on` relationships and status data rather than maintained separately
by the frontend.

The read model is designed with the initial API contract, while the full React
DAG and drill-down experience is targeted for Release 1.1.

## Decision 24 — AppKit Lakebase Migrations

**Status:** Accepted with phased hardening

Databricks AppKit is the approved Lakebase integration boundary: connection
pooling, OAuth credential refresh, and the service-principal pool used for
DDL/admin operations must use the supported AppKit v1 methods. AppKit does
not supply a versioned schema-migration engine. The guarded
`CREATE SCHEMA/TABLE IF NOT EXISTS` checks that AppKit sample apps run during
`onPluginsReady` are a startup-bootstrap convenience only; they carry no
checksum, version, or lock semantics and must not be treated as the
production migration authority.

The application owns an authoritative TypeScript migration module/file that
is invoked during App startup, before the App accepts traffic, and uses
AppKit's service-principal connection pool for DDL/admin operations. Release 1
retains the LakeLoom-style minimal startup migration pattern: ordered
TypeScript migration definitions, basic applied-version/history tracking,
AppKit Lakebase connection usage, and execution during App startup. Migration
artifacts are validated on a disposable Lakebase child branch and then applied
to the protected `production` branch through the DAB-managed deployment and
startup path; Lakebase branches are not merged or promoted like Git branches.

Release 1.1 incorporates the stronger safeguards identified by the
AppKit/LakeLoom review: migration checksums, Postgres advisory locking,
fail-closed readiness, migration-registry validation, a dedicated migration
session, transactional migration-history writes, rejection of schema versions
newer than the running code supports, comprehensive migration tests, and
Lakeflow Jobs for large data backfills. Release 1.1 also formalizes
expand-and-contract compatibility and post-migration schema verification.
These safeguards are Release 1.1 hardening unless another accepted decision
or requirement independently makes one mandatory earlier.

Guarded, versioned, idempotent migration DDL is permitted only inside the
startup migration module. MCP requests and all other request-path handlers
must never execute DDL. Destructive, unversioned, or ad hoc DDL is prohibited
everywhere, including at startup.

## Decision 25 — Lakebase-Referenced Remediation Prompts

**Status:** Accepted

Lakebase is the authoritative source for review findings, remediation details,
acceptance criteria, evidence, and review history. Reviewers must write
structured, immutable findings to the `state` schema rather than placing the
complete remediation payload in a dispatch prompt.

The Supervisor dispatches a bounded remediation envelope to the originating
workstream by default. The envelope contains the finding and review identifiers,
required action, severity, affected attempt or artifact, correlation metadata,
and the MCP scope needed to retrieve the full details. The workstream retrieves
the authoritative remediation record through MCP, then acknowledges, fixes,
validates, and resubmits evidence.

A separate remediation workstream is created when the original workstream cannot
continue, lacks authorization or capability, requires independent ownership, or
would conflict with another change. The Supervisor records prompt delivery and
retrieval failures. Stale review or artifact references require a new
remediation request and re-review.

## Decision 26 — Remediation State Separation

**Status:** Accepted

Workstream lifecycle state and review-finding state are separate state machines.
A workstream follows the review lifecycle:

```text
READY_FOR_REVIEW → UNDER_REVIEW → COMPLETE
                         ↓
                    FIX_REQUIRED
                         ↓
                    VALIDATING
                         ↓
                 READY_FOR_REVIEW
```

A finding follows its own lifecycle:

```text
OPEN → ACKNOWLEDGED → IN_REMEDIATION → RESUBMITTED → VERIFIED
```

Findings may transition to `BLOCKED` when remediation cannot proceed, or to
`WAIVED` only through an authorized, immutable exception with rationale.
`COMPLETE` requires every blocking finding to be `VERIFIED`. Advisory findings
may remain open only with an owner and documented disposition.

Each remediation attempt creates new evidence and review records. A workstream
status change cannot silently close, waive, or replace a finding. Lakebase is
authoritative for both state machines, while notifications only accelerate
Supervisor evaluation.

## Decision 27 — Review Finding Dependency Impact

**Status:** Accepted

A `REQUIRED_FIX` finding prevents the affected workstream from completing and
blocks downstream workstreams that directly depend on it. Unrelated workstreams
and workstreams whose dependencies are otherwise satisfied may continue.

A `BLOCKING` finding has the same direct-dependency effect and may additionally
block broader orchestration progress when the dependency graph makes the
affected workstream critical to the plan. An `ADVISORY` finding does not block
completion or downstream execution, but requires an owner and documented
disposition.

The Dispatcher must derive dependency impact from persisted graph relationships
rather than manually maintained flags. When a finding is resolved and verified,
WS-INIT re-evaluates affected dependents on the next event-driven or scheduled
tick. Notifications accelerate this evaluation but do not determine readiness.

## Decision 28 — Dependency-Blocked State

**Status:** Accepted

A workstream whose direct dependency is held by an unresolved `REQUIRED_FIX` or
`BLOCKING` finding enters the explicit `BLOCKED_BY_DEPENDENCY` state rather than
general `BLOCKED` state.

The Dispatcher must not dispatch work in `BLOCKED_BY_DEPENDENCY`. The state is
automatically recoverable: when the upstream finding is verified and the
upstream workstream becomes eligible, WS-INIT re-evaluates the dependent on the
next event-driven or scheduled tick. If another dependency or local condition
still prevents readiness, the workstream remains `BLOCKED_BY_DEPENDENCY` with
updated dependency context.

`BLOCKED` remains reserved for terminal, unsafe, unauthorized, or otherwise
non-automatically recoverable conditions requiring supervisor or human action.

## Decision 29 — Remediation Finding Grouping

**Status:** Accepted

The Supervisor may group multiple review findings into one remediation prompt or
workstream when they affect the same artifact or component, can be addressed by
the same worker capability, share a dependency and validation boundary, and do
not require conflicting ownership or execution tiers.

Findings must remain separate when they involve different owners, artifacts,
security boundaries, execution tiers, or independent review gates. Every grouped
remediation retains the individual finding identifiers and verification results
so that one finding cannot be implicitly closed by another.

## Decision 30 — Review Evidence Freshness

**Status:** Accepted

Review evidence is valid only for the exact source, artifact, configuration, and
acceptance contract that were reviewed. Evidence becomes stale when any of the
following changes:

- Source commit, artifact digest, or deployed version
- Deployment target or environment configuration
- Acceptance criteria or review-contract version
- Relevant dependency version
- Test, build, lint, type-check, or validation configuration
- Security, identity, or authorization configuration

Stale evidence must not be used to authorize `COMPLETE`. The Supervisor must
return the workstream to `VALIDATING` when the producing workstream must
regenerate evidence, or to `READY_FOR_REVIEW` when the existing evidence can be
re-submitted after an authoritative freshness check. A new review task and
immutable review record are required whenever the reviewed evidence is
invalidated.

## Decision 31 — Review Retry, Lease, and Escalation Policy

**Status:** Accepted

Review execution uses separate retry budgets for reviewer infrastructure,
initial implementation, and remediation. The default budgets are:

- Three automatic review-task attempts per review submission
- Three worker attempts for the initial implementation
- Three remediation attempts per grouped finding and artifact

Review-task retries use exponential backoff with jitter. The initial retry is
scheduled after one minute, the second after five minutes, and no individual
backoff exceeds fifteen minutes. Lease recovery does not consume an
implementation or remediation attempt.

Review tasks use a fifteen-minute durable lease. Long-running reviews renew the
lease. Expired leases may be reclaimed by a later WS-INIT evaluation, and only
one active lease may exist for a workstream attempt. Idempotency keys prevent
duplicate review records.

Reviewer outages, timeouts, and crashes leave the workstream in
`READY_FOR_REVIEW`. The Supervisor retries the review, continues unrelated
workstreams, and escalates to supervisor attention after the automatic review
budget is exhausted. Reviewer unavailability alone does not transition a
workstream to `BLOCKED`.

A validation failure creates a remediation request. After three failed
remediation attempts for the same finding group, the workstream enters
`BLOCKED`. Unsafe, unauthorized, destructive, ambiguous, or unverifiable
conditions may enter `BLOCKED` immediately.

Human intervention is required for security or authorization changes,
destructive operations, production policy exceptions, acceptance waivers,
ambiguous requirements, scope changes, new sub-workstreams, terminal blocked
resets, exhausted retry budgets, and unresolved reviewer disagreement.

`LISTEN/NOTIFY` accelerates review evaluation but does not replace persisted
state, leases, idempotency, or scheduled-tick recovery.

## Decision 32 — Global Runtime Configuration and Admin Surface

**Status:** Accepted

Operational policy values must be changeable without requiring an application
code change, while deployment wiring and hard safety limits remain managed by
the Declarative Automation Bundle (DAB).

Release 1 uses Lakebase-backed global configuration in the `dispatch` schema
as the authoritative runtime source. DAB variables seed missing values and
define immutable safety envelopes; deployments must not overwrite existing
operator-managed values.

The initial allowlist includes review, implementation, and remediation retry
budgets; review lease and renewal durations; and review backoff, multiplier, and
jitter settings. Arbitrary configuration keys are prohibited. Cross-field
validation must reject unsafe combinations, such as a renewal interval that is
not shorter than the lease duration.

Configuration changes require optimistic concurrency, idempotency, an explicit
reason, authorized actor identity, and immutable before/after audit history.
Attempts, leases, reviews, and remediation records snapshot the effective
configuration version when created. Later changes apply to new operations and
do not retroactively alter active retry budgets or leases.

Configuration administration is outside the Workstream MCP. Release 1 exposes
a versioned Supervisor Admin API and typed SDK methods to a dedicated
`hi-genie-config-admins` role. The React frontend remains read-only for mutable
configuration in Release 1. A later release may add a React editor after the
API, validation, audit, rollback, and authorization contracts are proven.

Release 1.1 may add project-scoped overrides, followed by developer-scoped
overrides in a later release. The planned precedence is project, then
developer, then global, followed by DAB bootstrap and compiled emergency
fallbacks. Override eligibility remains configuration-key specific.

## Decision 33 — Configuration Schema and Supervisor Admin API

**Status:** Accepted

Release 1 defines an explicit, allowlisted configuration contract in the
`dispatch` schema. The configuration model consists of:

- `config_definitions` for key names, value types, descriptions, defaults,
  safety bounds, allowed values, mutability, restart requirements, and schema
  version.
- `config_values` for the current global value, configuration version,
  enabled state, update actor, and update timestamp.
- `config_change_events` for immutable before-and-after values, actor,
  reason, optional change-ticket reference, validation result, idempotency key,
  request ID, correlation ID, and timestamp.

The Supervisor Admin API is the authority for runtime changes:

```text
GET  /api/v1/admin/config
GET  /api/v1/admin/config/{key}
PUT  /api/v1/admin/config/{key}
GET  /api/v1/admin/config/history
```

`PUT` requires an expected configuration version, idempotency key, explicit
reason, typed value, and an authorized `hi-genie-config-admins` identity. The
API rejects unknown keys, stale versions, invalid ranges, and unsafe
cross-setting combinations. The typed Python SDK exposes these operations
without duplicating configuration or validation logic.

Lakebase remains authoritative after bootstrap. `LISTEN/NOTIFY` may invalidate
cached configuration, but it does not replace transactional reads or
optimistic-concurrency checks. Each new attempt, review, and lease records the
configuration version used for its policy decision; active operations are not
changed retroactively.

## Deferred Decisions

- Workspace-specific identity, endpoint, catalog, and service-level values
- Final embedding endpoint, model identifier, and vector dimensions
- Physical DDL details and migration filenames
- Exact request/response examples for the versioned API and MCP tools

## Decision 34 — Review Schema Ownership and Boundaries

**Status:** Accepted

Review execution and review evidence have separate ownership boundaries in the
shared Lakebase project:

- `dispatch.review_tasks` is Supervisor-owned and contains scheduling,
  idempotency, retry, lease, escalation, and configuration-version state.
- `state.review_results` is MCP/state-owned and is append-only evidence for a
  specific workstream attempt and review task.
- `state.review_findings` is MCP/state-owned finding state, including severity,
  remediation status, dependency impact, and authorized disposition.
- `state.remediation_attempts` is MCP/state-owned append-only history linking
  grouped findings to remediation attempts and subsequent evidence.
- `state.review_events` is the append-only audit stream for finding,
  remediation, evidence, and review lifecycle events.

Cross-schema references use shared immutable identifiers and application-level
validation. Database foreign keys are limited to relationships within one
schema. The Dispatcher must not write directly to `state`; it publishes an
explicit integration event or invokes the state boundary for state-owned
records.

`dispatch.review_tasks` is system-scoped and protected by Supervisor
authorization. State-owned records use the authenticated-user-to-Lakebase
identity bridge and row-level security once that bridge is finalized.

## Decision 35 — Review Records and State Model

**Status:** Accepted

Release 1 uses the following logical records:

### `dispatch.review_tasks`

Mutable fields include status, attempt number, lease owner, lease expiry,
renewal timestamp, next retry time, escalation state, and configuration
version. The record is keyed by `review_task_id` and has idempotency protection
for the reviewed workstream attempt. Only one active lease may exist for an
attempt; expired leases are reclaimable by WS-INIT.

### `state.review_results`

Each result is immutable and records the review task, workstream attempt,
reviewer identity and implementation version, contract and plan hashes,
artifact references and digests, checks, test results, evidence freshness
fingerprint, verdict, rationale, timestamps, and configuration version.

### `state.review_findings`

Findings use the lifecycle `OPEN → ACKNOWLEDGED → IN_REMEDIATION →
RESUBMITTED → VERIFIED`, with authorized `BLOCKED` and `WAIVED` outcomes.
Updates use optimistic concurrency and emit an immutable event. Every finding
has severity, acceptance-criterion linkage, evidence, remediation ownership,
and dependency impact.

### `state.remediation_attempts`

Remediation attempts preserve the grouped finding identifiers, originating
review and artifact references, delivery and acknowledgement status, attempt
number, remediation workstream, evidence reference, outcome, stale reason,
and configuration version. They are append-only.

### `state.review_events`

Events are append-only and carry event type, actor, scope identifiers,
correlation and request identifiers, timestamp, and bounded redacted payload.
They record all state transitions, lease outcomes, remediation-envelope
delivery, evidence invalidation, escalation, and authorized waivers.

The exact physical DDL remains implementation work, but these ownership,
mutability, lifecycle, and audit rules are normative. Migrations must use the
startup TypeScript migration module. Release 1 review-schema migrations use
the ordered, guarded, idempotent startup pattern; Release 1.1 adds the
expand-and-contract process and stronger migration safeguards defined in
Decision 24.

## Decision 39 — Review Event Ownership and Physical Schema Guidance

**Status:** Accepted

The state-owned review event stream is limited to MCP/state-owned evidence,
finding, remediation, waiver, and evidence-freshness transitions. Dispatcher
lease, retry, reclaim, and escalation transitions remain Dispatcher-owned and
must be recorded in `dispatch.review_task_events`.

The Supervisor may consume state-owned review outcomes through a read-only
integration view or an explicit state-boundary operation. It must not write
directly to `state.review_events`, `state.review_results`, or
`state.review_findings`.

The physical schema follows these rules:

- Use UUID primary keys with database-generated defaults.
- Keep cross-schema references as validated identifier columns; do not add
  cross-schema foreign keys.
- Enforce review-task idempotency per workstream attempt and remediation
  idempotency per grouped finding and attempt number.
- Use optimistic `version` columns on mutable finding and configuration rows.
- Use partial/status and parent/timestamp indexes for lease reclaim, finding
  impact, and chronological audit queries.
- Keep remediation finding groups traceable through explicit finding IDs; the
  implementation may use a same-schema join table when queryability requires
  it, but must not lose individual finding identity.
- Create one migration file in the startup migration module per schema owner
  and change set; never hide `dispatch` and `state` ownership changes in one
  opaque migration.

RLS policies on state-owned review records remain blocked on the verified
Databricks-user-to-Lakebase identity bridge. The application must not replace
that bridge with informal filtering.

## Decision 36 — Surface Contracts and Read Models

**Status:** Accepted

The combined App exposes three intentionally separate surfaces:

- `/mcp` for user-authorized Workstream MCP tools.
- `/api/v1/...` for Supervisor and Dispatcher operations.
- `/api/v1/ui/...` for same-origin, authorization-filtered React read models.

Supervisor endpoints remain role-restricted and include plan ingestion,
workstream and task inspection, pause/unpause, tick evaluation, readiness,
dependency graph, review dispatch, and the Admin API. The typed Python SDK is
a thin versioned client for these endpoints; it contains no scheduling,
retry, authorization, or configuration policy logic.

The React backend-for-frontend exposes read-only orchestration summaries,
dependency graph nodes and edges, workstream status, review state, bounded
session summaries, findings, and completion metrics. It never connects
directly to Lakebase, MCP, Jobs, or workspace APIs. UI responses are scoped by
the authenticated user, bounded, redacted, and derived from explicit read
models rather than arbitrary table access.

Dispatch actions are never exposed through MCP or the initial React UI.

## Decision 37 — Production Deployment and Bundle Targets

**Status:** Accepted

The production deployment is one Databricks App named
`mcp-hi-genie-orchestrator`, managed through a Declarative Automation Bundle.
The bundle owns the App, Lakeflow Jobs and tasks, Lakebase project/database
resources, permissions, secret references, and runtime configuration bootstrap.
The CI/CD pipeline must deploy the bundle and explicitly run the App resource
so the new App version is active; deployment alone is not treated as rollout.
The CLI version used by CI/CD is pinned and must support the required App,
Lakebase, and Job resources.

Use separate `dev`, `staging`, and `prod` bundle targets/workspaces. Lakebase
child branches support schema and data validation, but do not replace
workspace-level validation of App permissions, OAuth scopes, Unity Catalog,
Jobs, or preview settings. Production migration applies the same immutable
artifacts validated on the child branch; it does not promote or merge the
branch itself.

Interactive HTTP/MCP handling remains in the App. Durable supervision,
embedding, compaction, re-indexing, cleanup, and reconciliation run as
Databricks-native Lakeflow Jobs. Schema migration is the one background task
that runs from the App's own startup migration module instead of a Lakeflow
Job, so the App never serves traffic before its schema is verified (see
Decision 24). No external gateway, database, queue, identity provider,
telemetry platform, or vector database is required.

The scheduled tick remains the recovery trigger. Lakebase `LISTEN/NOTIFY`
events accelerate review and dispatch evaluation, but notifications are not
the source of truth. All consumers re-read persisted state and use durable
locks or leases before acting.

## Decision 38 — Memory, Tracing, and Retention Operations

**Status:** Accepted

Lakebase remains the canonical store for short-term session memory, episodic
summaries, semantic memories, and their versioned embeddings. Release 1 uses
ordinary PostgreSQL/pgvector-compatible storage and a retrieval abstraction;
Lakebase Search is an enabled-but-optional Beta optimization that requires an
explicit production provisioning approval because enablement is irreversible
and restarts project compute. Structured relational search remains available
without the Beta feature, and Databricks Vector Search remains the native
fallback if the workspace declines Lakebase Search.

All deployment-sensitive values are DAB variables with explicit defaults and
validation, including memory TTLs, embedding retention, model endpoint,
vector dimensions, and `mlflow_trace_retention_days` defaulting to `90`.

MLflow 3 traces use Unity Catalog-backed trace storage. OpenTelemetry and
MLflow tracing share request, session, workstream, tool, and database
correlation identifiers. Redaction occurs before persistence/export; tokens,
secrets, authorization headers, raw SQL literals, unrestricted conversations,
and sensitive memory payloads are excluded.

Cleanup, compaction, re-embedding, and trace-retention tasks run as
Databricks-native scheduled or job tasks under the production bundle. Failure
of embeddings or cleanup must not prevent structured state reads and writes.

## Decision 40 — Implementation Sequence and Release Gates

**Status:** Accepted

Implementation proceeds in dependency order and every stage must remain
deployable through Databricks-native resources:

1. Define physical `dispatch` and `state` DDL, RLS prerequisites, indexes, and
   pinned migration artifacts in the startup TypeScript migration module,
   validated on a disposable Lakebase child branch using AppKit's
   service-principal connection pool for DDL/admin operations.

2. Implement the versioned Supervisor API, thin Python SDK, and Workstream MCP
   contracts using generated or shared schemas rather than duplicated models.
3. Implement WS-INIT tick evaluation, Lakebase `LISTEN/NOTIFY` acceleration,
   durable locks/leases, review dispatch, remediation routing, and scheduled
   recovery.
4. Implement state-boundary integration views/events and the review evidence,
   finding, remediation, and audit flows.
5. Add asynchronous memory compaction, Databricks-hosted embeddings,
   Lakebase-native vector search, and retention jobs.
6. Add the same-origin React read models and UI. Keep Release 1 UI read-only;
   defer configuration editing and supervisor mutations until a later release.

Release 1 is complete only when separate `dev`, `staging`, and `prod` bundle
targets can validate representative MCP/API calls, RLS and authorization,
review/remediation flows, event-driven and scheduled recovery, startup
migration execution, background memory jobs, and trace export. A disposable
Lakebase child branch validates migration compatibility; the production
target's App startup applies the same immutable migration artifacts after
approval. The release pipeline must deploy and explicitly run the App
resource so the startup migration module executes against the deployed
target.

Release 1.1 adds cross-project developer memory with explicit authorization,
the React DAG and drill-down experience, richer dependency/artifact read
models, read-only configuration history, optional Lakebase Search activation
if approved, and the migration hardening defined in Decision 24: checksums,
advisory locking, fail-closed readiness, registry validation, a dedicated
migration session, transactional history, future-schema rejection,
comprehensive migration tests, and Lakeflow Jobs for large backfills. Later
releases may add authorized configuration editing, UI-triggered supervisor
actions, project/developer overrides, and additional governance integrations.

## Decision 41 — Databricks-Native Operations Baseline

**Status:** Accepted

The App is an interactive control plane, not the owner of durable background
loops. Lakeflow Jobs own scheduled WS-INIT recovery, embedding and memory
compaction, re-indexing, cleanup, reconciliation, and other retryable
background work. App routes persist commands and return operation identifiers
rather than waiting for long-running work. Schema migration is the one
exception to "no DDL in the App": it is owned by the App's own startup
migration module, not by a Lakeflow Job, because the App must never accept
traffic against an unmigrated or incompatible schema (see Decision 24).

The release pipeline uses pinned Databricks CLI tooling and separate `dev`,
`staging`, and `prod` bundle targets. It validates and deploys the bundle, then
explicitly runs the App resource so the deployed version is active and its
startup migration module runs against the target's Lakebase database.
Lakebase child branches are disposable validation environments; they are not
merged or promoted as Git branches and do not replace workspace-level
authorization, Unity Catalog, Jobs, or preview-feature validation.

AppKit v1 remains the required Lakebase integration boundary for connection
pooling, OAuth credential refresh, and the service-principal pool used for
DDL/admin operations; it is not itself a migration engine. The application's
TypeScript migration module runs during App startup using that AppKit
service-principal pool for the DDL connection. Release 1 requires ordered
migrations and basic migration-history/version tracking. Release 1.1 adds the
stronger migration safeguards enumerated in Decision 24. Guarded, versioned,
idempotent migration DDL is permitted only inside that startup module. MCP
requests and all other request-path code never execute DDL, and no destructive,
unversioned, or ad hoc DDL is permitted anywhere.

The Release 1 retrieval contract does not depend on Lakebase Search Beta.
pgvector-compatible storage and structured relational retrieval remain the
baseline. Lakebase Search may be enabled after explicit workspace approval;
Databricks Vector Search is the Databricks-native fallback. Operational
telemetry and MLflow 3 traces use separate storage responsibilities with shared
W3C correlation IDs, bounded attributes, redaction, sampling, and backpressure.

## Decision 42 — Omnigent Agent Profile and Routing Contract

Release 1.1 uses one parent Hi Genie Omnigent Agent with specialized sub-agents. The parent coordinates intent, routing, policy evaluation, correlation, and result synthesis; it does not replace WS-INIT or directly access Lakebase.

### Sub-agent responsibilities

- **Planning Research A and B:** independently investigate ambiguous requirements, open questions, architectural choices, and potential blockers. They receive equivalent context through separate execution contexts and report structured evidence, options, risks, and release implications.
- **Supervisor:** the only sub-agent authorized to call Supervisor API tools. It prepares validation, publication, materialization, dispatch, retry, remediation, and configuration requests, subject to API policy enforcement.
- **Reviewer:** independently evaluates workstream attempts and remediation evidence using a distinct execution context and identity from the producing Worker. It produces findings and verdicts but cannot mark work complete.
- **Worker Insight:** observes workstream state through the Workstream MCP and prepares summaries, blocker reports, and context. It never performs implementation work or receives Worker execution authority.

WS-INIT remains the authoritative Dispatcher, scheduler, and source of execution truth.

### Routing policy

Use deterministic role and capability routing before model-based selection. Planning questions invoke two independent researchers by default. Review submissions invoke the Reviewer. Supervisor API operations invoke only the Supervisor sub-agent. Status and context requests invoke Worker Insight when observation is sufficient.

A single researcher may handle low-risk informational questions. Architectural, security, persistence, deployment, authorization, and release-scope questions require two independent research passes.

### Approval levels

- **Automatic:** bounded, read-only, idempotent, non-destructive operations within authorized scope.
- **Policy-approved mutation:** explicitly allowlisted low-risk mutations with audit records, idempotency, scope checks, and configured limits.
- **Interactive confirmation:** plan publication, workstream materialization, dispatch, pause/resume, global configuration changes, and new remediation workstreams.
- **Human-only:** completion approval, acceptance waivers, security or RLS changes, destructive operations, production exceptions, blocked resets, and unresolved reviewer disagreement.

No agent or sub-agent may grant itself additional authority. The Supervisor API remains the enforcement point, and policy decisions are persisted with the operation record.

### Handoff contract

Sub-agents exchange typed, minimal handoff envelopes containing the project and workstream scope, correlation and session identifiers, source and target roles, requested action, referenced Lakebase records, required outputs, authorization scope, policy level, idempotency key where applicable, and expiration. Lakebase remains authoritative for full findings, remediation details, planning records, and review evidence.

Remediation handoffs carry finding, review, attempt, and target-workstream identifiers rather than duplicating the complete finding payload.

### Failure and disagreement handling

- Preserve independent research reports and surface agreement, partial agreement, disagreement, or insufficient evidence.
- Do not promote a disputed recommendation without a tie-breaker review or required human decision.
- Keep workstreams in a safe prior state when a reviewer or sub-agent is unavailable.
- Retry classified transient failures within separate review, implementation, and remediation budgets.
- Fail closed on authorization, scope, evidence-freshness, or policy failures.
- Persist handoffs before dispatching follow-up work so a later parent session can resume from Lakebase.

Release 1.1 includes the parent agent, five specialized profiles, deterministic routing, structured handoffs, policy-based approvals, independent review context, and durable escalation. Later releases may add specialized reviewer fleets, quorum review, dynamic cost-aware routing, project/developer policy overrides, and additional autonomous remediation while preserving WS-INIT authority.

## Decision 46 — Omnigent Agent Release Scope Revision

The original file-based WS-INIT was a scheduled Genie Code session, but the Hi
Genie Release 1 design intentionally moves privileged scheduling and dependency
evaluation into the deterministic WS-INIT Dispatcher contract. The historical
agent session therefore does not justify moving the full Omnigent Agent into
Release 1.

Release 1 includes an optional, read-only **Worker Insight** sub-agent. It uses
the Workstream MCP to explain active workstreams, progress, blockers,
dependencies, validation evidence, session summaries, and next actions. It
does not implement work, call Supervisor API tools, modify dispatch state,
review artifacts, approve completion, or replace WS-INIT.

Release 1 Worker Insight requires no handoff tables, planning-research
provenance tables, privileged API identity, or new Lakebase schema. It uses the
existing Release 1 MCP read tools and the existing Hi Genie telemetry,
redaction, authorization, and retention policies.

The remaining Omnigent profiles stay in Release 1.1:

- Planning Research A and B
- Supervisor sub-agent with exclusive Supervisor API access
- Independent Reviewer sub-agent
- Durable handoffs and handoff attempts
- Planning-research run, report, and synthesis persistence
- Policy-governed privileged approvals and full multi-role routing

This preserves the original scheduled-session experience where it is useful
for conversational insight while keeping privileged orchestration deterministic
and auditable. WS-INIT remains the authoritative scheduler, Dispatcher, and
source of execution truth.

## Decision 43 — Omnigent Handoff and Research Persistence

**Status:** Accepted

Release 1 remains unchanged in its core Lakebase schema. Existing planning,
review, remediation, execution, and memory records must consistently carry
`correlation_id`, `session_id`, `project_id`, `workstream_id`, actor or
execution identity, idempotency metadata where applicable, timestamps, and
provenance so future agent operations can reference them without redesigning
the domain model.

Release 1.1 adds an agent-orchestration layer without adding a Lakebase project
or a third database schema:

- `dispatch.agent_handoffs` stores durable typed handoff envelopes, source and
  target roles and identities, requested action, scope, Lakebase references,
  required outputs, authorization and policy context, idempotency, expiry,
  configuration version, and lifecycle status.
- `dispatch.agent_handoff_attempts` stores append-only delivery attempts,
  leases, execution identity, retry classification, timestamps, result
  references, and trace correlation.
- `state.planning_research_runs` stores the research question, source planning
  record, independent researcher identities, context snapshot, and run status.
- `state.planning_research_reports` stores each independent report, evidence
  references, options, recommendation, risks, release implications, and
  disagreement classification.
- `state.planning_research_synthesis` stores the parent synthesis, disposition,
  unresolved disagreements, and any resulting proposal or decision reference.

Handoff envelopes are minimal and reference authoritative Lakebase records;
they do not duplicate complete findings, remediation details, planning
records, or review evidence. Handoffs are persisted before dispatch, use
idempotent delivery, expire safely, and fail closed on authorization, scope,
stale-reference, or policy failures. Parent-agent recovery resumes from
Lakebase rather than in-memory conversation state.

Planning Research A and B receive equivalent context through independent
execution contexts and report separately before synthesis. The parent must
surface agreement, partial agreement, disagreement, or insufficient evidence;
it may not silently average conflicting recommendations or promote a disputed
recommendation without a tie-breaker review or required human decision.

Release 1.1 includes durable handoffs and planning-research provenance. A
later release may add reviewer fleets, quorum, dynamic routing, or richer
agent-level workflow state, but must preserve the `state`/`dispatch` boundary
and WS-INIT authority.

## Decision 44 — Omnigent Handoff and Research Record Contracts

**Status:** Accepted

Release 1.1 uses typed relational records rather than a generic agent-workflow
JSON table. Every record has a UUID primary key, immutable creation metadata,
project scope, correlation identifiers, and an append-only event or attempt
history where retries or state changes are possible.

### `dispatch.agent_handoffs`

This is the durable envelope and current delivery state. Required fields are:

- `handoff_id` — immutable UUID primary key.
- `project_id`, optional `workstream_id`, optional `session_id` — authorization
  scope.
- `source_role`, `target_role`, `source_execution_id`, `target_profile` — role
  and execution routing.
- `requested_action`, `priority`, `context_refs`, `required_outputs` — typed
  bounded request content; referenced records remain authoritative.
- `authorization_scope`, `policy_level`, `policy_version` — authorization
  context captured at creation.
- `correlation_id`, `parent_handoff_id`, `idempotency_key` — trace and retry
  correlation.
- `status`, `attempt_count`, `expires_at`, `created_at`, `updated_at`,
  `created_by` — lifecycle and audit metadata.
- `configuration_version` — runtime policy snapshot used for delivery.

Lifecycle:

```text
CREATED → DISPATCHED → CLAIMED → ACKNOWLEDGED → COMPLETED
                         ├→ RETRYABLE_FAILURE → DISPATCHED
                         ├→ EXPIRED
                         └→ FAILED
```

Only the Supervisor path may dispatch, retry, expire, or fail a handoff. A
sub-agent may claim and acknowledge a handoff, but cannot change its
authorization scope or target. Completion records the result reference and
must be idempotent.

### `dispatch.agent_handoff_attempts`

This append-only table records each delivery attempt:

- `attempt_id`, `handoff_id`, `attempt_number` — identity and ordering.
- `lease_owner`, `lease_expires_at`, `claimed_at`, `started_at`, `ended_at` —
  delivery lease metadata.
- `execution_id`, `profile_name`, `configuration_version` — execution
  provenance.
- `status`, `failure_class`, `failure_code`, bounded `failure_summary` —
  outcome without unrestricted payloads.
- `result_ref`, `trace_id`, `correlation_id`, `created_at` — result and
  observability references.

Attempts are never updated to rewrite history. Lease expiry permits recovery
by a later Supervisor evaluation, subject to the handoff retry budget.

### `state.planning_research_runs`

This table represents one dual-research request:

- `research_run_id` — immutable UUID primary key.
- `project_id`, optional `requirement_id`, `question_id`, `decision_id`, or
  `blocker_id` — source planning scope.
- `research_question`, `context_snapshot_ref`, `context_snapshot_hash` — the
  exact bounded input used by both researchers.
- `researcher_a_profile`, `researcher_b_profile`, execution identifiers,
  `contract_version` — independent execution provenance.
- `status`, `disagreement_status`, `started_at`, `completed_at`, `created_by`,
  `correlation_id` — lifecycle and correlation metadata.

Lifecycle:

```text
REQUESTED → RUNNING → REPORTS_READY → SYNTHESIZED
                         └→ FAILED / EXPIRED
```

A run is not synthesized until both independent reports are present or the
Supervisor records an explicit insufficient-evidence disposition.

### `state.planning_research_reports`

Each researcher produces one immutable report linked to a run:

- `report_id`, `research_run_id`, `researcher_slot`, `execution_id`.
- `assumptions`, `evidence_refs`, `options_considered`, `recommendation`,
  `risks`, `release_implications`, `uncertainties`.
- `report_hash`, `contract_version`, `created_at`, `completed_at`.
- `status` with `SUBMITTED`, `INVALID`, or `WITHDRAWN`; reports are never
  silently overwritten.

The two researcher slots must be distinct. Reports cannot be edited after
submission; corrections create a successor report linked to the original.

### `state.planning_research_synthesis`

This table stores the parent-agent synthesis:

- `synthesis_id`, `research_run_id`, `synthesizer_execution_id`.
- `classification` — `AGREEMENT`, `PARTIAL_AGREEMENT`, `DISAGREEMENT`, or
  `INSUFFICIENT_EVIDENCE`.
- `common_findings`, `differences`, `recommendation`, `risks`,
  `required_follow_up`, `linked_proposal_ref`, `linked_decision_ref`.
- `contract_version`, `created_at`, `created_by`, `correlation_id`.

A synthesis may recommend a proposal, but it cannot itself accept a decision,
publish a plan, dispatch work, or mark completion. Disagreement requires a
follow-up research pass, tie-breaker, or authorized human disposition before
promotion.

### Shared storage rules

All five tables require project-scoped authorization and redaction. JSON fields
are bounded typed structures validated against the contract; they are not an
arbitrary workflow engine. Foreign-key enforcement is used within an owning
schema where lifecycle ordering permits it; cross-schema references use stable
IDs and application-enforced authorization. Indexes must cover project scope,
status, expiry, correlation, idempotency, and source-record lookups.

Release 1.1 includes the logical contracts, migrations, lifecycle enforcement,
lease recovery, audit records, and representative integration tests. Later
releases may add richer result payloads, reviewer quorum, dynamic routing, and
per-project or per-developer policy overrides.

## Decision 45 — Omnigent PostgreSQL Physical Contract

**Status:** Accepted

The five Release 1.1 Omnigent tables use PostgreSQL `uuid` primary keys,
`timestamptz` audit timestamps, bounded `text` identities, typed bounded
`jsonb` reference/envelope columns, restrictive same-schema foreign keys,
idempotency and successor-history uniqueness, lifecycle and timestamp checks,
and indexes for project scope, status, correlation, expiry, leases, and recent
activity. The complete column contract is maintained in
`architecture/omnigent-postgresql-contract.md`.

RLS is forced on every table. Supervisor writes `dispatch`; the Workstream MCP
owns authorized `state` operations; worker identities are limited to assigned
handoffs and attempt outcomes; research identities are limited to authorized
runs and reports. No application role deletes append-first history.
Cross-schema references remain stable identifiers with application-enforced
authorization.

Migrations run in dependency order in the dedicated migration session, under
the approved advisory lock, with transactional history, checksums, validation,
future-schema rejection, and fail-closed readiness. Release 1.1 includes the
physical contract and hardening; Release 1 keeps only forward-compatible
fields and does not create these five tables.
