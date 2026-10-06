/**
 * Telemetry — OpenTelemetry SDK Configuration
 *
 * Attaches custom span processors (sanitizer, OTLP dual-export, console) and
 * auto-instrumentations to AppKit's EXISTING global OTel provider.
 *
 * Why not NodeSDK?
 *   AppKit registers the global OTel APIs (context, propagation, trace) during
 *   `createApp()`. A second `NodeSDK.start()` call would attempt duplicate
 *   registration of those globals, producing harmless but noisy errors.
 *   Instead, we retrieve AppKit's provider and extend it in place.
 *
 * The Databricks App platform routes OTel data to Unity Catalog tables
 * via `telemetry_export_destinations` in databricks.yml:
 *   - {catalog}.{schema}.hi_genie_otel_logs
 *   - {catalog}.{schema}.hi_genie_otel_metrics
 *   - {catalog}.{schema}.hi_genie_otel_traces
 *
 * Architecture decisions:
 *   - Decision 9: Both OTel and MLflow 3 tracing required
 *   - Decision 12: Sanitize before export
 */

import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type SpanProcessor,
  type BasicTracerProvider,
} from '@opentelemetry/sdk-trace-base';
import { trace, diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

import { createSanitizingProcessor, type SanitizerOptions } from './sanitizer.js';

// ─── Configuration Types ────────────────────────────────────────────────────

export interface OtelConfig {
  /** OTLP endpoint URL (falls back to OTEL_EXPORTER_OTLP_ENDPOINT env var). */
  readonly otlpEndpoint?: string;
  /** Batch export interval in milliseconds. Default: 5000. */
  readonly exportIntervalMs?: number;
  /** Maximum export batch size. Default: 512. */
  readonly maxExportBatchSize?: number;
  /** Maximum queue size before dropping spans. Default: 2048. */
  readonly maxQueueSize?: number;
  /** Enable console span exporter for local debugging. Default: false. */
  readonly enableConsoleExporter?: boolean;
  /** OTel diagnostic log level. Default: INFO in dev, ERROR in production. */
  readonly diagLogLevel?: DiagLogLevel;
  /** Sanitizer options passed to the sanitizing processor. */
  readonly sanitizerOptions?: SanitizerOptions;
}

// ─── Environment Helpers ────────────────────────────────────────────────────

function env(key: string, fallback?: string): string | undefined {
  return process.env[key] ?? fallback;
}

interface ResolvedConfig {
  readonly otlpEndpoint: string;
  readonly exportIntervalMs: number;
  readonly maxExportBatchSize: number;
  readonly maxQueueSize: number;
  readonly enableConsoleExporter: boolean;
  readonly diagLogLevel: DiagLogLevel;
  readonly sanitizerOptions: SanitizerOptions;
}

function resolveConfig(config: OtelConfig = {}): ResolvedConfig {
  const nodeEnv = env('NODE_ENV', 'production');
  const isDev = nodeEnv === 'development';

  return {
    otlpEndpoint: config.otlpEndpoint ?? env('OTEL_EXPORTER_OTLP_ENDPOINT') ?? '',
    exportIntervalMs: config.exportIntervalMs ?? 5000,
    maxExportBatchSize: config.maxExportBatchSize ?? 512,
    maxQueueSize: config.maxQueueSize ?? 2048,
    enableConsoleExporter: config.enableConsoleExporter ?? isDev,
    diagLogLevel: config.diagLogLevel ?? (isDev ? DiagLogLevel.INFO : DiagLogLevel.ERROR),
    sanitizerOptions: config.sanitizerOptions ?? {},
  };
}

// ─── Provider Resolution ───────────────────────────────────────────────────────

/**
 * Traverses the OTel provider proxy chain to find a provider we can attach
 * span processors to. Handles:
 *   - ProxyTracerProvider (has getDelegate() or _delegate)
 *   - NodeTracerProvider / BasicTracerProvider (has addSpanProcessor directly)
 *   - Providers that expose _activeSpanProcessor or internal processor arrays
 *   - Multi-level wrapping (up to 5 levels deep)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveTracerProvider(provider: any): BasicTracerProvider | null {
  let current = provider;
  const maxDepth = 5;

  for (let i = 0; i < maxDepth; i++) {
    if (!current) return null;

    // Found it — has addSpanProcessor
    if (typeof current.addSpanProcessor === 'function') {
      return current as BasicTracerProvider;
    }

    // Check prototype chain (handles cases where method isn't directly enumerable)
    const proto = Object.getPrototypeOf(current);
    if (proto && typeof proto.addSpanProcessor === 'function') {
      return current as BasicTracerProvider;
    }

    // Try public getDelegate() (OTel API 1.9+)
    if (typeof current.getDelegate === 'function') {
      current = current.getDelegate();
      continue;
    }

    // Try private _delegate (ProxyTracerProvider internal)
    if (current._delegate) {
      current = current._delegate;
      continue;
    }

    // Try _tracerProvider (some SDK wrappers)
    if (current._tracerProvider) {
      current = current._tracerProvider;
      continue;
    }

    // No more traversal paths
    return null;
  }

  return null;
}

/**
 * Builds a human-readable description of the provider chain for diagnostics.
 * Includes available method names on the terminal provider for debugging.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeProviderChain(provider: any): string {
  const chain: string[] = [];
  let current = provider;
  let terminal = provider;
  const maxDepth = 5;

  for (let i = 0; i < maxDepth && current; i++) {
    const name = current?.constructor?.name ?? typeof current;
    const hasAdd = typeof current?.addSpanProcessor === 'function';
    const protoHasAdd = (() => {
      try {
        const p = Object.getPrototypeOf(current);
        return p && typeof p.addSpanProcessor === 'function';
      } catch { return false; }
    })();
    chain.push(`${name}${hasAdd ? '(+direct)' : protoHasAdd ? '(+proto)' : ''}`);
    terminal = current;

    if (typeof current.getDelegate === 'function') {
      current = current.getDelegate();
    } else if (current._delegate) {
      current = current._delegate;
    } else if (current._tracerProvider) {
      current = current._tracerProvider;
    } else {
      break;
    }
  }

  // List methods + properties on the terminal provider for debugging
  try {
    // Prototype methods
    const proto = Object.getPrototypeOf(terminal);
    const methods = proto ? Object.getOwnPropertyNames(proto)
      .filter((n) => typeof proto[n] === 'function' && n !== 'constructor')
      .slice(0, 10) : [];
    if (methods.length > 0) {
      chain.push(`[proto: ${methods.join(', ')}]`);
    }
    // Instance properties (look for processor arrays)
    const ownKeys = Object.getOwnPropertyNames(terminal)
      .filter((n) => n.includes('processor') || n.includes('Processor') || n.includes('_span'))
      .slice(0, 10);
    if (ownKeys.length > 0) {
      chain.push(`[instance: ${ownKeys.join(', ')}]`);
    }
    // Full prototype chain method search
    let p = Object.getPrototypeOf(terminal);
    const allMethods: string[] = [];
    let depth = 0;
    while (p && depth < 4) {
      const names = Object.getOwnPropertyNames(p)
        .filter((n) => typeof p[n] === 'function' && n !== 'constructor');
      if (names.length > 0) allMethods.push(`L${depth}:[${names.slice(0, 8).join(',')}]`);
      p = Object.getPrototypeOf(p);
      depth++;
    }
    if (allMethods.length > 0) {
      chain.push(`[chain: ${allMethods.join(' ')}]`);
    }
  } catch { /* ignore */ }

  return chain.join(' \u2192 ');
}

/**
 * Unwraps a provider to its terminal node (deepest in the proxy chain),
 * regardless of whether it has addSpanProcessor.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapToTerminal(provider: any): any {
  let current = provider;
  const maxDepth = 5;

  for (let i = 0; i < maxDepth; i++) {
    if (typeof current?.getDelegate === 'function') {
      current = current.getDelegate();
    } else if (current?._delegate) {
      current = current._delegate;
    } else if (current?._tracerProvider) {
      current = current._tracerProvider;
    } else {
      break;
    }
  }
  return current;
}

/**
 * Resolves the best available function to add a SpanProcessor to a provider.
 * Tries (in order):
 *   1. Public `addSpanProcessor()` method
 *   2. Prototype-inherited `addSpanProcessor()`
 *   3. Direct push to `_registeredSpanProcessors` array (OTel SDK internal)
 *   4. Direct push to `_spanProcessors` array (alternative internal)
 *
 * Returns a function that accepts a SpanProcessor, or null if no path works.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveAddProcessorFn(provider: any): ((proc: SpanProcessor) => void) | null {
  if (!provider) return null;

  // Strategy 1: Public method on instance or prototype chain
  if (typeof provider.addSpanProcessor === 'function') {
    return (proc) => provider.addSpanProcessor(proc);
  }

  // Strategy 2: Check full prototype chain explicitly
  let proto = Object.getPrototypeOf(provider);
  while (proto) {
    if (typeof proto.addSpanProcessor === 'function') {
      return (proc) => proto.addSpanProcessor.call(provider, proc);
    }
    proto = Object.getPrototypeOf(proto);
  }

  // Strategy 3: Internal _registeredSpanProcessors array (BasicTracerProvider)
  if (Array.isArray(provider._registeredSpanProcessors)) {
    console.log('[otel] Using internal _registeredSpanProcessors array injection.');
    return (proc) => provider._registeredSpanProcessors.push(proc);
  }

  // Strategy 4: Internal _spanProcessors array
  if (Array.isArray(provider._spanProcessors)) {
    console.log('[otel] Using internal _spanProcessors array injection.');
    return (proc) => provider._spanProcessors.push(proc);
  }

  // Strategy 5: _activeSpanProcessor with _spanProcessors (MultiSpanProcessor)
  if (provider._activeSpanProcessor && Array.isArray(provider._activeSpanProcessor._spanProcessors)) {
    console.log('[otel] Using _activeSpanProcessor._spanProcessors injection.');
    return (proc) => provider._activeSpanProcessor._spanProcessors.push(proc);
  }

  return null;
}

/**
 * Wraps the platform's existing span processors with a sanitizer so that
 * ALL spans (including those exported to UC tables) are sanitized before export.
 *
 * Looks for `_activeSpanProcessor._spanProcessors` (MultiSpanProcessor) and
 * replaces each processor with a sanitizer wrapper.
 *
 * @returns true if platform processors were successfully wrapped.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapPlatformProcessors(provider: any, sanitizerOptions: SanitizerOptions): boolean {
  if (!provider) return false;

  // Try _activeSpanProcessor._spanProcessors (MultiSpanProcessor pattern)
  const multiProc = provider._activeSpanProcessor;
  if (multiProc && Array.isArray(multiProc._spanProcessors) && multiProc._spanProcessors.length > 0) {
    const original = [...multiProc._spanProcessors];
    multiProc._spanProcessors.length = 0; // clear
    for (const proc of original) {
      const wrapped = createSanitizingProcessor(proc, sanitizerOptions);
      multiProc._spanProcessors.push(wrapped);
    }
    console.log(
      `[otel] Wrapped ${original.length} platform processor(s) with sanitizer. ` +
      'All spans (including UC table export) are now sanitized.',
    );
    return true;
  }

  // Try _registeredSpanProcessors array directly
  if (Array.isArray(provider._registeredSpanProcessors) && provider._registeredSpanProcessors.length > 0) {
    const original = [...provider._registeredSpanProcessors];
    provider._registeredSpanProcessors.length = 0;
    for (const proc of original) {
      const wrapped = createSanitizingProcessor(proc, sanitizerOptions);
      provider._registeredSpanProcessors.push(wrapped);
    }
    console.log(
      `[otel] Wrapped ${original.length} registered processor(s) with sanitizer.`,
    );
    return true;
  }

  console.warn(
    '[otel] No platform processors found to wrap. ' +
    `Provider keys: ${Object.getOwnPropertyNames(provider).filter((k) => k.includes('rocess') || k.includes('span')).join(', ') || 'none'}`,
  );
  return false;
}

// ─── State ──────────────────────────────────────────────────────────────────

let initialized = false;
let processors: SpanProcessor[] = [];

/**
 * Extends AppKit's existing OTel provider with custom span processors and
 * auto-instrumentations. Does NOT create a new NodeSDK or register globals.
 *
 * AppKit registers the global OTel APIs (context, trace, propagation) during
 * `createApp()`. This function:
 *   1. Retrieves the existing global TracerProvider
 *   2. Attaches sanitizing + optional OTLP/console BatchSpanProcessors to it
 *   3. Registers auto-instrumentations (HTTP, Express, pg) via the
 *      `registerInstrumentations()` helper (module-level patching, no globals)
 *
 * The Databricks App platform's telemetry sidecar handles primary export to
 * Unity Catalog tables (via `telemetry_export_destinations`). Our processors
 * add sanitization and optional dual-export.
 *
 * @param config - Optional configuration overrides
 * @throws Never — logs warnings on failure, never crashes the app
 */
export function initializeOtelSdk(config?: OtelConfig): void {
  if (initialized) {
    console.warn('[otel] Already initialized, skipping.');
    return;
  }

  const resolved = resolveConfig(config);

  // Configure diagnostic logging
  diag.setLogger(new DiagConsoleLogger(), resolved.diagLogLevel);

  // ── Step 1: Get AppKit's existing tracer provider ───────────────────────
  const globalProvider = trace.getTracerProvider();

  // AppKit's provider is a sealed NodeTracerProvider that does NOT expose
  // addSpanProcessor(). We resolve it and attempt to inject into its internal
  // processor arrays (or use addSpanProcessor if the public API is available).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolvedProvider = resolveTracerProvider(globalProvider as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawProvider = resolvedProvider ?? unwrapToTerminal(globalProvider as any);

  const addProcessor = resolveAddProcessorFn(rawProvider);

  if (!addProcessor) {
    console.warn(
      '[otel] Could not find a way to inject span processors into the global provider. ' +
      'Custom processors (sanitizer, OTLP) will NOT be active. ' +
      'Platform-level export via telemetry_export_destinations still works. ' +
      `Provider chain: ${describeProviderChain(globalProvider)}`,
    );
  }

  // ── Step 2: Build and attach span processors ────────────────────────────
  processors = [];

  // OTLP dual-export: ONLY when explicitly configured via OtelConfig.otlpEndpoint
  // (not from OTEL_EXPORTER_OTLP_ENDPOINT env var, which is the platform sidecar's
  // endpoint — we already sanitize that path by wrapping the platform processor).
  const explicitOtlpEndpoint = config?.otlpEndpoint;
  if (explicitOtlpEndpoint && explicitOtlpEndpoint.startsWith('http')) {
    const otlpExporter = new OTLPTraceExporter({
      url: `${explicitOtlpEndpoint}/v1/traces`,
      headers: buildExporterHeaders(),
    });

    const batchProcessor = new BatchSpanProcessor(otlpExporter, {
      scheduledDelayMillis: resolved.exportIntervalMs,
      maxExportBatchSize: resolved.maxExportBatchSize,
      maxQueueSize: resolved.maxQueueSize,
    });

    // Wrap with sanitizing processor
    const sanitizedProcessor = createSanitizingProcessor(
      batchProcessor,
      resolved.sanitizerOptions,
    );
    processors.push(sanitizedProcessor);
  }

  // Console exporter for development debugging
  if (resolved.enableConsoleExporter) {
    const consoleExporter = new ConsoleSpanExporter();
    const consoleBatch = new BatchSpanProcessor(consoleExporter, {
      scheduledDelayMillis: 1000,
      maxExportBatchSize: 10,
    });
    const sanitizedConsole = createSanitizingProcessor(
      consoleBatch,
      resolved.sanitizerOptions,
    );
    processors.push(sanitizedConsole);
  }

  // ── Step 2b: Wrap platform processors with sanitizer ─────────────────────
  // The platform's telemetry sidecar exports to UC tables via its own
  // processors in _activeSpanProcessor._spanProcessors. To sanitize ALL
  // spans (including those going to UC tables), we wrap each existing
  // platform processor with our sanitizer.
  const platformWrapped = wrapPlatformProcessors(rawProvider, resolved.sanitizerOptions);

  // Attach any additional custom processors (OTLP dual-export, console)
  if (addProcessor && processors.length > 0) {
    for (const proc of processors) {
      addProcessor(proc);
    }
    console.log(`[otel] Attached ${processors.length} custom processor(s) to AppKit provider.`);
  } else if (processors.length > 0) {
    console.warn(
      `[otel] Built ${processors.length} processor(s) but could NOT attach them. ` +
      'Sanitizer is NOT active on the secondary export path.',
    );
  }

  if (!platformWrapped && processors.length === 0) {
    console.warn(
      '[otel] Sanitizer is NOT active: no platform processors wrapped, no custom processors attached.',
    );
  }

  // ── Step 3: Register auto-instrumentations ──────────────────────────────
  // These patch Node.js modules (http, express, pg) at the module level.
  // They use the already-registered global tracer provider — no new provider
  // registration needed.
  registerInstrumentations({
    instrumentations: [
      getNodeAutoInstrumentations({
        // HTTP instrumentation: capture incoming and outgoing requests
        '@opentelemetry/instrumentation-http': {
          enabled: true,
          ignoreIncomingRequestHook: (request) => {
            // Skip health checks from tracing
            return request.url === '/healthz';
          },
          // Note: Headers are NOT captured by default (privacy-first).
          // The sanitizer still processes all span attributes, redacting any
          // sensitive values that appear in custom attributes set by app code.
        },
        // Express instrumentation: route-level spans
        '@opentelemetry/instrumentation-express': {
          enabled: true,
        },
        // pg instrumentation: Lakebase query spans
        '@opentelemetry/instrumentation-pg': {
          enabled: true,
          enhancedDatabaseReporting: false, // Don't capture full SQL by default
          addSqlCommenterCommentToQueries: true,
        },
        // Disable instrumentations we don't need
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });

  initialized = true;
  console.log(
    `[otel] Initialized (piggyback mode): ` +
    `processors=${processors.length}, ` +
    `otlp=${explicitOtlpEndpoint ? 'dual-export' : 'platform-only'}, ` +
    `platformWrapped=${platformWrapped}, ` +
    `instrumentations=http+express+pg`,
  );
}

/**
 * Gracefully shuts down custom processors, flushing pending spans.
 * Does NOT shut down AppKit's provider — that's managed by the platform.
 */
export async function shutdownOtelSdk(): Promise<void> {
  if (!initialized) {
    console.warn('[otel] Not initialized, nothing to shut down.');
    return;
  }

  try {
    // Force flush then shut down each processor we added
    await Promise.all(processors.map((p) => p.forceFlush()));
    await Promise.all(processors.map((p) => p.shutdown()));
    console.log('[otel] Custom processors shut down successfully.');
  } catch (err) {
    console.error('[otel] Error during processor shutdown:', err);
  } finally {
    processors = [];
    initialized = false;
  }
}

/**
 * Force-flushes all custom span processors without shutting down.
 * Useful before critical operations or on-demand export.
 */
export async function flushOtelSpans(): Promise<void> {
  if (!initialized || processors.length === 0) return;
  try {
    await Promise.all(processors.map((p) => p.forceFlush()));
  } catch (err) {
    console.error('[otel] Error during span flush:', err);
  }
}

// ─── Internal Helpers ──────────────────────────────────────────────────────

function buildExporterHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  // The Databricks platform injects auth headers for App-to-App telemetry.
  // Additional headers can be configured via OTEL_EXPORTER_OTLP_HEADERS.
  const envHeaders = env('OTEL_EXPORTER_OTLP_HEADERS');
  if (envHeaders) {
    for (const pair of envHeaders.split(',')) {
      const [key, ...rest] = pair.split('=');
      if (key && rest.length > 0) {
        headers[key.trim()] = rest.join('=').trim();
      }
    }
  }

  return headers;
}
