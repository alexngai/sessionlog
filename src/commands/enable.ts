/**
 * Enable Command
 *
 * Enables Entire in a repository: creates settings, installs hooks,
 * auto-detects agents.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type EntireSettings,
  type AgentName,
  ENTIRE_DIR,
  ENTIRE_METADATA_DIR,
  ENTIRE_TMP_DIR,
  SESSION_DIR_NAME,
} from '../types.js';
import {
  isGitRepository,
  getWorktreeRoot,
  getGitDir,
  getHead,
  initSessionRepo,
  resolveSessionRepoPath,
} from '../git-operations.js';
import { saveProjectSettings, saveLocalSettings, ensureGitignore } from '../config.js';
import { installGitHooks } from '../hooks/git-hooks.js';
import { detectAgent, getAgent, listAgentNames } from '../agent/registry.js';
import { hasHookSupport } from '../agent/types.js';

// ============================================================================
// Types
// ============================================================================

export interface EnableOptions {
  /** Working directory */
  cwd?: string;

  /** Specific agent to enable (auto-detect if not specified) */
  agent?: AgentName;

  /** Force reinstall hooks even if already present */
  force?: boolean;

  /** Save to local settings instead of project settings */
  local?: boolean;

  /** Write to settings.json even if already present */
  project?: boolean;

  /** Disable automatic session log pushing */
  skipPushSessions?: boolean;

  /** Opt out of anonymous analytics */
  telemetry?: boolean;

  /** Path to a separate repository for session/checkpoint storage */
  sessionRepoPath?: string;
}

export interface EnableResult {
  enabled: boolean;
  agent: AgentName | null;
  agentHooksInstalled: number;
  gitHooksInstalled: number;
  errors: string[];
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Enable Entire in a repository
 */
export async function enable(options: EnableOptions = {}): Promise<EnableResult> {
  const cwd = options.cwd ?? process.cwd();
  const errors: string[] = [];

  // Validate git repository
  if (!(await isGitRepository(cwd))) {
    return {
      enabled: false,
      agent: null,
      agentHooksInstalled: 0,
      gitHooksInstalled: 0,
      errors: ['Not a git repository'],
    };
  }

  // Validate repository has at least one commit
  try {
    await getHead(cwd);
  } catch {
    return {
      enabled: false,
      agent: null,
      agentHooksInstalled: 0,
      gitHooksInstalled: 0,
      errors: ['Repository has no commits'],
    };
  }

  const root = await getWorktreeRoot(cwd);

  // Detect or resolve agent
  const agent = options.agent ? getAgent(options.agent) : await detectAgent(cwd);

  if (!agent) {
    errors.push(
      `No agent detected. Available agents: ${listAgentNames().join(', ')}. ` +
        `Install an agent or specify one with --agent.`,
    );
  }

  // Create directories
  await createDirectories(root, cwd);

  // Save settings
  const settings: Partial<EntireSettings> = {
    enabled: true,
    strategy: 'manual-commit',
  };

  if (options.skipPushSessions !== undefined) {
    settings.skipPushSessions = options.skipPushSessions;
  }

  if (options.telemetry !== undefined) {
    settings.telemetryEnabled = options.telemetry;
  }

  if (options.sessionRepoPath) {
    settings.sessionRepoPath = options.sessionRepoPath;
  }

  if (options.local) {
    await saveLocalSettings(settings, cwd);
  } else {
    await saveProjectSettings(settings, cwd);
  }

  // Initialize separate session repo if configured
  if (options.sessionRepoPath) {
    try {
      const resolved = resolveSessionRepoPath(options.sessionRepoPath, root);
      await initSessionRepo(resolved);
    } catch (e) {
      errors.push(
        `Failed to initialize session repo: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Set up .gitignore for local files
  await ensureGitignore(cwd);

  // Install git hooks
  let gitHooksInstalled = 0;
  try {
    gitHooksInstalled = await installGitHooks(root);
  } catch (e) {
    errors.push(`Failed to install git hooks: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Install agent hooks
  let agentHooksInstalled = 0;
  if (agent && hasHookSupport(agent)) {
    try {
      agentHooksInstalled = await agent.installHooks(root, options.force);
    } catch (e) {
      errors.push(`Failed to install agent hooks: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    enabled: true,
    agent: agent?.name ?? null,
    agentHooksInstalled,
    gitHooksInstalled,
    errors,
  };
}

async function createDirectories(root: string, cwd: string): Promise<void> {
  const dirs = [
    path.join(root, ENTIRE_DIR),
    path.join(root, ENTIRE_METADATA_DIR),
    path.join(root, ENTIRE_TMP_DIR),
  ];

  // Also create .git/entire-sessions/
  try {
    const gitDir = await getGitDir(cwd);
    const sessionsDir = path.resolve(root, gitDir, SESSION_DIR_NAME);
    dirs.push(sessionsDir);
  } catch {
    // Ignore if git dir resolution fails
  }

  for (const dir of dirs) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
}
