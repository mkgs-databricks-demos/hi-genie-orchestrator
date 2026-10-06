/**
 * OpenAPI 3.1 Specification — Hi Genie Orchestrator Supervisor API
 *
 * Machine-readable contract for the /api/v1 surface. Used by:
 *   - Swagger UI at /api/docs
 *   - TypeScript client SDK generation (shared/sdk/)
 *   - Contract testing and documentation
 *
 * Endpoints (14 total):
 *   Plans (4): create, get, publish, orchestrate
 *   Workstreams (6): materialize, list, dispatch, retry, pause, unpause
 *   Reviews (4): create, get, remediation, approve
 */

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Hi Genie Orchestrator — Supervisor API',
    version: '1.1.0',
    description:
      'Supervisor dispatch API for durable orchestration context, bounded state, and review-gated workstream lifecycle. ' +
      'Authenticated via Databricks Apps OBO (x-forwarded-user / x-databricks-user headers). ' +
      'For M2M access, use SPN client_credentials OAuth flow.',
    contact: { email: 'matthew.giglia@databricks.com' },
  },
  servers: [
    {
      url: 'https://mcp-hi-genie-orchestrator-dev-7474657291520070.aws.databricksapps.com',
      description: 'Dev (source-linked)',
    },
  ],
  tags: [
    { name: 'Plans', description: 'Plan ingestion, publishing, and orchestration' },
    { name: 'Workstreams', description: 'Workstream materialization and dispatch control' },
    { name: 'Reviews', description: 'Review-gated completion lifecycle' },
    { name: 'MCP', description: 'MCP tool catalog (REST discovery)' },
    { name: 'Health', description: 'Service health and status' },
  ],
  components: {
    securitySchemes: {
      databricksOBO: {
        type: 'apiKey',
        in: 'header',
        name: 'x-forwarded-user',
        description: 'Databricks Apps auth-proxy injects the verified user identity',
      },
      bearerSPN: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'OAuth2 (client_credentials)',
        description: 'SPN M2M token from POST /oidc/v1/token',
      },
    },
    schemas: {
      // ── Shared ───────────────────────────────────────────────────────────
      ErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Error code (e.g. VALIDATION_ERROR, NOT_FOUND)' },
          message: { type: 'string', description: 'Human-readable error description' },
          details: { type: 'object', description: 'Zod validation details (if VALIDATION_ERROR)' },
        },
        required: ['error'],
      },

      // ── Plans ────────────────────────────────────────────────────────────
      CreatePlanRequest: {
        type: 'object',
        properties: {
          project_id: { type: 'string', format: 'uuid' },
          name: { type: 'string', minLength: 1, maxLength: 255 },
          description: { type: 'string' },
          source_ref: { type: 'object', additionalProperties: true },
        },
        required: ['project_id', 'name'],
      },
      Plan: {
        type: 'object',
        properties: {
          plan_id: { type: 'string', format: 'uuid' },
          project_id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          source_ref: { type: 'object', nullable: true },
          current_snapshot_id: { type: 'string', format: 'uuid', nullable: true },
          created_by: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      PublishPlanRequest: {
        type: 'object',
        properties: {
          content: { type: 'object', additionalProperties: true, description: 'Immutable plan content (hashed for idempotency)' },
          workstream_count: { type: 'integer', minimum: 0 },
        },
        required: ['content', 'workstream_count'],
      },
      PlanSnapshot: {
        type: 'object',
        properties: {
          plan_snapshot_id: { type: 'string', format: 'uuid' },
          plan_id: { type: 'string', format: 'uuid' },
          version: { type: 'integer' },
          content_hash: { type: 'string' },
          content: { type: 'object' },
          workstream_count: { type: 'integer' },
          created_by: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      OrchestratePlanRequest: {
        type: 'object',
        properties: {
          plan_snapshot_id: { type: 'string', format: 'uuid', description: 'Defaults to current_snapshot_id if omitted' },
          priority: { type: 'integer', minimum: 0, maximum: 100, default: 50 },
        },
      },
      Orchestration: {
        type: 'object',
        properties: {
          orchestration_id: { type: 'string', format: 'uuid' },
          project_id: { type: 'string', format: 'uuid' },
          plan_id: { type: 'string', format: 'uuid' },
          plan_snapshot_id: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'CANCELLED'] },
          priority: { type: 'integer' },
          correlation_id: { type: 'string', format: 'uuid' },
          configuration_version: { type: 'string' },
          created_by: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },

      // ── Workstreams ─────────────────────────────────────────────────────
      MaterializeRequest: {
        type: 'object',
        properties: {
          plan_snapshot_id: { type: 'string', format: 'uuid' },
          priority: { type: 'integer', minimum: 0, maximum: 100, default: 50 },
          correlation_id: { type: 'string', format: 'uuid' },
          configuration_version: { type: 'string', default: '1.0.0' },
        },
        required: ['plan_snapshot_id'],
      },
      Workstream: {
        type: 'object',
        properties: {
          workstream_id: { type: 'string', format: 'uuid' },
          orchestration_id: { type: 'string', format: 'uuid' },
          project_id: { type: 'string', format: 'uuid' },
          workstream_key: { type: 'string' },
          name: { type: 'string' },
          status: {
            type: 'string',
            enum: ['NOT_STARTED', 'IN_PROGRESS', 'VALIDATING', 'READY_FOR_REVIEW', 'COMPLETE', 'BLOCKED', 'RETRYING', 'CANCELLED'],
          },
          execution_tier: { type: 'integer' },
          depends_on: { type: 'array', items: { type: 'string' } },
          config: { type: 'object' },
          attempt_count: { type: 'integer' },
          max_retries: { type: 'integer' },
          assigned_to: { type: 'string', nullable: true },
          priority: { type: 'integer' },
          correlation_id: { type: 'string', format: 'uuid' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
          started_at: { type: 'string', format: 'date-time', nullable: true },
          completed_at: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      DispatchRequest: {
        type: 'object',
        properties: {
          worker_identity: { type: 'string', minLength: 1, description: 'Identity of the worker claiming this workstream' },
          correlation_id: { type: 'string', format: 'uuid' },
        },
        required: ['worker_identity'],
      },
      RetryRequest: {
        type: 'object',
        properties: {
          reason: { type: 'string', minLength: 1, maxLength: 1000 },
          correlation_id: { type: 'string', format: 'uuid' },
        },
        required: ['reason'],
      },
      PauseRequest: {
        type: 'object',
        properties: {
          reason: { type: 'string', minLength: 1, maxLength: 1000 },
        },
      },

      // ── Reviews ─────────────────────────────────────────────────────────
      CreateReviewRequest: {
        type: 'object',
        properties: {
          review_task_id: { type: 'string', format: 'uuid' },
          workstream_id: { type: 'string', format: 'uuid' },
          orchestration_id: { type: 'string', format: 'uuid' },
          project_id: { type: 'string', format: 'uuid' },
          execution_id: { type: 'string', format: 'uuid' },
          correlation_id: { type: 'string', format: 'uuid' },
        },
        required: ['review_task_id', 'workstream_id', 'orchestration_id', 'project_id', 'execution_id'],
      },
      ReviewTask: {
        type: 'object',
        properties: {
          review_task_id: { type: 'string', format: 'uuid' },
          workstream_id: { type: 'string', format: 'uuid' },
          orchestration_id: { type: 'string', format: 'uuid' },
          project_id: { type: 'string', format: 'uuid' },
          execution_id: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['PENDING', 'IN_PROGRESS', 'APPROVED', 'REJECTED', 'CANCELLED'] },
          reviewer_identity: { type: 'string', nullable: true },
          checks_performed: { type: 'array', items: { type: 'string' }, nullable: true },
          artifact_refs: { type: 'array', items: { type: 'string' }, nullable: true },
          test_results: { type: 'array', nullable: true },
          findings: { type: 'array', nullable: true },
          outcome: { type: 'string', enum: ['PASS', 'FAIL', 'INCONCLUSIVE'], nullable: true },
          outcome_reason: { type: 'string', nullable: true },
          correlation_id: { type: 'string', format: 'uuid' },
          created_by: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
          completed_at: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      RemediationRequest: {
        type: 'object',
        properties: {
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                category: { type: 'string' },
                severity: { type: 'string', enum: ['INFO', 'WARNING', 'ERROR', 'CRITICAL'] },
                description: { type: 'string' },
                remediation_hint: { type: 'string' },
                artifact_ref: { type: 'string' },
              },
              required: ['category', 'severity', 'description'],
            },
          },
          test_results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                test_name: { type: 'string' },
                passed: { type: 'boolean' },
                message: { type: 'string' },
                artifact_ref: { type: 'string' },
              },
              required: ['test_name', 'passed'],
            },
          },
          checks_performed: { type: 'array', items: { type: 'string' } },
          correlation_id: { type: 'string', format: 'uuid' },
        },
        required: ['findings'],
      },
      ApproveRequest: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['PASS', 'FAIL', 'INCONCLUSIVE'] },
          outcome_reason: { type: 'string', minLength: 1, maxLength: 2000 },
          checks_performed: { type: 'array', items: { type: 'string' } },
          artifact_refs: { type: 'array', items: { type: 'string' } },
          correlation_id: { type: 'string', format: 'uuid' },
        },
        required: ['outcome', 'outcome_reason'],
      },

      // ── MCP Tool Catalog ────────────────────────────────────────────────
      McpToolDefinition: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          inputSchema: { type: 'object', description: 'JSON Schema for tool parameters' },
        },
        required: ['name', 'description', 'inputSchema'],
      },
    },
  },
  security: [{ databricksOBO: [] }, { bearerSPN: [] }],
  paths: {
    // ═══════════════════════════════════════════════════════════════════════
    // PLANS
    // ═══════════════════════════════════════════════════════════════════════
    '/api/v1/plans': {
      post: {
        tags: ['Plans'],
        operationId: 'createPlan',
        summary: 'Ingest a new plan',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreatePlanRequest' } } },
        },
        responses: {
          '201': {
            description: 'Plan created',
            content: { 'application/json': { schema: { type: 'object', properties: { plan: { $ref: '#/components/schemas/Plan' } } } } },
          },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          '401': { description: 'Unauthenticated' },
        },
      },
    },
    '/api/v1/plans/{planId}': {
      get: {
        tags: ['Plans'],
        operationId: 'getPlan',
        summary: 'Retrieve plan with snapshots',
        parameters: [{ name: 'planId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': {
            description: 'Plan with snapshots',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    plan: { $ref: '#/components/schemas/Plan' },
                    snapshots: { type: 'array', items: { $ref: '#/components/schemas/PlanSnapshot' } },
                  },
                },
              },
            },
          },
          '404': { description: 'Plan not found' },
        },
      },
    },
    '/api/v1/plans/{planId}/publish': {
      post: {
        tags: ['Plans'],
        operationId: 'publishPlan',
        summary: 'Create immutable plan snapshot (idempotent via content hash)',
        parameters: [{ name: 'planId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/PublishPlanRequest' } } },
        },
        responses: {
          '201': { description: 'Snapshot created', content: { 'application/json': { schema: { type: 'object', properties: { snapshot: { $ref: '#/components/schemas/PlanSnapshot' }, idempotent: { type: 'boolean' } } } } } },
          '200': { description: 'Idempotent match (content already published)' },
          '404': { description: 'Plan not found' },
        },
      },
    },
    '/api/v1/plans/{planId}/orchestrate': {
      post: {
        tags: ['Plans'],
        operationId: 'orchestratePlan',
        summary: 'Create orchestration from published snapshot',
        parameters: [{ name: 'planId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/OrchestratePlanRequest' } } },
        },
        responses: {
          '201': { description: 'Orchestration created', content: { 'application/json': { schema: { type: 'object', properties: { orchestration: { $ref: '#/components/schemas/Orchestration' } } } } } },
          '404': { description: 'Plan or snapshot not found' },
          '409': { description: 'No snapshot published yet' },
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // WORKSTREAMS
    // ═══════════════════════════════════════════════════════════════════════
    '/api/v1/orchestrations/{orchId}/materialize': {
      post: {
        tags: ['Workstreams'],
        operationId: 'materializeWorkstreams',
        summary: 'Materialize workstreams from plan snapshot content',
        parameters: [{ name: 'orchId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/MaterializeRequest' } } },
        },
        responses: {
          '201': {
            description: 'Workstreams materialized',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    orchestration_id: { type: 'string', format: 'uuid' },
                    workstreams_materialized: { type: 'integer' },
                    workstreams: { type: 'array', items: { $ref: '#/components/schemas/Workstream' } },
                    correlation_id: { type: 'string', format: 'uuid' },
                  },
                },
              },
            },
          },
          '404': { description: 'Orchestration or snapshot not found' },
          '409': { description: 'Orchestration not in PENDING status' },
        },
      },
    },
    '/api/v1/orchestrations/{orchId}/workstreams': {
      get: {
        tags: ['Workstreams'],
        operationId: 'listWorkstreams',
        summary: 'List workstreams for an orchestration',
        parameters: [{ name: 'orchId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': {
            description: 'Workstream list (ordered by tier ASC, priority DESC)',
            content: { 'application/json': { schema: { type: 'object', properties: { workstreams: { type: 'array', items: { $ref: '#/components/schemas/Workstream' } } } } } },
          },
        },
      },
    },
    '/api/v1/orchestrations/{orchId}/workstreams/{wsKey}/dispatch': {
      post: {
        tags: ['Workstreams'],
        operationId: 'dispatchWorkstream',
        summary: 'Assign worker and begin execution',
        parameters: [
          { name: 'orchId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'wsKey', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/DispatchRequest' } } },
        },
        responses: {
          '201': {
            description: 'Execution created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    execution_id: { type: 'string', format: 'uuid' },
                    workstream_id: { type: 'string', format: 'uuid' },
                    workstream_key: { type: 'string' },
                    attempt_number: { type: 'integer' },
                    status: { type: 'string' },
                    correlation_id: { type: 'string', format: 'uuid' },
                  },
                },
              },
            },
          },
          '404': { description: 'Workstream not found' },
          '409': { description: 'Cannot dispatch from current status (allowed: NOT_STARTED, RETRYING)' },
        },
      },
    },
    '/api/v1/orchestrations/{orchId}/workstreams/{wsKey}/retry': {
      post: {
        tags: ['Workstreams'],
        operationId: 'retryWorkstream',
        summary: 'Retry a blocked workstream',
        parameters: [
          { name: 'orchId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'wsKey', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RetryRequest' } } },
        },
        responses: {
          '200': { description: 'Workstream set to RETRYING' },
          '404': { description: 'Workstream not found' },
          '409': { description: 'Cannot retry from current status or retries exhausted' },
        },
      },
    },
    '/api/v1/orchestrations/{orchId}/workstreams/{wsKey}/pause': {
      post: {
        tags: ['Workstreams'],
        operationId: 'pauseWorkstream',
        summary: 'Pause workstream (transitions to BLOCKED)',
        parameters: [
          { name: 'orchId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'wsKey', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/PauseRequest' } } },
        },
        responses: {
          '200': { description: 'Workstream paused' },
          '409': { description: 'Cannot pause from current status (allowed: NOT_STARTED, IN_PROGRESS, RETRYING)' },
        },
      },
    },
    '/api/v1/orchestrations/{orchId}/workstreams/{wsKey}/unpause': {
      post: {
        tags: ['Workstreams'],
        operationId: 'unpauseWorkstream',
        summary: 'Resume a paused (BLOCKED) workstream',
        parameters: [
          { name: 'orchId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'wsKey', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Workstream unpaused (set to RETRYING)' },
          '409': { description: 'Cannot unpause from current status (allowed: BLOCKED)' },
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // REVIEWS
    // ═══════════════════════════════════════════════════════════════════════
    '/api/v1/reviews': {
      post: {
        tags: ['Reviews'],
        operationId: 'createReview',
        summary: 'Create review task (idempotent via review_task_id PK)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateReviewRequest' } } },
        },
        responses: {
          '201': { description: 'Review task created', content: { 'application/json': { schema: { type: 'object', properties: { review_task: { $ref: '#/components/schemas/ReviewTask' }, idempotent: { type: 'boolean' } } } } } },
          '200': { description: 'Idempotent match (already exists)' },
          '400': { description: 'Validation error' },
        },
      },
    },
    '/api/v1/reviews/{reviewId}': {
      get: {
        tags: ['Reviews'],
        operationId: 'getReview',
        summary: 'Retrieve review task with findings and outcome',
        parameters: [{ name: 'reviewId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Review task', content: { 'application/json': { schema: { type: 'object', properties: { review_task: { $ref: '#/components/schemas/ReviewTask' } } } } } },
          '404': { description: 'Review task not found' },
        },
      },
    },
    '/api/v1/reviews/{reviewId}/remediation': {
      post: {
        tags: ['Reviews'],
        operationId: 'deliverRemediation',
        summary: 'Deliver remediation findings and test results',
        parameters: [{ name: 'reviewId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RemediationRequest' } } },
        },
        responses: {
          '200': { description: 'Remediation delivered (review now IN_PROGRESS)' },
          '404': { description: 'Review task not found' },
          '409': { description: 'Review is APPROVED or CANCELLED (immutable)' },
        },
      },
    },
    '/api/v1/reviews/{reviewId}/approve': {
      post: {
        tags: ['Reviews'],
        operationId: 'approveReview',
        summary: 'Supervisor-only completion approval (transitions workstream on PASS)',
        parameters: [{ name: 'reviewId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApproveRequest' } } },
        },
        responses: {
          '200': {
            description: 'Approval recorded; PASS → workstream COMPLETE, FAIL → workstream RETRYING',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    review_task_id: { type: 'string', format: 'uuid' },
                    status: { type: 'string' },
                    outcome: { type: 'string' },
                    outcome_reason: { type: 'string' },
                    workstream_id: { type: 'string', format: 'uuid' },
                    workstream_status: { type: 'string' },
                    correlation_id: { type: 'string', format: 'uuid' },
                  },
                },
              },
            },
          },
          '404': { description: 'Review task not found' },
          '409': { description: 'Already APPROVED/CANCELLED or invalid state for approval' },
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // MCP TOOL CATALOG
    // ═══════════════════════════════════════════════════════════════════════
    '/api/v1/mcp/tools': {
      get: {
        tags: ['MCP'],
        operationId: 'listMcpTools',
        summary: 'List all registered MCP tools (REST-friendly discovery)',
        description:
          'Returns the same tool definitions that tools/list returns over JSON-RPC, ' +
          'but via a standard REST GET for non-MCP consumers (dashboards, SDK generators, docs).',
        responses: {
          '200': {
            description: 'MCP tool catalog',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    tools: { type: 'array', items: { $ref: '#/components/schemas/McpToolDefinition' } },
                    count: { type: 'integer' },
                    mcp_endpoint: { type: 'string', description: 'JSON-RPC MCP endpoint URL' },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // HEALTH
    // ═══════════════════════════════════════════════════════════════════════
    '/api/health': {
      get: {
        tags: ['Health'],
        operationId: 'getHealth',
        summary: 'Service health check with module status',
        security: [],
        responses: {
          '200': {
            description: 'Service healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['ok'] },
                    service: { type: 'string' },
                    version: { type: 'string' },
                    timestamp: { type: 'string', format: 'date-time' },
                    modules: {
                      type: 'object',
                      properties: {
                        migrations: { type: 'boolean' },
                        telemetry: { type: 'boolean' },
                        memory: { type: 'boolean' },
                        dispatch: { type: 'boolean' },
                        mcp: { type: 'boolean' },
                        api: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
