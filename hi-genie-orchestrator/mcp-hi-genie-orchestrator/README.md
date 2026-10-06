# mcp-hi-genie-orchestrator

Hi Genie Orchestrator — Supervisor dispatch API (`/api/v1`) + Workstream MCP (`/mcp`) powered by AppKit + Lakebase.

## Prerequisites

- **hi-genie-infra bundle deployed** (provisions Lakebase, UC schema, secret scope, SQL warehouse, volumes)
- Databricks CLI authenticated (`databricks auth login`)
- Node.js 20+ (for local dev only — container handles production builds)

---

## Deployment

### 1. First-Time Deployment (Runbook)

The `app_deploy.sh` script handles the full first-deploy lifecycle:

```bash
./app_deploy.sh --target dev
```

**What it does:**

1. Resolves infra bundle values (`catalog`, `schema`, `lakebase_project_id`) from the sibling `hi-genie-infra` bundle
2. Resolves `lakebase_database_id` via `databricks postgres list-databases`
3. Checks for SPN credentials in the secret scope
4. On first deploy: sources `bootstrap_credentials.sh` to create placeholder secrets → deploys bundle → retrieves real SPN client_id → updates secret
5. Runs `databricks bundle deploy --target <target> --var <overrides>`
6. Triggers a source code deployment via the REST API (`POST /api/2.0/apps/{name}/deployments`)

**First-deploy credential flow:**

After the first run, the app's SPN is created by the platform. You must manually set the `client_secret` in the secret scope:

```bash
# Get the client_secret from the Account Console for the app SPN
databricks secrets put-secret hi_genie_credentials client_secret_dev_matthew_giglia_hi_genie --string-value "<secret>"

# Re-run to complete bootstrap
./app_deploy.sh --target dev --auto-approve
```

### 2. Iterative Development (Dev Target)

**Key variables for dev target** (in `databricks.yml`):

| Variable | Dev Value | Notes |
| --- | --- | --- |
| `catalog` | `hls_fde_dev` | UC catalog |
| `schema` | `dev_matthew_giglia_hi_genie` | UC schema |
| `lakebase_project_id` | `hi-genie-orchestrator` | Shared across targets |
| `lakebase_branch` | `development` | Lakebase branch |
| `lakebase_database_id` | `databricks-postgres` | Resolve via `databricks postgres list-databases` |
| `mlflow_experiment_id` | `4038008988926083` | MLflow 3 experiment (from infra bundle) |
| `app_name` | `mcp-hi-genie-orchestrator-dev` | Platform app name |
| `client_id_dbs_key` | `client_id_dev_matthew_giglia_hi_genie` | Secret scope key |
| `client_secret_dbs_key` | `client_secret_dev_matthew_giglia_hi_genie` | Secret scope key |

**Source-linked deployment** is enabled for dev — `bundle deploy` links the workspace folder as the app's source. Changes in the workspace are reflected immediately on next deployment trigger.

**Manual iterative deploy:**

```bash
# Deploy bundle resources (updates app config, links source)
databricks bundle deploy --target dev --var lakebase_database_id=databricks-postgres

# Trigger a new app deployment (builds + starts from workspace source)
databricks api post /api/2.0/apps/mcp-hi-genie-orchestrator-dev/deployments \
  --json '{"source_code_path": "/Workspace/Users/matthew.giglia@databricks.com/brainstorming-hi-genie-orchestrator/genie-workstream-orchestrator/hi-genie-orchestrator/mcp-hi-genie-orchestrator"}'
```

### 3. Genie Code Deployment (Automated)

Genie Code deploys using the Python SDK from a notebook cell:

```python
from databricks.sdk import WorkspaceClient
from databricks.sdk.service.apps import AppDeployment

w = WorkspaceClient()

# Step 1: Bundle deploy (via runDatabricksCli tool)
# databricks bundle deploy --target dev --auto-approve --var lakebase_database_id=databricks-postgres

# Step 2: Trigger app deployment
SOURCE_CODE_PATH = "/Workspace/Users/matthew.giglia@databricks.com/brainstorming-hi-genie-orchestrator/genie-workstream-orchestrator/hi-genie-orchestrator/mcp-hi-genie-orchestrator"

waiter = w.apps.deploy(
    app_name="mcp-hi-genie-orchestrator-dev",
    app_deployment=AppDeployment(source_code_path=SOURCE_CODE_PATH)
)
print(f"Deployment: {waiter.deployment_id}")
```

**Key notes for Genie Code:**
- `bundle deploy` is available via the `runDatabricksCli` tool
- `w.apps.deploy()` works from `executeCode` (Python SDK, not blocked)
- The `--var lakebase_database_id=databricks-postgres` override is REQUIRED (variable defaults to empty)
- Poll `GET /api/2.0/apps/{name}` for `active_deployment.status.state == 'SUCCEEDED'`
- Build logs stream to `hls_fde_dev.dev_matthew_giglia_hi_genie.hi_genie_otel_logs`

### 4. Git Deployment (Production)

The `prod` target deploys directly from the `release` branch in GitHub — no workspace files are involved. The container pulls source from Git at deploy time.

#### How It Differs from Source-Linked (Dev)

| Aspect | Dev (source-linked) | Prod (git) |
| --- | --- | --- |
| Source of truth | Workspace folder | Git repository (`release` branch) |
| Code sync | Bundle syncs to workspace → container reads workspace | Container pulls directly from Git |
| Deploy trigger | `w.apps.deploy(source_code_path=...)` | `databricks apps deploy --json '{"git_source": {"branch": "release"}}'` |
| Iteration speed | Instant (workspace = source) | Must push to Git first |
| Safety | Risk of deploying uncommitted edits | Only committed, reviewed code deploys |
| Rollback | Redeploy previous workspace state (manual) | Pin to tag or commit SHA |

#### Prerequisites (One-Time Setup)

1. **Create the `release` branch** in GitHub (long-lived branch, receives merges from `main` or feature branches after review).

2. **Configure the Git repository on the app.** This is handled by the DABs resource definition (`resources/hi_genie_app.app.yml` → `prod` target override):

   ```yaml
   prod:
     resources:
       apps:
         app:
           git_repository:
             url: https://github.com/matthew-gigl-db/brainstorming
             provider: gitHub
           git_source:
             branch: release
             source_code_path: genie-workstream-orchestrator/hi-genie-orchestrator/mcp-hi-genie-orchestrator
   ```

   After `bundle deploy --target prod`, the platform registers the Git repo on the app.

3. **Configure a Git credential for the app's service principal** (required for private repos). The app SPN must have a GitHub PAT with read access to the repository:

   ```bash
   # Get the app SPN's numeric principal ID
   APP_SPN_ID=$(databricks apps get mcp-hi-genie-orchestrator-prod | jq -r '.service_principal_id')

   # Create a Git credential for the SPN
   databricks git-credentials create --json "{
     \"git_provider\": \"gitHub\",
     \"git_email\": \"matthew.giglia@databricks.com\",
     \"personal_access_token\": \"<GITHUB_PAT_WITH_REPO_READ>\",
     \"principal_id\": $APP_SPN_ID,
     \"name\": \"GitHub credentials for Hi Genie Orchestrator prod SPN\"
   }"
   ```

   **Requirements:**
   - You must have `CAN MANAGE` permissions on the app's service principal
   - The PAT needs `repo` (read) scope for private repos; public repos need no credential
   - SPNs support one Git credential per provider — updating it elsewhere replaces the existing one

4. **Deploy the bundle** to register the git configuration:

   ```bash
   databricks bundle deploy --target prod --var lakebase_database_id=<id> --var mlflow_experiment_id=<id>
   ```

#### Deploying from Git

Once prerequisites are met, deploy from the `release` branch:

```bash
# Deploy latest commit on release branch
databricks apps deploy mcp-hi-genie-orchestrator-prod \
  --json '{"git_source": {"branch": "release"}}'

# Deploy a specific tag (release pinning)
databricks apps deploy mcp-hi-genie-orchestrator-prod \
  --json '{"git_source": {"tag": "v1.2.0"}}'

# Deploy an exact commit (rollback or audit)
databricks apps deploy mcp-hi-genie-orchestrator-prod \
  --json '{"git_source": {"commit": "abc123def456"}}'

# Deploy from a subdirectory (already configured in DABs, but for manual override)
databricks apps deploy mcp-hi-genie-orchestrator-prod \
  --json '{"git_source": {"branch": "release", "source_code_path": "genie-workstream-orchestrator/hi-genie-orchestrator/mcp-hi-genie-orchestrator"}}'
```

#### Enabling Auto-Deploy on Push (Optional, GitHub Beta)

Automatic deployments register a webhook on the repository and redeploy on every commit to the watched branch:

1. Install the **Databricks GitHub App** on the repository (required)
2. Repository must be **private** (public repos are not supported for auto-deploy)
3. Ensure the SPN Git credential is configured (step 3 above)
4. Enable via the Databricks UI: App Settings → Auto deploy on push events → Branch: `release`

**Limitations:**
- GitHub and Azure DevOps only (Beta)
- Git reference must be a branch (tags not supported for auto-deploy)
- Max 20 webhooks per repo (250 for GitHub Enterprise)
- If the SPN credential expires, deployments silently fail

#### Workspace Admin Enforcement

Workspace admins can require all apps to deploy from Git: **Settings → Development → Apps → "Only allow app deployments from Git"**. When enabled:
- Users must configure a Git repo before creating any app
- Workspace folder deployments are blocked
- App templates are disabled
- Existing apps continue running but cannot redeploy without a Git repo

#### Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Deploy fails with credential error | SPN Git credential missing or expired | Re-create via `databricks git-credentials create` |
| Deploy succeeds but app crashes | `source_code_path` wrong (container can't find `app.yaml`) | Verify path relative to repo root |
| Auto-deploy not triggering | Webhook not registered or branch mismatch | Check GitHub → Settings → Webhooks; ensure branch matches |
| "CAN MANAGE required" error | Older app — creator lacks SPN permissions | Ask workspace admin to grant CAN MANAGE on the SPN |
| `package-lock.json` not found | Not committed to the `release` branch | Ensure lock file is committed (container needs it for reproducible installs) |

---

## Container Build Behavior

The Databricks Apps container builds with `NODE_ENV=production`:

1. `npm install` — installs `dependencies` only (skips `devDependencies`)
2. `postinstall` hook — runs `appkit generate-types || true` (non-fatal)
3. `npm run build` — runs `build:server` (`tsc -b && tsdown`)
4. `npm run start` — `node ./dist/server.js`

**Implications:**
- Build-time tools (`typescript`, `tsdown`, `tsx`, `@types/*`) MUST be in `dependencies`
- Client build tools (`vite`, `@vitejs/plugin-react`, `tailwindcss`, etc.) are ALSO in `dependencies`
- `build` script runs both server and client (`build:server && build:client`)
- Client build skips `tsc` (Vite/rolldown handles JSX) — re-enable once warehouse types are generated
- `package-lock.json` MUST be committed (container uses it for reproducible installs)

---

## Architecture

```
server/server.ts          → AppKit entry point (all modules enabled, graceful degradation)
server/api/               → Supervisor dispatch API (/api/v1) + Swagger UI (/api/docs)
server/mcp/               → Workstream MCP tools (/mcp, 39 tools, protocol 2025-11-25)
server/dispatch/          → Dispatch engine (tick polling + outbox; LISTEN/NOTIFY disabled by default)
server/memory/            → Semantic + episodic memory service (pgvector + lakebase_text)
server/telemetry/         → OTel + MLflow trace instrumentation
server/migrations/        → Lakebase schema migrations (v1-v9; v9 = dispatch.projects + FK)
shared/sdk/               → TypeScript client SDK (zero-dep, typed OrchestratorClient)
client/                   → React UI (AppKit scaffold: router, analytics, lakebase, files)
resources/                → DABs resource definitions
docs/design/              → Forward-looking research, architecture explorations, RFCs
fixtures/sessions/        → Session summaries (reverse-chronological)
```

---

## MCP Tools Reference

The `/mcp` endpoint exposes 39 JSON-RPC tools organized by category (filtered per persona via UC MCP Service `include_tool_selectors`). Tool input schemas are defined in `server/mcp/tools/` and validated at call time.

### State Tools (`server/mcp/tools/state.ts`)

Mutable, auditable state transitions with concurrency control.

| Tool | Parameters | Concurrency |
| --- | --- | --- |
| `update_workstream_status` | `project_id`, `workstream_id`, `status`, `reason` | FOR UPDATE row-lock |
| `update_task_status` | `project_id`, `execution_id`, `status`, `reason` | FOR UPDATE row-lock |
| `update_recovery_state` | `project_id`, `workstream_id`, `expected_version`, `state_data` | Optimistic (version column) |
| `start_session` | `project_id`, `workstream_id`, `metadata`? | INSERT |
| `end_session` | `project_id`, `session_id`, `expected_version` | Optimistic (version column) |

### Record Tools (`server/mcp/tools/records.ts`)

Append-only immutable records with idempotency keys (except `record_workstream_event`).

| Tool | Key Parameters | Notes |
| --- | --- | --- |
| `record_decision` | `title`, `context`, `decision`, `rationale`? | Idempotent |
| `record_session_summary` | `session_id`, `summary`, `metadata`? | Idempotent |
| `record_error` | `error_class`, `is_blocking`, `message`, `error_code`?, `stack_trace`?, `context`? | Idempotent |
| `record_workstream_event` | `event_type`, `previous_value`?, `new_value`?, `metadata`? | Append-only (no idempotency key) |
| `record_task_attempt` | `task_key`, `attempt_number`, `status`, `started_at`, `output_ref`?, `duration_ms`? | Idempotent |
| `record_task_completion` | `task_key`, `final_status`, `summary`, `artifacts_ref`?, `total_attempts`? | Idempotent |

All record tools also accept `project_id`, `workstream_id`, `session_id`?, and `idempotency_key` (where applicable).

### Context Tools (`server/mcp/tools/context.ts`)

Read-only project/workstream context, configuration, and status queries.

### Search Tools (`server/mcp/tools/search.ts`)

Semantic and keyword search over decisions, errors, events, and memory.

---

## Monitoring

**OTel tables** (in `hls_fde_dev.dev_matthew_giglia_hi_genie`):
- `hi_genie_otel_logs` — deployment + application logs
- `hi_genie_otel_metrics` — runtime metrics
- `hi_genie_otel_traces` — distributed traces (spans from dispatch, memory, tools)

**MLflow Experiment:** ID `4038008988926083` — platform-managed via app resource (`valueFrom: experiment` in `app.yaml`). Traces correlate OTel span IDs with MLflow 3 trace storage.

**App URL:** `https://mcp-hi-genie-orchestrator-dev-7474657291520070.aws.databricksapps.com`

**Health check:** `GET /api/health` returns JSON with module status (version, enabled modules). Note: `/healthz` is intercepted by the platform's liveness probe (returns empty 200) — use `/api/health` for detailed status.

**Lakebase Search:** Enabled at the project level (manual toggle — no DABs method available). Extensions must be installed per-database:

```sql
CREATE EXTENSION IF NOT EXISTS lakebase_vector CASCADE;  -- vector ANN search
CREATE EXTENSION IF NOT EXISTS lakebase_text;            -- BM25 full-text search
```

Use AppKit plugin modules (`appkit.lakebase`) for all Lakebase operations wherever possible.

---

## TypeScript Client SDK

The `shared/sdk/` package provides a typed, zero-dependency HTTP client for the Supervisor API.

### Installation

The SDK lives in-repo at `shared/sdk/`. Import directly (no npm publish needed):

```typescript
import { OrchestratorClient } from '../shared/sdk';
```

### Authentication

For M2M (service-to-service) access, obtain an OAuth token via the SPN client_credentials flow:

```typescript
const tokenResponse = await fetch(
  'https://fevm-hls-fde.cloud.databricks.com/oidc/v1/token',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: '<app_spn_client_id>',
      client_secret: '<app_spn_client_secret>',
      scope: 'all-apis',
    }),
  },
);
const { access_token } = await tokenResponse.json();
```

### Basic Usage

```typescript
import { OrchestratorClient, OrchestratorApiError } from '../shared/sdk';

const client = new OrchestratorClient({
  baseUrl: 'https://mcp-hi-genie-orchestrator-dev-7474657291520070.aws.databricksapps.com',
  token: access_token,
});

// Health check
const health = await client.health();
console.log(health.modules); // { migrations: true, mcp: true, ... }
```

### Full Lifecycle Example

```typescript
// 1. Create a plan
const { plan } = await client.plans.create({
  project_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  name: 'Sprint 42 Workstream Plan',
  description: 'Automated delivery for sprint 42',
});

// 2. Publish an immutable snapshot
const { snapshot } = await client.plans.publish(plan.plan_id, {
  content: {
    workstreams: [
      { workstream_key: 'data-ingestion', name: 'Data Ingestion', execution_tier: 0, depends_on: [], config: {} },
      { workstream_key: 'feature-eng', name: 'Feature Engineering', execution_tier: 1, depends_on: ['data-ingestion'], config: {} },
    ],
  },
  workstream_count: 2,
});

// 3. Create orchestration
const { orchestration } = await client.plans.orchestrate(plan.plan_id, {
  priority: 75,
});

// 4. Materialize workstreams
const { workstreams } = await client.workstreams.materialize(
  orchestration.orchestration_id,
  { plan_snapshot_id: snapshot.plan_snapshot_id },
);

// 5. Dispatch a workstream to a worker
const execution = await client.workstreams.dispatch(
  orchestration.orchestration_id,
  'data-ingestion',
  { worker_identity: 'worker-agent-1@databricks.com' },
);
console.log(`Execution ${execution.execution_id} started (attempt ${execution.attempt_number})`);

// 6. After work completes — create review task
const { review_task } = await client.reviews.create({
  review_task_id: crypto.randomUUID(),
  workstream_id: workstreams[0].workstream_id,
  orchestration_id: orchestration.orchestration_id,
  project_id: plan.project_id,
  execution_id: execution.execution_id,
});

// 7. Deliver remediation findings
await client.reviews.deliverRemediation(review_task.review_task_id, {
  findings: [
    { category: 'data_quality', severity: 'INFO', description: 'All assertions passed' },
  ],
  test_results: [
    { test_name: 'row_count_check', passed: true },
  ],
});

// 8. Supervisor approves → workstream transitions to COMPLETE
const approval = await client.reviews.approve(review_task.review_task_id, {
  outcome: 'PASS',
  outcome_reason: 'All quality gates met, data landed correctly',
});
console.log(`Workstream ${approval.workstream_id} → ${approval.workstream_status}`);
```

### Error Handling

```typescript
try {
  await client.plans.get('nonexistent-id');
} catch (err) {
  if (err instanceof OrchestratorApiError) {
    console.log(err.status);      // 404
    console.log(err.body.error);   // 'NOT_FOUND'
    console.log(err.body.message); // 'Plan not found'
  }
}
```

### MCP Tool Discovery

```typescript
// List all 39 registered MCP tools via REST
const catalog = await client.mcp.listTools();
console.log(`${catalog.count} tools in ${Object.keys(catalog.categories).length} categories`);
catalog.tools.forEach((t) => console.log(`  ${t.name}: ${t.description}`));
```

### Workstream Control

```typescript
// Pause a running workstream
await client.workstreams.pause(orchId, 'feature-eng', {
  reason: 'Upstream data delayed — pausing until backfill completes',
});

// Resume later
await client.workstreams.unpause(orchId, 'feature-eng');

// Retry a blocked workstream
await client.workstreams.retry(orchId, 'feature-eng', {
  reason: 'Upstream backfill complete, retrying',
});
```

---

## API Documentation (Swagger UI)

Interactive API docs are served at `/api/docs` (no auth required). The raw OpenAPI 3.1 JSON spec is available at `/api/docs/openapi.json` for tooling and code generators.

---

## Further Reference

- **[PROJECT_MEMORY.md](./PROJECT_MEMORY.md)** — persistent context for Genie Code: targets, IDs, conventions, architecture decisions, known issues
- **[fixtures/sessions/INDEX.md](./fixtures/sessions/INDEX.md)** — session summaries (reverse-chronological)
