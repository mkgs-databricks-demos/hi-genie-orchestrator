import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requireVerifiedIdentity } from './identity.js';

function makeReqRes(headers: Record<string, string | undefined>) {
  const req = { headers } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { status } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next, status, json };
}

describe('requireVerifiedIdentity', () => {
  it('attaches the identity and calls next() when x-forwarded-user is present', () => {
    const { req, res, next } = makeReqRes({ 'x-forwarded-user': 'alice@example.com' });
    requireVerifiedIdentity(req, res, next);
    expect(req.verifiedIdentity).toBe('alice@example.com');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('falls back to x-databricks-user when x-forwarded-user is absent', () => {
    const { req, res, next } = makeReqRes({ 'x-databricks-user': 'bob@example.com' });
    requireVerifiedIdentity(req, res, next);
    expect(req.verifiedIdentity).toBe('bob@example.com');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects with 401 and does not call next() when no identity header is present', () => {
    const { req, res, next, status, json } = makeReqRes({});
    requireVerifiedIdentity(req, res, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'UNAUTHENTICATED' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a blank/whitespace-only identity header', () => {
    const { req, res, next, status } = makeReqRes({ 'x-forwarded-user': '   ' });
    requireVerifiedIdentity(req, res, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
