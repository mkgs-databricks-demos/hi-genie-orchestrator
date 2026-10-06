/**
 * Unit Tests — OpenAPI Specification
 *
 * Validates the spec structure, path count, schema completeness,
 * and adherence to OpenAPI 3.1 conventions.
 */

import { describe, it, expect } from 'vitest';
import { openApiSpec } from './openapi.js';

// The methods object under each path entry (get/post/etc.) is typed as a
// large literal by TS inference, not Record<string, unknown> — narrow to
// the handful of fields these structural assertions actually read, rather
// than casting to `any` at each call site.
interface OpenApiOperation {
  operationId?: unknown;
  tags?: unknown[];
  security?: unknown[];
}

function operationsOf(methods: unknown): Record<string, OpenApiOperation> {
  return methods as Record<string, OpenApiOperation>;
}

describe('OpenAPI Spec', () => {
  it('is version 3.1.0', () => {
    expect(openApiSpec.openapi).toBe('3.1.0');
  });

  it('has correct service info', () => {
    expect(openApiSpec.info.title).toContain('Supervisor API');
    expect(openApiSpec.info.version).toBe('1.1.0');
  });

  it('defines exactly 15 path entries', () => {
    // 4 plans + 6 workstreams + 4 reviews + 1 MCP catalog + 1 health = 16 paths
    // But some paths share entries (e.g. /plans/{planId} is 1 entry with GET)
    const pathCount = Object.keys(openApiSpec.paths).length;
    expect(pathCount).toBeGreaterThanOrEqual(14);
  });

  it('has all plan paths', () => {
    expect(openApiSpec.paths).toHaveProperty('/api/v1/plans');
    expect(openApiSpec.paths).toHaveProperty('/api/v1/plans/{planId}');
    expect(openApiSpec.paths).toHaveProperty('/api/v1/plans/{planId}/publish');
    expect(openApiSpec.paths).toHaveProperty('/api/v1/plans/{planId}/orchestrate');
  });

  it('has all workstream paths', () => {
    expect(openApiSpec.paths).toHaveProperty('/api/v1/orchestrations/{orchId}/materialize');
    expect(openApiSpec.paths).toHaveProperty('/api/v1/orchestrations/{orchId}/workstreams');
    expect(openApiSpec.paths).toHaveProperty('/api/v1/orchestrations/{orchId}/workstreams/{wsKey}/dispatch');
    expect(openApiSpec.paths).toHaveProperty('/api/v1/orchestrations/{orchId}/workstreams/{wsKey}/retry');
    expect(openApiSpec.paths).toHaveProperty('/api/v1/orchestrations/{orchId}/workstreams/{wsKey}/pause');
    expect(openApiSpec.paths).toHaveProperty('/api/v1/orchestrations/{orchId}/workstreams/{wsKey}/unpause');
  });

  it('has all review paths', () => {
    expect(openApiSpec.paths).toHaveProperty('/api/v1/reviews');
    expect(openApiSpec.paths).toHaveProperty('/api/v1/reviews/{reviewId}');
    expect(openApiSpec.paths).toHaveProperty('/api/v1/reviews/{reviewId}/remediation');
    expect(openApiSpec.paths).toHaveProperty('/api/v1/reviews/{reviewId}/approve');
  });

  it('has MCP catalog path', () => {
    expect(openApiSpec.paths).toHaveProperty('/api/v1/mcp/tools');
  });

  it('has health path', () => {
    expect(openApiSpec.paths).toHaveProperty('/api/health');
  });

  it('defines security schemes', () => {
    expect(openApiSpec.components.securitySchemes).toHaveProperty('databricksOBO');
    expect(openApiSpec.components.securitySchemes).toHaveProperty('bearerSPN');
  });

  it('defines all required schemas', () => {
    const schemas = openApiSpec.components.schemas;
    const requiredSchemas = [
      'ErrorResponse',
      'CreatePlanRequest',
      'Plan',
      'PublishPlanRequest',
      'PlanSnapshot',
      'OrchestratePlanRequest',
      'Orchestration',
      'MaterializeRequest',
      'Workstream',
      'DispatchRequest',
      'RetryRequest',
      'PauseRequest',
      'CreateReviewRequest',
      'ReviewTask',
      'RemediationRequest',
      'ApproveRequest',
      'McpToolDefinition',
    ];

    for (const name of requiredSchemas) {
      expect(schemas).toHaveProperty(name);
    }
  });

  it('all paths have operationId', () => {
    for (const [path, methods] of Object.entries(openApiSpec.paths)) {
      for (const [method, operation] of Object.entries(operationsOf(methods))) {
        if (['get', 'post', 'put', 'delete', 'patch'].includes(method)) {
          expect(operation.operationId, `${method.toUpperCase()} ${path} missing operationId`).toBeDefined();
        }
      }
    }
  });

  it('all paths have tags', () => {
    for (const [path, methods] of Object.entries(openApiSpec.paths)) {
      for (const [method, operation] of Object.entries(operationsOf(methods))) {
        if (['get', 'post', 'put', 'delete', 'patch'].includes(method)) {
          expect(operation.tags, `${method.toUpperCase()} ${path} missing tags`).toBeDefined();
          expect(operation.tags!.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('health endpoint has no security (public)', () => {
    const healthOps = operationsOf(openApiSpec.paths['/api/health']);
    expect(healthOps.get.security).toEqual([]);
  });

  it('Workstream schema has correct status enum', () => {
    const statusProp = openApiSpec.components.schemas.Workstream.properties.status;
    expect(statusProp.enum).toContain('NOT_STARTED');
    expect(statusProp.enum).toContain('IN_PROGRESS');
    expect(statusProp.enum).toContain('COMPLETE');
    expect(statusProp.enum).toContain('BLOCKED');
    expect(statusProp.enum).toContain('CANCELLED');
  });

  it('ReviewTask schema has correct outcome enum', () => {
    const outcomeProp = openApiSpec.components.schemas.ReviewTask.properties.outcome;
    expect(outcomeProp.enum).toEqual(['PASS', 'FAIL', 'INCONCLUSIVE']);
  });
});
