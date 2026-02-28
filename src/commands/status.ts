/**
 * Status Command
 *
 * Shows the current Entire setup status, active sessions,
 * and configuration.
 */

import { type EntireSettings, CHECKPOINTS_BRANCH } from '../types.js';
import {
  isGitRepository,
  getWorktreeRoot,
  getCurrentBranch,
  refExists,
  initSessionRepo,
  resolveSessionRepoPath,
  getProjectID,
} from '../git-operations.js';
import { loadSettings } from '../config.js';
import { createSessionStore } from '../store/session-store.js';
import { SESSION_DIR_NAME } from '../types.js';
import { areGitHooksInstalled } from '../hooks/git-hooks.js';
import { detectAgents } from '../agent/registry.js';
import { hasHookSupport } from '../agent/types.js';

// ============================================================================
// Types
// ============================================================================

export interface StatusResult {
  /** Whether Entire is set up and enabled */
  enabled: boolean;

  /** Current strategy */
  strategy: string;

  /** Current branch */
  branch: string | null;

  /** Whether the checkpoints branch exists */
  hasCheckpointsBranch: boolean;

  /** Active sessions */
  sessions: SessionStatus[];

  /** Installed agents with hooks */
  agents: string[];

  /** Whether git hooks are installed */
  gitHooksInstalled: boolean;

  /** Effective settings */
  settings: EntireSettings;
}

export interface SessionStatus {
  sessionID: string;
  agentType: string;
  phase: string;
  startedAt: string;
  firstPrompt?: string;
  filesTouched: string[];
  stepCount: number;
  tokenUsage?: {
    input: number;
    output: number;
  };
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Get the current status of Entire
 */
export async function status(cwd?: string): Promise<StatusResult> {
  const isRepo = await isGitRepository(cwd);

  if (!isRepo) {
    return {
      enabled: false,
      strategy: 'manual-commit',
      branch: null,
      hasCheckpointsBranch: false,
      sessions: [],
      agents: [],
      gitHooksInstalled: false,
      settings: { enabled: false, strategy: 'manual-commit' },
    };
  }

  const root = await getWorktreeRoot(cwd);
  const settings = await loadSettings(cwd);
  const branch = await getCurrentBranch(cwd);
  const gitHooks = await areGitHooksInstalled(root);

  // Resolve session repo if configured
  let sessionRepoCwd: string | undefined;
  let sessionsDir: string | undefined;
  let cpBranch = CHECKPOINTS_BRANCH;
  if (settings.sessionRepoPath) {
    try {
      const projectID = getProjectID(root);
      const resolved = resolveSessionRepoPath(settings.sessionRepoPath, root);
      sessionRepoCwd = await initSessionRepo(resolved);
      sessionsDir = `${sessionRepoCwd}/${SESSION_DIR_NAME}/${projectID}`;
      cpBranch = `${CHECKPOINTS_BRANCH}/${projectID}`;
    } catch {
      // Fall back to project repo if session repo can't be initialized
    }
  }

  const checkpointsCwd = sessionRepoCwd ?? cwd;
  const hasCheckpoints = await refExists(`refs/heads/${cpBranch}`, checkpointsCwd);

  // Detect agents with hooks
  const agents = await detectAgents(cwd);
  const agentNames: string[] = [];
  for (const agent of agents) {
    if (hasHookSupport(agent)) {
      const installed = await agent.areHooksInstalled(root);
      if (installed) agentNames.push(agent.name);
    }
  }

  // Load sessions
  const sessionStore = createSessionStore(cwd, sessionsDir);
  const allSessions = await sessionStore.list();

  const sessions: SessionStatus[] = allSessions.map((s) => ({
    sessionID: s.sessionID,
    agentType: s.agentType,
    phase: s.phase,
    startedAt: s.startedAt,
    firstPrompt: s.firstPrompt,
    filesTouched: s.filesTouched,
    stepCount: s.stepCount,
    tokenUsage: s.tokenUsage
      ? {
          input: s.tokenUsage.inputTokens + s.tokenUsage.cacheReadTokens,
          output: s.tokenUsage.outputTokens,
        }
      : undefined,
  }));

  return {
    enabled: settings.enabled,
    strategy: settings.strategy,
    branch,
    hasCheckpointsBranch: hasCheckpoints,
    sessions,
    agents: agentNames,
    gitHooksInstalled: gitHooks,
    settings,
  };
}

/**
 * Format status for display (JSON output)
 */
export function formatStatusJSON(result: StatusResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Format token count for display
 */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}
