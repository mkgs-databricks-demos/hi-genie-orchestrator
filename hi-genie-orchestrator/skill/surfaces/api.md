---
module: surfaces/api
version: 1.0.0
purpose: How the Architect and Supervisor interact with the REST API surface
depends_on: [roles/architect, roles/supervisor]
consumed_by: [roles/architect, roles/supervisor]
---

# REST API Surface

The Hi Genie Orchestrator app exposes a versioned REST API at `/api/v1`. The
Architect uses it to publish plans. The Supervisor uses it to orchestrate,
dispatch, and manage workstream execution.

Workers and reviewers do NOT use this API — they interact via MCP tools only.

The Supervisor API and thin typed Python SDK are the control-plane surface for trusted supervisor workflows.

## Planning Operations

- Validate planning records and dependencies.
- Publish immutable plan snapshots.
- Approve or activate release plans.
- Materialize workstreams from a published snapshot.
- Report coverage and unresolved blocking questions.

## Dispatch Operations

- Run or request an evaluation tick.
- Inspect readiness and dependency state.
- Dispatch, retry, pause, and unpause workstreams or tasks.
- Create and claim review tasks.
- Deliver remediation reference envelopes.
- Mark completion only after review and evidence conditions pass.

## Administrative Operations

The Supervisor Admin API owns allowlisted global runtime configuration. Configuration updates require authorization, typed validation, expected-version concurrency, idempotency, a reason, and immutable change history. DAB values seed missing configuration and define hard safety bounds; Lakebase is authoritative after bootstrap.


