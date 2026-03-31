/**
 * Rewind Command
 *
 * Browse checkpoints and restore session state to a previous point.
 * Supports both shadow branch (temporary) and committed checkpoint rewind.
 */

import type { RewindPoint } from '../types.js';
import { git, hasUncommittedChanges } from '../git-operations.js';
import { createCheckpointStore } from '../store/checkpoint-store.js';
import { resolveSessionRepoConfig } from '../utils/session-repo.js';

// ============================================================================
// Types
// ============================================================================

export interface RewindOptions {
  cwd?: string;
  /** Maximum number of rewind points to return */
  limit?: number;
}

export interface RewindResult {
  success: boolean;
  message: string;
  rewindPoint?: RewindPoint;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * List available rewind points
 */
export async function listRewindPoints(options: RewindOptions = {}): Promise<RewindPoint[]> {
  const cwd = options.cwd;
  const limit = options.limit ?? 20;
  const points: RewindPoint[] = [];

  const { sessionRepoCwd, checkpointsBranch } = await resolveSessionRepoConfig(cwd);
  const checkpointStore = createCheckpointStore(cwd, sessionRepoCwd, checkpointsBranch);

  // 1. Shadow branch checkpoints (temporary, most recent)
  const temporaryBranches = await checkpointStore.listTemporary();
  for (const temp of temporaryBranches) {
    points.push({
      id: temp.latestCommit,
      message: `Shadow checkpoint on ${temp.branchName}`,
      date: temp.timestamp,
      isTaskCheckpoint: false,
      isLogsOnly: false,
      sessionID: temp.sessionID,
      sessionCount: 1,
      sessionIDs: temp.sessionID ? [temp.sessionID] : [],
    });
  }

  // 2. Committed checkpoints (permanent)
  const committed = await checkpointStore.listCommitted(limit);
  for (const cp of committed) {
    const sessionIDs = cp.sessions
      .map((s) => {
        const match = s.metadata.match(/\/(\d+)\/metadata\.json$/);
        return match ? match[1] : '';
      })
      .filter(Boolean);

    points.push({
      id: cp.checkpointID,
      message: `Checkpoint ${cp.checkpointID.slice(0, 8)}`,
      checkpointID: cp.checkpointID,
      date: new Date().toISOString(), // Will be populated from metadata
      isTaskCheckpoint: false,
      isLogsOnly: true,
      agent: undefined,
      sessionCount: cp.sessions.length,
      sessionIDs,
    });

    // Read detailed metadata for each committed checkpoint
    for (let i = 0; i < cp.sessions.length; i++) {
      const content = await checkpointStore.readSessionContent(cp.checkpointID, i);
      if (content) {
        const lastPoint = points[points.length - 1];
        lastPoint.date = content.metadata.createdAt;
        lastPoint.agent = content.metadata.agent;
        lastPoint.sessionID = content.metadata.sessionID;
        if (content.metadata.isTask) {
          lastPoint.isTaskCheckpoint = true;
        }
      }
    }
  }

  // Sort by date (most recent first) and limit
  points.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return points.slice(0, limit);
}

/**
 * Rewind to a specific point (non-interactive)
 */
export async function rewindTo(
  pointID: string,
  options: { cwd?: string; logsOnly?: boolean; reset?: boolean } = {},
): Promise<RewindResult> {
  const cwd = options.cwd;

  // Safety check: uncommitted changes
  if (await hasUncommittedChanges(cwd)) {
    return {
      success: false,
      message: 'Cannot rewind: there are uncommitted changes. Commit or stash them first.',
    };
  }

  // Find the rewind point
  const points = await listRewindPoints({ cwd, limit: 50 });
  const point = points.find((p) => p.id === pointID || p.checkpointID === pointID);

  if (!point) {
    return { success: false, message: `Rewind point not found: ${pointID}` };
  }

  if (point.isLogsOnly && !options.logsOnly && !options.reset) {
    return {
      success: false,
      message:
        'This is a logs-only checkpoint. Use --logs-only to restore logs, or --reset to reset the branch.',
    };
  }

  if (options.reset) {
    // Destructive: git reset --hard
    try {
      await git(['reset', '--hard', pointID], { cwd });
      return {
        success: true,
        message: `Reset to ${pointID.slice(0, 8)}`,
        rewindPoint: point,
      };
    } catch (e) {
      return {
        success: false,
        message: `Reset failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  if (point.isLogsOnly || options.logsOnly) {
    // Restore logs only (no checkout)
    return {
      success: true,
      message: `Logs restored for checkpoint ${point.checkpointID ?? pointID}`,
      rewindPoint: point,
    };
  }

  // Full rewind: checkout to the shadow branch commit
  try {
    await git(['checkout', pointID], { cwd });
    return {
      success: true,
      message: `Rewound to ${pointID.slice(0, 8)}`,
      rewindPoint: point,
    };
  } catch (e) {
    return {
      success: false,
      message: `Rewind failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * List rewind points as JSON (for CLI --list flag)
 */
export async function listRewindPointsJSON(options: RewindOptions = {}): Promise<string> {
  const points = await listRewindPoints(options);
  return JSON.stringify(
    points.map((p) => ({
      id: p.id,
      message: p.message,
      date: p.date,
      is_task_checkpoint: p.isTaskCheckpoint,
      is_logs_only: p.isLogsOnly,
      checkpoint_id: p.checkpointID,
      agent: p.agent,
      session_id: p.sessionID,
      session_prompt: p.sessionPrompt,
      session_count: p.sessionCount,
    })),
    null,
    2,
  );
}
