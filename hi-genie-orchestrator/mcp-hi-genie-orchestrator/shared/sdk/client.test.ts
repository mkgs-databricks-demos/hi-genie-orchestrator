/**
 * Unit Tests — OrchestratorClient SDK
 *
 * Tests all sub-clients (Plans, Workstreams, Reviews, MCP) and error handling.
 * Uses a mock fetch to intercept HTTP calls without network dependencies.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  OrchestratorClient,
  OrchestratorApiError,
  PlansClient,
  WorkstreamsClient,
  ReviewsClient,
  McpClient,
} from './client.js';
import type { OrchestratorClientConfig } from './types.js';

// ── Mock Fetch ─────────────────────────────────────────────────────────────

/**
 * `vi.fn<typeof fetch>()` (not the untyped `vi.fn()`) makes `mockFetch` a
 * `Mock<typeof fetch>` by inference from the real global `fetch` signature —
 * no cast needed to get there, and no cast means TypeScript actually checks
 * what `.mockResolvedValue()` is handed against `Promise<Response>`, the real
 * return type `OrchestratorClient.request()` awaits. Resolving with an actual
 * `Response` (constructed from Node's built-in `Response`, available in the
 * `node` test environment since Node 18) rather than a hand-rolled object
 * literal is what makes that check meaningful: if `OrchestratorClient` were
 * changed to read a `Response` member this mock doesn't provide (e.g.
 * `.headers`), a real `Response` still has it, so a type-level mismatch would
 * have to come from an actually-incompatible usage, not from the mock being a
 * narrower ad hoc shape that happens to satisfy today's call sites.
 */
function createMockFetch(status: number, body: unknown): Mock<typeof fetch> {
  const mockFetch = vi.fn<typeof fetch>();
  mockFetch.mockResolvedValue(new Response(JSON.stringify(body), { status }));
  return mockFetch;
}

function createClient(mockFetch: Mock<typeof fetch>): OrchestratorClient {
  const config: OrchestratorClientConfig = {
    baseUrl: 'https://test-app.databricksapps.com',
    token: 'test-token-123',
    fetch: mockFetch,
  };
  return new OrchestratorClient(config);
}

/** Every call site destructures a real fetch call's [url, init] and reads
 * init.body as a JSON string — narrow that once instead of re-asserting
 * `any` at each of the ~9 call sites below. Every caller here always sends
 * a JSON object body, never an array or primitive, so `Record<string,
 * unknown>` is the correct (and precise) shape rather than `unknown`. */
function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(init!.body as string) as Record<string, unknown>;
}

// ── Client Construction ────────────────────────────────────────────────────

describe('OrchestratorClient', () => {
  it('exposes sub-clients', () => {
    const client = createClient(createMockFetch(200, {}));
    expect(client.plans).toBeInstanceOf(PlansClient);
    expect(client.workstreams).toBeInstanceOf(WorkstreamsClient);
    expect(client.reviews).toBeInstanceOf(ReviewsClient);
    expect(client.mcp).toBeInstanceOf(McpClient);
  });

  it('strips trailing slash from baseUrl', async () => {
    const mockFetch = createMockFetch(200, { status: 'ok' });
    const config: OrchestratorClientConfig = {
      baseUrl: 'https://test-app.databricksapps.com/',
      token: 'tok',
      fetch: mockFetch,
    };
    const client = new OrchestratorClient(config);
    await client.health();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://test-app.databricksapps.com/api/health',
      expect.anything(),
    );
  });

  it('includes Authorization header', async () => {
    const mockFetch = createMockFetch(200, { status: 'ok' });
    const client = createClient(mockFetch);
    await client.health();

    const [, options] = mockFetch.mock.calls[0];
    const headers = options?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token-123');
  });
});

// ── Error Handling ─────────────────────────────────────────────────────────

describe('OrchestratorApiError', () => {
  it('throws on non-2xx responses', async () => {
    const mockFetch = createMockFetch(404, { error: 'NOT_FOUND', message: 'Plan not found' });
    const client = createClient(mockFetch);

    await expect(client.plans.get('bad-id')).rejects.toThrow(OrchestratorApiError);
  });

  it('contains status, body, and url', async () => {
    const mockFetch = createMockFetch(409, { error: 'INVALID_STATE', message: 'Cannot dispatch' });
    const client = createClient(mockFetch);

    try {
      await client.plans.get('some-id');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestratorApiError);
      const apiErr = err as OrchestratorApiError;
      expect(apiErr.status).toBe(409);
      expect(apiErr.body.error).toBe('INVALID_STATE');
      expect(apiErr.body.message).toBe('Cannot dispatch');
      expect(apiErr.url).toContain('/api/v1/plans/some-id');
    }
  });

  it('produces readable error message', () => {
    const err = new OrchestratorApiError(
      400,
      { error: 'VALIDATION_ERROR', message: 'Invalid body' },
      'https://example.com/api/v1/plans',
    );
    expect(err.message).toBe('[400] VALIDATION_ERROR: Invalid body');
    expect(err.name).toBe('OrchestratorApiError');
  });
});

// ── Plans Client ───────────────────────────────────────────────────────────

describe('PlansClient', () => {
  let mockFetch: Mock<typeof fetch>;
  let client: OrchestratorClient;

  beforeEach(() => {
    mockFetch = createMockFetch(201, { plan: { plan_id: 'p1', name: 'Test' } });
    client = createClient(mockFetch);
  });

  it('create() POSTs to /api/v1/plans', async () => {
    const result = await client.plans.create({ project_id: 'proj-1', name: 'Sprint' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://test-app.databricksapps.com/api/v1/plans',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.plan.plan_id).toBe('p1');
  });

  it('get() GETs /api/v1/plans/:planId', async () => {
    mockFetch = createMockFetch(200, { plan: { plan_id: 'p1' }, snapshots: [] });
    client = createClient(mockFetch);

    await client.plans.get('p1');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test-app.databricksapps.com/api/v1/plans/p1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('publish() POSTs to /api/v1/plans/:planId/publish', async () => {
    mockFetch = createMockFetch(201, { snapshot: { version: 1 }, idempotent: false });
    client = createClient(mockFetch);

    await client.plans.publish('p1', { content: { workstreams: [] }, workstream_count: 0 });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test-app.databricksapps.com/api/v1/plans/p1/publish',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('orchestrate() POSTs to /api/v1/plans/:planId/orchestrate', async () => {
    mockFetch = createMockFetch(201, { orchestration: { orchestration_id: 'o1' } });
    client = createClient(mockFetch);

    await client.plans.orchestrate('p1', { priority: 80 });
    const [, options] = mockFetch.mock.calls[0];
    expect(requestBody(options)).toEqual({ priority: 80 });
  });

  it('orchestrate() with no args sends empty body', async () => {
    mockFetch = createMockFetch(201, { orchestration: { orchestration_id: 'o1' } });
    client = createClient(mockFetch);

    await client.plans.orchestrate('p1');
    const [, options] = mockFetch.mock.calls[0];
    expect(requestBody(options)).toEqual({});
  });
});

// ── Workstreams Client ─────────────────────────────────────────────────────

describe('WorkstreamsClient', () => {
  let mockFetch: Mock<typeof fetch>;
  let client: OrchestratorClient;

  beforeEach(() => {
    mockFetch = createMockFetch(201, {});
    client = createClient(mockFetch);
  });

  it('materialize() POSTs to /orchestrations/:id/materialize', async () => {
    await client.workstreams.materialize('o1', { plan_snapshot_id: 'snap-1' });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test-app.databricksapps.com/api/v1/orchestrations/o1/materialize',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('list() GETs /orchestrations/:id/workstreams', async () => {
    mockFetch = createMockFetch(200, { workstreams: [] });
    client = createClient(mockFetch);

    await client.workstreams.list('o1');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test-app.databricksapps.com/api/v1/orchestrations/o1/workstreams',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('dispatch() includes worker_identity in body', async () => {
    await client.workstreams.dispatch('o1', 'ws-key', { worker_identity: 'agent@db.com' });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/workstreams/ws-key/dispatch');
    expect(requestBody(options).worker_identity).toBe('agent@db.com');
  });

  it('retry() includes reason in body', async () => {
    await client.workstreams.retry('o1', 'ws-key', { reason: 'backfill done' });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/workstreams/ws-key/retry');
    expect(requestBody(options).reason).toBe('backfill done');
  });

  it('pause() sends optional reason', async () => {
    await client.workstreams.pause('o1', 'ws-key', { reason: 'manual hold' });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/workstreams/ws-key/pause');
    expect(requestBody(options).reason).toBe('manual hold');
  });

  it('pause() with no args sends empty body', async () => {
    await client.workstreams.pause('o1', 'ws-key');
    const [, options] = mockFetch.mock.calls[0];
    expect(requestBody(options)).toEqual({});
  });

  it('unpause() POSTs with no body', async () => {
    await client.workstreams.unpause('o1', 'ws-key');
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/workstreams/ws-key/unpause');
    expect(options?.body).toBeUndefined();
  });
});

// ── Reviews Client ─────────────────────────────────────────────────────────

describe('ReviewsClient', () => {
  let mockFetch: Mock<typeof fetch>;
  let client: OrchestratorClient;

  beforeEach(() => {
    mockFetch = createMockFetch(201, { review_task: { review_task_id: 'r1' }, idempotent: false });
    client = createClient(mockFetch);
  });

  it('create() POSTs to /api/v1/reviews', async () => {
    await client.reviews.create({
      review_task_id: 'r1',
      workstream_id: 'w1',
      orchestration_id: 'o1',
      project_id: 'p1',
      execution_id: 'e1',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test-app.databricksapps.com/api/v1/reviews',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('get() GETs /api/v1/reviews/:id', async () => {
    mockFetch = createMockFetch(200, { review_task: { review_task_id: 'r1' } });
    client = createClient(mockFetch);

    await client.reviews.get('r1');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test-app.databricksapps.com/api/v1/reviews/r1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('deliverRemediation() POSTs findings to /reviews/:id/remediation', async () => {
    mockFetch = createMockFetch(200, { review_task_id: 'r1', status: 'IN_PROGRESS', findings_count: 1 });
    client = createClient(mockFetch);

    await client.reviews.deliverRemediation('r1', {
      findings: [{ category: 'test', severity: 'INFO', description: 'All good' }],
    });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/reviews/r1/remediation');
    expect(requestBody(options).findings).toHaveLength(1);
  });

  it('approve() POSTs outcome to /reviews/:id/approve', async () => {
    mockFetch = createMockFetch(200, {
      review_task_id: 'r1',
      status: 'APPROVED',
      outcome: 'PASS',
      workstream_status: 'COMPLETE',
    });
    client = createClient(mockFetch);

    const result = await client.reviews.approve('r1', {
      outcome: 'PASS',
      outcome_reason: 'Looks great',
    });
    expect(result.status).toBe('APPROVED');
    expect(result.workstream_status).toBe('COMPLETE');
  });
});

// ── MCP Client ─────────────────────────────────────────────────────────────

describe('McpClient', () => {
  it('listTools() GETs /api/v1/mcp/tools', async () => {
    const mockFetch = createMockFetch(200, {
      tools: [{ name: 'test_tool', description: 'A test', inputSchema: {} }],
      count: 1,
      categories: { context: ['test_tool'] },
      mcp_endpoint: '/mcp',
      protocol_version: '2025-03-26',
      transport: 'Streamable HTTP',
    });
    const client = createClient(mockFetch);

    const catalog = await client.mcp.listTools();
    expect(catalog.count).toBe(1);
    expect(catalog.tools[0].name).toBe('test_tool');
    expect(catalog.mcp_endpoint).toBe('/mcp');
  });
});

// ── Health ─────────────────────────────────────────────────────────────────

describe('health()', () => {
  it('GETs /api/health', async () => {
    const mockFetch = createMockFetch(200, {
      status: 'ok',
      service: 'mcp-hi-genie-orchestrator',
      version: '1.1.0',
      modules: { migrations: true, mcp: true, api: true },
    });
    const client = createClient(mockFetch);

    const health = await client.health();
    expect(health.status).toBe('ok');
    expect(health.modules.mcp).toBe(true);
  });
});

// ── OpenAPI Spec Endpoint ──────────────────────────────────────────────────

describe('getOpenApiSpec()', () => {
  it('GETs /api/docs/openapi.json', async () => {
    const mockFetch = createMockFetch(200, { openapi: '3.1.0', info: { title: 'Test' } });
    const client = createClient(mockFetch);

    const spec = await client.getOpenApiSpec();
    expect(spec.openapi).toBe('3.1.0');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test-app.databricksapps.com/api/docs/openapi.json',
      expect.anything(),
    );
  });
});
