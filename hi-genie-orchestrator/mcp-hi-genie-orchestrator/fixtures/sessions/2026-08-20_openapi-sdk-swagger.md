# Session: OpenAPI Spec, Swagger UI, MCP Catalog REST, TypeScript SDK

**Date:** 2026-08-20  
**Branch:** `mg-genie-openapi-sdk-swagger`  
**Commit:** `6de60a6`  
**Deployment:** `01f19c65a061168ab8c8a1303ebe47f5` (SUCCEEDED)

---

## Objective

Add developer-facing API documentation and a typed TypeScript client SDK:
1. OpenAPI 3.1.0 specification covering all 14 API + 2 discovery endpoints
2. Interactive Swagger UI at `/api/docs`
3. MCP tool catalog REST endpoint at `/api/v1/mcp/tools`
4. Zero-dependency TypeScript client SDK in `shared/sdk/`
5. Unit tests for all new modules
6. SDK usage examples in README

---

## Problems Encountered

### 1. TypeScript build errors (TS2345)
**Root cause:** `req.params.toolName` resolves to `string | string[]` in newer Express types.  
**Fix:** Use generic `Request<{ toolName: string }>` to narrow the param type.

### 2. `dist/api/docs.js` emitted as empty stub (0.04 kB)
**Root cause:** `tsdown` unbundle mode with `external` function couldn't properly emit `import swaggerUi from 'swagger-ui-express'` (CJS module in ESM project). The default import was tree-shaken because rolldown treated the CJS interop as side-effect-free.  
**Fix:** Replaced with `createRequire(import.meta.url)` — a Node.js built-in that resolves CJS modules correctly in ESM contexts and survives tree-shaking.

### 3. Routes returning 404 despite build success
**Root cause:** `setupDocs(app)` and `app.use('/api/v1/mcp', mcpCatalogRoutes)` were **imported** in `api/index.ts` but never **called** inside `appkit.server.extend()`. The barrel exported them for downstream consumption but the actual route mounting was missing.  
**Fix:** Added `setupDocs(app)` (before identity middleware, so docs don't require auth) and `app.use('/api/v1/mcp', mcpCatalogRoutes)` inside the extend callback.

### 4. App crash on invalid UUID (pre-existing)
**Observation:** `GET /api/v1/plans/test` (non-UUID) triggers unhandled postgres error that crashes the Node process. Pre-existing issue — not introduced in this session. Filed mentally as future hardening work.

---

## Files Created

| File | ID | Purpose |
| --- | --- | --- |
| `server/api/openapi.ts` | `4038008988926515` | OpenAPI 3.1 spec (16 paths, 17 schemas) |
| `server/api/docs.ts` | `4038008988926516` | Swagger UI mount (createRequire for CJS) |
| `server/api/routes/mcp-catalog.ts` | `4038008988926517` | REST tool catalog (GET /tools, GET /tools/:name) |
| `shared/sdk/types.ts` | `4038008988926519` | All request/response TypeScript types |
| `shared/sdk/client.ts` | `4038008988926520` | OrchestratorClient with sub-clients |
| `shared/sdk/index.ts` | `4038008988926521` | Barrel export |
| `shared/sdk/client.test.ts` | `4038008988926695` | Vitest: SDK client tests (27 cases) |
| `server/api/openapi.test.ts` | `4038008988926696` | Vitest: OpenAPI spec validation |
| `server/api/routes/mcp-catalog.test.ts` | `4038008988926697` | Vitest: MCP catalog route tests |

## Files Modified

| File | Changes |
| --- | --- |
| `server/api/index.ts` | Import + call `setupDocs`, `createMcpCatalogRoutes` inside extend |
| `package.json` | Add `@types/swagger-ui-express` to dependencies |
| `README.md` | SDK Usage section, Swagger UI docs reference |

---

## Decisions

1. **Swagger UI before identity middleware** — `/api/docs` doesn't require verified identity (read-only public docs). Mounted before `requireVerifiedIdentity`.
2. **MCP catalog behind identity middleware** — `/api/v1/mcp/tools` sits under `/api/v1` and goes through auth (consistent with other `/api/v1` routes).
3. **`createRequire` over ESM import** — CJS interop via `createRequire` is the only reliable pattern for `swagger-ui-express` in an ESM project bundled with tsdown unbundle mode.
4. **`@types/swagger-ui-express` in `dependencies`** — Container builds with `NODE_ENV=production` install only `dependencies`, not `devDependencies`. TypeScript compilation happens inside the container, so type packages must be in `dependencies`.

---

## Verification

| Endpoint | Status | Details |
| --- | --- | --- |
| `GET /api/health` | ✅ 200 | All 6 modules healthy |
| `GET /api/docs` | ✅ 200 | Swagger UI HTML (3.1 kB) |
| `GET /api/docs/openapi.json` | ✅ 200 | OpenAPI 3.1.0, 16 paths, 17 schemas |
| `GET /api/v1/mcp/tools` | ✅ 200 | 22 tools, 4 categories |
| `GET /api/v1/mcp/tools/get_project_context` | ✅ 200 | category=context, invocation_example correct |

---

## Next Steps

- Run vitest locally (Node.js not available on serverless compute)
- Harden UUID validation in route handlers (prevent crash on invalid UUID)
- Consider adding `shared/sdk/index.ts` barrel content
- PR review and merge
