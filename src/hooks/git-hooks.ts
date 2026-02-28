/**
 * Git Hooks
 *
 * Installation and management of git hooks (prepare-commit-msg,
 * commit-msg, post-commit, pre-push) that integrate Runlog into the git workflow.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGitDir } from '../git-operations.js';

// ============================================================================
// Constants
// ============================================================================

const HOOK_MARKER = '# Runlog CLI hook';
const HOOK_NAMES = ['prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-push'] as const;

export type GitHookName = (typeof HOOK_NAMES)[number];

// ============================================================================
// Git Hook Installation
// ============================================================================

/**
 * Install git hooks for Runlog into a repository
 */
export async function installGitHooks(
  repoPath: string,
  runlogExecutable = 'runlog',
): Promise<number> {
  const gitDir = await getGitDir(repoPath);
  const hooksDir = path.resolve(repoPath, gitDir, 'hooks');

  await fs.promises.mkdir(hooksDir, { recursive: true });

  let installed = 0;

  for (const hookName of HOOK_NAMES) {
    const hookPath = path.join(hooksDir, hookName);
    const hookScript = generateHookScript(hookName, runlogExecutable);

    // Read existing content if any
    let existingContent = '';
    try {
      existingContent = await fs.promises.readFile(hookPath, 'utf-8');
    } catch {
      // File doesn't exist
    }

    // Check if Runlog hook already installed
    if (existingContent.includes(HOOK_MARKER)) {
      continue;
    }

    // Append or create
    if (existingContent) {
      // Append to existing hook
      const newContent = existingContent.trimEnd() + '\n\n' + hookScript + '\n';
      await fs.promises.writeFile(hookPath, newContent);
    } else {
      // Create new hook
      await fs.promises.writeFile(hookPath, '#!/bin/sh\n\n' + hookScript + '\n');
    }

    // Make executable
    await fs.promises.chmod(hookPath, 0o755);
    installed++;
  }

  return installed;
}

/**
 * Uninstall git hooks for Runlog from a repository
 */
export async function uninstallGitHooks(repoPath: string): Promise<void> {
  const gitDir = await getGitDir(repoPath);
  const hooksDir = path.resolve(repoPath, gitDir, 'hooks');

  for (const hookName of HOOK_NAMES) {
    const hookPath = path.join(hooksDir, hookName);

    try {
      const content = await fs.promises.readFile(hookPath, 'utf-8');

      // Remove Runlog section
      const lines = content.split('\n');
      const filtered: string[] = [];
      let inRunlogSection = false;

      for (const line of lines) {
        if (line.includes(HOOK_MARKER)) {
          inRunlogSection = true;
          continue;
        }
        if (inRunlogSection && line.trim() === '') {
          inRunlogSection = false;
          continue;
        }
        if (!inRunlogSection) {
          filtered.push(line);
        }
      }

      const newContent = filtered.join('\n').trim();

      if (newContent === '#!/bin/sh' || newContent === '') {
        // Hook is now empty, remove it
        await fs.promises.unlink(hookPath);
      } else {
        await fs.promises.writeFile(hookPath, newContent + '\n');
      }
    } catch {
      // Hook doesn't exist
    }
  }
}

/**
 * Check if git hooks are installed
 */
export async function areGitHooksInstalled(repoPath: string): Promise<boolean> {
  const gitDir = await getGitDir(repoPath);
  const hooksDir = path.resolve(repoPath, gitDir, 'hooks');

  for (const hookName of HOOK_NAMES) {
    const hookPath = path.join(hooksDir, hookName);
    try {
      const content = await fs.promises.readFile(hookPath, 'utf-8');
      if (content.includes(HOOK_MARKER)) return true;
    } catch {
      // Hook doesn't exist
    }
  }

  return false;
}

// ============================================================================
// Hook Script Generation
// ============================================================================

function generateHookScript(hookName: GitHookName, executable: string): string {
  switch (hookName) {
    case 'prepare-commit-msg':
      return [
        HOOK_MARKER,
        `${executable} hooks git prepare-commit-msg "$@" 2>/dev/null || true`,
      ].join('\n');

    case 'commit-msg':
      return [
        HOOK_MARKER,
        '# Commit-msg hook: strip trailer if no user content (allows aborting empty commits)',
        `${executable} hooks git commit-msg "$1" || exit 1`,
      ].join('\n');

    case 'post-commit':
      return [HOOK_MARKER, `${executable} hooks git post-commit 2>/dev/null || true`].join('\n');

    case 'pre-push':
      return [HOOK_MARKER, `${executable} hooks git pre-push "$@" 2>/dev/null || true`].join('\n');
  }
}
