/**
 * Supervisor API — Review Routes Unit Tests
 *
 * Covers request validation (Zod schemas) for the review-gated completion
 * lifecycle: create, remediation delivery, and supervisor-only approval.
 */

import { describe, it, expect } from 'vitest';
import { CreateReviewSchema, RemediationSchema, ApproveSchema } from './reviews.js';

// RFC 4122 requires the variant nibble (4th group) to be 8/9/a/b — Zod v4's
// .uuid() enforces this strictly, so a hand-rolled placeholder like
// '11111111-1111-1111-1111-111111111111' fails validation. See PROJECT_MEMORY
// Known Issue 13.
const VALID_UUID = '11111111-1111-4111-8111-111111111111';

describe('CreateReviewSchema', () => {
  it('accepts a fully-formed review task request', () => {
    const parsed = CreateReviewSchema.parse({
      review_task_id: VALID_UUID,
      workstream_id: VALID_UUID,
      orchestration_id: VALID_UUID,
      project_id: VALID_UUID,
      execution_id: VALID_UUID,
    });
    expect(parsed.review_task_id).toBe(VALID_UUID);
  });

  it('rejects a request missing a required UUID field', () => {
    expect(() =>
      CreateReviewSchema.parse({
        review_task_id: VALID_UUID,
        workstream_id: VALID_UUID,
        orchestration_id: VALID_UUID,
        project_id: VALID_UUID,
        // execution_id omitted
      }),
    ).toThrow();
  });
});

describe('RemediationSchema', () => {
  it('requires at least the findings array, with category/severity/description per finding', () => {
    const parsed = RemediationSchema.parse({
      findings: [{ category: 'security', severity: 'CRITICAL', description: 'missing RLS' }],
    });
    expect(parsed.findings).toHaveLength(1);
  });

  it('rejects an invalid severity value', () => {
    expect(() =>
      RemediationSchema.parse({
        findings: [{ category: 'security', severity: 'YIKES', description: 'bad severity' }],
      }),
    ).toThrow();
  });
});

describe('ApproveSchema', () => {
  it('requires a valid outcome and a non-empty outcome_reason', () => {
    const parsed = ApproveSchema.parse({ outcome: 'PASS', outcome_reason: 'All checks passed' });
    expect(parsed.outcome).toBe('PASS');
  });

  it('rejects an outcome outside PASS/FAIL/INCONCLUSIVE', () => {
    expect(() => ApproveSchema.parse({ outcome: 'MAYBE', outcome_reason: 'unclear' })).toThrow();
  });

  it('rejects an empty outcome_reason', () => {
    expect(() => ApproveSchema.parse({ outcome: 'FAIL', outcome_reason: '' })).toThrow();
  });
});
