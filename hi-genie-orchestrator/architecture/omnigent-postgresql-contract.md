# Omnigent PostgreSQL Physical Contracts

**Status:** Accepted for Release 1.1 implementation planning
**Date:** 2026-08-17

This document defines the physical PostgreSQL contract for the five approved
Omnigent tables. It is a migration and access-layer contract, not application
source code. The portable reference skill remains unchanged.

## Conventions

- Primary keys use PostgreSQL `uuid`; UUID generation belongs to the
  migration/runtime boundary and does not require a particular extension.
- Audit and lifecycle timestamps use UTC `timestamptz`.
- Identities and enumerated values use bounded `text` plus `CHECK` constraints;
  the final enum representation remains an implementation question.
- `jsonb` is limited to bounded, typed reference and envelope structures;
  application validation enforces allowed keys and size limits.
- Cross-schema references are stable IDs or bounded reference objects with
  application-enforced authorization. Same-owner lifecycle references use
  foreign keys with restrictive deletes.

## `dispatch.agent_handoffs`

| Column | Type | Contract |
| --- | --- | --- |
| `handoff_id` | `uuid NOT NULL` | Primary key. |
| `project_id` | `uuid NOT NULL` | Authorization scope. |
| `workstream_id`, `session_id` | `uuid` | Optional scope identifiers. |
| `source_role`, `target_role` | `text NOT NULL` | Non-empty bounded role names. |
| `source_execution_id`, `target_profile` | `text NOT NULL` | Routing provenance. |
| `requested_action` | `text NOT NULL` | Bounded action identifier. |
| `priority` | `smallint NOT NULL DEFAULT 50` | Must be 0 through 100. |
| `context_refs`, `required_outputs` | `jsonb NOT NULL DEFAULT '[]'` | Typed bounded arrays. |
| `authorization_scope` | `jsonb NOT NULL` | Captured authorized scope. |
| `policy_level`, `policy_version` | `text NOT NULL` | Policy decision snapshot. |
| `correlation_id` | `uuid NOT NULL` | End-to-end trace key. |
| `parent_handoff_id` | `uuid` | Restrictive self-reference. |
| `idempotency_key` | `text NOT NULL` | Retry-safe caller key. |
| `status` | `text NOT NULL DEFAULT 'CREATED'` | `CREATED`, `DISPATCHED`, `CLAIMED`, `ACKNOWLEDGED`, `COMPLETED`, `RETRYABLE_FAILURE`, `EXPIRED`, or `FAILED`. |
| `attempt_count` | `integer NOT NULL DEFAULT 0` | Must be non-negative. |
| `expires_at` | `timestamptz NOT NULL` | Must follow creation time. |
| `configuration_version` | `text NOT NULL` | Runtime policy snapshot. |
| `created_by` | `text NOT NULL` | Authenticated or approved app identity. |
| `created_at`, `updated_at` | `timestamptz NOT NULL DEFAULT now()` | Immutable creation and current-state timestamps. |
| `completed_result_ref` | `jsonb` | Required exactly for `COMPLETED`. |

`parent_handoff_id` references `dispatch.agent_handoffs(handoff_id)` with
`ON DELETE RESTRICT`. `(project_id, idempotency_key)` is unique. Checks require
non-empty bounded text, valid priority/status/policy values, non-negative
attempt count, ordered timestamps, and completion/result consistency.

Indexes: `(project_id, status, created_at DESC)`, `(status, expires_at)` for
active expirable rows, `(correlation_id)`, `(parent_handoff_id)`, and the
idempotency unique index.

## `dispatch.agent_handoff_attempts`

Columns: `attempt_id uuid NOT NULL`, `handoff_id uuid NOT NULL`,
`attempt_number integer NOT NULL`, `lease_owner text`,
`lease_expires_at timestamptz`, `claimed_at timestamptz`,
`started_at timestamptz`, `ended_at timestamptz`, `execution_id text NOT NULL`,
`profile_name text NOT NULL`, `configuration_version text NOT NULL`,
`status text NOT NULL`, `failure_class text`, `failure_code text`,
`failure_summary text`, `result_ref jsonb`, `trace_id text`,
`correlation_id uuid NOT NULL`, and `created_at timestamptz NOT NULL DEFAULT
now()`.

`attempt_id` is the primary key. `handoff_id` references
`dispatch.agent_handoffs(handoff_id)` with `ON DELETE RESTRICT`.
`(handoff_id, attempt_number)` is unique. Checks require a positive attempt
number, ordered lease and lifecycle timestamps, bounded identities, and a
failure classification/summary for failures. Status is `CLAIMED`, `RUNNING`,
`SUCCEEDED`, `RETRYABLE_FAILURE`, `FAILED`, or `EXPIRED`.

Indexes: `(handoff_id, attempt_number DESC)`, a partial lease-recovery index
on `(lease_expires_at)` for `CLAIMED`/`RUNNING`, `(correlation_id)`, and
`(created_at DESC)`. Attempts are append-only: application roles insert/read,
but do not update or delete.

## `state.planning_research_runs`

Columns: `research_run_id uuid NOT NULL`, `project_id uuid NOT NULL`,
`workstream_id uuid`, `session_id uuid`, `source_requirement_ref jsonb`,
`source_decision_ref jsonb`, `source_blocker_ref jsonb`,
`research_question text NOT NULL`, `context_snapshot_ref jsonb NOT NULL`,
`context_snapshot_hash text NOT NULL`, `researcher_a_profile text NOT NULL`,
`researcher_a_execution_id text NOT NULL`, `researcher_b_profile text NOT NULL`,
`researcher_b_execution_id text NOT NULL`, `contract_version text NOT NULL`,
`status text NOT NULL DEFAULT 'REQUESTED'`, `disagreement_status text`,
`correlation_id uuid NOT NULL`, `created_by text NOT NULL`,
`created_at timestamptz NOT NULL DEFAULT now()`, `started_at timestamptz`, and
`completed_at timestamptz`.

`research_run_id` is the primary key. `(project_id, correlation_id)` is unique.
Checks require distinct A/B execution identities, bounded questions/profiles,
ordered timestamps, statuses `REQUESTED`, `RUNNING`, `REPORTS_READY`,
`SYNTHESIZED`, `FAILED`, or `EXPIRED`, and disagreement values
`AGREEMENT`, `PARTIAL_AGREEMENT`, `DISAGREEMENT`, or `INSUFFICIENT_EVIDENCE`.
Synthesis requires both reports or an explicit insufficient-evidence
disposition. Indexes: `(project_id, created_at DESC)`, `(project_id, status,
created_at DESC)`, `(correlation_id)`, and a partial active-run index.

## `state.planning_research_reports`

Columns: `report_id uuid NOT NULL`, `research_run_id uuid NOT NULL`,
`researcher_slot text NOT NULL`, `execution_id text NOT NULL`,
`assumptions jsonb NOT NULL DEFAULT '[]'`, `evidence_refs jsonb NOT NULL
DEFAULT '[]'`, `options jsonb NOT NULL DEFAULT '[]'`, `recommendation text NOT
NULL`, `risks jsonb NOT NULL DEFAULT '[]'`, `release_implications jsonb NOT
NULL DEFAULT '[]'`, `uncertainties jsonb NOT NULL DEFAULT '[]'`,
`report_hash text NOT NULL`, `contract_version text NOT NULL`,
`status text NOT NULL DEFAULT 'SUBMITTED'`, `supersedes_report_id uuid`,
`correlation_id uuid NOT NULL`, `created_by text NOT NULL`, and
`created_at timestamptz NOT NULL DEFAULT now()`.

`report_id` is the primary key. `research_run_id` references
`state.planning_research_runs(research_run_id)` and `supersedes_report_id`
self-references `report_id`, both `ON DELETE RESTRICT`. The unique key is
`(research_run_id, researcher_slot, report_hash)`. Slot is `A` or `B`; the
application permits only one current report per slot. Reports are immutable;
corrections create successor rows. Checks require non-empty recommendation,
bounded JSON arrays, a valid hash, and status `SUBMITTED` or `SUPERSEDED`.
Indexes: `(research_run_id, researcher_slot, created_at DESC)`,
`(correlation_id)`, and a partial current-report index.

## `state.planning_research_synthesis`

Columns: `synthesis_id uuid NOT NULL`, `research_run_id uuid NOT NULL`,
`synthesizer_execution_id text NOT NULL`, `classification text NOT NULL`,
`common_findings jsonb NOT NULL DEFAULT '[]'`, `differences jsonb NOT NULL
DEFAULT '[]'`, `recommendation text NOT NULL`, `risks jsonb NOT NULL DEFAULT
'[]'`, `required_follow_up jsonb NOT NULL DEFAULT '[]'`,
`linked_proposal_ref jsonb`, `linked_decision_ref jsonb`,
`contract_version text NOT NULL`, `created_by text NOT NULL`,
`correlation_id uuid NOT NULL`, `created_at timestamptz NOT NULL DEFAULT
now()`, plus successor-history fields `supersedes_synthesis_id uuid` and
`superseded_at timestamptz`.

`synthesis_id` is the primary key. `research_run_id` references
`state.planning_research_runs(research_run_id)` with `ON DELETE RESTRICT`.
Classification is `AGREEMENT`, `PARTIAL_AGREEMENT`, `DISAGREEMENT`, or
`INSUFFICIENT_EVIDENCE`. A unique partial index on `research_run_id` where
`superseded_at IS NULL` permits one current synthesis per run. Checks require
a recommendation, bounded arrays, and differences or follow-up for any
non-agreement. Synthesis cannot publish plans, dispatch work, or mark
completion. Indexes cover run/current status and correlation.

## RLS and Migration Boundaries

RLS is enabled and forced on all five tables. Policies use the transaction-
local authenticated principal and project scope established by the API/MCP
boundary; caller-supplied project IDs are insufficient by themselves.

- Supervisor roles own `dispatch`; worker identities can claim/acknowledge
  only assigned handoffs and insert their attempt outcomes.
- Workstream MCP roles own authorized `state` operations; they cannot write
  `dispatch`. Research identities can write only their authorized run/report.
- No application role deletes handoffs, attempts, reports, or synthesis;
  retention uses a separately approved audited identity.

Migration order is: schemas/ownership, handoffs, attempts, research runs,
reports, synthesis, then indexes/RLS validation/checksum registration. The
dedicated migration session acquires the advisory lock, records transactional
history and checksums, rejects future schema versions, and fails closed on
validation or RLS failure. Request paths never run DDL; large backfills use
Lakeflow Jobs.

These tables, constraints, indexes, RLS boundaries, and migration hardening
are Release 1.1 scope. Release 1 adds only forward-compatible shared fields;
it does not create these tables.

## Open Implementation Questions

- Whether lifecycle values remain checked `text` or become PostgreSQL enums.
- Transaction-local identity GUC names and production role grants.
- Exact bounded JSON schemas and size limits for reference/evidence objects.
- Final advisory-lock key and migration registry shape.
