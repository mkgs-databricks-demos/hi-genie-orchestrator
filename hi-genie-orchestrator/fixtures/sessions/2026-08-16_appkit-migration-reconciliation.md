# Session Summary — AppKit Migration Reconciliation

**Date:** 2026-08-16
**Status:** Decision 24 revised; release sequencing approved

## Summary

A review comment identified that earlier sessions and Decision 24 overstated
AppKit's role: AppKit's Lakebase Plugin supplies connection pooling, OAuth
credential refresh, and a service-principal pool for DDL/admin operations, but
no versioned migration engine. AppKit sample apps run guarded
`CREATE SCHEMA/TABLE IF NOT EXISTS` checks during `onPluginsReady`, which is a
startup-bootstrap convenience, not checksum/version/lock migration management,
and is unsafe as the production migration authority. Prior docs also
contradicted themselves by saying both "a migration engine runs from a
one-shot Lakeflow Job" and "App startup ... must not execute DDL," while also
citing "App startup" schema promotion elsewhere.

## Approved Release Split

- Release 1 keeps the LakeLoom-style TypeScript startup migration pattern as
  the minimal baseline: ordered migration definitions, basic migration
  history/version tracking, AppKit Lakebase connection usage, and startup
  execution before serving traffic.
- Release 1.1 incorporates the stronger AppKit/LakeLoom review safeguards:
  checksums, advisory locking, fail-closed readiness, registry validation, a
  dedicated migration session, transactional history, future-schema rejection,
  comprehensive migration tests, and Lakeflow Jobs for large backfills.
- Expand-and-contract compatibility and post-migration schema verification are
  part of Release 1.1 hardening unless another accepted requirement makes them
  mandatory earlier.
- Guarded, versioned, idempotent migration DDL is permitted only inside the
  startup migration module. MCP requests and all other request-path code
  never execute DDL; destructive, unversioned, or ad hoc DDL is prohibited
  everywhere, including at startup.
- The 100% Databricks-native constraint and DAB infrastructure boundary remain
  unchanged. Schema migrations still run from App startup; Release 1.1 uses
  Lakeflow Jobs only for large data backfills.

## Remaining Open Questions

- Which internal TypeScript migration library (if any) the startup module wraps
  for Release 1 ordering/history and Release 1.1 hardening is an implementation
  choice tracked in `OPEN_QUESTIONS.md`.
- AppKit v1 package/version approval for the target workspace remains open.

## Related Artifacts

- `../../architecture/decisions.md` (Decision 24, 35, 39, 40, 41)
- `../../architecture/requirements.md` (Migration Strategy, Review Schema Requirements)
- `../../OPEN_QUESTIONS.md`
- `../../PROJECT_MEMORY.md`
- `../../README.md`
