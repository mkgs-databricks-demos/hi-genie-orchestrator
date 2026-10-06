/**
 * Supervisor API — Plan Routes Unit Tests
 *
 * Covers pure logic only (content hashing, identity resolution). Does not
 * exercise the Express handlers or Lakebase queries, which need integration
 * tests against a real/mocked pool.
 */

import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { computeContentHash, getUserIdentity } from './plans.js';

function makeRequest(verifiedIdentity?: string): Request {
  return { verifiedIdentity } as unknown as Request;
}

describe('computeContentHash', () => {
  it('is stable regardless of key insertion order', () => {
    const a = computeContentHash({ b: 2, a: 1 });
    const b = computeContentHash({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it('produces a 64-character hex sha256 digest', () => {
    const hash = computeContentHash({ workstreams: [] });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces different hashes for different content', () => {
    const a = computeContentHash({ workstreams: [1] });
    const b = computeContentHash({ workstreams: [2] });
    expect(a).not.toBe(b);
  });
});

describe('getUserIdentity', () => {
  // Header parsing itself now lives in ../middleware/identity.ts
  // (requireVerifiedIdentity) — see identity.test.ts for that coverage.
  // getUserIdentity just reads the already-verified value it attaches.

  it('returns the identity attached by requireVerifiedIdentity middleware', () => {
    const req = makeRequest('alice@example.com');
    expect(getUserIdentity(req)).toBe('alice@example.com');
  });

  it('fails closed: throws when no verified identity is present on the request', () => {
    const req = makeRequest(undefined);
    expect(() => getUserIdentity(req)).toThrow(/UNVERIFIED_IDENTITY/);
  });
});
