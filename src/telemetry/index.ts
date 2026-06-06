/**
 * Telemetry Module
 *
 * Optional OpenTelemetry integration for remote monitoring of agent sessions.
 * All OTel SDK dependencies are loaded dynamically — this module has zero
 * impact when telemetry is disabled.
 *
 * Quick start:
 *
 *   import { initTelemetry } from 'sessionlog/telemetry';
 *
 *   const exporter = await initTelemetry({ enabled: true });
 *   if (exporter) {
 *     const lifecycle = wrapWithTelemetry({ inner, exporter, sessionStore });
 *   }
 */

export type {
  OTelSettings,
  SamplingConfig,
  TelemetryEvent,
  TelemetryEventMeta,
  TelemetryExporter,
  TelemetryExporterFactory,
} from './types.js';

export { SemanticAttributes, MetricNames } from './types.js';

export { createOTelExporter } from './otel-exporter.js';

export { wrapWithTelemetry, type TelemetryLifecycleConfig } from './lifecycle-hook.js';

export { initTelemetry } from './init.js';
