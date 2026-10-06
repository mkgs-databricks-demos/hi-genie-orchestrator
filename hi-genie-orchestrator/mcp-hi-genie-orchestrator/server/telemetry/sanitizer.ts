/**
 * Telemetry — Sensitive Data Sanitization SpanProcessor
 *
 * Applied in the OTel processing pipeline before any exporter. Ensures that
 * OAuth tokens, bearer tokens, API keys, auth headers, sensitive SQL literals,
 * and secrets never leave the process boundary.
 *
 * Factory: createSanitizingProcessor(options?)
 *
 * Architecture decisions:
 *   - Decision 12: Trace data must be sanitized before export
 *   - Requirements: Never persist/log/trace OAuth access tokens
 *   - Safe attributes: tool name, status, latency, request_id, session_id,
 *     workstream_id, record counts, payload sizes, sanitized error classes
 */

import type {
  SpanProcessor,
  ReadableSpan,
  Span,
} from '@opentelemetry/sdk-trace-base';
import type { Context } from '@opentelemetry/api';

// ─── Configuration ──────────────────────────────────────────────────────────

export interface SanitizerOptions {
  /** Additional header names to redact (case-insensitive). */
  readonly additionalRedactedHeaders?: readonly string[];
  /** Attribute key patterns to always allow through (regex). */
  readonly allowlistPatterns?: readonly RegExp[];
  /** Attribute key patterns to always redact (regex). Applied after allowlist. */
  readonly denylistPatterns?: readonly RegExp[];
  /** Replacement string for redacted values. */
  readonly redactionMarker?: string;
}

const DEFAULT_REDACTION_MARKER = '[REDACTED]';

// ─── Redaction Patterns ─────────────────────────────────────────────────────

/** Header names that are always redacted (lowercase for comparison). */
const REDACTED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'x-forwarded-access-token',
  'x-databricks-token',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
]);

/** Patterns matching sensitive values in attribute strings. */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  // Bearer/OAuth tokens
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // Generic API key patterns (32+ hex/base64 chars)
  /(?:api[_-]?key|token|secret|password|credential)[\s:="']+[A-Za-z0-9\-._~+/]{16,}/gi,
  // Databricks PAT tokens
  /dapi[a-f0-9]{32}/gi,
  // Connection strings with embedded credentials
  /(?:postgres|postgresql|mysql|redis|amqp):\/\/[^\s@]+:[^\s@]+@/gi,
  // AWS-style keys
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
  // JSON web tokens (3 base64 segments)
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

/** Attribute key patterns that indicate sensitive content. */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /password/i,
  /secret/i,
  /token/i,
  /credential/i,
  /auth/i,
  /\bkey\b/i,
  /connection_string/i,
  /dsn/i,
];

/** SQL literal patterns to mask (passwords, connection strings in SQL). */
const SQL_SENSITIVE_PATTERNS: readonly RegExp[] = [
  // PASSWORD 'value' or PASSWORD "value"
  /PASSWORD\s*[=:]?\s*['"][^'"]*['"]/gi,
  // CONNECTION_STRING or CONN_STR assignments
  /(?:CONNECTION_STRING|CONN_STR|DSN)\s*[=:]?\s*['"][^'"]*['"]/gi,
  // SECRET assignments
  /SECRET\s*[=:]?\s*['"][^'"]*['"]/gi,
];

// ─── Sanitization Logic ─────────────────────────────────────────────────────

function isAllowlisted(key: string, allowlist: readonly RegExp[]): boolean {
  return allowlist.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(key);
  });
}

function isDenylisted(key: string, denylist: readonly RegExp[]): boolean {
  return denylist.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(key);
  });
}

function isHeaderAttribute(key: string): boolean {
  return key.startsWith('http.request.header.') ||
    key.startsWith('http.response.header.') ||
    key.startsWith('rpc.request.metadata.') ||
    key.startsWith('rpc.response.metadata.');
}

function extractHeaderName(key: string): string {
  const parts = key.split('.');
  return parts[parts.length - 1].toLowerCase();
}

function isSensitiveHeader(
  key: string,
  additionalHeaders: ReadonlySet<string>,
): boolean {
  if (!isHeaderAttribute(key)) return false;
  const headerName = extractHeaderName(key);
  return REDACTED_HEADERS.has(headerName) || additionalHeaders.has(headerName);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(key);
  });
}

function sanitizeStringValue(
  value: string,
  redactionMarker: string,
): string {
  let sanitized = value;

  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, redactionMarker);
  }

  for (const pattern of SQL_SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, (match) => {
      const quoteIndex = match.search(/['"]/);
      if (quoteIndex >= 0) {
        return match.substring(0, quoteIndex) + `'${redactionMarker}'`;
      }
      return redactionMarker;
    });
  }

  return sanitized;
}

function sanitizeAttributeValue(
  key: string,
  value: unknown,
  options: Required<SanitizerOptions>,
): unknown {
  const {
    allowlistPatterns,
    denylistPatterns,
    redactionMarker,
    additionalRedactedHeaders,
  } = options;

  // Check allowlist first — always pass through
  if (isAllowlisted(key, allowlistPatterns)) {
    return value;
  }

  // Check denylist — always redact
  if (isDenylisted(key, denylistPatterns)) {
    return redactionMarker;
  }

  const additionalSet = new Set(
    (additionalRedactedHeaders ?? []).map((h) => h.toLowerCase()),
  );

  // Redact known sensitive headers
  if (isSensitiveHeader(key, additionalSet)) {
    return redactionMarker;
  }

  // Redact attributes with sensitive key names
  if (isSensitiveKey(key)) {
    return redactionMarker;
  }

  // For string values, apply content-level sanitization
  if (typeof value === 'string') {
    return sanitizeStringValue(value, redactionMarker);
  }

  // For arrays of strings, sanitize each element
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') {
        return sanitizeStringValue(item, redactionMarker);
      }
      return item;
    });
  }

  return value;
}

// ─── SpanProcessor Implementation ──────────────────────────────────────────

/**
 * A SpanProcessor that sanitizes span attributes and events before they
 * reach any downstream exporter. Applied as a wrapping processor in the
 * OTel pipeline.
 */
class SanitizingSpanProcessor implements SpanProcessor {
  private readonly options: Required<SanitizerOptions>;
  private readonly inner: SpanProcessor;

  constructor(inner: SpanProcessor, options: SanitizerOptions = {}) {
    this.inner = inner;
    this.options = {
      additionalRedactedHeaders: options.additionalRedactedHeaders ?? [],
      allowlistPatterns: options.allowlistPatterns ?? [],
      denylistPatterns: options.denylistPatterns ?? [],
      redactionMarker: options.redactionMarker ?? DEFAULT_REDACTION_MARKER,
    };
  }

  onStart(span: Span, parentContext: Context): void {
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    const sanitizedSpan = this.sanitizeSpan(span);
    this.inner.onEnd(sanitizedSpan);
  }

  async shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  async forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  private sanitizeSpan(span: ReadableSpan): ReadableSpan {
    const originalAttributes = span.attributes;
    const sanitizedAttributes: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(originalAttributes)) {
      sanitizedAttributes[key] = sanitizeAttributeValue(
        key,
        value,
        this.options,
      );
    }

    // Sanitize event attributes
    const sanitizedEvents = span.events.map((event) => {
      if (!event.attributes) return event;
      const sanitizedEventAttrs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(event.attributes)) {
        sanitizedEventAttrs[key] = sanitizeAttributeValue(
          key,
          value,
          this.options,
        );
      }
      return { ...event, attributes: sanitizedEventAttrs };
    });

    // Return a Proxy that delegates all methods/properties to the original span
    // but overrides `attributes` and `events` with sanitized versions.
    // This preserves spanContext(), duration, name, etc. on the prototype.
    return new Proxy(span, {
      get(target, prop, receiver) {
        if (prop === 'attributes') return sanitizedAttributes;
        if (prop === 'events') return sanitizedEvents;
        const value = Reflect.get(target, prop, receiver);
        // Bind methods to the original target so `this` context is correct
        if (typeof value === 'function') return value.bind(target);
        return value;
      },
    });
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Creates a sanitizing SpanProcessor that wraps an inner processor.
 * All span attributes and events are sanitized before reaching the
 * inner processor's onEnd.
 *
 * @param inner - The downstream SpanProcessor (e.g., BatchSpanProcessor)
 * @param options - Optional sanitization configuration
 * @returns A SpanProcessor that sanitizes before delegating
 *
 * @example
 * ```typescript
 * const exporter = new OTLPTraceExporter({ url: endpoint });
 * const batchProcessor = new BatchSpanProcessor(exporter);
 * const processor = createSanitizingProcessor(batchProcessor, {
 *   additionalRedactedHeaders: ['x-custom-secret'],
 * });
 * ```
 */
export function createSanitizingProcessor(
  inner: SpanProcessor,
  options?: SanitizerOptions,
): SpanProcessor {
  return new SanitizingSpanProcessor(inner, options);
}

// ─── Utility Exports ────────────────────────────────────────────────────────

/** Exported for testing — sanitize a single attribute value. */
export function sanitizeAttribute(
  key: string,
  value: unknown,
  options?: Partial<SanitizerOptions>,
): unknown {
  const resolved: Required<SanitizerOptions> = {
    additionalRedactedHeaders: options?.additionalRedactedHeaders ?? [],
    allowlistPatterns: options?.allowlistPatterns ?? [],
    denylistPatterns: options?.denylistPatterns ?? [],
    redactionMarker: options?.redactionMarker ?? DEFAULT_REDACTION_MARKER,
  };
  return sanitizeAttributeValue(key, value, resolved);
}
