# Hi Genie Orchestrator — Architecture Index

This directory contains the design baseline and the recommended order for
turning it into an implementation.

## Documents

| Document | Purpose | Status |
| --- | --- | --- |
| `requirements.md` | Product, surface, security, deployment, memory, migration, UI, and observability requirements | Accepted baseline with implementation details open |
| `decisions.md` | Accepted architecture decisions and deferred implementation choices | Decisions 1–41 accepted or explicitly deferred; migration hardening phased between Release 1 and 1.1 |
| `omnigent-postgresql-contract.md` | Physical PostgreSQL types, keys, constraints, indexes, RLS boundaries, and migration order for the five Release 1.1 Omnigent tables | Accepted physical contract; implementation details remain open |

## Implementation Order

1. Pin exact Supervisor API, typed SDK, and MCP payload contracts.
2. Convert the approved physical contracts into DDL, RLS policies, and the
   startup TypeScript migration module's pinned migration files.
3. Confirm the user-to-Lakebase identity bridge in the target workspace.
4. Define DAB targets, bundle variables, cleanup jobs, and production runbooks.
5. Define React backend-for-frontend response models and DAG payloads.
6. Implement feature-branch validation and protected production promotion.

## Boundary

The Supervisor API/SDK owns the `dispatch` schema and WS-INIT control plane.
The Workstream MCP owns the `state` schema and durable worker context. Both
surfaces run in `mcp-hi-genie-orchestrator`, but neither surface owns the other
surface's unrestricted records or operations.
