/**
 * Clean Command
 *
 * Removes orphaned Runlog data: shadow branches, stale session files,
 * and temporary files that are no longer referenced.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { RUNLOG_TMP_DIR, SHADOW_BRANCH_PREFIX, CHECKPOINTS_BRANCH } from '../types.js';
import { getWorktreeRoot, listBranches, deleteBranch } from '../git-operations.js';
import { createSessionStore } from '../store/session-store.js';

// ============================================================================
// Types
// ============================================================================

export interface CleanupItem {
  type: 'shadow-branch' | 'session-file' | 'temp-file';
  path: string;
  reason: string;
}

export interface CleanResult {
  items: CleanupItem[];
  deletedCount: number;
  errors: string[];
}

export interface CleanOptions {
  cwd?: string;
  /** Actually delete (default: preview only) */
  force?: boolean;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Find orphaned items
 */
export async function findOrphaned(cwd?: string): Promise<CleanupItem[]> {
  const items: CleanupItem[] = [];
  const sessionStore = createSessionStore(cwd);
  const sessions = await sessionStore.list();
  const activeBaseCommits = new Set(sessions.map((s) => s.baseCommit).filter(Boolean));

  // 1. Orphaned shadow branches
  const branches = await listBranches(`${SHADOW_BRANCH_PREFIX}*`, cwd);
  for (const branch of branches) {
    if (branch === CHECKPOINTS_BRANCH) continue;

    // Extract base commit from branch name
    const hashPart = branch.slice(SHADOW_BRANCH_PREFIX.length);
    const baseCommit = hashPart.split('-')[0];

    // A shadow branch is orphaned if no active session references its base commit
    if (!activeBaseCommits.has(baseCommit)) {
      // Check against full base commits (the hash part is a short hash)
      const isReferenced = sessions.some(
        (s) => s.baseCommit && s.baseCommit.startsWith(baseCommit),
      );

      if (!isReferenced) {
        items.push({
          type: 'shadow-branch',
          path: branch,
          reason: 'No active session references this branch',
        });
      }
    }
  }

  // 2. Orphaned temp files
  try {
    const root = await getWorktreeRoot(cwd);
    const tmpDir = path.join(root, RUNLOG_TMP_DIR);

    const files = await fs.promises.readdir(tmpDir).catch(() => []);
    for (const file of files) {
      const filePath = path.join(tmpDir, file);
      const stat = await fs.promises.stat(filePath);

      // Consider temp files older than 24 hours as orphaned
      if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) {
        items.push({
          type: 'temp-file',
          path: filePath,
          reason: 'Temporary file older than 24 hours',
        });
      }
    }
  } catch {
    // Temp dir may not exist
  }

  return items;
}

/**
 * Clean orphaned items
 */
export async function clean(options: CleanOptions = {}): Promise<CleanResult> {
  const cwd = options.cwd;
  const items = await findOrphaned(cwd);
  const errors: string[] = [];
  let deletedCount = 0;

  if (!options.force) {
    return { items, deletedCount: 0, errors: [] };
  }

  for (const item of items) {
    try {
      switch (item.type) {
        case 'shadow-branch':
          await deleteBranch(item.path, true, cwd);
          deletedCount++;
          break;
        case 'session-file':
        case 'temp-file':
          await fs.promises.unlink(item.path);
          deletedCount++;
          break;
      }
    } catch (e) {
      errors.push(`Failed to delete ${item.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { items, deletedCount, errors };
}
