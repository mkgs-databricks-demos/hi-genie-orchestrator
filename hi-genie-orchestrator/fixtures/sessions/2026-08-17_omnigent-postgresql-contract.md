# Session Summary — Omnigent PostgreSQL Physical Contract

**Date:** 2026-08-17

## Outcome

Defined the physical PostgreSQL contracts for the five approved Release 1.1
Omnigent tables without changing source code, tests, or the portable reference
skill.

## Decisions

- `dispatch.agent_handoffs` is the mutable current envelope with project-
  scoped idempotency, lifecycle checks, expiry, and a restrictive parent
  reference.
- `dispatch.agent_handoff_attempts` is append-only, uniquely ordered per
  handoff, lease-recoverable, and foreign-keyed to the handoff table.
- `state.planning_research_runs` is the bounded dual-research parent with
  distinct A/B execution identities and explicit synthesis gating.
- `state.planning_research_reports` is immutable, slot-limited, hash-tracked,
  and successor-linked for corrections.
- `state.planning_research_synthesis` is classification-driven and cannot
  publish plans, dispatch work, or complete execution.
- All five tables use UUID keys, `timestamptz`, bounded typed `jsonb`, checks,
  scoped indexes, forced RLS, owner-specific roles, and restrictive deletes.
- Migrations run schemas → handoffs → attempts → runs → reports → synthesis →
  validation/RLS/checksum registration in a dedicated locked session.

## Release Scope

Release 1 does not create these tables. Release 1.1 includes the physical
contract, migration hardening, RLS validation, durable handoffs and attempts,
and independent research provenance and synthesis.

## Open Questions

Enum versus checked text representation, identity GUC names and role grants,
bounded JSON schemas and size limits, and the final migration registry/advisory
lock details remain implementation questions.
