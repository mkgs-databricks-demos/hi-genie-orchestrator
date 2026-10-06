# Session: Databricks Sandbox API Research & Design Docs Structure

**Date:** 2026-08-20T15:11Z  
**Branch:** `mg-genie-sandbox-research`  
**Status:** Research complete, documented

---

## Summary

Investigated Databricks Sandbox (Beta) as a potential r1.2 compute surface for running npm builds/tests from Genie Code sessions. Discovered an undocumented REST API, mapped the full endpoint surface, and documented findings. Established a new `docs/design/` directory for forward-looking research and architecture explorations.

---

## Problems Investigated

1. **Can Genie Code run npm/Node.js builds?** — No. `executeCode` runs on serverless compute (Python/SQL/sh only). `runDatabricksCli` has `sandbox` not in allow-list. The CLI on serverless refuses to run outside the web terminal.

2. **Can Databricks Sandbox fill this gap?** — Partially. Sandboxes have Node.js pre-installed and internet egress, but are SSH-only for command execution. No remote exec API exists.

3. **Is there a programmatic path to sandboxes?** — Yes, via `/api/2.0/sandboxes` REST API (undocumented). Omnigent already auto-provisions sandboxes through it. But the API is CRUD-only (no exec).

---

## Key Findings

### Undocumented REST API

- `GET /api/2.0/sandboxes` — lists all sandboxes (callable from serverless via SDK)
- `GET /api/2.0/sandboxes/<name>` — full sandbox detail
- `POST /api/2.0/sandboxes` — create endpoint exists (route accepted by API gateway)
- No exec/command/terminal/logs subresources exist

### Workspace Inventory

- 15 sandboxes total: 14 by `SANDBOX_CREATOR_OMNIGENTS`, 1 by `SANDBOX_CREATOR_LAKEBOX`
- 3 currently running (Omnigent-managed, 24h timeout)
- Naming: `omnigent-<user_id>-<hash>` (Omnigent) | `ascending-reindeer-7322` (Lakebox)
- Internal FQDN exposed in status (potential App→sandbox networking)

### Execution Gap

- Sandboxes support SSH-only execution (no REST exec endpoint)
- Supervisor API's built-in sandbox is different (locked-down, no internet, no Node.js)
- Genie Code can create/manage sandboxes but cannot run commands in them

---

## Changes Made

### New Files

| File | Purpose |
| --- | --- |
| `docs/design/INDEX.md` | Design docs directory index: purpose, naming convention, lifecycle stages, document registry |
| `docs/design/2026-08-19_sandbox-api-exploration.md` | Full research writeup: API surface, Omnigent patterns, 5 architecture options for r1.2, recommendations |
| `fixtures/sessions/2026-08-20_sandbox-api-research-and-design-docs.md` | This session summary |

### Modified Files

| File | Change |
| --- | --- |
| `PROJECT_MEMORY.md` | Added "Design Documents" section linking to `docs/design/INDEX.md` |
| `fixtures/sessions/INDEX.md` | Added this session entry (top of list) |

---

## Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | `docs/design/` directory for future-oriented research | Separates concerns: sessions (past), PROJECT_MEMORY (present), design docs (future) |
| 2 | Naming convention `YYYY-MM-DD_<topic>.md` | Matches session summaries for chronological discovery |
| 3 | Lifecycle stages: Research → Proposal → Accepted → Superseded | Clear progression from investigation to commitment |
| 4 | No immediate sandbox integration (r1.1 stays on container builds) | Exec gap makes sandbox unusable from Genie Code today |
| 5 | r1.2 candidate: App→sandbox SSH bridge | `internal_fqdn` suggests network reachability; needs validation |

---

## r1.2 Candidates Identified

1. **App→Sandbox SSH bridge** — Test if App container can reach sandbox `internal_fqdn` over SSH port 22. If yes, use `ssh2` Node.js library to run `npm test` remotely.
2. **MCP server on sandbox** — Bootstrap an MCP server on a persistent sandbox, connect from orchestrator as a sub-agent tool.
3. **Monitor for exec API** — Probe `/api/2.0/sandboxes/<name>:exec` in future sessions.
4. **GitHub Actions fallback** — External CI as pragmatic alternative (works today, outside governance boundary).

---

## Open Questions

- Is sandbox `internal_fqdn` reachable from App containers?
- What creator type do CLI-created sandboxes use?
- Will `sandbox` enter the `runDatabricksCli` allow-list?
- Is there an undocumented WebSocket terminal endpoint?
