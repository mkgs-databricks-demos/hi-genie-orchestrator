/**
 * Identity Middleware — Fail-Closed Request Authentication
 *
 * Resolves the calling Databricks identity from the platform auth-proxy
 * headers (x-forwarded-user / x-databricks-user) and attaches it to the
 * request as `req.verifiedIdentity`. Requests without a verifiable identity
 * are rejected with 401 before reaching any /api/v1 route handler.
 *
 * Replaces the previous behavior where a missing identity header silently
 * fell back to the shared 'system' identity — see Polly review
 * hey_polly/001_release-1-readiness.md, Phase 3.
 *
 * NOTE: this only closes the "who is calling" gap at the application layer.
 * It does NOT yet implement Postgres row-level security. True per-user RLS
 * on Lakebase requires provisioning a Postgres role per Databricks identity
 * via the `databricks_auth` extension (`databricks_create_role`) and routing
 * writes through AppKit's Lakebase OBO pool rather than the shared SP pool
 * — see https://docs.databricks.com/aws/en/oltp/projects/data-api/. That is
 * a larger architectural change flagged separately rather than guessed at
 * here.
 */

import type { Request, Response, NextFunction } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Verified Databricks identity for this request, set by requireVerifiedIdentity. */
      verifiedIdentity?: string;
    }
  }
}

/**
 * Express middleware: rejects any /api/v1 request that does not carry a
 * verifiable Databricks identity header. On success, attaches the resolved
 * identity to `req.verifiedIdentity` for downstream handlers (see
 * `getUserIdentity` in routes/plans.ts).
 */
export function requireVerifiedIdentity(req: Request, res: Response, next: NextFunction): void {
  const userHeader = req.headers['x-forwarded-user'] ?? req.headers['x-databricks-user'];

  if (typeof userHeader !== 'string' || userHeader.trim().length === 0) {
    res.status(401).json({
      error: 'UNAUTHENTICATED',
      message: 'No verified Databricks identity present on this request.',
    });
    return;
  }

  req.verifiedIdentity = userHeader.trim();
  next();
}
