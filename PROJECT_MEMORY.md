# Project Memory — Genie Workstream Orchestrator

## What This Is

A standalone, reusable skill that decomposes projects into autonomous parallel workstreams coordinated via Genie Code scheduled tasks. Extracted from `genieCodeWorkshop/docs/skills/workstream-orchestration/` and generalized for any customer.

## Origin

Original skill lived at:
```
/Users/matthew.giglia@databricks.com/genieCodeWorkshop/docs/skills/workstream-orchestration/
```

That version was tightly coupled to:
- Databricks Bundles as the only execution backend
- Workshop-specific path conventions (`fixtures/`, `PROJECT_MEMORY.md`)
- A single git workflow (branch stacking + push-clone)
- Flat markdown status files with no queryable history
- Manual prompt authoring (copy-paste templates)

## Goals of the Redesign

1. **SDK-like interface** — Point at requirements/architecture docs → auto-synthesize workstreams
2. **Pluggable backends** — Bundle, notebook, SQL, pipeline, or custom execution
3. **Durable state** — Lakebase Postgres for ACID coordination, retry intelligence, observability
4. **Optional git** — Branch isolation is an enhancement, not a prerequisite
5. **Multi-customer reusable** — No hardcoded paths, no workshop assumptions

## Directory Structure

```
genie-workstream-orchestrator/
├── README.md                    # Architecture review + redesign brainstorm
├── PROJECT_MEMORY.md            # This file
├── plan.json                    # Self-build orchestration plan (dogfood)
├── architecture/                # Contract documents (DONE — 12 files)
│   ├── INDEX.md                 # Document manifest + build order
│   ├── input-contract.md        # What the skill accepts as input
│   ├── workstream-spec.md       # What a valid workstream is (5 types)
│   ├── decomposition-rules.md   # How to break input → DAG
│   ├── state-layer.md           # Lakebase schema + file fallback + ticks table
│   ├── prompt-contract.md       # 5-section prompt structure + supervisor prompt
│   ├── backend-contracts.md     # Execution interface per backend
│   ├── scheduling-contract.md   # WS-INIT model + cron strategy
│   ├── execution-protocol.md    # Worker lifecycle + supervisor tick protocol
│   ├── ws-init-protocol.md      # Supervisor workstream (creates & monitors workers)
│   └── bundle-strategy.md       # Dependency-ordered bundle partitioning + deploy.sh
├── templates/                   # Reusable templates (DONE — 7 files)
│   ├── ws-init-template.md      # Supervisor prompt (fill variables, schedule)
│   ├── worker-prompt-template.md # Worker prompt (5-section, synthesized by WS-INIT)
│   ├── status-file-template.md  # Per-workstream state file (file-based mode)
│   ├── orchestration-status-template.md # Top-level orchestration tracker
│   ├── ws-final-template.md     # Final workstream (summary, merge plan, deploy plan)
│   ├── plan-schema.md           # plan.json JSON Schema spec + full example
│   └── provisioning-protocol.md # Bootstrap sequence: plan.json → running WS-INIT
├── fixtures/                    # Convention-based artifacts
│   └── sessions/                # Session summaries (per bundle root)
│       ├── INDEX.md             # Reverse-chronological index
│       ├── 2025-07-12_architecture-docs-complete.md
│       ├── 2026-08-14_ws-init-protocol.md
│       ├── 2026-08-14_templates-complete.md
│       ├── 2026-08-14_plan-json-and-ws-init-lifecycle.md
│       ├── 2026-08-14_launch-and-platform-constraints.md
│       ├── 2026-08-15_self-build-orchestration-complete.md
│       ├── 2026-08-15_ws-a-core-state-machine.md
│       ├── 2026-08-15_ws-b-decomposition-dag-builder.md
│       ├── 2026-08-15_ws-c-core-prompt-synthesis.md
│       ├── 2026-08-15_ws-d-backend-modules-complete.md
│       ├── 2026-08-15_ws-e-tracking-modules-complete.md
│       ├── 2026-08-15_ws-final-integration-verification.md
│       └── 2026-08-15_examples-samples-catalog.md
├── orchestration/               # Self-build orchestration state (COMPLETED)
│   ├── orchestration-status.md  # Status: COMPLETED, 12 ticks
│   ├── SUMMARY.md               # Executive summary of all modules
│   ├── INTEGRATION_REPORT.md    # 6/6 cross-reference checks PASS
│   └── state/                   # Per-workstream status files (all COMPLETE)
└── skill/                       # The actual skill files (DONE — 11 modules)
    ├── SKILL.md                 # Entry point (generic, decoupled)
    ├── core/                    # DONE — 4 files, ~2,199 lines
    │   ├── state-machine.md     # 7-state lifecycle, 3 contracts
    │   ├── decomposition.md     # 5-phase work breakdown algorithm
    │   ├── dag-builder.md       # DAG construction, 12-rule validation, plan.json
    │   └── prompt-synthesis.md  # Template selection, 25+ vars, 4 backends
    ├── backends/                # DONE — 7 files, ~1,150+ lines
    │   ├── bundle.md            # Declarative Automation Bundle deployment
    │   ├── notebook.md          # Notebook execution backend
    │   ├── sql.md               # SQL statement execution backend
    │   ├── custom.md            # Free-form execution backend
    │   ├── pipeline.md          # SDP pipeline-editor handoff + bundle capture
    │   ├── dashboard.md         # AI/BI Dashboard draft-canvas handoff + bundle capture
    │   └── genie-space.md       # Genie Space/Agent editor handoff + bundle capture
    └── tracking/                # DONE — 3 files, ~1,180 lines
        ├── lakebase-schema.md   # 8-table Postgres DDL + indexes
        ├── status-protocol.md   # Dual-mode state read/write protocol
        └── observability.md     # Tick logging, duration, dashboard views
```

## Key Design Decisions (Resolved)

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | Architecture docs separate from skill modules | Arch docs are the "why/what"; skill modules are the "how". Keeps skill files actionable, not explanatory. |
| 2 | File-based state as default, Lakebase as upgrade | Zero-friction start. Graduate when observability matters. |
| 3 | State machine adds VALIDATING + RETRYING states | Original only had 4 states. VALIDATING makes verification explicit. RETRYING enables auto-recovery. |
| 4 | Backend interface is validate/execute/verify/rollback | Minimal contract. Every backend must implement all four. |
| 5 | Git is optional | Many customers don't use git-linked folders. Skill must work without it. |
| 6 | Prompts are synthesized, not hand-written | The whole point of "SDK-like" — user provides intent, skill produces prompts. |
| 7 | WS-INIT owns ALL task lifecycle (create/pause/unpause/delete) | Single point of control eliminates race conditions. Workers are scheduling-unaware — simpler prompts, no API knowledge required. |
| 8 | Context-by-reference (Strategy B) as default prompt size strategy | Prompts stay ~2–4K chars. Context lives in readable workspace files. Workers read via `readAssetById` at runtime. No truncation risk. |
| 9 | Sub-stream splitting (Strategy A) for large workstreams | >8K chars of execution steps → split into parent→child sub-streams. Convention: `${parent_key}-1`, `${parent_key}-2`. |
| 10 | Bundle editor = default execution backend | Most common Databricks use case. Test this backend first in integration. |
| 11 | Hourly cron + manual "Run now" as execution model | Platform minimum is hourly. Cron = safety net. "Run now" = primary trigger for responsive execution. WS-INIT outputs actionable links. |
| 12 | 4-tier execution model with graceful degradation | tier_0 (inline), tier_1 (job-backed), tier_2 (genie+kick/pg_notify), tier_3 (genie+cron). tier_3 is default/universal. tier_1/tier_2 require Dispatcher App + Lakebase; absent infrastructure degrades silently to tier_3. |
| 13 | Mustache-style conditional blocks in templates | `{{#if variable}}...{{/if}}` controls section inclusion. Prompt synthesis strips markers and omits content when conditions are false. Keeps templates DRY while supporting multiple deployment configurations. |
| 14 | Editor-backed backends (pipeline, dashboard, genie-space) are a dev-efficiency pattern, not a bundle bypass | SDP/Dashboard/Genie Space workstreams hand off to their specialized Databricks editor for authoring (live schema inference, widget canvas, instruction tuning), but every backend mandates a `databricks bundle generate --existing-id <id> --type <resource_type>` capture step so the resulting resource still lands in `resources/*.yml` for version control and target promotion. |

## Key Design Decisions (Open)

| # | Question | Context |
| --- | --- | --- |
| 1 | Should decomposition be interactive or one-shot? | Interactive = propose DAG, user confirms. One-shot = generate and go. |
| 2 | Lakebase project: shared or per-orchestration? | Shared = less infra. Per-orch = better isolation. |
| 3 | ~~Self-pause mechanism~~ | **RESOLVED (decision #7):** WS-INIT owns all lifecycle control. Workers never self-pause. Removed from state-machine.md, execution-protocol.md, ws-init-template.md. |
| 4 | Max workstreams per orchestration? | Unbounded risks runaway. Cap at 10? 15? Sub-stream splitting may increase effective count. |
| 5 | Multi-modal input (images/diagrams)? | Architecture docs often have diagrams. Worth parsing? |
| 6 | Cost attribution | No token usage API for scheduled tasks today. Infer from duration? |
| 7 | ~~Lakebase + AppKit MCP as memory layer?~~ | **RESOLVED:** The `hi-genie-orchestrator/` design is now the `mcp-hi-genie-orchestrator` single-App architecture with Supervisor API/SDK, Workstream MCP, and separate `dispatch`/`state` Lakebase schemas. |
| 8 | Programmatic session creation (non-scheduled)? | No public API to create interactive Genie Code sessions programmatically. Only `scheduleAgentTool` exists. Limits WS-INIT’s responsiveness to hourly cron + manual "Run now". |
| 9 | ~~Tool surface in scheduled tasks?~~ | **RESOLVED:** Full tool surface confirmed (90 tools). `readAssetById`, `editAsset`, `createAsset`, `executeCode`, `scheduleAgentTool`, `executeLakebasePostgresSql`, skills, all available. Recursive scheduling confirmed (child task executed). Limitations: cannot see own automationId; no intra-session sub-tasking; external MCPs read-only. |

## Technology Stack

- **Execution platform:** Genie Code scheduled tasks (`scheduleAgentTool`)
- **State layer (simple):** Workspace markdown files with YAML frontmatter
- **State layer (advanced):** Lakebase Postgres (row-level locking, SQL queryable)
- **Scheduling:** Quartz cron expressions via `scheduleAgentTool` (hourly minimum)
- **Event-driven dispatch:** Lakebase `pg_notify` → Dispatcher App → `jobs.run_now()` (<30s activation)
- **Task lifecycle:** WS-INIT controls all pause/unpause/delete via `alerts-internal` API
- **Git (optional):** `runGit` tool for branch isolation + push-clone archival
- **Approved app:** `hi-genie-orchestrator/` documents the `mcp-hi-genie-orchestrator`
  App, including Lakebase memory, the startup TypeScript migration module
  (using AppKit's service-principal pool for DDL), and the Workstream MCP.

## Conventions

- All paths use `${variable}` substitution — never literal user paths
- Architecture docs use present-tense declarative ("The system does X", not "The system should do X")
- Skill modules use imperative ("Read the status file", "Set state to IN_PROGRESS")
- Templates use `<placeholder>` for user-supplied values
- DAG definitions are JSON (machine-readable, human-reviewable)
- Status tracking keys off `workstream_key` (short string like "ws-a"), not UUIDs

## Related Projects

- **Original skill:** `genieCodeWorkshop/docs/skills/workstream-orchestration/` (reference, not a dependency)
- **Lakebase experience:** lakeLoom (`lakeloom-infra/`), scAuditor (`scAuditor_infra/`), dbxWearables ZeroBus
- **Scheduling experience:** All workstream orchestration runs in the workshop used `scheduleAgentTool`

## Self-Build Orchestration (Dogfood)

The skill modules were built using the orchestrator itself (`orch-2026-08-14-self-build`).

| Metric | Value |
| --- | --- |
| Orchestration ID | `orch-2026-08-14-self-build` |
| Ticks | 12 |
| Workstreams | 6 (ws-a through ws-final) |
| Retries / Blocks | 0 / 0 |
| Total skill lines | ~4,529 |
| Integration checks | 6/6 PASS |

### Lessons Learned

1. **File-race condition** — Workers overwrote status files during gate-check, wiping supervisor metadata. Fixed: mandate single-field editAsset patches (constraint #8 in worker-prompt-template + prompt-synthesis enforces it).
2. **COMPLETE fallback** — Worker's final status edit can fail if supervisor patches the file concurrently. Fixed: re-read and retry with actual current value.
3. **Hourly cron latency** — Manual kick-off is the practical acceleration pattern for interactive builds.
4. **Artifact-based completion** — When status files are unreliable, output artifact existence is the authoritative signal.

## Hi Genie Orchestrator Design

The planned durable-memory and supervisor application is documented in the
`hi-genie-orchestrator/` sibling project. Its approved target is one production
Databricks App, `mcp-hi-genie-orchestrator`, with a Supervisor API/typed SDK
and a worker-facing MCP backed by separate `dispatch` and `state` Lakebase
schemas. Its additive app-specific operating skill lives under
`hi-genie-orchestrator/skill/`; the portable reference skill remains unchanged
for users without App access. See that project's `PROJECT_MEMORY.md`,
requirements, decisions, skill, and open questions for the current design
baseline.

## Current Status

**Phase:** Skill modules COMPLETE. Integration test PASS. File-mode validated end-to-end.

**Completed:**
- [x] Full review of original skill (8 files)
- [x] Architecture review + redesign brainstorm (README.md)
- [x] Generic SKILL.md (entry point, decoupled)
- [x] Architecture documents (11 files)
- [x] Templates (7 files, including provisioning-protocol.md)
- [x] plan.json (self-build DAG)
- [x] Skill core modules — state-machine, decomposition, dag-builder, prompt-synthesis
- [x] Backend modules — bundle, notebook, sql, custom
- [x] Tracking modules — lakebase-schema, status-protocol, observability
- [x] Integration verification — 11/11 files, 6/6 cross-checks PASS
- [x] File-race bug fix in worker-prompt-template + prompt-synthesis
- [x] Update SKILL.md to link all 11 skill modules with descriptions
- [x] Move session summaries to fixtures/sessions/ per conventions
- [x] Full gap analysis — 3 critical contradictions, 4 significant gaps, 3 platform unknowns
- [x] Self-pause contradiction resolved (WS-INIT owns all lifecycle)
- [x] Priority numbering fixed in ws-init-template (sequential 1-10)
- [x] `notes_for_downstream` naming aligned across schema + queries
- [x] `file_non_empty` expansion rule added to prompt-synthesis
- [x] Prompt Size Strategy documented (Strategy B default + Strategy A for large)
- [x] README updated for hourly cron reality + WS-INIT lifecycle ownership

**Completed (canary tests — tasks deleted after execution):**
- [x] Canary task: tool surface enumeration (task `93b4d1dc`) — 90 tools confirmed, results in `orchestration/canary-results.md`
- [x] Canary task: recursive scheduling (task `b984b632`) — child worker executed (`CHILD_EXECUTED: true`), results in `orchestration/child-worker-result.md`
- [x] Canary task: child worker (task `e24e2f3d`) — spawned by recursive test, confirmed execution
- [x] All 3 canary tasks cleaned up (deleted via alerts-internal API)

**Completed (integration test — 2026-08-15):**
- [x] 4 integration gaps fixed: null convention, provisioning-protocol, WS-INIT self-discovery, status-protocol multi-patch claims
- [x] Integration Test 2WS: 2 workers + ws-final, file-mode, custom backend
- [x] All 3 workstreams completed autonomously (8 ticks, ~36 min)
- [x] Dependency gating verified (ws-b waited for ws-a COMPLETE)
- [x] CAS claim patches work correctly (null convention alignment confirmed)
- [x] WS-INIT SELF_COMPLETE with self-discovery protocol
- [x] Task auto-cleanup (0 tasks remaining after completion)
- [x] Test artifacts: `/Users/matthew.giglia@databricks.com/test-workstream-orchestration/`

**Next:**
- [ ] Execute Bakehouse example (first full-stack orchestration on real data)
- [ ] Execute CityPulse example (cross-catalog fusion test)
- [ ] Execute WanderBricks example (largest scope, all capabilities)
- [ ] Test with git enabled (commit-per-workstream)
- [ ] Test Lakebase state mode
- [ ] Test BLOCKED → RETRYING → recovery path
- [ ] Test with notebook backend (tier_1 job-backed)
- [ ] Test bundle provisioning (tier_2 with Databricks resources)
- [ ] Test concurrent workstreams (max_concurrent_workstreams enforcement)
- [ ] End-to-end test on scAuditor architecture (real project)
- [ ] Evaluate: decomposition interactive vs one-shot (open decision #1)
- [ ] Lakebase project provisioning (open decision #2)
- [x] Define the Hi Genie Orchestrator single-App architecture and Lakebase
  memory/MCP boundary (see `hi-genie-orchestrator/`)
- [x] Define review schema ownership, remediation records, surface contracts,
  Databricks-native deployment boundaries, and runtime configuration policy
  (see `hi-genie-orchestrator/architecture/`)
- [x] Define Databricks operations baseline: Lakeflow Jobs for durable work, pinned CLI, disposable Lakebase child-branch validation, immutable migrations, and optional Lakebase Search
- [x] Add 3 editor-backed backends (pipeline, dashboard, genie-space) so SDP/Dashboard/Genie Space workstreams hand off to their specialized Databricks editor, with mandatory `databricks bundle generate` capture back into `resources/*.yml` (2026-08-17)
- [x] Add 3 editor-backed backends (pipeline, dashboard, genie-space) so SDP/Dashboard/Genie Space workstreams hand off to their specialized Databricks editor, with mandatory `databricks bundle generate` capture back into `resources/*.yml` (2026-08-17)

## Integration Test Results

| Test | Date | Result | Details |
| --- | --- | --- | --- |
| File-mode 2WS | 2026-08-15 | PASS | 3/3 workstreams, dep gating, CAS claims, self-complete |

## Example Projects (from samples.* catalog)

All examples deliver 7 components: SDP, semantic layer, AI/BI dashboard, Genie Space, AI/ML, Lakebase, branded app.

| Project | Source | AI Capability | Theme |
| --- | --- | --- | --- |
| wanderbricks-travel-intelligence | samples.wanderbricks (16 tables) | Vector Search (descriptions + reviews) | Sunset orange + ocean blue |
| bakehouse-franchise-analytics | samples.bakehouse (6 tables) | XGBoost demand forecast | Golden amber + espresso |
| citypulse-urban-mobility | samples.nyctaxi + samples.accuweather | Weather-aware demand prediction | Dark charcoal + electric cyan |

## Git History (Feature Branch)

**Branch:** `mg-genie-integration-test-readiness` (current)

| Commit | Description |
| --- | --- |
| `fa43b59` | refactor: move session summaries to fixtures/sessions/ per conventions |
| `dcf86fa` | docs: update PROJECT_MEMORY.md to reflect completed skill modules |
| `f04c777` | fix(orchestrator): prevent file-race in worker status edits |
| `7c254cd` | feat(orchestrator): complete self-build orchestration |
| `863fb0d` | feat(orchestration): ws-c/ws-d complete + session summary + ws-e created |
| `bc80b06` | docs: platform constraints + ws-a/ws-b worker output |
| `dea7791` | feat(orchestration): provision state layer and launch WS-INIT |
| `bf00f79` | feat: add self-build plan.json + WS-INIT lifecycle control |
