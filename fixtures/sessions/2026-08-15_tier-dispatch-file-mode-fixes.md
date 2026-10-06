# Session: Tier Dispatch File-Mode Gap Analysis & Fixes

**Date:** 2026-08-15  
**Context:** Standalone readiness review + WanderBricks integration test planning  
**Orchestration:** N/A (architecture work, not orchestrated)

---

## Problem

The WS-INIT template (`templates/ws-init-template.md`) referenced execution tier variables (`${ws_init_dispatcher_job_id}`, `${lakebase_endpoint}`) that had no resolution rules in `skill/core/prompt-synthesis.md`. This meant prompt synthesis would either fail or inject empty strings when running in file-mode (standalone, no Lakebase, no Dispatcher App).

Additionally, Priority 3 (SILENT FAILURE RECOVERY) included a tier_1 (job-backed) detection path that is unreachable in file-mode, inflating the supervisor prompt with dead code.

## Root Cause

The execution tier system was formally specified in `templates/plan-schema.md` (4 tiers: tier_0 through tier_3) but:
1. The architecture docs (`scheduling-contract.md`, `ws-init-protocol.md`) made no mention of tiers
2. `prompt-synthesis.md`'s substitution table didn't include the tier-related variables
3. The template had no conditional-inclusion mechanism to omit irrelevant sections

The self-build orchestration succeeded because all workstreams defaulted to tier_3 (the universal fallback) and the unresolved variables were never exercised.

## What Was Done

### Fix 1: Prompt Synthesis Substitution Table
**File:** `skill/core/prompt-synthesis.md`

Added 4 new variables to the substitution table:
- `${ws_init_dispatcher_job_id}` — nullable, from `plan.scheduling.dispatcher_job_id`
- `${lakebase_endpoint}` — nullable, from `plan.state.lakebase.host` (only when mode=lakebase)
- `${execution_tier}` — from `workstream.execution_tier.tier` (default: tier_3)
- `${worker_cron}` — from `plan.scheduling.worker_cron`

Added 4 new computed variables:
- `${has_tier_1_workers}` — controls conditional template sections
- `${has_dispatcher}` — controls Dispatcher Job line inclusion
- Resolution rules for `${ws_init_dispatcher_job_id}` (omit line when null)
- Resolution rules for `${lakebase_endpoint}` (omit line when file mode)

### Fix 2: WS-INIT Template Conditional Sections
**File:** `templates/ws-init-template.md`

Added Mustache-style conditional blocks:
- `{{#if has_dispatcher}}` around Dispatcher Job identity line
- `{{#if lakebase_endpoint}}` around Lakebase endpoint identity line
- `{{#if has_tier_1_workers}}` around tier_1 detection logic in Priority 3

Added a `<!-- TEMPLATE PROCESSING NOTES -->` header documenting the conditional variable system.

### Fix 3: Architecture Doc — Execution Tiers
**File:** `architecture/scheduling-contract.md`

Added a new "Execution Tiers" section (before Cron Strategy) covering:
- Tier reference table (tier_0 through tier_3 with mechanism, latency, requirements)
- Tier selection heuristic
- File-mode behavior (all degrades to tier_3, omitted sections)
- Tier availability matrix by state mode

## Key Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | Mustache-style conditionals in templates | Lightweight, no build tool required. Prompt synthesis strips markers during assembly. |
| 2 | tier_3 as universal default | Zero-infrastructure guarantee. Every workspace can run the orchestrator without Lakebase or Dispatcher. |
| 3 | Graceful degradation (not error) for tier_1/tier_2 without infrastructure | Don't block users who haven't set up advanced infra. Fall back silently. |
| 4 | Architecture doc updated (not just template fix) | The tier system was a hidden spec. Making it visible prevents future confusion. |

## Files Modified

| File | Action |
| --- | --- |
| `skill/core/prompt-synthesis.md` | Added 4 substitution vars + 4 computed vars |
| `templates/ws-init-template.md` | Added conditional blocks + processing notes header |
| `architecture/scheduling-contract.md` | Added Execution Tiers section |
| `fixtures/sessions/INDEX.md` | Added this session entry |
| `PROJECT_MEMORY.md` | Updated with tier dispatch decisions |

## Outcome

The skill is now unambiguously standalone-ready in file-mode:
- Prompt synthesis resolves all WS-INIT variables cleanly (no nulls leak into prompts)
- File-mode produces a lean supervisor prompt without tier_1/tier_2 dead code
- The architecture documents formally acknowledge the tier system
- Integration testing can proceed with confidence that file-mode is the fully-supported default path
