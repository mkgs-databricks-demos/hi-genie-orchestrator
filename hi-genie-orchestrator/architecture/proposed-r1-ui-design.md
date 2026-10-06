# Proposed Release 1 UI Design

**Status:** Proposed for review  
**Scope:** `mcp-hi-genie-orchestrator` React frontend  
**Release:** 1  
**Last updated:** 2026-08-19

## 1. Design Intent

The Release 1 frontend should be a calm, operational read model for understanding what Hi Genie is doing. It should help a user answer four questions quickly:

1. What is the current orchestration status?
2. Which workstreams are blocked, active, waiting for review, or complete?
3. What evidence, summaries, and review findings explain that status?
4. What requires attention next?

Release 1 should prioritize **observability and comprehension over control**. The UI should not become a second Dispatcher, planning editor, or database console. Dispatch, retry, pause, completion, configuration writes, and other privileged mutations remain behind the Supervisor API and its authorization policy.

## 2. Release 1 Scope

### In scope

- Read-only orchestration overview.
- Dependency DAG visualization.
- Workstream status and completion summaries.
- Workstream detail and bounded session-summary drill-down.
- Review status, findings, remediation status, and evidence summaries.
- Active blocker and dependency views.
- Health, schema version, and telemetry-readiness indicators.
- Effective runtime configuration and configuration-history visibility for authorized users, without editing.
- Responsive layout for desktop and tablet widths.
- Accessible light and dark themes.

### Deferred to Release 1.1 or later

- Planning authoring boards for requirements, questions, decisions, and features.
- Plan publication or materialization actions.
- Dispatch, retry, pause, resume, reset, or completion actions from the UI.
- Runtime configuration editing.
- Cross-project planning and memory views.
- Rich agent-handoff and Omnigent activity views.
- Live push updates if the initial polling model is sufficient.

## 3. Information Architecture

Use a small, stable navigation model:

- **Overview** — orchestration summary, attention queue, and recent activity.
- **Workstreams** — searchable/filterable list of workstreams.
- **Graph** — dependency DAG with status-aware nodes and an accessible list alternative.
- **Reviews** — review queue, findings, remediation, and evidence summaries.
- **Sessions** — bounded session summaries and handoff context.
- **System** — health, schema version, telemetry readiness, and read-only configuration history.

The selected project and orchestration should remain visible in the application shell. Scope must never be implicit; display `project_id`, orchestration identifier, and the active environment in the header or scope bar.

## 4. Primary Screens

### Overview

The Overview is the default landing page. It should contain:

- A compact status summary: total, active, blocked, ready for review, and complete.
- Completion percentage based on persisted workstream state, not client-side guesses.
- An attention queue ordered by blocking severity and dependency impact.
- A small “recent activity” list linking to events, reviews, and session summaries.
- A health strip showing API, Lakebase, migration/schema, and telemetry readiness.

Do not use a dashboard wall of equal-weight cards. The first viewport should make blockers and review-pending work more prominent than historical metrics.

### Workstream list

Provide:

- Search by name, key, or identifier.
- Filters for status, execution tier, owner, review state, and dependency state.
- Sort by attention, status, last update, or execution tier.
- Bounded pagination.
- Clear badges for `READY_FOR_REVIEW`, `UNDER_REVIEW`, `FIX_REQUIRED`, `BLOCKED_BY_DEPENDENCY`, `BLOCKED`, and `COMPLETE`.

Each row should show the workstream key, short title, status, dependency summary, latest attempt, review state, and last updated time.

### Workstream detail

Use a two-column desktop layout that collapses to one column on smaller screens:

- **Summary:** goal, status, execution tier, dependencies, timestamps, and completion rationale.
- **Progress:** current task/attempt information and bounded progress indicators.
- **Reviews:** latest verdict, open findings, severity, remediation owner, and evidence freshness.
- **Sessions:** recent session summaries with timestamps and actor/execution identity.
- **Artifacts and evidence:** references, versions, checks, and validation results; never raw secrets or unrestricted payloads.
- **History:** immutable state changes, attempts, review events, and remediation events.

The detail page should preserve the distinction between worker-submitted evidence and independently generated review evidence.

### Graph

The graph is a dependency view, not a free-form editing canvas in Release 1.

- Nodes represent workstreams.
- Edges represent persisted `depends_on` relationships.
- Node color, icon, and label communicate state redundantly.
- Selecting a node opens a side panel with summary and navigation to detail.
- Provide zoom, pan, fit-to-view, and a reset control.
- Offer filters for execution tier, status, and dependency impact.
- Avoid rendering unbounded session or task detail inside the graph.

The graph must have an accessible table/list mode containing the same nodes, statuses, and dependency relationships. Keyboard users must not need pointer-based graph interaction to understand the orchestration.

### Reviews

The Reviews screen should emphasize what is waiting and why:

- Review tasks by lifecycle state and lease status.
- Findings grouped by workstream and review attempt.
- Severity (`BLOCKING`, `REQUIRED_FIX`, `ADVISORY`).
- Required action and remediation status.
- Evidence freshness and reviewed artifact/version.
- Reviewer identity/type and timestamps.
- Links to the originating workstream and related remediation attempt.

The UI may display a “review recommended” or “remediation required” callout, but it must not imply that viewing a finding changes its state.

### Sessions

Show bounded summaries only:

- Session identifier, actor/execution identity, workstream, start/end time, and outcome.
- Summary text with redaction applied by the backend.
- Decisions, errors, artifacts, and next steps linked as structured records.
- No raw conversation transcript by default.

### System

The System screen is read-only in Release 1:

- Liveness/readiness state.
- Lakebase connection and schema version.
- Migration status.
- OpenTelemetry and MLflow trace export readiness.
- Effective global runtime settings.
- Configuration version and immutable change history.

Do not expose tokens, connection strings, SQL literals, secret names that reveal credentials, or unrestricted operational payloads.

## 5. Visual System

### Design direction

Use a restrained Databricks-native visual language: neutral surfaces, strong information hierarchy, compact data density, and status accents used sparingly. The UI should feel like an operational control room without imitating a monitoring product full of saturated colors.

### Color tokens

Define semantic tokens rather than hard-coding colors in components:

- `--color-bg`: warm or cool neutral page background.
- `--color-surface`: elevated card and panel surface.
- `--color-surface-muted`: secondary table and graph surface.
- `--color-text`: primary text.
- `--color-text-muted`: timestamps and supporting labels.
- `--color-border`: low-contrast separators.
- `--color-accent`: Hi Genie brand/action accent.
- `--color-info`: informational state.
- `--color-success`: complete/healthy.
- `--color-warning`: review pending or attention needed.
- `--color-danger`: blocked, failed, or blocking finding.

Recommended status semantics:

- **Complete/healthy:** teal or green accent.
- **Active/in progress:** blue accent.
- **Ready for review:** amber accent.
- **Required fix:** orange accent.
- **Blocked/blocking:** red accent.
- **Paused/not started:** neutral gray.

Status must never be conveyed by color alone. Pair color with text, iconography, and accessible labels.

### Themes

Support light and dark themes from the first UI implementation:

- Default to the operating-system preference.
- Allow an explicit user preference.
- Persist only the theme preference locally; do not persist authorization or project scope in client storage.
- Ensure graph edges, focus rings, charts, and badges meet contrast requirements in both themes.
- Avoid pure black backgrounds and pure white text; use layered neutral surfaces for hierarchy.

### Typography and density

- Use the AppKit/UI system font stack already established by the scaffold.
- Use a clear type scale with one prominent page title and restrained section headings.
- Prefer compact tables with comfortable row height and strong hover/focus states.
- Keep timestamps and identifiers visually subordinate but easy to copy.
- Use monospace only for IDs, commit SHAs, versions, and technical values.

## 6. UX and Interaction Principles

- **Scope first:** every data view displays its project and orchestration scope.
- **Read-only clarity:** controls that do not mutate state should look different from future privileged actions.
- **Explain status:** every non-terminal state has a human-readable reason and a link to supporting evidence.
- **Progressive disclosure:** show summaries first; reveal history and evidence on demand.
- **Safe loading:** use skeletons for initial loads and explicit stale-data indicators for refresh failures.
- **Bounded data:** paginate and cap session summaries, findings, and event history.
- **Deep links:** every workstream, review, finding, and session summary should have a stable URL.
- **Refresh:** support explicit refresh and a conservative polling interval; show the last successful refresh time.
- **Errors:** distinguish authorization failure, unavailable dependency, stale data, and empty results.
- **No false authority:** the UI must not suggest that a displayed review or recommendation has approved completion.

## 7. Accessibility Requirements

- Meet WCAG 2.2 AA for the implemented surface.
- Full keyboard navigation and visible focus indicators.
- Semantic headings, landmarks, tables, buttons, and links.
- Accessible graph alternative with equivalent dependency information.
- Screen-reader labels for status, severity, freshness, and health indicators.
- Respect reduced-motion preferences; do not animate graph layout continuously.
- Ensure dialogs, drawers, tooltips, and dropdowns are keyboard and screen-reader usable.
- Use live regions sparingly for refresh or health changes.
- Maintain usable layout at 200% zoom.

## 8. Data and API Boundaries

The React client must call same-origin backend-for-frontend read models under the app API. It must not access Lakebase, MCP tools, Databricks Jobs, or workspace APIs directly.

Initial read-model groups:

- `/api/v1/ui/overview`
- `/api/v1/ui/orchestrations/{id}/graph`
- `/api/v1/ui/workstreams`
- `/api/v1/ui/workstreams/{id}`
- `/api/v1/ui/workstreams/{id}/sessions`
- `/api/v1/ui/reviews`
- `/api/v1/ui/system`

Responses should be authorization-filtered, bounded, redacted, and include correlation metadata plus a last-updated timestamp. The client should not infer completion, dependency readiness, or review validity from partial records.

## 9. App-Bundle Folders Required for UI Implementation

No UI source changes are required to review this proposal. When implementation begins, the expected write scope is:

### Primary UI folders

- `mcp-hi-genie-orchestrator/client/src/`
  - React routes, pages, components, state/query hooks, graph rendering, accessibility behavior, and UI tests.
- `mcp-hi-genie-orchestrator/client/public/`
  - Only if product icons, manifest metadata, or static assets need updating.

### Shared UI configuration

- `mcp-hi-genie-orchestrator/client/index.html`
- `mcp-hi-genie-orchestrator/client/tailwind.config.ts`
- `mcp-hi-genie-orchestrator/client/postcss.config.js`
- `mcp-hi-genie-orchestrator/client/components.json`
- `mcp-hi-genie-orchestrator/client/vite.config.ts`
- `mcp-hi-genie-orchestrator/client/src/index.css`

These should be touched only when needed for theme tokens, component configuration, asset loading, or build behavior.

### Backend-for-frontend folders

- `mcp-hi-genie-orchestrator/server/api/routes/`
- `mcp-hi-genie-orchestrator/server/routes/`
- `mcp-hi-genie-orchestrator/shared/`

These are required for same-origin UI read models, shared response types, pagination contracts, and redaction-safe serialization. UI work must not bypass these boundaries by querying Lakebase or MCP directly.

### Test and documentation scope

- `mcp-hi-genie-orchestrator/tests/` for browser smoke tests and UI integration tests.
- `hi-genie-orchestrator/architecture/` for approved UI requirements and decisions.

### Folders that should remain out of UI work

- `hi-genie-infra/` — platform bundle and Lakebase infrastructure.
- `hi-genie-sdk/` — Supervisor SDK, unless a deliberate shared contract change is approved.
- `server/migrations/` — no UI-driven schema changes.
- `.review-protocol/`, `hi_genie/`, and `hey_polly/` — collaboration channels, not application UI.
- `server/dispatch/` and `server/mcp/` — only change when a separately approved API contract requires it; UI implementation should consume existing read models.

## 10. Recommended Implementation Order

1. Confirm the read-model contracts and authorization behavior.
2. Establish semantic theme tokens and global layout shell.
3. Implement Overview and Workstream list with loading, empty, error, and stale states.
4. Implement Workstream detail and review/evidence panels.
5. Implement the DAG with the accessible list alternative.
6. Add Sessions and System views.
7. Add browser smoke tests for navigation, scope display, status rendering, and accessibility basics.
8. Validate light/dark themes and responsive behavior.

## 11. Open Design Questions

These do not block reviewing the visual direction but should be resolved before implementation:

- Should the Hi Genie accent use a branded orange/amber or a cooler blue/teal accent?
- Which AppKit graph/visualization component, if any, is approved for the DAG?
- Should the initial refresh model use polling only, or add server-sent updates later?
- Which project/orchestration selector behavior is preferred when a user has access to multiple scopes?
- Should System configuration history be visible to all authorized users or only configuration administrators?

## Recommendation

Proceed with a **read-only, operations-first Release 1 UI** using semantic tokens, accessible light/dark themes, a status-aware DAG plus equivalent list view, and same-origin backend-for-frontend read models. Keep privileged actions and planning authoring outside the initial UI implementation until the underlying API and authorization contracts are proven.
