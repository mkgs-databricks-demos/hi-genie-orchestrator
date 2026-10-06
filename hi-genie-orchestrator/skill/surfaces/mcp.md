---
module: surfaces/mcp
version: 1.0.0
purpose: What the MCP surface does, what workers and reviewers can do via it, and its boundaries
depends_on: [core/state-machine]
consumed_by: [roles/worker, roles/reviewer, roles/supervisor]
---

# MCP Surface

The Workstream MCP is the user-authorized `/mcp` surface for workers and compatible clients.

## Owns

- Project and workstream context retrieval.
- Requirements, open questions, decisions, features, release items, and workstream specifications.
- Session summaries, errors, events, task attempts, task completions, and bounded mutable state.
- Structured and in-project semantic memory from sanitized content.
- Review evidence retrieval and remediation finding retrieval.

## Does Not Own

- Plan publication or activation.
- Workstream materialization or scheduling.
- Retry and lease administration.
- Dispatch configuration.
- Job triggering or arbitrary SQL.
- Marking a workstream `COMPLETE`.

All reads and writes are project/workstream scoped, user-authorized, redacted, auditable, and bounded. Lakebase RLS is required; application filtering alone is insufficient.
