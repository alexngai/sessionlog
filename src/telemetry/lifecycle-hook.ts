/**
 * Lifecycle Telemetry Hook
 *
 * Wraps a LifecycleHandler to emit telemetry events alongside the
 * normal lifecycle dispatch. This is the integration seam — it sits
 * between the agent hooks and the lifecycle handler, intercepting
 * events and forwarding them to the TelemetryExporter.
 *
 * Usage:
 *   const lifecycle = createLifecycleHandler(config);
 *   const withTelemetry = wrapWithTelemetry(lifecycle, exporter);
 *   // use withTelemetry.dispatch() instead of lifecycle.dispatch()
 */

import type { Event, SessionState } from '../types.js';
import { EventType } from '../types.js';
import type { Agent } from '../agent/types.js';
import type { SessionStore } from '../store/session-store.js';
import type { LifecycleHandler } from '../hooks/lifecycle.js';
import type { TelemetryExporter, TelemetryEvent, TelemetryEventMeta } from './types.js';

export interface TelemetryLifecycleConfig {
  /** The inner lifecycle handler to delegate to. */
  inner: LifecycleHandler;

  /** The telemetry exporter to emit events to. */
  exporter: TelemetryExporter;

  /** Session store for reading state snapshots. */
  sessionStore: SessionStore;
}

interface TurnSnapshot {
  inputTokens: number;
  outputTokens: number;
  startTime: number;
}

/**
 * Wrap a LifecycleHandler with telemetry emission.
 *
 * The wrapper calls the inner handler first (so session state is updated),
 * then reads the updated state and emits a TelemetryEvent. For SessionStart,
 * the telemetry event fires after the state is created. For SessionEnd,
 * it fires before shutdown.
 */
export function wrapWithTelemetry(config: TelemetryLifecycleConfig): LifecycleHandler {
  const { inner, exporter, sessionStore } = config;

  // Track per-turn state for delta calculation
  const turnSnapshots = new Map<string, TurnSnapshot>();

  return {
    async dispatch(agent: Agent, event: Event): Promise<void> {
      // Snapshot pre-turn state for delta calculation
      if (event.type === EventType.TurnStart) {
        const state = await sessionStore.load(event.sessionID);
        turnSnapshots.set(event.sessionID, {
          inputTokens: state?.tokenUsage?.inputTokens ?? 0,
          outputTokens: state?.tokenUsage?.outputTokens ?? 0,
          startTime: Date.now(),
        });
      }

      // Delegate to the real lifecycle handler
      await inner.dispatch(agent, event);

      // Read the now-updated session state
      const state = await sessionStore.load(event.sessionID);
      if (!state) return;

      // Build and emit telemetry event
      const telemetryEvent = buildTelemetryEvent(event, state, turnSnapshots);
      exporter.emit(telemetryEvent);

      // Cleanup
      if (event.type === EventType.TurnEnd) {
        turnSnapshots.delete(event.sessionID);
      }

      // Flush on session end
      if (event.type === EventType.SessionEnd) {
        turnSnapshots.delete(event.sessionID);
        await exporter.shutdown().catch(() => {});
      }
    },
  };
}

function buildTelemetryEvent(
  event: Event,
  session: SessionState,
  turnSnapshots: Map<string, TurnSnapshot>,
): TelemetryEvent {
  const meta: TelemetryEventMeta = {};

  switch (event.type) {
    case EventType.TurnStart:
      meta.turnID = session.turnID;
      meta.prompt = event.prompt?.slice(0, 500);
      meta.promptLength = event.prompt?.length;
      break;

    case EventType.TurnEnd: {
      meta.turnID = session.turnID;
      meta.turnFilesModified = session.filesTouched;

      // Calculate turn wall-clock duration
      const snapshot = turnSnapshots.get(event.sessionID);
      if (snapshot) {
        meta.turnDurationMs = Date.now() - snapshot.startTime;

        // Calculate token delta for this turn
        if (session.tokenUsage) {
          meta.turnTokenUsage = {
            inputTokens: session.tokenUsage.inputTokens - snapshot.inputTokens,
            outputTokens: session.tokenUsage.outputTokens - snapshot.outputTokens,
            cacheCreationTokens: session.tokenUsage.cacheCreationTokens,
            cacheReadTokens: session.tokenUsage.cacheReadTokens,
            apiCallCount: session.tokenUsage.apiCallCount,
          };
        }
      } else if (session.tokenUsage) {
        meta.turnTokenUsage = session.tokenUsage;
      }
      break;
    }

    case EventType.TaskCreate:
    case EventType.TaskUpdate:
      meta.taskID = event.taskID;
      meta.taskSubject = event.taskSubject;
      meta.taskStatus = event.taskStatus;
      break;

    case EventType.SubagentStart:
    case EventType.SubagentEnd:
      meta.subagentType = event.subagentType;
      meta.toolUseID = event.toolUseID;
      break;

    case EventType.SkillUse:
      meta.skillName = event.skillName;
      meta.skillArgs = event.skillArgs;
      break;

    case EventType.PlanModeExit:
      meta.planFilePath = event.planFilePath;
      break;

    case EventType.Compaction:
      break;
  }

  return {
    eventType: event.type,
    session,
    timestamp: new Date().toISOString(),
    meta,
  };
}
