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

  // Track per-turn token deltas for TurnEnd metrics
  const preTokenSnapshots = new Map<string, { inputTokens: number; outputTokens: number }>();

  return {
    async dispatch(agent: Agent, event: Event): Promise<void> {
      // Snapshot pre-turn token state for delta calculation
      if (event.type === EventType.TurnStart) {
        const state = await sessionStore.load(event.sessionID);
        if (state?.tokenUsage) {
          preTokenSnapshots.set(event.sessionID, {
            inputTokens: state.tokenUsage.inputTokens,
            outputTokens: state.tokenUsage.outputTokens,
          });
        }
      }

      // Delegate to the real lifecycle handler
      await inner.dispatch(agent, event);

      // Read the now-updated session state
      const state = await sessionStore.load(event.sessionID);
      if (!state) return;

      // Build and emit telemetry event
      const telemetryEvent = buildTelemetryEvent(event, state, preTokenSnapshots);
      exporter.emit(telemetryEvent);

      // Cleanup
      if (event.type === EventType.TurnEnd) {
        preTokenSnapshots.delete(event.sessionID);
      }

      // Flush on session end
      if (event.type === EventType.SessionEnd) {
        preTokenSnapshots.delete(event.sessionID);
        await exporter.shutdown().catch(() => {});
      }
    },
  };
}

function buildTelemetryEvent(
  event: Event,
  session: SessionState,
  preTokenSnapshots: Map<string, { inputTokens: number; outputTokens: number }>,
): TelemetryEvent {
  const meta: TelemetryEventMeta = {};

  switch (event.type) {
    case EventType.TurnStart:
      meta.turnID = session.turnID;
      meta.prompt = event.prompt?.slice(0, 500);
      break;

    case EventType.TurnEnd: {
      meta.turnID = session.turnID;
      meta.turnFilesModified = session.filesTouched;

      // Calculate token delta for this turn
      const pre = preTokenSnapshots.get(event.sessionID);
      if (session.tokenUsage && pre) {
        meta.turnTokenUsage = {
          inputTokens: session.tokenUsage.inputTokens - pre.inputTokens,
          outputTokens: session.tokenUsage.outputTokens - pre.outputTokens,
          cacheCreationTokens: session.tokenUsage.cacheCreationTokens,
          cacheReadTokens: session.tokenUsage.cacheReadTokens,
          apiCallCount: session.tokenUsage.apiCallCount,
        };
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
      break;

    case EventType.PlanModeExit:
      meta.planFilePath = event.planFilePath;
      break;
  }

  return {
    eventType: event.type,
    session,
    timestamp: new Date().toISOString(),
    meta,
  };
}
