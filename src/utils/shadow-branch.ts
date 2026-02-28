/**
 * Shadow Branch Utilities
 *
 * Standalone utilities for shadow branch name generation, parsing,
 * and classification. Extracted from checkpoint-store.ts for reuse.
 *
 * Ported from Go: checkpoint/temporary.go, strategy/cleanup.go
 */

import * as crypto from 'node:crypto';
import { SHADOW_BRANCH_PREFIX, SHADOW_BRANCH_HASH_LENGTH, CHECKPOINTS_BRANCH } from '../types.js';
import { listBranches, deleteBranch } from '../git-operations.js';

/** Worktree ID hash length (6 hex characters) */
const WORKTREE_ID_HASH_LENGTH = 6;

/** Pattern for shadow branches: runlog/<hex7+>(-<hex6+>)? */
const SHADOW_BRANCH_PATTERN = new RegExp(
  `^${SHADOW_BRANCH_PREFIX.replace('/', '\\/')}[0-9a-f]{${SHADOW_BRANCH_HASH_LENGTH},}(-[0-9a-f]{${WORKTREE_ID_HASH_LENGTH},})?$`,
);

/**
 * Hash a worktree identifier to a short hex string.
 */
export function hashWorktreeID(worktreeID: string): string {
  return crypto
    .createHash('sha256')
    .update(worktreeID)
    .digest('hex')
    .slice(0, WORKTREE_ID_HASH_LENGTH);
}

/**
 * Returns the shadow branch name for a base commit hash and worktree identifier.
 * Format: runlog/<commit[:7]>-<hash(worktreeID)[:6]>
 */
export function shadowBranchNameForCommit(baseCommit: string, worktreeID?: string): string {
  const commitPart = baseCommit.slice(0, SHADOW_BRANCH_HASH_LENGTH);
  if (worktreeID) {
    const worktreeHash = hashWorktreeID(worktreeID);
    return `${SHADOW_BRANCH_PREFIX}${commitPart}-${worktreeHash}`;
  }
  return `${SHADOW_BRANCH_PREFIX}${commitPart}`;
}

/**
 * Parse a shadow branch name to extract commit prefix and worktree hash.
 * Returns null if the branch name doesn't match the shadow branch pattern.
 */
export function parseShadowBranchName(
  branchName: string,
): { commitPrefix: string; worktreeHash: string } | null {
  if (!branchName.startsWith(SHADOW_BRANCH_PREFIX)) return null;
  if (branchName === CHECKPOINTS_BRANCH) return null;

  const suffix = branchName.slice(SHADOW_BRANCH_PREFIX.length);
  const lastDash = suffix.lastIndexOf('-');

  if (lastDash === -1 || lastDash === 0 || lastDash === suffix.length - 1) {
    // No dash or dash at boundary — old format with just commit prefix
    return { commitPrefix: suffix, worktreeHash: '' };
  }

  return {
    commitPrefix: suffix.slice(0, lastDash),
    worktreeHash: suffix.slice(lastDash + 1),
  };
}

/**
 * Returns true if the branch name matches the shadow branch pattern.
 * The "runlog/checkpoints/v1" branch is NOT a shadow branch.
 */
export function isShadowBranch(branchName: string): boolean {
  if (branchName === CHECKPOINTS_BRANCH) return false;
  return SHADOW_BRANCH_PATTERN.test(branchName);
}

/**
 * List all shadow branches in the repository.
 * Returns an empty array if no shadow branches exist.
 */
export async function listShadowBranches(cwd?: string): Promise<string[]> {
  const allBranches = await listBranches(cwd);
  return allBranches.filter(isShadowBranch);
}

/**
 * Delete the specified shadow branches from the repository.
 * Returns two arrays: successfully deleted and failed to delete.
 */
export async function deleteShadowBranches(
  branches: string[],
  cwd?: string,
): Promise<{ deleted: string[]; failed: string[] }> {
  const deleted: string[] = [];
  const failed: string[] = [];

  for (const branch of branches) {
    try {
      await deleteBranch(branch, false, cwd);
      deleted.push(branch);
    } catch {
      failed.push(branch);
    }
  }

  return { deleted, failed };
}
