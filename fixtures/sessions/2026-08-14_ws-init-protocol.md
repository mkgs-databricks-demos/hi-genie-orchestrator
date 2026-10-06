# Session: WS-INIT Supervisor Protocol

**Date:** 2026-08-14
**Branch:** `mg-genie-one-genie-onto`

---

## Summary

Designed and documented the WS-INIT supervisor workstream — a centralized
controller that creates, monitors, and coordinates all worker workstreams.
This represents a fundamental shift from distributed self-coordination
(all workstreams fire on cron, gate-check themselves) to centralized
supervision (WS-INIT is the only recurring task).

---

## Key Design Decision: v1 = Plan Executor, v2 = Full Decomposer

**v1 (implemented this session):**
- WS-INIT executes a pre-decomposed plan (produced during interactive session)
- Cannot re-decompose from raw documents at runtime
- Sub-workstream spawning requires human approval
- Maximum spawning depth = 1 from original plan

**v2 (future):**
- WS-INIT re-decomposes from raw documents
- Auto-resolves blockers
- Re-plans when fundamentals change
- Unlimited sub-workstream depth

---

## What Was Built

### New File

| File | Lines | Purpose |
| --- | --- | --- |
| `architecture/ws-init-protocol.md` | 599 | Full supervisor spec: tick model, decision engine, prompt synthesis, spawning rules |

### Updated Files

| File | Change |
| --- | --- |
| `architecture/workstream-spec.md` | Added Supervisor (WS-INIT) as 5th workstream type |
| `architecture/scheduling-contract.md` | WS-INIT model as preferred launch; legacy preserved; 5-min cron added |
| `architecture/execution-protocol.md` | Added Supervisor Tick Protocol (4-phase: Reconstruct/Decide/Act/Log) |
| `architecture/state-layer.md` | Added `ticks` table, `created_at_tick` + `prompt_synthesized` fields, observability queries |
| `architecture/prompt-contract.md` | Added Supervisor Prompt structure (control loop, not 5-section) |
| `architecture/INDEX.md` | Added ws-init-protocol.md to manifest, SUPERVISE phase, build sequence |

**Total changes:** ~908 lines added across 7 files

---

## Core Architecture: The Tick Model

```
WS-INIT fires every 5 min (ONLY scheduled task)
    |
    v
RECONSTRUCT (read full state, ~15 sec)
    |
    v
DECIDE (priority-ordered decision tree, ~5 sec)
    |
    v
ACT (exactly ONE action, 1-60 sec)
    |
    v
LOG (record tick, ~5 sec)
    |
    v
EXIT
```

Decision priority:
1. Terminal check (all COMPLETE?) → SELF_COMPLETE
2. Failure check (any BLOCKED?) → SURFACE_BLOCKER
3. Completion propagation (new gates cleared?) → CREATE_NEXT
4. Ready to launch (uncreated WS with met deps?) → CREATE_NEXT
5. Plan evolution (sub-workstream suggestions?) → SURFACE_SUGGESTION
6. Progress check (timeouts?) → LOG_WARNING
7. Idle → OBSERVE

---

## Key Principles Established

1. **One action per tick** — debuggable, recoverable, bounded blast radius
2. **Stateless reconstruction** — no memory between fires; reads all state fresh
3. **Prompts immutable once created** — no rewriting mid-flight
4. **Just-in-time synthesis** — prompts built with LATEST context at creation
5. **Human approval for DAG mutations** — sub-workstreams proposed, not auto-created
6. **Backward compatible** — legacy all-at-once model still works; WS-INIT is opt-in

---

## Implications for Self-Build Test

The self-build scenario (skill builds itself from its own architecture docs) now
has a clear execution model:

1. Human decomposes in interactive session → produces plan JSON
2. WS-INIT created as single scheduled task
3. Tick 1: Creates WS-A (core modules, root node)
4. WS-A fires (tight cron), reads architecture docs, writes core/ files
5. Tick N: WS-A completes → WS-INIT creates WS-B (backends, depends on A)
6. Continue until all modules built
7. WS-INIT produces summary, self-pauses

---

## Git Log

```
cfa39cd docs(workstream-orchestrator): add ws-init-protocol.md
ee5add1 docs(workstream-orchestrator): integrate WS-INIT into all architecture docs
```

---

---

## Part 2: Bundle Strategy

Added `bundle-strategy.md` (500 lines) defining how the orchestrator handles
Declarative Automation Bundle creation and deployment ordering.

### Key Principle

Bundles are partitioned by **deployment dependency depth**, not by type.
The question is: "Does resource B require resource A to EXIST (as a runtime
artifact) before B can be deployed?" If yes, they go in separate bundles.

### Design Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | Bundle paths: sibling to orchestration (Option B) | Matches existing projects (lakeLoom, scAuditor) |
| 2 | Cross-bundle params: deploy.sh + WS-INIT injection (Option C) | CI/CD needs deploy.sh; dev-time needs prompt injection |
| 3 | Minimal scaffolding (name + dev target only) | Future workstreams define full content |
| 4 | WS-INIT sets execution_backend: databricks-bundle | Bundle editor tools used for resource population |
| 5 | Bundle creation is always its own workstream | Exists before population workstreams fire |
| 6 | Not rigid 3-tier; 1-N bundles by dependency depth | Metric views in platform (workflow handles), endpoint in downstream |

### WS-INIT Decision Tree Updated

New Priority 3 (BUNDLE PROVISIONING) added between FAILURE CHECK and
COMPLETION PROPAGATION. Ensures bundles are scaffolded before any
resource-population workstream attempts to add content.

---

## Git Log (Full Session)

```
cfa39cd docs(workstream-orchestrator): add ws-init-protocol.md
ee5add1 docs(workstream-orchestrator): integrate WS-INIT into all architecture docs
2bd41d2 docs(workstream-orchestrator): session summary + README update for WS-INIT
5e85318 docs(workstream-orchestrator): add bundle-strategy.md
```

---

## What's Next

1. **Self-build test** — Generate the plan JSON and WS-INIT prompt for the skill to build its own modules
2. **WS-INIT prompt template** — A reusable template file in `templates/ws-init-template.md`
3. **v2 planning** — Design the full-decomposer mode (WS-INIT reads raw docs)
4. **Lakebase deployment** — Create `genie-orchestrator` project with the schema (now 6 tables)
5. **Bundle template** — Minimal `databricks.yml` template with variable substitution
