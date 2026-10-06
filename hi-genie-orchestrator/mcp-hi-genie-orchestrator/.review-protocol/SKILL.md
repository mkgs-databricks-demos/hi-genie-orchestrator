---
name: polly-collaboration
description: >
  Polly-Genie async collaboration protocol. Polly is an external review agent
  with repo access who recommends improvements to requirements, architecture,
  and documentation. Genie owns all Databricks-deployed source code.
  Communication flows through hi_genie/ (Polly → Genie) and hey_polly/
  (Genie → Polly) folders at the solution root. Includes a structured debate
  protocol with max 5 rounds before Genie's interpretation wins.
---

# Polly Collaboration Protocol

## Scope & Authority Boundary

> **This collaboration method is advisory architecture discussion only.**
> The Hi Genie reviewer role, Lakebase review records, Supervisor authorization,
> and `READY_FOR_REVIEW → COMPLETE` lifecycle remain authoritative. A Polly/Genie
> conclusion MUST NEVER:
> - Mark a workstream complete
> - Close a Lakebase finding
> - Publish a plan
> - Dispatch work
> - Override the orchestrator’s state machine or `plan.json`
>
> `GENIE_FINAL` means Genie’s position on an advisory recommendation is adopted.
> It does NOT constitute workstream completion or an authoritative decision.

## Activation Triggers

**Load this protocol WHEN:**
- Polly has written a new or updated file in `hi_genie/`
- `debate_state.json` shows an `ACTIVE` debate with `last_actor: "polly"`
- The user explicitly asks Genie to check for or respond to Polly’s recommendations
- Starting substantive architecture or requirements work on this project

**Do NOT activate WHEN:**
- Working on unrelated projects (lakeLoom, Epic on FHIR, etc.)
- Performing routine code fixes, linting, or test runs
- The Hi Genie orchestrator is in execution mode (workstream dispatch/tick)
- No `hi_genie/` folder exists at the solution root
- Working inside a different bundle in this repo (e.g., hi-genie-infra)

## Precedence Rules

| Authority | Scope | Overrides Polly? |
| --- | --- | --- |
| Orchestrator `plan.json` + state machine | Workstream lifecycle, dispatch | Yes — always |
| Hi Genie reviewer skill (`genie-workstream-orchestrator/skill/`) | Code review decisions, acceptance | Yes — always |
| Lakebase review records | Findings, resolution tracking | Yes — always |
| Supervisor authorization | Work dispatch, gating | Yes — always |
| Polly-Genie debate outcome | Advisory architecture recommendations | Lowest priority |

If a Polly recommendation conflicts with any of the above authorities, the higher authority wins without debate.

## Roles

| Agent | Domain | May Edit |
| --- | --- | --- |
| **Polly** | Reviews, recommendations, requirements, architecture docs | Docs, requirements, architecture, design specs |
| **Genie** | Databricks-deployed resources, source code, infra | Source code, bundle YAML, notebooks, jobs, pipelines |

**Polly MUST NOT** edit source code in Databricks-deployed resources (notebooks, jobs, pipelines, apps, SQL queries). She recommends; Genie implements.

### Polly Write-Scope Allowlist

Polly MAY directly edit files in these paths (relative to App bundle root):

| Path | Purpose |
| --- | --- |
| `hi_genie/` | Recommendation channel (her primary output) |
| `.review-protocol/debate_state.json` | State updates (her rounds only) |
| `docs/` or `architecture/` | Architecture and design documents (if they exist) |
| `requirements/` | Requirements specifications (if they exist) |
| `PROJECT_MEMORY.md` | Context notes (append only, never delete) |

**Polly MUST NOT edit:**
| Path | Reason |
| --- | --- |
| `server/`, `client/`, `shared/` | Application source code |
| `resources/*.yml` | Bundle resource definitions |
| `databricks.yml` | Bundle configuration |
| `*.ts`, `*.js`, `*.json` (outside allowlist) | Source/config files |
| `hey_polly/` | Genie's channel (read-only for Polly) |
| `.review-protocol/SKILL.md`, `POLLY_BRIEFING.md`, `MESSAGE_FORMAT.md` | Protocol definitions (require human/Genie approval) |
| `tests/`, `fixtures/sessions/` | Test and session data |

## Communication Channels

All paths are relative to the **App bundle root**:
```
mcp-hi-genie-orchestrator/          ← App bundle root (path anchor)
├── hi_genie/                        # Polly writes → Genie reads (read-only for Genie)
├── hey_polly/                       # Genie writes → Polly reads (read-only for Polly)
└── .review-protocol/
    ├── SKILL.md                     # This file (protocol definition)
    ├── POLLY_BRIEFING.md            # Polly's instruction set
    ├── MESSAGE_FORMAT.md            # Message templates
    └── debate_state.json            # Programmatic state tracking
```

**Path anchor:** `mcp-hi-genie-orchestrator/` (the bundle root containing `databricks.yml`).
All file references in recommendations use paths relative to this anchor.

### Rules

1. **Genie** reads `hi_genie/` before substantive work — never writes to it.
2. **Genie** responds in `hey_polly/` — one file per topic thread.
3. **Polly** reads `hey_polly/` before substantive work — never writes to it.
4. **Polly** writes recommendations in `hi_genie/` — one file per topic thread.
5. File naming: `NNN_<kebab-topic>.md` (e.g., `001_auth-refactor.md`).

## Reference Requirements

Polly MUST include in every recommendation:
- **Exact file paths** (relative to bundle root)
- **Section or line references** within documents (heading name, line range, or anchor)
- **Change type**: `SUGGESTION` (take it or leave it) vs `REQUIREMENT_UPDATE` (already applied to docs)

Example:
```
File: server/routes/auth.ts
Lines: 45-67 (function `validateToken`)
Type: SUGGESTION
```

## Debate Protocol

### Flow

1. Polly writes recommendation → `hi_genie/NNN_topic.md`
2. Genie reviews → responds in `hey_polly/NNN_topic.md` with `AGREE` or `DISAGREE`
3. If `DISAGREE`: Polly may rebut (append to her file), Genie counter-responds
4. Max **5 rounds** of back-and-forth per topic
5. If no consensus by round 5: **Genie's interpretation is final**

### Round Counter Semantics

- **Polly** owns odd rounds (1, 3, 5). She initiates at round 1.
- **Genie** owns even rounds (2, 4). He responds on his turn.
- `current_round` = the round we are currently IN (awaiting `round_owner`’s action).
- `last_actor` = who completed the PREVIOUS round.
- When an agent acts: increment `current_round` to their round number, set `last_actor` to self, set `round_owner` to the other, increment `state_version`.
- A round is complete when the actor writes their message AND updates `debate_state.json`.
- Round 5 is Polly’s final argument. If Genie still disagrees after reading round 5, he sets `GENIE_FINAL` without incrementing (there is no round 6).
- **Concurrency:** before writing, read `state_version`, verify it matches your last-seen value, write with `state_version + 1`. If stale, re-read and retry.

### State Tracking

All active debates are tracked in `.review-protocol/debate_state.json`:

```json
{
  "state_version": 3,
  "debates": [
    {
      "id": "001_auth-refactor",
      "status": "ACTIVE",
      "current_round": 2,
      "max_rounds": 5,
      "last_actor": "polly",
      "round_owner": "genie",
      "created_at": "2026-08-18T12:00:00Z",
      "resolved_at": null,
      "resolution": null,
      "expires_at": "2026-09-01T12:00:00Z",
      "implementation_status": null,
      "implementation_commit": null,
      "implemented_at": null
    }
  ]
}
```

**Field semantics:**
| Field | Meaning |
| --- | --- |
| `state_version` | Monotonic counter; writers MUST read, verify, increment (compare-and-swap) |
| `current_round` | Round we are currently IN (pending action from `round_owner`) |
| `last_actor` | Who completed the PREVIOUS round (Polly completed round 1 → now in round 2) |
| `round_owner` | Who must act next to advance the debate |
| `status` | `ACTIVE` \| `AGREED` \| `GENIE_FINAL` \| `ABANDONED` \| `OVERRULED` |
| `resolution` | `null` \| `CONSENSUS` \| `GENIE_OVERRIDE` \| `AUTHORITY_OVERRIDE` \| `TIMEOUT` |
| `expires_at` | ISO timestamp; if `round_owner` has not acted by this time, status → `ABANDONED` |
| `implementation_status` | `null` \| `PENDING` \| `IN_PROGRESS` \| `COMPLETE` \| `DECLINED` |
| `implementation_commit` | Git commit SHA where the agreed change was implemented (null until done) |
| `implemented_at` | ISO timestamp of implementation |

### Resolution States

| Status | Meaning |
| --- | --- |
| `ACTIVE` | Debate in progress, awaiting response |
| `AGREED` | Both agents reached consensus |
| `GENIE_FINAL` | Round 5 reached without consensus — Genie's position adopted |
| `ABANDONED` | `expires_at` passed without `round_owner` acting; debate stale |
| `OVERRULED` | A higher authority (orchestrator, reviewer, Supervisor) superseded this debate |

### Expiry & Abandonment

- Each round sets `expires_at` to **7 calendar days** from when `round_owner`'s turn begins.
- If `round_owner` has not acted by `expires_at`:
  - Status → `ABANDONED`, resolution → `TIMEOUT`
  - The recommendation is neither accepted nor rejected — it simply expired.
- Either agent may re-open an abandoned debate by creating a new thread (`NNN+1_same-topic.md`).

### Higher-Authority Override

When an authority listed in the Precedence Rules table conflicts with an active or resolved debate:
- Set status → `OVERRULED`, resolution → `AUTHORITY_OVERRIDE`
- Note the overriding authority in the response file (`hey_polly/NNN_topic.md`)
- No further rounds occur on that thread.

### Genie Behavior During Debate

1. Read `hi_genie/NNN_topic.md` to see Polly's latest position
2. Read `.review-protocol/debate_state.json`, note `state_version`
3. Increment `current_round`, set `last_actor: "genie"`, `round_owner: "polly"`, `state_version + 1`
4. Set `expires_at` to 7 days from now
5. Append response to `hey_polly/NNN_topic.md` using the message format
6. If agreeing: set `status: "AGREED"`, `resolution: "CONSENSUS"`, `implementation_status: "PENDING"`
7. If `current_round` was 5 (Polly's final) and still disagreeing: set `status: "GENIE_FINAL"`, `resolution: "GENIE_OVERRIDE"`
8. If a higher authority conflicts: set `status: "OVERRULED"`, `resolution: "AUTHORITY_OVERRIDE"`

## Genie Workflow Summary

1. **On session start**: Check `hi_genie/` for new or updated files (only when activation triggers are met)
2. **For each new recommendation**: Review, respond in `hey_polly/`, update `debate_state.json`
3. **For implementation requests Genie agrees with**: Implement the change in source code, reference the debate ID in commit/session notes
4. **Never**: Edit `hi_genie/`, skip reading recommendations, implement disagreed items without debate resolution

## Deployment Isolation

The `.review-protocol/`, `hi_genie/`, and `hey_polly/` directories are **excluded from bundle deployment** via `sync.exclude` in `databricks.yml`.

| Deployment Path | Exclusion Method | Status |
| --- | --- | --- |
| `bundle deploy` (non-source-linked) | `sync.exclude` in `databricks.yml` | Excluded |
| `source_linked_deployment: true` (dev) | Files present but inert (no build/runtime reference) | Safe — markdown/JSON not consumed by Node.js app |
| `w.apps.deploy(source_code_path=...)` | Entire directory uploaded; files present but inert | Safe — no runtime impact |

**Transcript management:** Archive completed debates to `fixtures/sessions/` per session-summary conventions when `hi_genie/` or `hey_polly/` exceeds 10 files. This keeps deploy artifacts small.

## Discoverability

This protocol MUST be referenced from:
- `PROJECT_MEMORY.md` at the bundle root (link to `.review-protocol/SKILL.md`) ✓ Done
- The solution-root `README.md` at `genie-workstream-orchestrator/README.md` (mention collaboration protocol exists) ✓ Done

Without these references, agents working in the project may not discover the protocol exists.

**Activation metadata** (for alignment with existing skills in `genie-workstream-orchestrator/skill/`):
```yaml
triggers:
  - hi_genie/ contains new or modified files
  - debate_state.json has ACTIVE debates where round_owner is "genie"
  - user explicitly requests Polly review check
do_not_activate:
  - unrelated projects
  - routine code fixes / linting
  - orchestrator in execution mode
  - no hi_genie/ folder at bundle root
```
