# Session Summary — Omnigent Handoff Contracts

**Date:** 2026-08-17

## Outcome

Defined the field-level Release 1.1 contracts for durable Omnigent Agent
handoffs and independent planning research.

## Contracts

- `dispatch.agent_handoffs` stores the current typed envelope and lifecycle.
- `dispatch.agent_handoff_attempts` stores immutable delivery attempts,
  leases, failures, and result references.
- `state.planning_research_runs` stores one dual-research request and its
  bounded context snapshot.
- `state.planning_research_reports` stores immutable, independently attributed
  reports from Researcher A and Researcher B.
- `state.planning_research_synthesis` stores parent synthesis and explicit
  agreement, partial agreement, disagreement, or insufficient-evidence state.

## Rules

- Handoffs are persisted before invocation and use idempotent delivery.
- Supervisor authorization owns dispatch, retry, expiry, and failure transitions.
- Lease expiry permits recovery without rewriting attempt history.
- Research reports and synthesis are append-first; corrections create successor
  records.
- A synthesis cannot accept decisions, publish plans, dispatch work, or mark
  completion.
- Cross-schema references use stable IDs and application-enforced
  authorization; all records use existing Hi Genie redaction, telemetry,
  retention, and audit policies.

## Release Scope

The contracts are Release 1.1 implementation-planning scope. Release 1 only
adds the common correlation, identity, scope, provenance, and idempotency fields
needed for forward compatibility.
