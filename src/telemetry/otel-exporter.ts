/**
 * OpenTelemetry Exporter Implementation
 *
 * Maps sessionlog lifecycle events to OTel signals:
 *   - Sessions    → Traces  (root span per session)
 *   - Turns       → Spans   (child span per turn within the session trace)
 *   - Tasks       → Spans   (child span per subagent task)
 *   - Tokens      → Metrics (counters + histograms per turn)
 *   - Skill use   → Metrics (counter) + Span event + Log record
 *   - Plan mode   → Span events
 *   - Compaction  → Span event
 *   - User prompt → Span event (length only) + Log record (full text, opt-in)
 *
 * Privacy model (aligned with Codex):
 *   - Traces (spans + span events) contain only aggregate/structural data.
 *     No prompt text, tool arguments, or output content appears on spans.
 *   - Logs may contain sensitive text when logSensitiveData is true.
 *   - This split matches the codex dual-path: trace_safe vs log_only.
 *
 * All @opentelemetry/* imports are dynamic so this file is never loaded
 * unless OTel is explicitly enabled. The OTel SDK packages are optional
 * peer dependencies — sessionlog remains zero-dep at runtime.
 */

import { createRequire } from 'node:module';
import { EventType } from '../types.js';
import type { TelemetryExporter, TelemetryEvent, OTelSettings } from './types.js';
import { SemanticAttributes, MetricNames } from './types.js';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../../package.json') as { version: string };

// ============================================================================
// OTel SDK types (resolved at runtime via dynamic import)
// ============================================================================

type OTelAPI = typeof import('@opentelemetry/api');
type SpanStatusCode = import('@opentelemetry/api').SpanStatusCode;
type Tracer = import('@opentelemetry/api').Tracer;
type Span = import('@opentelemetry/api').Span;
type Meter = import('@opentelemetry/api').Meter;
type Counter = import('@opentelemetry/api').Counter;
type Histogram = import('@opentelemetry/api').Histogram;
// The Logs API lives in @opentelemetry/sdk-logs, not @opentelemetry/api;
// derive the type from the provider so we don't depend on the separate
// @opentelemetry/api-logs package.
type Logger = ReturnType<LoggerProvider['getLogger']>;
type TracerProvider = import('@opentelemetry/sdk-trace-node').NodeTracerProvider;
type MeterProvider = import('@opentelemetry/sdk-metrics').MeterProvider;
type LoggerProvider = import('@opentelemetry/sdk-logs').LoggerProvider;

// ============================================================================
// State
// ============================================================================

interface SessionTrace {
  rootSpan: Span;
  activeTurnSpan?: Span;
  turnStartTime?: number;
  taskSpans: Map<string, Span>;
  startTime: number;
}

// ============================================================================
// Implementation
// ============================================================================

export async function createOTelExporter(settings: OTelSettings): Promise<TelemetryExporter> {
  const api = await loadOTelAPI();
  const spanStatusCode = (await import('@opentelemetry/api')).SpanStatusCode;
  const { tracerProvider, meterProvider, loggerProvider } = await initProviders(settings);

  const tracer: Tracer = tracerProvider.getTracer('sessionlog', getVersion());
  const meter: Meter = meterProvider.getMeter('sessionlog', getVersion());
  const logger: Logger = loggerProvider.getLogger('sessionlog', getVersion());

  const sessions = new Map<string, SessionTrace>();
  let processStartRecorded = false;

  // --- Metrics instruments (created once, reused) ---
  const counters = {
    tokensInput: meter.createCounter(MetricNames.TOKENS_INPUT, {
      description: 'Total input tokens consumed',
    }),
    tokensOutput: meter.createCounter(MetricNames.TOKENS_OUTPUT, {
      description: 'Total output tokens generated',
    }),
    tokensCacheRead: meter.createCounter(MetricNames.TOKENS_CACHE_READ, {
      description: 'Tokens read from prompt cache',
    }),
    tokensCacheCreation: meter.createCounter(MetricNames.TOKENS_CACHE_CREATION, {
      description: 'Tokens written to prompt cache',
    }),
    apiCalls: meter.createCounter(MetricNames.API_CALLS, {
      description: 'Total API calls made',
    }),
    turns: meter.createCounter(MetricNames.TURN_COUNT, {
      description: 'Total turns completed',
    }),
    steps: meter.createCounter(MetricNames.STEPS, {
      description: 'Total checkpoint steps',
    }),
    processStart: meter.createCounter(MetricNames.PROCESS_START, {
      description: 'Process start events',
    }),
    skillCall: meter.createCounter(MetricNames.SKILL_CALL, {
      description: 'Total skill/tool invocations',
    }),
  } satisfies Record<string, Counter>;

  const histograms = {
    sessionDuration: meter.createHistogram(MetricNames.SESSION_DURATION, {
      description: 'Session duration in seconds',
      unit: 's',
    }),
    filesTouched: meter.createHistogram(MetricNames.FILES_TOUCHED, {
      description: 'Files modified per turn',
    }),
    turnDuration: meter.createHistogram(MetricNames.TURN_DURATION, {
      description: 'Turn wall-clock duration',
      unit: 'ms',
    }),
    turnTokenUsage: meter.createHistogram(MetricNames.TURN_TOKEN_USAGE, {
      description: 'Total tokens (input + output) per turn',
    }),
  } satisfies Record<string, Histogram>;

  // --- Common metric attributes for a session ---
  function metricAttrs(event: TelemetryEvent) {
    return {
      [SemanticAttributes.SESSION_AGENT]: event.session.agentType,
      [SemanticAttributes.SESSION_REPO]: settings.resourceAttributes?.['repo'] ?? '',
    };
  }

  // --- Emit handlers by event type ---

  function onSessionStart(event: TelemetryEvent): void {
    // Record process start once per exporter lifetime
    if (!processStartRecorded) {
      counters.processStart.add(1, metricAttrs(event));
      processStartRecorded = true;
    }

    const span = tracer.startSpan(`session ${event.session.agentType}`, {
      attributes: {
        [SemanticAttributes.SESSION_ID]: event.session.sessionID,
        [SemanticAttributes.SESSION_AGENT]: event.session.agentType,
        [SemanticAttributes.SESSION_BASE_COMMIT]: event.session.baseCommit,
        [SemanticAttributes.SESSION_PHASE]: 'active',
      },
    });

    sessions.set(event.session.sessionID, {
      rootSpan: span,
      taskSpans: new Map(),
      startTime: Date.now(),
    });

    logger.emit({
      body: 'Session started',
      attributes: {
        'event.name': 'sessionlog.session_start',
        [SemanticAttributes.SESSION_ID]: event.session.sessionID,
        [SemanticAttributes.SESSION_AGENT]: event.session.agentType,
        [SemanticAttributes.SESSION_BASE_COMMIT]: event.session.baseCommit,
      },
    });
  }

  function onTurnStart(event: TelemetryEvent): void {
    const trace = sessions.get(event.session.sessionID);
    if (!trace) return;

    const ctx = api.trace.setSpan(api.context.active(), trace.rootSpan);
    const turnSpan = tracer.startSpan(
      `turn ${event.session.stepCount}`,
      {
        attributes: {
          [SemanticAttributes.TURN_ID]: event.meta?.turnID ?? '',
          [SemanticAttributes.TURN_STEP_INDEX]: event.session.stepCount,
        },
      },
      ctx,
    );

    trace.activeTurnSpan = turnSpan;
    trace.turnStartTime = Date.now();

    // User prompt — trace-safe: length only (no text on spans)
    if (event.meta?.prompt) {
      const promptLength = event.meta.promptLength ?? event.meta.prompt.length;
      turnSpan.addEvent('sessionlog.user_prompt', {
        [SemanticAttributes.PROMPT_LENGTH]: promptLength,
      });

      // Log-only: include full prompt text if configured
      logger.emit({
        body: settings.logSensitiveData
          ? `User prompt: ${event.meta.prompt}`
          : `User prompt [${promptLength} chars]`,
        attributes: {
          'event.name': 'sessionlog.user_prompt',
          [SemanticAttributes.SESSION_ID]: event.session.sessionID,
          [SemanticAttributes.TURN_ID]: event.meta.turnID ?? '',
          [SemanticAttributes.PROMPT_LENGTH]: promptLength,
          ...(settings.logSensitiveData
            ? { [SemanticAttributes.PROMPT_TEXT]: event.meta.prompt }
            : {}),
        },
      });
    }
  }

  function onTurnEnd(event: TelemetryEvent): void {
    const trace = sessions.get(event.session.sessionID);
    if (!trace?.activeTurnSpan) return;

    const turnSpan = trace.activeTurnSpan;
    const attrs = metricAttrs(event);

    // Turn duration
    const turnDurationMs =
      event.meta?.turnDurationMs ??
      (trace.turnStartTime ? Date.now() - trace.turnStartTime : undefined);
    if (turnDurationMs != null) {
      turnSpan.setAttribute(SemanticAttributes.TURN_DURATION_MS, turnDurationMs);
      histograms.turnDuration.record(turnDurationMs, attrs);
    }

    // Files touched
    const filesCount = event.meta?.turnFilesModified?.length ?? 0;
    turnSpan.setAttribute(SemanticAttributes.TURN_FILES_COUNT, filesCount);
    if (event.meta?.turnFilesModified) {
      turnSpan.setAttribute(
        SemanticAttributes.TURN_FILES_MODIFIED,
        event.meta.turnFilesModified.join(','),
      );
    }
    histograms.filesTouched.record(filesCount, attrs);

    // Token usage
    const tokens = event.meta?.turnTokenUsage;
    if (tokens) {
      turnSpan.setAttribute(SemanticAttributes.TOKENS_INPUT, tokens.inputTokens);
      turnSpan.setAttribute(SemanticAttributes.TOKENS_OUTPUT, tokens.outputTokens);
      turnSpan.setAttribute(SemanticAttributes.TOKENS_CACHE_READ, tokens.cacheReadTokens);
      turnSpan.setAttribute(SemanticAttributes.TOKENS_CACHE_CREATION, tokens.cacheCreationTokens);
      turnSpan.setAttribute(SemanticAttributes.API_CALL_COUNT, tokens.apiCallCount);

      counters.tokensInput.add(tokens.inputTokens, attrs);
      counters.tokensOutput.add(tokens.outputTokens, attrs);
      counters.tokensCacheRead.add(tokens.cacheReadTokens, attrs);
      counters.tokensCacheCreation.add(tokens.cacheCreationTokens, attrs);
      counters.apiCalls.add(tokens.apiCallCount, attrs);

      // Per-turn token distribution histogram
      const totalTurnTokens = tokens.inputTokens + tokens.outputTokens;
      histograms.turnTokenUsage.record(totalTurnTokens, attrs);
    }

    counters.turns.add(1, attrs);
    turnSpan.end();
    trace.activeTurnSpan = undefined;
    trace.turnStartTime = undefined;
  }

  function onSessionEnd(event: TelemetryEvent): void {
    const trace = sessions.get(event.session.sessionID);
    if (!trace) return;

    // Close any dangling turn span
    trace.activeTurnSpan?.end();

    // Close any dangling task spans
    for (const taskSpan of trace.taskSpans.values()) {
      taskSpan.end();
    }

    const durationS = (Date.now() - trace.startTime) / 1000;
    const attrs = metricAttrs(event);

    trace.rootSpan.setAttribute(SemanticAttributes.SESSION_PHASE, 'ended');
    trace.rootSpan.setAttribute('sessionlog.session.step_count', event.session.stepCount);
    trace.rootSpan.setAttribute(
      'sessionlog.session.files_touched_total',
      event.session.filesTouched.length,
    );

    // Set final token totals on root span
    if (event.session.tokenUsage) {
      trace.rootSpan.setAttribute(
        SemanticAttributes.TOKENS_INPUT,
        event.session.tokenUsage.inputTokens,
      );
      trace.rootSpan.setAttribute(
        SemanticAttributes.TOKENS_OUTPUT,
        event.session.tokenUsage.outputTokens,
      );
    }

    // Set error status if the session has an error
    if (event.meta?.errorMessage) {
      trace.rootSpan.setStatus({
        code: spanStatusCode.ERROR,
        message: event.meta.errorMessage,
      });
    }

    histograms.sessionDuration.record(durationS, attrs);
    counters.steps.add(event.session.stepCount, attrs);

    trace.rootSpan.end();
    sessions.delete(event.session.sessionID);
  }

  function onTaskCreate(event: TelemetryEvent): void {
    const trace = sessions.get(event.session.sessionID);
    if (!trace) return;

    const parent = trace.activeTurnSpan ?? trace.rootSpan;
    const ctx = api.trace.setSpan(api.context.active(), parent);

    const taskSpan = tracer.startSpan(
      `task ${event.meta?.taskSubject ?? event.meta?.taskID ?? 'unknown'}`,
      {
        attributes: {
          [SemanticAttributes.TASK_ID]: event.meta?.taskID ?? '',
          [SemanticAttributes.TASK_SUBJECT]: event.meta?.taskSubject ?? '',
          [SemanticAttributes.TASK_STATUS]: event.meta?.taskStatus ?? 'pending',
        },
      },
      ctx,
    );

    if (event.meta?.taskID) {
      trace.taskSpans.set(event.meta.taskID, taskSpan);
    }
  }

  function onTaskUpdate(event: TelemetryEvent): void {
    if (!event.meta?.taskID) return;
    const trace = sessions.get(event.session.sessionID);
    if (!trace) return;
    const taskSpan = trace.taskSpans.get(event.meta.taskID);
    if (!taskSpan) return;

    if (event.meta.taskStatus) {
      taskSpan.setAttribute(SemanticAttributes.TASK_STATUS, event.meta.taskStatus);
    }

    if (event.meta.taskStatus === 'completed') {
      taskSpan.end();
      trace.taskSpans.delete(event.meta.taskID);
    }
  }

  function onSkillUse(event: TelemetryEvent): void {
    const trace = sessions.get(event.session.sessionID);
    const span = trace?.activeTurnSpan ?? trace?.rootSpan;

    const skillName = event.meta?.skillName ?? '';
    const attrs = metricAttrs(event);

    // Trace-safe: span event with name only (no args)
    span?.addEvent('sessionlog.skill_use', {
      [SemanticAttributes.SKILL_NAME]: skillName,
    });

    // Metric: counter per skill invocation
    counters.skillCall.add(1, {
      ...attrs,
      [SemanticAttributes.SKILL_NAME]: skillName,
    });

    // Log record: includes args if sensitive logging is enabled
    logger.emit({
      body: settings.logSensitiveData
        ? `Skill used: ${skillName}(${event.meta?.skillArgs ?? ''})`
        : `Skill used: ${skillName}`,
      attributes: {
        'event.name': 'sessionlog.skill_use',
        [SemanticAttributes.SESSION_ID]: event.session.sessionID,
        [SemanticAttributes.SKILL_NAME]: skillName,
        ...(settings.logSensitiveData && event.meta?.skillArgs
          ? { [SemanticAttributes.SKILL_ARGS]: event.meta.skillArgs }
          : {}),
      },
    });
  }

  function onPlanModeEnter(event: TelemetryEvent): void {
    const trace = sessions.get(event.session.sessionID);
    const span = trace?.activeTurnSpan ?? trace?.rootSpan;
    span?.addEvent('sessionlog.plan_mode_enter');

    logger.emit({
      body: 'Plan mode entered',
      attributes: {
        'event.name': 'sessionlog.plan_mode_enter',
        [SemanticAttributes.SESSION_ID]: event.session.sessionID,
      },
    });
  }

  function onPlanModeExit(event: TelemetryEvent): void {
    const trace = sessions.get(event.session.sessionID);
    const span = trace?.activeTurnSpan ?? trace?.rootSpan;
    span?.addEvent('sessionlog.plan_mode_exit', {
      [SemanticAttributes.PLAN_FILE]: event.meta?.planFilePath ?? '',
    });

    logger.emit({
      body: `Plan mode exited${event.meta?.planFilePath ? `: ${event.meta.planFilePath}` : ''}`,
      attributes: {
        'event.name': 'sessionlog.plan_mode_exit',
        [SemanticAttributes.SESSION_ID]: event.session.sessionID,
        [SemanticAttributes.PLAN_FILE]: event.meta?.planFilePath ?? '',
      },
    });
  }

  function onSubagentStart(event: TelemetryEvent): void {
    const trace = sessions.get(event.session.sessionID);
    if (!trace) return;

    const parent = trace.activeTurnSpan ?? trace.rootSpan;
    const ctx = api.trace.setSpan(api.context.active(), parent);

    const subSpan = tracer.startSpan(
      `subagent ${event.meta?.subagentType ?? 'unknown'}`,
      {
        attributes: {
          [SemanticAttributes.SUBAGENT_TYPE]: event.meta?.subagentType ?? '',
          [SemanticAttributes.TOOL_USE_ID]: event.meta?.toolUseID ?? '',
        },
      },
      ctx,
    );

    if (event.meta?.toolUseID) {
      trace.taskSpans.set(`subagent:${event.meta.toolUseID}`, subSpan);
    }
  }

  function onSubagentEnd(event: TelemetryEvent): void {
    if (!event.meta?.toolUseID) return;
    const trace = sessions.get(event.session.sessionID);
    if (!trace) return;
    const subSpan = trace.taskSpans.get(`subagent:${event.meta.toolUseID}`);
    if (!subSpan) return;

    subSpan.end();
    trace.taskSpans.delete(`subagent:${event.meta.toolUseID}`);
  }

  function onCompaction(event: TelemetryEvent): void {
    const trace = sessions.get(event.session.sessionID);
    const span = trace?.activeTurnSpan ?? trace?.rootSpan;

    span?.addEvent('sessionlog.compaction', {
      [SemanticAttributes.SESSION_ID]: event.session.sessionID,
      ...(event.meta?.checkpointID
        ? { [SemanticAttributes.CHECKPOINT_ID]: event.meta.checkpointID }
        : {}),
      ...(event.meta?.checkpointsCount != null
        ? { [SemanticAttributes.CHECKPOINT_COUNT]: event.meta.checkpointsCount }
        : {}),
    });

    logger.emit({
      body: `Transcript compacted${event.meta?.checkpointID ? ` (checkpoint: ${event.meta.checkpointID})` : ''}`,
      attributes: {
        'event.name': 'sessionlog.compaction',
        [SemanticAttributes.SESSION_ID]: event.session.sessionID,
      },
    });
  }

  // --- Dispatch table ---

  const handlers: Partial<Record<EventType, (event: TelemetryEvent) => void>> = {
    [EventType.SessionStart]: onSessionStart,
    [EventType.TurnStart]: onTurnStart,
    [EventType.TurnEnd]: onTurnEnd,
    [EventType.SessionEnd]: onSessionEnd,
    [EventType.TaskCreate]: onTaskCreate,
    [EventType.TaskUpdate]: onTaskUpdate,
    [EventType.SkillUse]: onSkillUse,
    [EventType.PlanModeEnter]: onPlanModeEnter,
    [EventType.PlanModeExit]: onPlanModeExit,
    [EventType.SubagentStart]: onSubagentStart,
    [EventType.SubagentEnd]: onSubagentEnd,
    [EventType.Compaction]: onCompaction,
  };

  // --- Public interface ---

  return {
    emit(event: TelemetryEvent): void {
      try {
        handlers[event.eventType]?.(event);
      } catch {
        // Telemetry must never break the lifecycle
      }
    },

    async shutdown(): Promise<void> {
      // End any orphaned spans
      for (const trace of sessions.values()) {
        trace.activeTurnSpan?.end();
        for (const taskSpan of trace.taskSpans.values()) {
          taskSpan.end();
        }
        trace.rootSpan.end();
      }
      sessions.clear();

      await Promise.all([
        tracerProvider.shutdown(),
        meterProvider.shutdown(),
        loggerProvider.shutdown(),
      ]);
    },
  };
}

// ============================================================================
// Provider Initialization (dynamic imports)
// ============================================================================

async function loadOTelAPI(): Promise<OTelAPI> {
  try {
    return await import('@opentelemetry/api');
  } catch {
    throw new Error(
      'OpenTelemetry is not installed. Install optional peer dependencies:\n' +
        '  npm install @opentelemetry/api @opentelemetry/sdk-trace-node ' +
        '@opentelemetry/sdk-metrics @opentelemetry/sdk-logs ' +
        '@opentelemetry/exporter-trace-otlp-proto @opentelemetry/exporter-metrics-otlp-proto ' +
        '@opentelemetry/exporter-logs-otlp-proto @opentelemetry/resources',
    );
  }
}

async function initProviders(settings: OTelSettings): Promise<{
  tracerProvider: TracerProvider;
  meterProvider: MeterProvider;
  loggerProvider: LoggerProvider;
}> {
  const [
    { NodeTracerProvider },
    { SimpleSpanProcessor },
    { OTLPTraceExporter },
    { MeterProvider, PeriodicExportingMetricReader },
    { OTLPMetricExporter },
    { LoggerProvider, SimpleLogRecordProcessor },
    { OTLPLogExporter },
    { Resource },
  ] = await Promise.all([
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/sdk-trace-base'),
    import('@opentelemetry/exporter-trace-otlp-proto'),
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/exporter-metrics-otlp-proto'),
    import('@opentelemetry/sdk-logs'),
    import('@opentelemetry/exporter-logs-otlp-proto'),
    import('@opentelemetry/resources'),
  ]);

  const endpoint =
    settings.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  const resource = new Resource({
    'service.name': 'sessionlog',
    'service.version': getVersion(),
    ...settings.resourceAttributes,
  });

  const exporterConfig = {
    url: endpoint,
    headers: settings.headers,
  };

  const tracerProvider = new NodeTracerProvider({ resource });
  tracerProvider.addSpanProcessor(new SimpleSpanProcessor(new OTLPTraceExporter(exporterConfig)));
  tracerProvider.register();

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(exporterConfig),
        exportIntervalMillis: 30_000,
      }),
    ],
  });

  const loggerProvider = new LoggerProvider({ resource });
  loggerProvider.addLogRecordProcessor(
    new SimpleLogRecordProcessor(new OTLPLogExporter(exporterConfig)),
  );

  return { tracerProvider, meterProvider, loggerProvider };
}

function getVersion(): string {
  return PKG_VERSION ?? '0.0.0';
}
