# Hi Genie — Omnigent Multi-Agent Configuration

Modeled after [Polly](https://github.com/omnigent-ai/omnigent/tree/main/examples/polly),
this configuration defines a multi-persona orchestrator for Databricks project
lifecycle management.

## Architecture

```
hi_genie (orchestrator brain)
├── architect/     → Plans projects, generates workstream DAGs
├── dispatcher/    → Materializes & dispatches workstreams (dependency-gated)
├── worker/        → Executes implementation tasks
└── reviewer/      → Independent cross-vendor quality verification
```

## Key Differences from Polly

| Aspect | Polly | Hi Genie |
|--------|-------|----------|
| Domain | Code orchestration | Databricks project lifecycle |
| Sub-agents | 7 coding harnesses (CLI-based) | 4 personas (MCP-based) |
| Tools | OS shell, git, file system | UC MCP Services (40 tools total) |
| State | Git worktrees + PRs | Lakebase PostgreSQL + OTel |
| Review model | Diff-based code review | Workstream acceptance criteria |
| Smart routing | Per-worker model selection | Per-persona + cross-vendor review |

## Setup

```bash
# Install Omnigent with Databricks extra
curl -fsSL https://raw.githubusercontent.com/omnigent-ai/omnigent/main/scripts/install_oss.sh | sh -s -- --extra databricks

# Configure Databricks auth
omnigent setup  # follow prompts for Databricks workspace

# Set token (or use profile-based auth)
export DATABRICKS_TOKEN=$(databricks auth token --profile DEFAULT | jq -r .access_token)

# Run the orchestrator
omnigent run omnigent/config.yaml
```

## Smart Routing

The orchestrator uses `smart_routing_harness: auto` which lets Omnigent pick
the best model per turn based on task complexity and cost. Sub-agents also
use smart routing, enabling:

- **Architect**: Strong reasoning (Opus, GPT-5.6 Sol) for complex planning
- **Dispatcher**: Fast + reliable (Sonnet 5, GPT-5.4) for state management
- **Worker**: Flexible (any model via Pi harness) matched to task complexity
- **Reviewer**: Cross-vendor (always different from worker) for objectivity

## MCP Services

Each persona connects to a governed UC MCP Service:

| Persona | Service | Tools |
|---------|---------|-------|
| Architect | `hi_genie_architect_dev` | 14 (create_project, create_plan, ...) |
| Dispatcher | `hi_genie_dispatcher_dev` | 16 (orchestrate_plan, dispatch_workstream, ...) |
| Worker | `hi_genie_worker_dev` | 17 (start_session, record_task_attempt, ...) |
| Reviewer | `hi_genie_reviewer_dev` | 14 (get_workstream_context, submit_review, ...) |

All tools are governed by Unity AI Gateway with EXECUTE grants, tool selectors,
audit logging, and service policies.

## Usage Example

```
User: Build a Unity Catalog foundation for ACME Corp with DLT pipelines
      and gold tables for their Genie space.

hi_genie:
  1. Dispatches architect → creates project, generates 4-workstream plan
  2. Presents plan to human → awaits approval
  3. Dispatches dispatcher → materializes workstreams, starts orchestration
  4. Dispatches worker (ws-catalog) → implements UC foundation
  5. Dispatches reviewer → validates ws-catalog against acceptance criteria
  6. On APPROVE: dispatcher advances ws-catalog → COMPLETE
  7. Dependency gate unlocks ws-dlt-pipeline → dispatches worker
  8. ... continues until all workstreams COMPLETE
```
