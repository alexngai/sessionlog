/**
 * Disable Command
 *
 * Disables Runlog in a repository. Can optionally fully uninstall
 * hooks and clean up all Runlog data.
 */

import { getWorktreeRoot, isGitRepository } from '../git-operations.js';
import { saveProjectSettings, saveLocalSettings } from '../config.js';
import { uninstallGitHooks } from '../hooks/git-hooks.js';
import { detectAgents } from '../agent/registry.js';
import { hasHookSupport } from '../agent/types.js';

// ============================================================================
// Types
// ============================================================================

export interface DisableOptions {
  cwd?: string;
  /** Fully uninstall hooks (not just disable) */
  uninstall?: boolean;
  /** Disable in local settings instead of project settings */
  local?: boolean;
}

export interface DisableResult {
  disabled: boolean;
  uninstalled: boolean;
  errors: string[];
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Disable Runlog in a repository
 */
export async function disable(options: DisableOptions = {}): Promise<DisableResult> {
  const cwd = options.cwd ?? process.cwd();
  const errors: string[] = [];

  if (!(await isGitRepository(cwd))) {
    return { disabled: false, uninstalled: false, errors: ['Not a git repository'] };
  }

  const root = await getWorktreeRoot(cwd);

  // Update settings
  if (options.local) {
    await saveLocalSettings({ enabled: false }, cwd);
  } else {
    await saveProjectSettings({ enabled: false }, cwd);
  }

  let uninstalled = false;

  if (options.uninstall) {
    // Remove git hooks
    try {
      await uninstallGitHooks(root);
    } catch (e) {
      errors.push(`Failed to uninstall git hooks: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Remove agent hooks
    const agents = await detectAgents(cwd);
    for (const agent of agents) {
      if (hasHookSupport(agent)) {
        try {
          await agent.uninstallHooks(root);
        } catch (e) {
          errors.push(
            `Failed to uninstall ${agent.name} hooks: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    uninstalled = true;
  }

  return { disabled: true, uninstalled, errors };
}
