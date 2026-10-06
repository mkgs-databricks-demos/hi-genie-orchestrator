# Session: Polly Collaboration Protocol

**Date:** 2026-08-19  
**Branch:** `mg-genie-polly-collaboration-protocol`  
**Commits:** 6 (feat + 4 fixes + docs)  
**Bundle:** `mcp-hi-genie-orchestrator`  

---

## Summary

Designed and implemented the Polly-Genie async collaboration protocol as a project skill for the Hi Genie Orchestrator app bundle. Polly is an external review agent with repo access that recommends improvements to requirements, architecture, and documentation — but never touches Databricks-deployed source code.

Two independent reviews were performed and all findings addressed.

---

## Problems Solved

1. No structured mechanism for external review agents to communicate with Genie across sessions
2. No conflict resolution process for architectural disagreements
3. No deployment isolation for collaboration artifacts
4. No concurrency safety for shared state files
5. No expiry/abandonment handling for stale debates

---

## Key Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | Rename `.polly/` → `.review-protocol/` | Avoids namespace collision with orchestrator’s Polly persona concept |
| 2 | App bundle root as path anchor | Consistent reference point; matches `databricks.yml` location |
| 3 | Polly owns odd rounds (1,3,5), Genie owns even (2,4) | Unambiguous turn ownership; eliminates shared counter confusion |
| 4 | `state_version` with compare-and-swap | Prevents concurrent writes from corrupting debate state |
| 5 | 7-day expiry per round | Prevents indefinitely open debates |
| 6 | Advisory-only scope | Protocol cannot mark workstreams complete, close findings, or dispatch work |
| 7 | Explicit write-scope allowlist for Polly | Prevents accidental source code edits |
| 8 | `sync.exclude` for deployment isolation | Protocol artifacts never ship with the app |

---

## Files Created

| Path (relative to App bundle root) | Purpose |
| --- | --- |
| `.review-protocol/SKILL.md` | Protocol definition — roles, debate rules, activation triggers, precedence, write-scope |
| `.review-protocol/POLLY_BRIEFING.md` | Polly’s instruction set, authority boundary, round ownership |
| `.review-protocol/MESSAGE_FORMAT.md` | Structured message templates for both directions |
| `.review-protocol/debate_state.json` | v2.0.0 state tracker (CAS, expiry, implementation tracking) |
| `hi_genie/README.md` | Polly → Genie channel guide |
| `hey_polly/README.md` | Genie → Polly channel guide |

## Files Modified

| Path | Change |
| --- | --- |
| `databricks.yml` | Added `sync.exclude` for `.review-protocol/`, `hi_genie/`, `hey_polly/` |
| `PROJECT_MEMORY.md` | Added Polly Collaboration Protocol reference section |
| `genie-workstream-orchestrator/README.md` | Added Collaboration Protocol section for discoverability |

---

## Review Findings Addressed

### Review 1 (Blocking Issues)
- Namespace collision (`.polly/` → `.review-protocol/`)
- Deployment surface contamination (sync.exclude)
- Skill-interference risks (activation triggers, precedence rules)
- Missing boundary statement (advisory-only scope)

### Review 2 (Hardening)
- Stale `.polly/` references in `hey_polly/README.md`
- Self-referential rename text in `PROJECT_MEMORY.md`
- Solution-root README discoverability
- Path anchor inconsistency (“solution root” vs “bundle root”)
- Round-state example contradiction
- Concurrency protection (`state_version` CAS)
- Expiry/abandonment states (`ABANDONED`, `expires_at`)
- Higher-authority outcomes (`OVERRULED`, `AUTHORITY_OVERRIDE`)
- Implementation tracking fields
- Activation metadata alignment
- Reviewer-skill path resolution
- Write-scope allowlist

---

## Protocol State Model (v2.0.0)

```
ACTIVE ───┬───► AGREED (CONSENSUS)
          ├───► GENIE_FINAL (GENIE_OVERRIDE) [after round 5]
          ├───► ABANDONED (TIMEOUT) [expires_at passed]
          └───► OVERRULED (AUTHORITY_OVERRIDE) [higher authority]
```

---

## Remaining Work

- `.assistant_instructions.md`: Two `.polly/` → `.review-protocol/` references (user applied manually)
- First real Polly recommendation to validate end-to-end flow
- CI/path checks (optional — enforcement at process level for now)
