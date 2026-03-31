/**
 * Doctor Command
 *
 * Identifies and fixes stuck sessions. A session is "stuck" if it's
 * in ACTIVE phase with no recent interaction, or in ENDED phase with
 * uncondensed checkpoint data.
 */

import type { SessionState } from '../types.js';
import { createSessionStore } from '../store/session-store.js';
import { createCheckpointStore } from '../store/checkpoint-store.js';
import { resolveSessionRepoConfig } from '../utils/session-repo.js';

// ============================================================================
// Types
// ============================================================================

export interface StuckSession {
  sessionID: string;
  reason: 'active-stale' | 'ended-uncondensed';
  session: SessionState;
  hasShadowBranch: boolean;
  canCondense: boolean;
}

export interface DoctorResult {
  stuckSessions: StuckSession[];
  fixedCount: number;
  discardedCount: number;
  errors: string[];
}

export interface DoctorOptions {
  cwd?: string;
  /** Auto-fix without prompting */
  force?: boolean;
  /** Stale threshold in milliseconds (default: 1 hour) */
  staleThresholdMs?: number;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Diagnose stuck sessions
 */
export async function diagnose(options: DoctorOptions = {}): Promise<StuckSession[]> {
  const cwd = options.cwd;
  const staleThreshold = options.staleThresholdMs ?? 60 * 60 * 1000; // 1 hour

  const { sessionRepoCwd, sessionsDir, checkpointsBranch } = await resolveSessionRepoConfig(cwd);
  const sessionStore = createSessionStore(cwd, sessionsDir);
  const checkpointStore = createCheckpointStore(cwd, sessionRepoCwd, checkpointsBranch);

  const sessions = await sessionStore.list();
  const temporaryBranches = await checkpointStore.listTemporary();
  const stuck: StuckSession[] = [];

  for (const session of sessions) {
    // Check for active stale sessions
    if (session.phase === 'active') {
      const lastInteraction = session.lastInteractionTime
        ? new Date(session.lastInteractionTime).getTime()
        : new Date(session.startedAt).getTime();

      if (Date.now() - lastInteraction > staleThreshold) {
        const hasShadow = temporaryBranches.some((b) => b.sessionID === session.sessionID);

        stuck.push({
          sessionID: session.sessionID,
          reason: 'active-stale',
          session,
          hasShadowBranch: hasShadow,
          canCondense: hasShadow && session.filesTouched.length > 0,
        });
      }
    }

    // Check for ended sessions with uncondensed data
    if (session.phase === 'ended') {
      const hasShadow = temporaryBranches.some((b) => b.sessionID === session.sessionID);

      if (hasShadow) {
        stuck.push({
          sessionID: session.sessionID,
          reason: 'ended-uncondensed',
          session,
          hasShadowBranch: true,
          canCondense: session.filesTouched.length > 0,
        });
      }
    }
  }

  return stuck;
}

/**
 * Discard a stuck session (delete state + shadow branch)
 */
export async function discardSession(
  sessionID: string,
  options: { cwd?: string } = {},
): Promise<void> {
  const cwd = options.cwd;
  const { sessionRepoCwd, sessionsDir, checkpointsBranch } = await resolveSessionRepoConfig(cwd);
  const sessionStore = createSessionStore(cwd, sessionsDir);
  const checkpointStore = createCheckpointStore(cwd, sessionRepoCwd, checkpointsBranch);

  const session = await sessionStore.load(sessionID);
  if (!session) return;

  // Delete shadow branch if it exists
  if (session.baseCommit) {
    const branchName = checkpointStore.getShadowBranchName(session.baseCommit, session.worktreeID);
    await checkpointStore.deleteShadowBranch(branchName);
  }

  // Delete session state
  await sessionStore.delete(sessionID);
}

/**
 * Run doctor with auto-fix
 */
export async function doctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const stuck = await diagnose(options);
  const errors: string[] = [];
  const fixedCount = 0;
  let discardedCount = 0;

  if (options.force) {
    for (const s of stuck) {
      try {
        // For now, discard all stuck sessions
        await discardSession(s.sessionID, { cwd: options.cwd });
        discardedCount++;
      } catch (e) {
        errors.push(
          `Failed to fix session ${s.sessionID}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  return { stuckSessions: stuck, fixedCount, discardedCount, errors };
}
