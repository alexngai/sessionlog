/**
 * Strategy Common Infrastructure
 *
 * Shared utilities used by strategy implementations for metadata branch
 * operations, repository validation, and setup.
 *
 * Ported from Go: strategy/common.go
 */

import {
  git,
  gitSafe,
  refExists,
  isGitRepository,
  getWorktreeRoot,
  getHead,
  showFile,
  commitTree,
  mktree,
  getGitAuthor,
} from '../git-operations.js';
import {
  CHECKPOINTS_BRANCH,
  type CheckpointID,
  type CommittedMetadata,
  checkpointIDPath,
} from '../types.js';
import { ensureGitignore } from '../config.js';

// ============================================================================
// Repository Validation
// ============================================================================

/**
 * Validates that the repository is suitable for the manual-commit strategy.
 * Throws if the repository is bare, has no commits, or is not a git repo.
 */
export async function validateRepository(cwd?: string): Promise<void> {
  const isRepo = await isGitRepository(cwd);
  if (!isRepo) {
    throw new Error('Not a git repository');
  }

  // Check that it's not a bare repository
  const isBare = await gitSafe(['rev-parse', '--is-bare-repository'], { cwd });
  if (isBare?.trim() === 'true') {
    throw new Error('Cannot operate on a bare repository');
  }

  // Check that we can access the worktree
  try {
    await getWorktreeRoot(cwd);
  } catch {
    throw new Error('Failed to access worktree');
  }
}

/**
 * Check if the repository has any commits.
 */
export async function isEmptyRepository(cwd?: string): Promise<boolean> {
  try {
    await getHead(cwd);
    return false;
  } catch {
    return true;
  }
}

/**
 * Check if commit `ancestor` is an ancestor of commit `descendant`.
 * Uses a bounded traversal to prevent runaway history walks.
 */
export async function isAncestorOf(
  ancestor: string,
  descendant: string,
  _maxDepth: number = 1000,
  cwd?: string,
): Promise<boolean> {
  const result = await gitSafe(['merge-base', '--is-ancestor', ancestor, descendant], { cwd });
  // git merge-base --is-ancestor exits 0 if true, 1 if not
  return result !== null;
}

/**
 * Check if we're inside a git worktree (not the main repo).
 */
export async function isInsideWorktree(cwd?: string): Promise<boolean> {
  const result = await gitSafe(['rev-parse', '--git-common-dir'], { cwd });
  const gitDir = await gitSafe(['rev-parse', '--git-dir'], { cwd });
  if (!result || !gitDir) return false;
  return result.trim() !== gitDir.trim();
}

// ============================================================================
// Metadata Branch Operations
// ============================================================================

/**
 * Ensure the metadata branch (runlog/checkpoints/v1) exists.
 * Creates it with an initial empty-tree commit if it doesn't exist.
 */
export async function ensureMetadataBranch(cwd?: string): Promise<void> {
  const branchRef = `refs/heads/${CHECKPOINTS_BRANCH}`;
  const exists = await refExists(branchRef, cwd);
  if (exists) return;

  // Create an empty tree
  const emptyTree = await mktree([], cwd);
  const author = await getGitAuthor(cwd);
  const commitHash = await commitTree(
    emptyTree,
    null,
    'Initialize Runlog checkpoints branch',
    author,
    cwd,
  );

  // Create the branch pointing to this commit
  await git(['branch', CHECKPOINTS_BRANCH, commitHash], { cwd });
}

/**
 * Read checkpoint metadata from the metadata branch.
 */
export async function readCheckpointMetadata(
  checkpointID: CheckpointID,
  cwd?: string,
): Promise<CommittedMetadata | null> {
  const checkpointPath = checkpointIDPath(checkpointID);

  try {
    const content = await showFile(CHECKPOINTS_BRANCH, `${checkpointPath}/metadata.json`, cwd);
    return JSON.parse(content) as CommittedMetadata;
  } catch {
    return null;
  }
}

/**
 * Read a session prompt from the metadata branch tree.
 */
export async function readSessionPromptFromTree(
  checkpointID: CheckpointID,
  sessionIndex: number,
  cwd?: string,
): Promise<string> {
  const checkpointPath = checkpointIDPath(checkpointID);

  try {
    return await showFile(CHECKPOINTS_BRANCH, `${checkpointPath}/${sessionIndex}/prompt.txt`, cwd);
  } catch {
    return '';
  }
}

/**
 * Read the agent type from checkpoint metadata.
 */
export async function readAgentTypeFromTree(
  checkpointID: CheckpointID,
  cwd?: string,
): Promise<string> {
  const metadata = await readCheckpointMetadata(checkpointID, cwd);
  return metadata?.agent ?? '';
}

/**
 * Extract the first user prompt from a transcript or prompt file.
 */
export function extractFirstPrompt(prompts: string): string {
  if (!prompts) return '';
  // Split on the prompt separator
  const parts = prompts.split('\n---\n');
  const first = parts[0]?.trim() ?? '';
  // Truncate to 200 chars
  return first.length > 200 ? first.slice(0, 200) + '...' : first;
}

// ============================================================================
// Setup
// ============================================================================

/**
 * Full strategy setup: create metadata branch, ensure .gitignore, etc.
 */
export async function ensureSetup(cwd?: string): Promise<void> {
  await validateRepository(cwd);
  await ensureMetadataBranch(cwd);
  await ensureGitignore(cwd);
}

/**
 * Get the root directory of the main repository (not a worktree).
 */
export async function getMainRepoRoot(cwd?: string): Promise<string> {
  const commonDir = await gitSafe(['rev-parse', '--git-common-dir'], { cwd });
  if (!commonDir) {
    throw new Error('Not inside a git repository');
  }

  const { resolve, dirname } = await import('node:path');
  // Common dir is typically <repo>/.git or <repo>/.git/worktrees/<name>
  // For the main repo, --git-common-dir returns .git
  const absCommon = resolve(cwd ?? process.cwd(), commonDir.trim());
  return dirname(absCommon);
}
