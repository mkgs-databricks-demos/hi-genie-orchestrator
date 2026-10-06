---
name: workstream-orchestrator
triggers:
  - break this into workstreams
  - decompose this project
  - orchestrate this project
  - run these in parallel
  - autonomous execution
  - set up workstream orchestration
  - scheduled task orchestration
  - here's my architecture doc, orchestrate this
  - decompose this requirements doc
  - plan autonomous execution from this spec
---

# Workstream Orchestrator

Decompose a project into autonomous, parallel workstreams that self-coordinate
via a durable state layer and Genie Code scheduled tasks. Each workstream runs
unattended with dependency gating, pluggable execution backends, and optional
git branch isolation.

> **This project: File Mode only.** Hi Genie Orchestrator's `plan.json` sets `state.mode: "file"` — all coordination state lives in `orchestration/state/*.md` YAML frontmatter. Every Lakebase-mode reference in this skill (state backend, tracking schema, dashboards) is inert here and kept for portable-skill reference only. Don't confuse it with the Lakebase project ws-0/ws-b are building as this orchestration's own deliverable.

## When to Use This Pattern

- Project has 3+ distinct deliverables that can be built independently
- Deliverables have clear dependency order (some must finish before others start)
- Each deliverable produces distinct artifacts (no output conflicts)
- You want hands-off execution with human review only at the end
- Total estimated work exceeds what one session can accomplish (~60 min limit)

## When NOT to Use

- Single deliverable that takes <60 min (just do it in one session)
- Highly interdependent work (every piece touches the same outputs)
- Exploratory work where requirements aren't yet clear
- Work that requires continuous human feedback at each step

## Prerequisites

- A workspace folder to serve as the orchestration root
- One or more input documents describing what to build (any of):
  - Architecture document
  - Requirements / PRD
  - Project README with clear deliverables
  - Existing codebase with a gap analysis
  - Conversation thread describing the project
- (Optional, not used by this project) A Lakebase project for durable state tracking — this project uses File Mode
- (Optional) A git-linked folder for branch-per-workstream isolation
- Clear understanding of what "done" looks like for each deliverable

## Quick Start (5 Steps)

1. **Analyze** — Read `core/decomposition.md`. Point the orchestrator at your
   input document(s). It extracts deliverables, maps dependencies, and proposes
   a DAG of workstreams. Output: `plan.json`.

2. **Review the DAG** — Validate the proposed workstreams: correct dependencies,
   proper isolation (no output conflicts), right sizing (15–60 min each).
   Confirm `plan.json` passes schema validation (see `templates/plan-schema.md`).

3. **Provision** — Read `templates/provisioning-protocol.md`. Follow the 6-step
   bootstrap sequence: create state directory, instantiate orchestration-status,
   synthesize WS-INIT prompt, schedule WS-INIT, activate. This is the critical
   bridge between planning and autonomous execution.

4. **Launch** — Click "Run now" on the WS-INIT scheduled task. WS-INIT reads
   `plan.json`, detects workstreams ready to start (no dependencies), synthesizes
   worker prompts from `core/prompt-synthesis.md`, creates scheduled tasks, and
   outputs "Run now" links. Click them for immediate execution.

5. **Monitor** — WS-INIT ticks hourly (safety net). Check `state/orchestration-status.md`
   for progress. Intervention only needed if a workstream enters BLOCKED status.
   WS-INIT surfaces blockers with resolution guidance on each tick.

## Skill Modules (14 files, ~5,200 lines)

### Core (4 files, ~2,199 lines)

| Module | Lines | Purpose |
| --- | --- | --- |
| [`core/state-machine.md`](core/state-machine.md) | ~355 | 7-state lifecycle (NOT_STARTED → GATED → IN_PROGRESS → VALIDATING → COMPLETE / BLOCKED / RETRYING), transition guards, timeout rules, claim protocol, 10 invariants, 3 downstream contracts (backend, tracking, prompt synthesis) |
| [`core/decomposition.md`](core/decomposition.md) | ~380 | 5-phase algorithm: input classification (5 types), deliverable extraction, dependency mapping, sizing/confidence scoring, candidate validation. Drives user interaction based on confidence level. |
| [`core/dag-builder.md`](core/dag-builder.md) | ~480 | DAG construction from candidates, Kahn's algorithm for cycle detection + topological sort, 3 dependency types (status_complete, table_exists, soft), isolation validation, 12 pre-output validation rules, plan.json generation |
| [`core/prompt-synthesis.md`](core/prompt-synthesis.md) | ~1,090 | Template selection (supervisor/final/worker), 25+ substitution variables, content block generation (Gate/Context/Execute/Validate/Complete), state-reference injection, 15-point self-containment checklist, 10-step assembly pipeline, full examples for all 7 backends |

### Execution Backends (7 files, ~1,800 lines)

Four backends execute work directly in the current session. Three **editor-handoff backends** (pipeline, dashboard, genie-space) delegate authoring to a specialized editor page and then capture the result into the bundle — because those page-specific agents have tooling that generic sessions lack.

> **All editor-handoff backends still require a bundle resource entry.** The handoff handles *authoring*; the bundle handles *deployment and management*. The resulting artifact (pipeline, `.lvdash.json`, or `.geniespace.json`) must be declared in `resources/*.yml` and deployed via `bundle deploy` before this workstream marks COMPLETE.

| Module | Lines | Purpose |
| --- | --- | --- |
| [`backends/bundle.md`](backends/bundle.md) | ~260 | Declarative Automation Bundle lifecycle: validate → deploy → verify → rollback. Handles `databricks.yml` configuration, target selection, resource dependency ordering. |
| [`backends/notebook.md`](backends/notebook.md) | ~290 | Notebook creation + editing + execution: createAsset → editAsset → executeCode/runNotebookCells → verify output. Multi-cell workflows, error self-correction protocol. |
| [`backends/sql.md`](backends/sql.md) | ~290 | Pure SQL DDL/DML/grant execution: CREATE OR REPLACE, schema setup, permission grants. Executes via `executeCode(language: 'sql')`. Idempotent patterns. |
| [`backends/custom.md`](backends/custom.md) | ~320 | Free-form and composite execution: apps, documentation, multi-backend workstreams. WS-FINAL pattern (read all upstream → produce summary). Sub-phase sequencing for composite work. |
| [`backends/pipeline.md`](backends/pipeline.md) | ~230 | **Editor-handoff.** Spark Declarative Pipeline (SDP) — createAsset(pipeline) → pipeline-editor page handoff with requirements-only continueMessage → bundle capture in `resources/pipelines/*.yml`. SDP code is authored exclusively on the pipeline editor page. |
| [`backends/dashboard.md`](backends/dashboard.md) | ~230 | **Editor-handoff.** AI/BI Dashboard — createAsset(dashboard) → draft-canvas page handoff → `bundle generate dashboard` exports `.lvdash.json` → bundle capture in `resources/dashboards/*.yml` (with `sync.exclude`). |
| [`backends/genie-space.md`](backends/genie-space.md) | ~220 | **Editor-handoff.** Genie Space / Agent — createAsset(genie) → Genie space page handoff → `bundle generate genie-space` exports `.geniespace.json` → bundle capture in `resources/genie_spaces/*.yml`. Requires `engine: direct` in `databricks.yml`. |

### Tracking (3 files, ~1,180 lines)

| Module | Lines | Purpose |
| --- | --- | --- |
| [`tracking/lakebase-schema.md`](tracking/lakebase-schema.md) | ~360 | Full Postgres DDL: 8 tables (orchestrations, workstreams, executions, gates, ticks, artifacts, events, schema_migrations), indexes, constraints, advisory locks, migration protocol. **Not used by this project (File Mode).** |
| [`tracking/status-protocol.md`](tracking/status-protocol.md) | ~420 | Dual-mode read/write protocol: Lakebase SQL (advisory lock + UPDATE RETURNING) and file-based (YAML frontmatter CAS via editAsset old_text matching). Error handling, retry semantics, timeout detection. **This project uses the file-based half only.** |
| [`tracking/observability.md`](tracking/observability.md) | ~400 | Tick logging, duration inference (computed columns), queryable history, 4 dashboard views (v_orchestration_summary, v_workstream_timeline, v_tick_history, v_error_report), alerting thresholds (critical/warning/info) |

## Key Concepts

- **Orchestration root** — Any workspace folder. Holds state files and project docs. No structural requirements imposed.
- **Workstream** — A self-contained unit of work (15–60 min) that runs as a Genie Code scheduled task.
- **DAG** — Directed acyclic graph of workstreams with dependency edges. Determines execution order.
- **Gate check** — The first thing a workstream does: verify own status (not already done) + upstream status (dependencies met).
- **Execution backend** — How the work gets done: bundle deploy, notebook run, SQL, or custom (executes directly in-session); pipeline-editor, dashboard-editor, or genie-space-editor (hands authoring off to a specialized editor page, then captures the result into the bundle). Pluggable per workstream.
- **State layer** — Where coordination state lives. Lakebase (ACID, queryable) or workspace files (simpler, no infra). **This project uses workspace files (File Mode) exclusively.**
- **Self-terminating** — COMPLETE status → immediate exit on next fire. Idempotent and safe.
- **WS-INIT** — Centralized supervisor workstream. Creates worker tasks, monitors execution, pauses after fire, detects failures. Workers are scheduling-unaware.
- **WS-FINAL** — Mandatory last workstream. Gates on ALL others. Produces summary + merge plan (if git).

## State Machine

```
NOT_STARTED ──► IN_PROGRESS ──► VALIDATING ──► COMPLETE
                            ──► BLOCKED (human intervention)
                            ──► RETRYING (auto-retry with context)
```

Transitions are one-way except:
- Human can reset BLOCKED → NOT_STARTED (manual recovery)
- System can set RETRYING → IN_PROGRESS (automatic with prior-attempt context)

## Execution Backend Interface

Every backend implements four operations:

```
validate(workstream) → success | errors[]
execute(workstream)  → artifacts[]
verify(workstream)   → passed | failed + details
rollback(workstream) → cleaned | partial
```

Workstreams declare which backend they use. A single orchestration can mix backends.

## Git Integration (Optional)

Git is **not required**. When enabled:

- Each workstream gets its own branch
- Branch stacking: downstream forks from upstream's branch (inherits code without merging)
- Push-clone at session end (write-only, never read from)
- WS-FINAL produces merge plan with PR titles and dependency order

When disabled:

- All work happens directly in the workspace
- State layer alone coordinates execution
- No merge plan in WS-FINAL (just a summary)

## Input Document Types

The orchestrator can decompose from any of these:

| Input | What Gets Extracted |
| --- | --- |
| Architecture doc | Components, data flows, build order, interfaces |
| Requirements / PRD | Deliverables, acceptance criteria, dependencies |
| Codebase + README | Current state, gaps, extension points |
| Conversation thread | Intent, constraints, success criteria |
| Existing DAG JSON | Direct execution (skip decomposition) |

## Scheduling Strategy (WS-INIT Model)

WS-INIT is the **only** recurring scheduled task. It creates and pauses worker tasks JIT.

| Task | Cron | Rationale |
| --- | --- | --- |
| WS-INIT (supervisor) | `0 0 */1 * * ?` (hourly) | Platform minimum; safety net. Manual "Run now" for responsiveness. |
| Workers (created by WS-INIT) | `0 0 */1 * * ?` (hourly) | Fire-once semantics; WS-INIT pauses after confirming execution. |

**Execution model:** WS-INIT creates worker tasks → user clicks "Run now" for immediate fire → WS-INIT detects execution on next tick → pauses the worker task. Hourly cron is a safety net, not the primary trigger.

## Error Recovery

| Status | Meaning | Recovery |
| --- | --- | --- |
| BLOCKED | Unrecoverable in current attempt | Human reads error, fixes, resets to NOT_STARTED |
| RETRYING | Failed but auto-retryable | System queries prior attempt, adjusts, re-enters |
| Stuck IN_PROGRESS | Session timed out mid-work | Human resets to NOT_STARTED; next fire resumes |

## Comparison: File-Based vs. Lakebase State

_This project has already chosen File-Based (see `plan.json` → `state.mode: "file"`) — kept below for reference only when deciding on a future orchestration._

| Concern | File-Based | Lakebase |
| --- | --- | --- |
| Setup complexity | None (just markdown files) | Requires Lakebase project |
| Query history | Manual grep | SQL queries |
| Concurrent access | Convention-based | Row-level locking |
| Retry intelligence | None | Query prior errors |
| Cost tracking | Not possible | Duration + artifacts logged |
| Best for | Simple/solo projects | Teams, repeated use, observability |

Start with file-based for simplicity. Graduate to Lakebase when you need
observability, retry intelligence, or multi-project tracking.
