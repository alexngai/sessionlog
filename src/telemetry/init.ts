/**
 * Telemetry Initialization
 *
 * Entry point for setting up OpenTelemetry. Reads configuration from
 * sessionlog settings and environment, then conditionally creates the
 * OTel exporter. Returns null when telemetry is disabled, so callers
 * can simply check the result.
 *
 * Configuration resolution order:
 *   1. Explicit OTelSettings argument
 *   2. .sessionlog/settings.json  → otel: { ... }
 *   3. Environment variables (OTEL_EXPORTER_OTLP_ENDPOINT, etc.)
 */

import type { TelemetryExporter, OTelSettings, SamplingConfig } from './types.js';

/**
 * Initialize telemetry if enabled.
 *
 * @param settings - OTel configuration. Pass `{ enabled: false }` to no-op.
 * @returns The exporter instance, or null if disabled / OTel not installed.
 */
export async function initTelemetry(
  settings: OTelSettings,
): Promise<TelemetryExporter | null> {
  if (!settings.enabled) return null;

  try {
    const { createOTelExporter } = await import('./otel-exporter.js');
    return await createOTelExporter(settings);
  } catch (err) {
    if (process.env.SESSIONLOG_DEBUG) {
      console.error('[sessionlog] Failed to initialize OpenTelemetry:', err);
    }
    return null;
  }
}

/**
 * Check whether a session should be sampled based on sampling config.
 * Used by the lifecycle hook to skip telemetry for unsampled sessions.
 */
export function shouldSample(
  config: SamplingConfig | undefined,
  sessionContext: {
    filesTouchedCount?: number;
    totalTokens?: number;
  },
): boolean {
  if (!config) return true;

  // Always-trace thresholds override sampling rate
  if (
    config.alwaysTraceFileThreshold != null &&
    sessionContext.filesTouchedCount != null &&
    sessionContext.filesTouchedCount >= config.alwaysTraceFileThreshold
  ) {
    return true;
  }

  if (
    config.alwaysTraceTokenThreshold != null &&
    sessionContext.totalTokens != null &&
    sessionContext.totalTokens >= config.alwaysTraceTokenThreshold
  ) {
    return true;
  }

  const rate = config.rate ?? 1.0;
  if (rate >= 1.0) return true;
  if (rate <= 0.0) return false;

  return Math.random() < rate;
}
