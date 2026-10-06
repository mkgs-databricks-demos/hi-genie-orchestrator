---
module: capabilities/detection-fallback
version: 2.0.0
purpose: How to detect app availability and handle connectivity failures at session start
depends_on: [surfaces/mcp, surfaces/api]
consumed_by: [roles/supervisor, roles/worker, roles/reviewer]
---

# App Connectivity and Availability

Before doing any planning, execution, or review work, confirm that the Hi Genie
Orchestrator app is reachable and that you have the required authorization.

## Detect availability

Before using a Hi Genie surface, confirm that the configured App endpoint is reachable and that the caller has the required authorization:

- Supervisor workflows check the versioned `/api/v1` surface.
- Workstreams check the user-authorized `/mcp` surface.
- A successful process response is not sufficient if readiness, schema compatibility, or authorization fails.

Do not send planning or execution mutations to an unavailable or unready surface.

## Fallback behavior

When the App is unavailable:

1. **Do not proceed.** Do not attempt to reconstruct state locally or invent a substitute.
2. Preserve the same project, workstream, task, and session identifiers where possible.
3. Record the fallback mode and unresolved synchronization work in the session summary.
4. Do not invent a second partially-compatible state contract.



## Reconciliation

Controlled dual-write or export is allowed only when the owning Supervisor process defines the reconciliation rule. The process must identify the authoritative record, detect conflicts, and publish an auditable result before the data is treated as synchronized.

Workers must not silently write to both systems or mark work complete in the file-based protocol when the Hi Genie review gate is authoritative. In Hi Genie, workers submit `READY_FOR_REVIEW`; only the supervisor-authorized path may mark `COMPLETE`.
