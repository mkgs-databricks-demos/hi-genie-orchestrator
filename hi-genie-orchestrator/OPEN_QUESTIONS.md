# Hi Genie Orchestrator — Open Questions

This list records design items that remain open after the initial architecture
review. Decisions should be added to `architecture/decisions.md` when accepted.

## Requires Workspace-Specific Attention

- How will the verified Databricks user map to the transaction-local Lakebase
  identity used by row-level security in the target workspace? Databricks App
  on-behalf-of-user authorization preserves the user's identity for supported
  Databricks API calls, but the AppKit Lakebase Plugin's default pool uses the
  App/service-principal database identity; it does not automatically make the
  PostgreSQL session user the end user. Release 1 must choose and validate the
  supported bridge: either a user-authorized Lakebase connection/role flow, or
  a fail-closed application-set transaction identity that is cryptographically
  bound to the verified OBO principal and enforced by database policies.
- Which AppKit v1 package/version is approved for the Lakebase Plugin's
  connection pool, OAuth credential refresh, and service-principal pool in the
  target workspace?
- Which TypeScript migration library (if any) the startup migration module
  wraps for Release 1 ordering and basic history/version tracking — for example
  `node-pg-migrate`, Drizzle, Umzug, or a hand-rolled tracker table — is an
  implementation choice, not an architecture decision. Release 1.1 must add
  the approved hardening, but the registry shape, dedicated-session mechanics,
  transactional-history implementation, test harness, and exact advisory-lock
  key remain implementation or deployment decisions.
- Which Databricks-hosted embedding endpoint, model version, and dimensions are
  approved for the production workspace?
- What catalog and schema names should store MLflow 3 traces, and are the
  required Unity Catalog trace-preview features approved in the target region?
- What availability, latency, scale-to-zero, backup, and disaster-recovery
  objectives apply to the production workspace?
- Is irreversible Lakebase Search enablement approved for production, or should
  Release 1 remain on pgvector-compatible storage plus structured retrieval?
- Which Databricks CLI version and bundle resource support set will CI/CD pin?

## Implementation Decisions

- Executable physical DDL, final index tuning, and startup migration module
  file naming derived from the accepted physical contract.
- Whether lifecycle values remain `text` plus `CHECK` constraints or become
  PostgreSQL enum types, subject to migration and rollback policy.
- The transaction-local identity GUC names and production role grants required
  by the forced RLS policies.
- Exact bounded JSON schemas and size limits for reference and evidence
  objects in the API/MCP payload contracts.
- Release 1.1 migration-hardening implementation details and the threshold for
  routing a data backfill to a Lakeflow Job.
- Final embedding endpoint, model version, dimensions, and memory cleanup
  values after workspace model approval.
- Exact generated API/MCP schema packaging and example payloads.

The logical architecture is otherwise considered settled. Any new question
that changes ownership, deployment purity, authorization, or completion
semantics must create a new architecture decision before implementation.
