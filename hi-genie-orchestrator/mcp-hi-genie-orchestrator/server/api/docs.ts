/**
 * Swagger UI — Interactive API Documentation
 *
 * Serves the OpenAPI 3.1 spec via Swagger UI at /api/docs.
 * Uses swagger-ui-express for the interactive explorer.
 *
 * Usage (from server/api/index.ts):
 *   import { setupDocs } from './docs.js';
 *   setupDocs(app);
 */

import type { Express } from 'express';
import { createRequire } from 'node:module';
import { openApiSpec } from './openapi.js';

const require = createRequire(import.meta.url);

/**
 * Mounts Swagger UI at /api/docs with the full OpenAPI spec.
 * Also serves the raw spec JSON at /api/docs/openapi.json.
 *
 * Uses createRequire for swagger-ui-express because it is a CJS
 * module that tsdown/rolldown cannot properly emit in unbundle mode.
 */
export function setupDocs(app: Express): void {
  // Load CJS module via createRequire to avoid ESM interop issues
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const swaggerUi = require('swagger-ui-express');

  // Serve raw spec for tooling (SDK generators, curl, etc.)
  app.get('/api/docs/openapi.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(openApiSpec);
  });

  // Swagger UI interactive explorer
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, {
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'Hi Genie Orchestrator \u2014 API Docs',
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        filter: true,
        tryItOutEnabled: true,
      },
    }),
  );

  console.log('[docs] Swagger UI available at /api/docs');
  console.log('[docs] OpenAPI spec at /api/docs/openapi.json');
}
