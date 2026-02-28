/**
 * Native Runlog Store
 *
 * Replaces the CLI-based RunlogStore with direct filesystem and git reads.
 * This is the primary integration point between the Runlog module and
 * the existing OpenTasks provider system.
 */

import type { RunlogStore, RunlogSession, RunlogCheckpoint } from './provider-types.js';
import type { SessionState } from '../types.js';
import { createSessionStore } from './session-store.js';
import { createCheckpointStore } from './checkpoint-store.js';

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a native Runlog store that reads directly from
 * the filesystem and git, without shelling out to the CLI.
 */
export function createNativeRunlogStore(cwd?: string): RunlogStore {
  const sessionStore = createSessionStore(cwd);
  const checkpointStore = createCheckpointStore(cwd);

  function sessionStateToRunlogSession(state: SessionState): RunlogSession {
    return {
      id: state.sessionID,
      agent: state.agentType,
      phase: state.phase === 'active' ? 'ACTIVE' : state.phase === 'idle' ? 'IDLE' : 'ENDED',
      baseCommit: state.baseCommit || undefined,
      branch: undefined, // Will be populated if needed
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      checkpoints: state.turnCheckpointIDs.length > 0 ? state.turnCheckpointIDs : undefined,
      tokenUsage: state.tokenUsage
        ? {
            input: state.tokenUsage.inputTokens + state.tokenUsage.cacheReadTokens,
            output: state.tokenUsage.outputTokens,
            cache: state.tokenUsage.cacheCreationTokens,
          }
        : undefined,
      filesTouched: state.filesTouched.length > 0 ? state.filesTouched : undefined,
      summary: state.firstPrompt,
    };
  }

  return {
    async getSession(id: string): Promise<RunlogSession | null> {
      try {
        const state = await sessionStore.load(id);
        if (!state) return null;
        return sessionStateToRunlogSession(state);
      } catch {
        return null;
      }
    },

    async listSessions(): Promise<RunlogSession[]> {
      try {
        const states = await sessionStore.list();
        return states.map(sessionStateToRunlogSession);
      } catch {
        return [];
      }
    },

    async getCheckpoint(id: string): Promise<RunlogCheckpoint | null> {
      try {
        const summary = await checkpointStore.readCommitted(id);
        if (!summary) return null;

        // Read first session content for details
        const content = await checkpointStore.readSessionContent(id, 0);

        return {
          id: summary.checkpointID,
          sessionId: content?.metadata.sessionID,
          commitHash: undefined, // Checkpoint hash, not a git commit
          commitMessage: content?.metadata.summary?.intent,
          promptCount: undefined,
          filesModified: summary.filesTouched.length > 0 ? summary.filesTouched : undefined,
          filesNew: undefined,
          filesDeleted: undefined,
          tokenUsage: summary.tokenUsage
            ? {
                input: summary.tokenUsage.inputTokens + summary.tokenUsage.cacheReadTokens,
                output: summary.tokenUsage.outputTokens,
                cache: summary.tokenUsage.cacheCreationTokens,
              }
            : undefined,
          context: content?.context,
        };
      } catch {
        return null;
      }
    },

    async listCheckpoints(): Promise<RunlogCheckpoint[]> {
      try {
        const summaries = await checkpointStore.listCommitted(50);
        const checkpoints: RunlogCheckpoint[] = [];

        for (const summary of summaries) {
          const content = await checkpointStore.readSessionContent(summary.checkpointID, 0);

          checkpoints.push({
            id: summary.checkpointID,
            sessionId: content?.metadata.sessionID,
            commitHash: undefined,
            commitMessage: content?.metadata.summary?.intent,
            promptCount: undefined,
            filesModified: summary.filesTouched.length > 0 ? summary.filesTouched : undefined,
            filesNew: undefined,
            filesDeleted: undefined,
            tokenUsage: summary.tokenUsage
              ? {
                  input: summary.tokenUsage.inputTokens + summary.tokenUsage.cacheReadTokens,
                  output: summary.tokenUsage.outputTokens,
                  cache: summary.tokenUsage.cacheCreationTokens,
                }
              : undefined,
            context: content?.context,
          });
        }

        return checkpoints;
      } catch {
        return [];
      }
    },

    async search(query: string): Promise<Array<RunlogSession | RunlogCheckpoint>> {
      const results: Array<RunlogSession | RunlogCheckpoint> = [];
      const lowerQuery = query.toLowerCase();

      // Search sessions
      try {
        const sessions = await this.listSessions();
        for (const session of sessions) {
          if (
            session.summary?.toLowerCase().includes(lowerQuery) ||
            session.id.toLowerCase().includes(lowerQuery) ||
            session.filesTouched?.some((f) => f.toLowerCase().includes(lowerQuery))
          ) {
            results.push(session);
          }
        }
      } catch {
        // Continue with checkpoints
      }

      // Search checkpoints
      try {
        const checkpoints = await this.listCheckpoints();
        for (const cp of checkpoints) {
          if (
            cp.commitMessage?.toLowerCase().includes(lowerQuery) ||
            cp.id.toLowerCase().includes(lowerQuery) ||
            cp.context?.toLowerCase().includes(lowerQuery) ||
            cp.filesModified?.some((f) => f.toLowerCase().includes(lowerQuery))
          ) {
            results.push(cp);
          }
        }
      } catch {
        // Return what we have
      }

      return results;
    },
  };
}
