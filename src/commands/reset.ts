/**
 * Reset Command
 *
 * Deletes shadow branch and session state for the current HEAD.
 * More targeted than clean — only affects the current commit's sessions.
 */

import type { SessionState } from '../types.js';
import { getHead } from '../git-operations.js';
import { createSessionStore } from '../store/session-store.js';
import { createCheckpointStore } from '../store/checkpoint-store.js';
import { resolveSessionRepoConfig } from '../utils/session-repo.js';

// ============================================================================
// Types
// ============================================================================

export interface ResetOptions {
  cwd?: string;
  /** Reset a specific session instead of all */
  sessionID?: string;
  /** Skip confirmation (for programmatic use) */
  force?: boolean;
}

export interface ResetResult {
  sessionsReset: string[];
  branchesDeleted: string[];
  errors: string[];
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Reset shadow branches and session state for the current HEAD
 */
export async function reset(options: ResetOptions = {}): Promise<ResetResult> {
  const cwd = options.cwd;
  const { sessionRepoCwd, sessionsDir, checkpointsBranch } = await resolveSessionRepoConfig(cwd);
  const sessionStore = createSessionStore(cwd, sessionsDir);
  const checkpointStore = createCheckpointStore(cwd, sessionRepoCwd, checkpointsBranch);
  const head = await getHead(cwd);

  const errors: string[] = [];
  const sessionsReset: string[] = [];
  const branchesDeleted: string[] = [];

  const sessions = await sessionStore.list();

  // Find sessions matching the current HEAD
  let matchingSessions: SessionState[];

  if (options.sessionID) {
    matchingSessions = sessions.filter((s) => s.sessionID === options.sessionID);
    if (matchingSessions.length === 0) {
      errors.push(`Session not found: ${options.sessionID}`);
      return { sessionsReset, branchesDeleted, errors };
    }
  } else {
    matchingSessions = sessions.filter(
      (s) => s.baseCommit === head || head.startsWith(s.baseCommit),
    );
  }

  // Safety check: warn about active sessions
  if (!options.force) {
    const activeSessions = matchingSessions.filter((s) => s.phase === 'active');
    if (activeSessions.length > 0) {
      errors.push(
        `${activeSessions.length} active session(s) found. Use --force to reset active sessions.`,
      );
      return { sessionsReset, branchesDeleted, errors };
    }
  }

  for (const session of matchingSessions) {
    // Delete shadow branch
    if (session.baseCommit) {
      const branchName = checkpointStore.getShadowBranchName(
        session.baseCommit,
        session.worktreeID,
      );
      try {
        await checkpointStore.deleteShadowBranch(branchName);
        branchesDeleted.push(branchName);
      } catch (e) {
        errors.push(
          `Failed to delete branch ${branchName}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // Delete session state
    try {
      await sessionStore.delete(session.sessionID);
      sessionsReset.push(session.sessionID);
    } catch (e) {
      errors.push(
        `Failed to delete session ${session.sessionID}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return { sessionsReset, branchesDeleted, errors };
}
