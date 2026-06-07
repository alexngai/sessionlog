/**
 * OpenTelemetry Integration Types
 *
 * Defines the exporter interface and configuration for optional
 * OpenTelemetry-based remote monitoring of agent sessions.
 *
 * Design principles:
 *   - OTel SDK is an optional peer dependency (dynamic import)
 *   - Zero impact when disabled — no imports, no overhead
 *   - Pluggable: users can supply their own TelemetryExporter
 *   - Redaction runs before any data leaves the process
 *   - Privacy: sensitive data (prompts, tool args) only in logs, never traces
 */

import type { EventType, SessionState, TokenUsage } from '../types.js';

// ============================================================================
// Configuration
// ============================================================================

export interface OTelSettings {
  /** Master switch. When false, no OTel code is loaded. */
  enabled: boolean;

  /**
   * OTLP endpoint URL.
   * Defaults to OTEL_EXPORTER_OTLP_ENDPOINT or 'http://localhost:4318'.
   */
  endpoint?: string;

  /**
   * OTLP transport protocol.
   * 'http/protobuf' is the most widely supported default.
   */
  protocol?: 'grpc' | 'http/protobuf' | 'http/json';

  /** Headers sent with every OTLP request (e.g. API keys). */
  headers?: Record<string, string>;

  /** OTel resource attributes merged into every signal. */
  resourceAttributes?: Record<string, string>;

  /**
   * Which signal types to export.
   * Defaults to all three when omitted.
   */
  signals?: {
    traces?: boolean;
    metrics?: boolean;
    logs?: boolean;
  };

  /**
   * Session sampling configuration.
   * Controls which sessions generate trace data to manage cost.
   */
  sampling?: SamplingConfig;

  /**
   * When true, include full prompt text and tool arguments in log records.
   * Traces never include sensitive text regardless of this setting.
   * Default: false.
   */
  logSensitiveData?: boolean;
}

export interface SamplingConfig {
  /** Sample rate between 0.0 and 1.0 (1.0 = every session). Default: 1.0 */
  rate?: number;

  /** Always trace sessions that touch more than N files. */
  alwaysTraceFileThreshold?: number;

  /** Always trace sessions that exceed this token count. */
  alwaysTraceTokenThreshold?: number;
}

// ============================================================================
// Telemetry Events (internal signal format)
// ============================================================================

/**
 * A telemetry event is the unit of data passed from the lifecycle handler
 * to the exporter. It carries the raw session + event data; the exporter
 * maps it to OTel signals.
 */
export interface TelemetryEvent {
  /** The lifecycle event type that triggered this. */
  eventType: EventType;

  /** Full session state snapshot at time of event. */
  session: Readonly<SessionState>;

  /** ISO timestamp of the event. */
  timestamp: string;

  /** Event-specific metadata (varies by event type). */
  meta?: TelemetryEventMeta;
}

export interface TelemetryEventMeta {
  /** Turn ID for TurnStart/TurnEnd events. */
  turnID?: string;

  /** User prompt text (TurnStart only, already truncated to 500 chars). */
  prompt?: string;

  /** Character length of the full user prompt (before truncation). */
  promptLength?: number;

  /** Token usage delta for this turn (TurnEnd only). */
  turnTokenUsage?: TokenUsage;

  /** Files modified in this turn (TurnEnd only). */
  turnFilesModified?: string[];

  /** Turn wall-clock duration in milliseconds (TurnEnd only). */
  turnDurationMs?: number;

  /** Task info for TaskCreate/TaskUpdate events. */
  taskID?: string;
  taskSubject?: string;
  taskStatus?: string;

  /** Subagent info for SubagentStart/SubagentEnd events. */
  subagentType?: string;
  toolUseID?: string;

  /** Skill info for SkillUse events. */
  skillName?: string;
  skillArgs?: string;

  /** Plan mode info. */
  planFilePath?: string;

  /** Error message when an event indicates failure. */
  errorMessage?: string;

  /** Checkpoint committed info (Compaction / postCommit context). */
  checkpointID?: string;
  checkpointsCount?: number;
}

// ============================================================================
// Exporter Interface
// ============================================================================

/**
 * The TelemetryExporter is the boundary between sessionlog and OTel.
 *
 * Sessionlog calls emit() on every lifecycle event. The exporter is
 * responsible for mapping TelemetryEvents to OTel signals (traces,
 * metrics, logs) and shipping them via OTLP.
 *
 * Implementations must be non-blocking — emit() should not throw
 * or delay the lifecycle handler.
 */
export interface TelemetryExporter {
  /** Process a lifecycle event. Must not throw. */
  emit(event: TelemetryEvent): void;

  /**
   * Flush pending data and release resources.
   * Called on SessionEnd and process exit.
   */
  shutdown(): Promise<void>;
}

/**
 * Factory function type for creating a TelemetryExporter.
 * Receives resolved settings and returns a ready exporter.
 */
export type TelemetryExporterFactory = (settings: OTelSettings) => Promise<TelemetryExporter>;

// ============================================================================
// Semantic Convention Constants
// ============================================================================

/**
 * Attribute keys following OTel semantic conventions.
 * Prefixed with `sessionlog.` for project-specific attributes,
 * and using `gen_ai.*` where aligned with the OTel GenAI SIG.
 *
 * Privacy rule: attributes marked "trace-safe" appear on spans.
 * Attributes marked "log-only" appear only in log records.
 */
export const SemanticAttributes = {
  // --- Resource-level ---
  SERVICE_NAME: 'service.name',
  SERVICE_VERSION: 'service.version',

  // --- Session (trace-level, trace-safe) ---
  SESSION_ID: 'sessionlog.session.id',
  SESSION_PHASE: 'sessionlog.session.phase',
  SESSION_AGENT: 'gen_ai.system',
  SESSION_BASE_COMMIT: 'sessionlog.session.base_commit',
  SESSION_BRANCH: 'sessionlog.session.branch',
  SESSION_REPO: 'sessionlog.session.repo',

  // --- Turn (span-level, trace-safe) ---
  TURN_ID: 'sessionlog.turn.id',
  TURN_STEP_INDEX: 'sessionlog.turn.step_index',
  TURN_FILES_MODIFIED: 'sessionlog.turn.files_modified',
  TURN_FILES_COUNT: 'sessionlog.turn.files_count',
  TURN_DURATION_MS: 'sessionlog.turn.duration_ms',

  // --- Token usage (trace-safe, on spans + metrics) ---
  TOKENS_INPUT: 'gen_ai.usage.input_tokens',
  TOKENS_OUTPUT: 'gen_ai.usage.output_tokens',
  TOKENS_CACHE_READ: 'gen_ai.usage.cache_read.input_tokens',
  TOKENS_CACHE_CREATION: 'sessionlog.tokens.cache_creation',
  API_CALL_COUNT: 'sessionlog.api_call_count',

  // --- User prompt (trace-safe: length only; log-only: text) ---
  PROMPT_LENGTH: 'sessionlog.prompt.length',
  PROMPT_TEXT: 'sessionlog.prompt.text',

  // --- Task/subagent (child span, trace-safe) ---
  TASK_ID: 'sessionlog.task.id',
  TASK_SUBJECT: 'sessionlog.task.subject',
  TASK_STATUS: 'sessionlog.task.status',
  SUBAGENT_TYPE: 'sessionlog.subagent.type',
  TOOL_USE_ID: 'sessionlog.tool_use_id',

  // --- Skill / tool (trace-safe: name; log-only: args) ---
  SKILL_NAME: 'sessionlog.skill.name',
  SKILL_ARGS: 'sessionlog.skill.args',

  // --- Plan mode (span event, trace-safe) ---
  PLAN_FILE: 'sessionlog.plan.file_path',

  // --- Checkpoint (trace-safe) ---
  CHECKPOINT_ID: 'sessionlog.checkpoint.id',
  CHECKPOINT_COUNT: 'sessionlog.checkpoint.count',

  // --- Error (trace-safe) ---
  ERROR_MESSAGE: 'error.message',
} as const;

// ============================================================================
// Metric Names
// ============================================================================

export const MetricNames = {
  // Token counters
  TOKENS_INPUT: 'sessionlog.tokens.input',
  TOKENS_OUTPUT: 'sessionlog.tokens.output',
  TOKENS_CACHE_READ: 'sessionlog.tokens.cache_read',
  TOKENS_CACHE_CREATION: 'sessionlog.tokens.cache_creation',
  API_CALLS: 'sessionlog.api_calls',

  // Token histogram (per-turn distribution)
  TURN_TOKEN_USAGE: 'sessionlog.turn.token_usage',

  // Session-level
  SESSION_DURATION: 'sessionlog.session.duration_seconds',
  PROCESS_START: 'sessionlog.process.start',

  // Turn-level
  TURN_COUNT: 'sessionlog.turns',
  TURN_DURATION: 'sessionlog.turn.duration_ms',

  // File-level
  FILES_TOUCHED: 'sessionlog.files_touched',

  // Checkpoint-level
  STEPS: 'sessionlog.steps',

  // Skill/tool
  SKILL_CALL: 'sessionlog.skill.call',
} as const;
