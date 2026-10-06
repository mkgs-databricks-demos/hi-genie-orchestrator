/**
 * Supervisor API — Workstream Routes Unit Tests
 *
 * Covers request validation (Zod schemas) and the status-transition
 * contracts enforced by the dispatch/retry/pause/unpause handlers.
 */

import { describe, it, expect } from 'vitest';
import {
  MaterializeSchema,
  DispatchSchema,
  RetrySchema,
  PauseSchema,
  DISPATCH_FROM,
  RETRY_FROM,
  PAUSE_FROM,
  UNPAUSE_FROM,
} from './workstreams.js';

// RFC 4122 requires the variant nibble (4th group) to be 8/9/a/b — Zod v4's
// .uuid() enforces this strictly, so a hand-rolled placeholder like
// '11111111-1111-1111-1111-111111111111' fails validation. See PROJECT_MEMORY
// Known Issue 13.
const VALID_UUID = '11111111-1111-4111-8111-111111111111';

describe('MaterializeSchema', () => {
  it('applies default priority and configuration_version', () => {
    const parsed = MaterializeSchema.parse({ plan_snapshot_id: VALID_UUID });
    expect(parsed.priority).toBe(50);
    expect(parsed.configuration_version).toBe('1.0.0');
  });

  it('rejects a non-uuid plan_snapshot_id', () => {
    expect(() => MaterializeSchema.parse({ plan_snapshot_id: 'not-a-uuid' })).toThrow();
  });

  it('rejects a priority outside the 0-100 range', () => {
    expect(() => MaterializeSchema.parse({ plan_snapshot_id: VALID_UUID, priority: 101 })).toThrow();
    expect(() => MaterializeSchema.parse({ plan_snapshot_id: VALID_UUID, priority: -1 })).toThrow();
  });
});

describe('DispatchSchema', () => {
  it('requires a non-empty worker_identity', () => {
    expect(() => DispatchSchema.parse({ worker_identity: '' })).toThrow();
    expect(DispatchSchema.parse({ worker_identity: 'worker-1' }).worker_identity).toBe('worker-1');
  });
});

describe('RetrySchema', () => {
  it('requires a non-empty reason', () => {
    expect(() => RetrySchema.parse({ reason: '' })).toThrow();
    expect(RetrySchema.parse({ reason: 'transient failure' }).reason).toBe('transient failure');
  });
});

describe('PauseSchema', () => {
  it('allows an omitted reason', () => {
    expect(PauseSchema.parse({}).reason).toBeUndefined();
  });
});

describe('workstream status transition contracts', () => {
  it('only allows dispatch from NOT_STARTED or RETRYING', () => {
    expect(DISPATCH_FROM).toEqual(['NOT_STARTED', 'RETRYING']);
  });

  it('only allows retry from BLOCKED', () => {
    expect(RETRY_FROM).toEqual(['BLOCKED']);
  });

  it('only allows pause from NOT_STARTED, IN_PROGRESS, or RETRYING', () => {
    expect(PAUSE_FROM).toEqual(['NOT_STARTED', 'IN_PROGRESS', 'RETRYING']);
  });

  it('only allows unpause from BLOCKED', () => {
    expect(UNPAUSE_FROM).toEqual(['BLOCKED']);
  });
});
