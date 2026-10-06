/**
 * Service Layer — Shared Types
 *
 * Discriminated union result pattern for service functions.
 * Routes map `ok: false` to the appropriate HTTP status code;
 * MCP tool handlers map to structured MCP error responses.
 */

/** Successful service result */
export interface ServiceSuccess<T> {
  ok: true;
  data: T;
  status: 200 | 201;
}

/** Failed service result — maps cleanly to HTTP error responses */
export interface ServiceError {
  ok: false;
  error: string;
  message: string;
  status: 400 | 404 | 409;
  details?: unknown;
}

/** Discriminated union for all service returns */
export type ServiceResult<T> = ServiceSuccess<T> | ServiceError;

// ── Convenience constructors ─────────────────────────────────────────────────

export function success<T>(data: T, status: 200 | 201 = 200): ServiceSuccess<T> {
  return { ok: true, data, status };
}

export function notFound(message: string): ServiceError {
  return { ok: false, error: 'NOT_FOUND', message, status: 404 };
}

export function conflict(message: string, error = 'INVALID_STATE'): ServiceError {
  return { ok: false, error, message, status: 409 };
}

export function validationError(message: string, details?: unknown): ServiceError {
  return { ok: false, error: 'VALIDATION_ERROR', message, status: 400, details };
}

export function badRequest(message: string, details?: unknown): ServiceError {
  return { ok: false, error: 'BAD_REQUEST', message, status: 400, details };
}
