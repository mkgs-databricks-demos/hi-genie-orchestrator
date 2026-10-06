---
module: surfaces/lakebase
version: 1.0.0
purpose: Lakebase schema boundaries and what each schema means for app users
depends_on: []
consumed_by: [roles/supervisor, roles/worker, roles/architect]
---

# Lakebase Schema Boundaries

Hi Genie Orchestrator uses one Lakebase project with two schemas. Understanding
which schema owns what helps you know where your data lives and which surface
(MCP or API) to use.

## `state` schema — Your Planning and Workstream Data

The Workstream MCP reads and writes to this schema on your behalf:

- **Planning records** — Requirements, open questions, decisions, features, release items
- **Workstream specs** — What each workstream should produce and how to verify it
- **Session summaries** — What happened in each worker/reviewer execution
- **Plan snapshots** — Immutable, content-hashed records that lock scope for orchestration
- **Memory** — Short-term, episodic, and semantic memory per project
- **Review evidence** — Findings, remediation references, and reviewer notes

All `state` data is project-scoped and user-authorized via Row-Level Security. You only see data for projects you have access to.

Once published, a plan snapshot is immutable. Changes require a new publication.

## `dispatch` schema — Execution Control (Supervisor-Owned)

The Supervisor API owns this schema. Workers and reviewers cannot write here
directly — they interact through MCP tools that enforce state transitions:

- **Orchestrations** — Running instances created from plan snapshots
- **Workstreams** — Materialized units of work with status, attempts, config
- **Executions** — Individual attempt records (heartbeats, automation IDs)
- **Skill versions** — Published skill content pinned per orchestration
- **Scheduling state** — Tick evaluation, leases, retry queues

## Publication Lifecycle

```
Planning records (state schema, mutable)
  → Publish — creates immutable snapshot
  → Materialize — Supervisor creates workstreams in dispatch
  → Execute — workers run, update status via MCP tools
  → Review + Complete

Lakebase planning records

  → immutable content-hashed plan snapshot
  → dispatch materialization
  → execution and review
```

Once published, a plan snapshot is immutable. Changes create a new revision and require explicit publication before they can affect a new orchestration.

## Access by Role

| Role | state schema | dispatch schema |
| --- | --- | --- |
| Architect (interactive) | Read/write planning records | Publishes via API only |
| Worker (MCP) | Read context, append records | Status updates via MCP tool |
| Reviewer (MCP) | Read evidence, record findings | No direct access |
| Supervisor (API) | Reads plan snapshots | Full ownership |

Neither surface exposes arbitrary SQL or permits one surface to bypass the other's ownership boundary.
- Supervisor operations are role-restricted and own publication, materialization, and scheduling.
- Findings and remediation details remain authoritative in Lakebase.
- Prompts between Supervisor and workers carry identifiers and required actions, not duplicated review payloads.
- Neither surface exposes arbitrary SQL or permits one surface to bypass the other’s ownership boundary.
