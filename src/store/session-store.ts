/**
 * Session Store
 *
 * Manages session state files in .git/sessionlog-sessions/.
 * Each active session has a JSON state file that tracks
 * its lifecycle, files touched, checkpoints, and token usage.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type SessionState,
  type SessionPhase,
  type TokenUsage,
  type PlanEntry,
  STALE_SESSION_DAYS,
} from '../types.js';
import { getSessionsDir, atomicWriteFile } from '../git-operations.js';

// ============================================================================
// Session Store Interface
// ============================================================================

export interface SessionStore {
  /** Load a session state by ID */
  load(sessionID: string): Promise<SessionState | null>;

  /** List all session states */
  list(): Promise<SessionState[]>;

  /** Save a session state */
  save(state: SessionState): Promise<void>;

  /** Delete a session state */
  delete(sessionID: string): Promise<void>;

  /** Get the sessions directory path */
  getDir(): Promise<string>;

  /** Check if a session exists */
  exists(sessionID: string): Promise<boolean>;

  /** Merge annotations into a session's existing annotations (load-merge-save) */
  annotate(sessionID: string, annotations: Record<string, unknown>): Promise<boolean>;
}

// ============================================================================
// Filesystem Session Store
// ============================================================================

/**
 * Create a session store.
 *
 * @param cwd - The project working directory (used to locate .git/sessionlog-sessions/)
 * @param sessionsDir - Optional explicit directory for session state files.
 *   When provided, session files are stored here instead of .git/sessionlog-sessions/.
 *   This is used when a separate session repo is configured.
 */
export function createSessionStore(cwd?: string, sessionsDir?: string): SessionStore {
  let sessionsDirCache: string | null = sessionsDir ?? null;

  async function getDir(): Promise<string> {
    if (sessionsDirCache) return sessionsDirCache;
    sessionsDirCache = await getSessionsDir(cwd);
    return sessionsDirCache;
  }

  function sessionFilePath(dir: string, sessionID: string): string {
    return path.join(dir, `${sessionID}.json`);
  }

  function parseSessionFile(filePath: string): SessionState | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as Record<string, unknown>;
      const id = path.basename(filePath, '.json');

      return normalizeSessionState(id, data);
    } catch {
      return null;
    }
  }

  function isStale(state: SessionState): boolean {
    if (state.phase !== 'ended' || !state.endedAt) return false;
    const endedAt = new Date(state.endedAt);
    const staleThreshold = Date.now() - STALE_SESSION_DAYS * 24 * 60 * 60 * 1000;
    return endedAt.getTime() < staleThreshold;
  }

  return {
    async load(sessionID: string): Promise<SessionState | null> {
      const dir = await getDir();
      const filePath = sessionFilePath(dir, sessionID);

      const state = parseSessionFile(filePath);
      if (!state) return null;

      // Auto-delete stale sessions
      if (isStale(state)) {
        try {
          await fs.promises.unlink(filePath);
        } catch {
          // Ignore deletion errors
        }
        return null;
      }

      return state;
    },

    async list(): Promise<SessionState[]> {
      const dir = await getDir();

      try {
        const files = await fs.promises.readdir(dir);
        const states: SessionState[] = [];

        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const filePath = path.join(dir, file);
          const state = parseSessionFile(filePath);

          if (!state) continue;

          // Auto-delete stale sessions
          if (isStale(state)) {
            try {
              await fs.promises.unlink(filePath);
            } catch {
              // Ignore
            }
            continue;
          }

          states.push(state);
        }

        return states;
      } catch {
        return [];
      }
    },

    async save(state: SessionState): Promise<void> {
      const dir = await getDir();
      const filePath = sessionFilePath(dir, state.sessionID);
      const content = JSON.stringify(serializeSessionState(state), null, 2);
      await atomicWriteFile(filePath, content);
    },

    async delete(sessionID: string): Promise<void> {
      const dir = await getDir();
      const filePath = sessionFilePath(dir, sessionID);
      try {
        await fs.promises.unlink(filePath);
      } catch {
        // Ignore if already deleted
      }
    },

    async getDir(): Promise<string> {
      return getDir();
    },

    async exists(sessionID: string): Promise<boolean> {
      const dir = await getDir();
      const filePath = sessionFilePath(dir, sessionID);
      try {
        await fs.promises.access(filePath);
        return true;
      } catch {
        return false;
      }
    },

    async annotate(sessionID: string, annotations: Record<string, unknown>): Promise<boolean> {
      const dir = await getDir();
      const filePath = sessionFilePath(dir, sessionID);
      const state = parseSessionFile(filePath);
      if (!state) return false;
      state.annotations = { ...state.annotations, ...annotations };
      const content = JSON.stringify(serializeSessionState(state), null, 2);
      await atomicWriteFile(filePath, content);
      return true;
    },
  };
}

// ============================================================================
// Normalization
// ============================================================================

/**
 * Normalize raw JSON data into a SessionState, handling field name variations
 */
export function normalizeSessionState(id: string, data: Record<string, unknown>): SessionState {
  return {
    sessionID: String(data.sessionID ?? data.session_id ?? id),
    cliVersion: data.cliVersion as string | undefined,
    baseCommit: String(data.baseCommit ?? data.base_commit ?? ''),
    attributionBaseCommit: data.attributionBaseCommit as string | undefined,
    worktreePath: data.worktreePath as string | undefined,
    worktreeID: data.worktreeID as string | undefined,
    startedAt: String(data.startedAt ?? data.started_at ?? new Date().toISOString()),
    endedAt: (data.endedAt ?? data.ended_at) as string | undefined,
    phase: normalizePhase(String(data.phase ?? data.state ?? 'idle')),
    turnID: data.turnID as string | undefined,
    turnCheckpointIDs: Array.isArray(data.turnCheckpointIDs)
      ? data.turnCheckpointIDs.map(String)
      : [],
    lastInteractionTime: (data.lastInteractionTime ?? data.last_interaction_time) as
      | string
      | undefined,
    stepCount: Number(data.stepCount ?? data.step_count ?? 0),
    checkpointTranscriptStart: Number(data.checkpointTranscriptStart ?? 0),
    untrackedFilesAtStart: Array.isArray(data.untrackedFilesAtStart)
      ? data.untrackedFilesAtStart.map(String)
      : [],
    filesTouched: Array.isArray(data.filesTouched) ? data.filesTouched.map(String) : [],
    lastCheckpointID: data.lastCheckpointID as string | undefined,
    agentType: String(data.agentType ?? data.agent ?? data.agent_type ?? 'Agent'),
    tokenUsage: data.tokenUsage as TokenUsage | undefined,
    transcriptIdentifierAtStart: data.transcriptIdentifierAtStart as string | undefined,
    transcriptPath: data.transcriptPath as string | undefined,
    firstPrompt: data.firstPrompt as string | undefined,
    promptAttributions: data.promptAttributions as SessionState['promptAttributions'],
    pendingPromptAttribution:
      data.pendingPromptAttribution as SessionState['pendingPromptAttribution'],
    tasks: data.tasks as SessionState['tasks'],
    inPlanMode: data.inPlanMode as boolean | undefined,
    planModeEntries: data.planModeEntries as number | undefined,
    planEntries: normalizePlanEntries(data),
    skillsUsed: Array.isArray(data.skillsUsed)
      ? (data.skillsUsed as SessionState['skillsUsed'])
      : undefined,
    annotations:
      data.annotations && typeof data.annotations === 'object' && !Array.isArray(data.annotations)
        ? (data.annotations as Record<string, unknown>)
        : undefined,
  };
}

function normalizePhase(phase: string): SessionPhase {
  const lower = phase.toLowerCase();
  if (lower === 'active') return 'active';
  if (lower === 'idle') return 'idle';
  if (lower === 'ended') return 'ended';
  return 'idle';
}

function normalizePlanEntries(data: Record<string, unknown>): PlanEntry[] | undefined {
  if (Array.isArray(data.planEntries)) {
    return data.planEntries as PlanEntry[];
  }

  // Migration: synthesize from old planFilePath/planContent fields
  const filePath = data.planFilePath as string | undefined;
  const content = data.planContent as string | undefined;
  if (filePath || content) {
    return [
      {
        enteredAt: (data.startedAt as string) ?? new Date().toISOString(),
        exitedAt: (data.startedAt as string) ?? new Date().toISOString(),
        filePath,
        content,
      },
    ];
  }

  return undefined;
}

/**
 * Serialize a SessionState for writing to disk
 */
function serializeSessionState(state: SessionState): Record<string, unknown> {
  const result: Record<string, unknown> = { ...state };
  // Remove undefined values
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined) delete result[key];
  }
  return result;
}
