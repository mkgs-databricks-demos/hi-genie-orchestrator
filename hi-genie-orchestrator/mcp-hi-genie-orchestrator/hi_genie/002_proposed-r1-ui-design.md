# Proposed Release 1 UI Design

## Round 1

**Date:** 2026-08-19
**Type:** SUGGESTION
**Priority:** MEDIUM

### References

| File | Location | Description |
| --- | --- | --- |
| `architecture/proposed-r1-ui-design.md` | Entire document | Proposed Release 1 information architecture, visual system, themes, UX, accessibility, API boundaries, and implementation scope |
| `architecture/release-1-readiness-review.md` | Release 1 findings | Current implementation readiness constraints that the UI should respect |
| `.review-protocol/SKILL.md` | Scope and authority boundary | Polly recommends; Genie owns application source and bundle implementation |

### Current State

Polly has written the proposed Release 1 UI design at:

`architecture/proposed-r1-ui-design.md`

The proposal treats the React frontend as a read-only operational read model for Release 1. It covers the overview, workstream list and detail, dependency DAG, reviews, sessions, system health, light and dark themes, accessibility, responsive behavior, and bounded same-origin backend-for-frontend APIs.

### Recommendation

Please review the proposed UI design with me before implementation begins. If the design is accepted, start UI implementation in a new stacked feature branch based on this branch, for example:

`feature/hi-genie-orchestrator-ui`

The primary implementation scope is:

- `mcp-hi-genie-orchestrator/client/src/`
- `mcp-hi-genie-orchestrator/client/public/` when static assets are needed
- Client configuration files only when required for the agreed theme, build, or asset behavior
- The backend-for-frontend route and shared-type locations identified in the proposal, when required to support the UI read models
- Relevant UI and BFF tests, while preserving the documented source ownership boundaries

Polly’s documentation-only review scope before implementation is limited to:

- `mcp-hi-genie-orchestrator/architecture/`
- `mcp-hi-genie-orchestrator/hi_genie/`
- `.review-protocol/debate_state.json`

Polly will not edit `client/`, `server/`, `shared/`, bundle resources, deployment configuration, or tests. Genie should implement those changes in the stacked UI branch.

### Rationale

A stacked UI branch keeps the approved architecture and the UI implementation separable while preserving this design checkpoint as the implementation baseline. The Release 1 proposal deliberately prioritizes observability and comprehension over control, so the first UI should not become a second Dispatcher or expose privileged mutations.

The design also keeps the React client behind same-origin, authorization-filtered read models. It does not allow direct Lakebase, MCP, Databricks Jobs, or workspace API access from the browser.

### Expected Impact

- Gives Genie a concrete UI baseline before source changes begin.
- Keeps Release 1 read-only and aligned with Supervisor authorization boundaries.
- Provides a clear folder and ownership boundary for the stacked implementation branch.
- Makes light/dark themes, accessibility, graph alternatives, bounded data, and freshness behavior explicit acceptance criteria.
- Preserves the option to add planning authoring and privileged controls in Release 1.1 without redesigning the operational read model.
