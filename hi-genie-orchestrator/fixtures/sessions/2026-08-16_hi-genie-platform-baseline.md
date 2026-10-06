# Session Summary — Hi Genie Platform Baseline

**Date:** 2026-08-16

## Summary

Completed the remaining platform and deployment architecture pass for Hi
Genie Orchestrator. The design remains 100% Databricks-native while separating
interactive App responsibilities from durable Lakeflow Job work.

## Decisions Recorded

- App routes handle short interactive HTTP/MCP requests; Lakeflow Jobs own
  WS-INIT recovery, embeddings, compaction, re-indexing, cleanup,
  reconciliation, Release 1.1 large backfills, and other durable background
  work. Schema migrations remain the App-startup exception.
- CI/CD pins the Databricks CLI, uses separate `dev`, `staging`, and `prod`
  bundle targets, deploys the bundle, and explicitly runs the App resource.
- Lakebase child branches are disposable validation environments, not Git-like
  promotion targets. The same immutable migration artifacts are applied to
  protected `production` after approval.
- AppKit v1 is the Lakebase integration boundary. Release 1 uses the App's
  LakeLoom-style TypeScript startup migration pattern with basic version/history
  tracking; Release 1.1 adds locking, checksums, compatibility safeguards, and
  the other approved hardening. Lakeflow Jobs are reserved for large backfills.
- Release 1 does not depend on Lakebase Search Beta. pgvector-compatible
  storage and structured retrieval remain available; Lakebase Search requires
  explicit workspace approval and Databricks Vector Search is the native
  fallback.
- Operational telemetry and MLflow 3 traces have separate responsibilities,
  shared W3C correlation, redaction, sampling, and backpressure.

## Remaining Workspace Questions

- Verified Databricks-user to Lakebase identity/RLS mapping.
- Approved AppKit v1 and migration-engine configuration.
- Embedding endpoint/model/dimensions.
- MLflow Unity Catalog trace destination and preview approval.
- Lakebase Search production approval.
- Production SLO, backup, and disaster-recovery objectives.
- Pinned Databricks CLI/resource support set.

## Next Implementation Handoff

Define physical DDL, generated API/MCP schemas, pinned migration artifacts,
identity/RLS integration, and the first disposable child-branch validation
workflow before implementing the App surfaces.
