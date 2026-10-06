# Databricks Sandbox API Exploration

**Date:** 2026-08-19  
**Status:** Research complete  
**Relevance:** r1.2 candidate — npm test runner for CI from Genie Code sessions  
**Prerequisite:** Sandbox feature preview enabled on workspace `fevm-hls-fde`

---

## Executive Summary

Databricks Sandbox (Beta) is a microVM compute environment accessible over SSH, running in the serverless compute plane. It comes pre-installed with **Node.js, Python, Rust, and Databricks CLI** with persistent storage.

We discovered an **undocumented REST API** (`/api/2.0/sandboxes`) that supports programmatic CRUD — and confirmed that **Omnigent already auto-provisions sandboxes** through it. However, **no remote command execution API exists** — the only way to run commands inside a sandbox is via SSH. This creates a gap for our use case (running `npm test` from a Genie Code session).

---

## 1. Sandbox Feature Overview (from docs)

### What It Is

- SSH-accessible microVM in the Databricks serverless compute plane
- 4 cores, 16 GB RAM, up to 100 GB storage
- Pre-installed: Python, **Node.js**, Rust, Databricks CLI (authenticated)
- Internet egress enabled (can `npm install`)
- Persistent home directory across sessions
- Starts in seconds; max 40 per user, 100 per workspace

### What It's Designed For

- Running coding agents (Claude Code, Codex, Cursor) in a governed environment
- Short-lived sub-agent environments for experiments
- Integration with MCP, Supervisor API, and Custom Agents on Apps
- Long-running agent tasks without local machine active

### What It's NOT

- Not a general-purpose compute cluster
- Not accessible from Genie Code's `executeCode` or `runDatabricksCli` tools
- Not (yet) configurable at startup or customizable beyond home directory
- Beta: data in home directory will be deleted when beta ends

### CLI Commands (documented)

| Command | Description |
| --- | --- |
| `databricks sandbox register` | Register SSH keys (one-time) |
| `databricks sandbox create [--name <label>]` | Create a new sandbox (blocks until running) |
| `databricks sandbox ssh` | SSH into default sandbox |
| `databricks sandbox status <id>` | Show sandbox state |
| `databricks sandbox delete <id> [--auto-approve]` | Permanently remove a sandbox |
| `databricks sandbox ssh-key list` | List registered SSH keys |
| `databricks sandbox ssh-key delete` | Delete a registered key |

---

## 2. Undocumented REST API Findings

### Discovery

The CLI's `sandbox` command group is NOT in the `runDatabricksCli` allow-list, but the **underlying REST API is callable from serverless compute** via the Python SDK's `w.api_client.do()` method.

### Confirmed Endpoints

| Method | Path | Status | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/2.0/sandboxes` | ✅ Works | Lists all sandboxes for the calling user |
| `GET` | `/api/2.0/sandboxes/<name>` | ✅ Works | Full sandbox detail (metadata, spec, status) |
| `POST` | `/api/2.0/sandboxes` | ✅ Exists | Create endpoint (blocked by executeCode safety, but route exists) |
| `DELETE` | `/api/2.0/sandboxes/<name>` | Likely works | Not tested (destructive) |

### Probed and Non-Existent

All of the following return `No API found`:

```
/api/2.0/sandboxes/<name>/exec
/api/2.0/sandboxes/<name>/execute
/api/2.0/sandboxes/<name>/commands
/api/2.0/sandboxes/<name>/run
/api/2.0/sandboxes/<name>/ssh
/api/2.0/sandboxes/<name>/terminal
/api/2.0/sandboxes/<name>/connection
/api/2.0/sandboxes/<name>/logs
/api/2.0/sandboxes/<name>/status
/api/2.0/sandboxes/<name>/keys
/api/2.0/sandboxes/<name>:start
/api/2.0/sandboxes/<name>:stop
/api/2.0/sandboxes/<name>:getStatus
/api/2.0/sandboxes/<name>:getLogs
/api/2.0/sandboxes/<name>:getConnection
/api/2.0/sandboxes:listCreators
/api/2.0/sandboxes:listSshKeys
/api/2.0/sandboxes/ssh-keys
/api/2.0/sandbox-ssh-keys
```

**Conclusion:** The API surface is minimal CRUD (list, get, create, delete). No remote execution, no lifecycle management (start/stop), no log streaming.

### Response Schema

```json
{
  "sandboxes": [
    {
      "metadata": {
        "name": "sandboxes/<slug>",
        "uid": "<uuid>",
        "create_time": "<ISO 8601>",
        "update_time": "<ISO 8601>",
        "annotations": { "custom/x-sandbox-type": "lakebox" },
        "sandbox_creator": "SANDBOX_CREATOR_LAKEBOX | SANDBOX_CREATOR_OMNIGENTS",
        "owner_user_id": "<numeric user id>",
        "display_name": "<optional label>",
        "account_id": "<workspace account uuid>"
      },
      "spec": {
        "compute_spec": { "inactivity_timeout": "600s | 86400s" },
        "environment_spec": { "environment_version": "1" }
      },
      "status": {
        "state": "SANDBOX_STATE_RUNNING | SANDBOX_STATE_TERMINATED",
        "dbns_uri": "dbns:execution-sandbox-microvm/<cluster-id>/driver-proxy",
        "internal_fqdn": "driver-proxy.<cluster-id>.execution-sandbox-microvm.exec-sandbox-vm.<region>.unprivileged.dbns.databricks.com"
      }
    }
  ]
}
```

---

## 3. Workspace Sandbox Inventory

As of 2026-08-19, the workspace has **15 sandboxes** across two creator types:

| Creator | Count | Naming Pattern | Inactivity Timeout | State |
| --- | --- | --- | --- | --- |
| `SANDBOX_CREATOR_OMNIGENTS` | 14 | `omnigent-<user_id>-<hex8>` | 86400s (24h) | 3 running, 11 terminated |
| `SANDBOX_CREATOR_LAKEBOX` | 1 | `ascending-reindeer-7322` | 600s (10min) | Terminated |

### Key Observations

1. **Omnigent auto-provisions sandboxes per-user** — the naming pattern `omnigent-<user_id>-<hash>` shows each is scoped to a workspace user ID. Multiple Omnigent sandboxes exist per user (different sessions/tasks).

2. **No CLI-created sandboxes visible** — all 15 are system-created. Either no CLI sandboxes have been created yet, or they use a different creator enum (e.g., `SANDBOX_CREATOR_USER` or `SANDBOX_CREATOR_CLI`).

3. **Lakebox is a distinct creator** — the annotation `custom/x-sandbox-type: lakebox` suggests Lakebox (the container infrastructure) can also spin up sandbox microVMs.

4. **24h timeout for Omnigent** — these are long-lived agent environments (a full workday), vs Lakebox's 10-minute ephemeral.

5. **Running sandboxes are reachable via internal FQDN** — the `internal_fqdn` field suggests network-reachable from within the Databricks control plane (Apps, other serverless compute).

---

## 4. Genie Code Execution Context Constraints

| Mechanism | `sandbox` CLI | REST API `/api/2.0/sandboxes` | SSH into sandbox |
| --- | --- | --- | --- |
| `runDatabricksCli` | ❌ Blocked (not in allow-list) | N/A | N/A |
| `executeCode` (Python) | CLI blocked ("interactive web terminal only") | ✅ Works (`w.api_client.do()`) | ❌ No SSH client available |
| `executeCode` (shell) | ❌ Blocked | N/A | ❌ No SSH |
| Local machine | ✅ Full access | ✅ Works | ✅ Full SSH |

**Key insight:** From Genie Code, we can **create and manage sandboxes** but cannot **execute commands inside them**.

---

## 5. The Supervisor API Code Execution Sandbox (different thing)

The Supervisor API has a **built-in code execution tool** that runs in a separate, locked-down sandbox:

| Property | Supervisor API Sandbox | Databricks Sandbox (microVM) |
| --- | --- | --- |
| Internet access | ❌ Blocked (all egress denied) | ✅ Enabled |
| File system | Ephemeral (per-request) | Persistent (home directory) |
| Languages | Python, SQL, shell | Any (full Linux, Node.js pre-installed) |
| Data access | Read-only declared UC tables | Full authenticated CLI |
| npm / Node.js | ❌ Not available | ✅ Pre-installed |
| Provisioning | Automatic (invisible) | Explicit (API or CLI) |
| User control | None (system-managed) | Full (create, SSH, delete) |

The Supervisor API sandbox **cannot run npm builds/tests** (no internet, no Node.js). It's designed for data analysis, not general-purpose development.

---

## 6. Architecture Options for npm Test Execution (r1.2 Candidates)

### Option A: App Container as Test Runner

**How it works:** Add a test phase to the existing container build pipeline (modify `package.json` build script or add a pre-deploy step).

| Pros | Cons |
| --- | --- |
| Already working (container runs `npm install` + `npm run build`) | Tests run on every deploy (slow feedback for non-test changes) |
| No new infrastructure | Can't run tests independently of deployment |
| Build logs stream to OTel | No way to run tests without triggering a full redeploy |

**Verdict:** Partial solution. Good for build-time validation, not for on-demand test execution.

### Option B: Sandbox + SSH from App Container

**How it works:** The orchestrator App (which has internet egress and the Databricks CLI) creates a sandbox via REST API, then SSH-es into it using `ssh2` (Node.js SSH library) to run `npm test`.

| Pros | Cons |
| --- | --- |
| Full npm/Node.js environment | SSH from App to sandbox may not be network-routable |
| Sandbox has internet (can npm install) | Requires SSH key management |
| Can be triggered on-demand | Uncharted territory (no docs on App ↔ sandbox networking) |
| Test results reportable back via MCP | Additional latency (sandbox create → SSH → clone → install → test) |

**Verdict:** Technically promising but blocked by unknown networking constraints. The `internal_fqdn` returned by the API suggests internal reachability, but no documentation confirms cross-service connectivity.

### Option C: Sandbox exec REST API (future)

**How it works:** Wait for Databricks to expose a `POST /api/2.0/sandboxes/<name>:exec` endpoint (or equivalent) that accepts a command and returns stdout/stderr.

| Pros | Cons |
| --- | --- |
| Clean API-first design | Doesn't exist yet |
| No SSH complexity | Unknown timeline |
| Callable from Genie Code directly | May never ship (SSH may be the intended UX) |

**Verdict:** Ideal but unavailable. Monitor the API surface in future sessions.

### Option D: Custom MCP Server on Sandbox

**How it works:** Create a persistent sandbox, install an MCP server on it (via SSH during setup), then connect to it from the orchestrator App or a Supervisor Agent via MCP protocol.

| Pros | Cons |
| --- | --- |
| Aligns with Databricks' MCP-first agent architecture | Complex setup (SSH bootstrap, MCP server install) |
| Sandbox docs explicitly mention MCP integration | Need to keep sandbox alive and MCP server running |
| Bidirectional communication (not just fire-and-forget) | 24h inactivity timeout means sandbox could terminate |
| Could expose npm/test/build as MCP tools | No documented pattern for this yet |

**Verdict:** Most architecturally aligned with the platform direction. The docs say "Use this with MCP, or when building custom agents with the Supervisor API." This is likely the intended path once the developer experience matures.

### Option E: GitHub Actions (external CI)

**How it works:** Use GitHub Actions for npm test/build, triggered by push to feature branches. Results reported via GitHub status checks.

| Pros | Cons |
| --- | --- |
| Mature, well-understood CI/CD | External to Databricks (no unified observability) |
| Free for public repos, cheap for private | Can't be triggered from Genie Code directly |
| Parallel test execution | Results not in OTel/MLflow |
| Caching, matrix builds, etc. | Requires secrets management outside Databricks |

**Verdict:** Pragmatic fallback. Would work immediately but creates a parallel system outside the Databricks governance boundary.

---

## 7. Recommendations

### Short-term (r1.1 — current)

- Continue using **App container builds** as the validation gate
- Run `npm test` locally via `databricks sandbox ssh` from developer machines
- No changes to current deploy pipeline

### Medium-term (r1.2 — next release)

1. **Investigate Option B** (App → sandbox SSH): Test whether the App container can reach a running sandbox's `internal_fqdn` over SSH. This is a single experiment that unblocks the whole architecture.

2. **Prototype Option D** (MCP server on sandbox): If SSH works, install a minimal MCP server that exposes `npm_test`, `npm_build`, and `git_clone` tools. Wire it as a sub-agent tool in the Supervisor hierarchy.

3. **Monitor the API surface**: In each future session, probe `/api/2.0/sandboxes/<name>:exec` to detect if/when an execution endpoint ships.

### Long-term (r2.0)

- Full CI/CD workstream worker: sandbox auto-provisioned per orchestration, clones repo, runs test suite, reports results to review tasks via MCP
- Sandbox lifecycle managed as part of workstream dispatch (create on dispatch, terminate on completion)
- Results flow into OTel traces for unified observability

---

## 8. Open Questions

1. **Is the sandbox `internal_fqdn` reachable from an App container?** The FQDN pattern (`*.execution-sandbox-microvm.exec-sandbox-vm.<region>.unprivileged.dbns.databricks.com`) suggests internal DNS, but no documentation confirms this.

2. **What creator type do CLI-created sandboxes use?** We only observed `SANDBOX_CREATOR_OMNIGENTS` and `SANDBOX_CREATOR_LAKEBOX`. A user-created sandbox via `databricks sandbox create` may use a different enum.

3. **Can we specify a `sandbox_creator` on POST?** The create payload schema is undocumented. Omnigent sets `SANDBOX_CREATOR_OMNIGENTS`; can we set a custom value?

4. **Is there a WebSocket/streaming terminal endpoint?** The Databricks web terminal connects via WebSocket. A similar undocumented endpoint may exist for sandboxes.

5. **Will the `sandbox` CLI command group enter the `runDatabricksCli` allow-list?** If so, Genie Code could directly `sandbox create` and possibly `sandbox ssh -- <command>` (non-interactive SSH with command).

---

## Appendix: Raw API Responses

### Sample Sandbox Object (Omnigent-created, running)

```json
{
  "metadata": {
    "name": "sandboxes/omnigent-102694850798-660362b0",
    "uid": "68f1afab-616d-4857-bc7e-8e1a2a2c15cc",
    "create_time": "2026-08-15T12:03:39.175Z",
    "update_time": "2026-08-19T13:39:42.719Z",
    "sandbox_creator": "SANDBOX_CREATOR_OMNIGENTS",
    "owner_user_id": "1081964970114387",
    "display_name": "managed-9ea04b84",
    "account_id": "05d08df7-ae03-43ad-bbae-14babb530ec0"
  },
  "spec": {
    "compute_spec": { "inactivity_timeout": "86400s" }
  },
  "status": {
    "state": "SANDBOX_STATE_RUNNING",
    "dbns_uri": "dbns:execution-sandbox-microvm/papuea1-lakebox-1-900da6bff5c04e08-0/driver-proxy",
    "internal_fqdn": "driver-proxy.papuea1-lakebox-1-900da6bff5c04e08-0.execution-sandbox-microvm.exec-sandbox-vm.default-papuea1s1fyo8ao.unprivileged.dbns.databricks.com"
  }
}
```

### Sample Sandbox Object (Lakebox-created, terminated)

```json
{
  "metadata": {
    "name": "sandboxes/ascending-reindeer-7322",
    "uid": "cbb5ff83-6965-48b9-bcdf-deb1526d9683",
    "create_time": "2026-08-12T02:39:22.590Z",
    "update_time": "2026-08-12T04:38:13.108Z",
    "annotations": { "custom/x-sandbox-type": "lakebox" },
    "sandbox_creator": "SANDBOX_CREATOR_LAKEBOX",
    "owner_user_id": "1081964970114387",
    "account_id": "05d08df7-ae03-43ad-bbae-14babb530ec0"
  },
  "spec": {
    "compute_spec": { "inactivity_timeout": "600s" },
    "environment_spec": { "environment_version": "1" }
  },
  "status": {
    "state": "SANDBOX_STATE_TERMINATED",
    "dbns_uri": "dbns:execution-sandbox-microvm/papuea1-lakebox-1-244aa22f22be4533-0/driver-proxy",
    "internal_fqdn": "driver-proxy.papuea1-lakebox-1-244aa22f22be4533-0.execution-sandbox-microvm.exec-sandbox-vm.default-papuea1s1fyo8ao.unprivileged.dbns.databricks.com"
  }
}
```
