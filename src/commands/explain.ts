/**
 * Explain Command
 *
 * Provides human-readable context about sessions, commits, and checkpoints.
 * This is the library implementation - consumers (CLI, IDE plugins) handle
 * their own output formatting and pager support.
 */

import type { CheckpointID, CommittedMetadata, Summary, AgentType, TokenUsage } from '../types.js';
import { CHECKPOINTS_BRANCH, checkpointIDPath } from '../types.js';
import { git, catFile, lsTree } from '../git-operations.js';
import { parseCheckpoint, parseAllSessions } from '../utils/trailers.js';
import { resolveSessionRepoConfig, type SessionRepoConfig } from '../utils/session-repo.js';

// ============================================================================
// Types
// ============================================================================

export interface CheckpointDetail {
  checkpointID: CheckpointID;
  sessionID: string;
  agent?: AgentType;
  strategy: string;
  createdAt: string;
  branch?: string;
  checkpointsCount: number;
  filesTouched: string[];
  tokenUsage?: TokenUsage;
  summary?: Summary;
  isTaskCheckpoint?: boolean;
  turnID?: string;
  transcriptIdentifierAtStart?: string;
  checkpointTranscriptStart: number;
}

export interface CheckpointListItem {
  checkpointID: CheckpointID;
  sessionID: string;
  message: string;
  date: string;
  isTaskCheckpoint: boolean;
  agent?: AgentType;
  sessionCount: number;
  sessionIDs: string[];
}

export interface ExplainOptions {
  cwd?: string;
  sessionFilter?: string;
  maxDepth?: number;
  searchAll?: boolean;
}

export interface CommitExplainResult {
  commitSHA: string;
  commitMessage: string;
  checkpointID: CheckpointID | null;
  detail: CheckpointDetail | null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * List checkpoints on the current branch.
 * Optionally filtered by session ID prefix.
 */
export async function listCheckpoints(options: ExplainOptions = {}): Promise<CheckpointListItem[]> {
  const cwd = options.cwd;
  const maxDepth = options.searchAll ? 0 : (options.maxDepth ?? 500);

  // Get commits on the current branch
  const logArgs = ['log', '--format=%H %s'];
  if (maxDepth > 0) logArgs.push(`-n`, `${maxDepth}`);

  let logOutput: string;
  try {
    logOutput = await git(logArgs, { cwd });
  } catch {
    return [];
  }

  const items: CheckpointListItem[] = [];

  for (const line of logOutput.split('\n')) {
    if (!line.trim()) continue;

    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;

    const sha = line.slice(0, spaceIdx);
    const message = line.slice(spaceIdx + 1);

    // Get full commit message to check for trailers
    let fullMessage: string;
    try {
      fullMessage = await git(['log', '-1', '--format=%B', sha], { cwd });
    } catch {
      continue;
    }

    const [cpID, hasCp] = parseCheckpoint(fullMessage);
    if (!hasCp || !cpID) continue;

    const sessionIDs = parseAllSessions(fullMessage);

    // Apply session filter
    if (options.sessionFilter) {
      const hasMatch = sessionIDs.some((sid) => sid.startsWith(options.sessionFilter!));
      if (!hasMatch) continue;
    }

    // Get commit date
    let date: string;
    try {
      date = (await git(['log', '-1', '--format=%aI', sha], { cwd })).trim();
    } catch {
      date = '';
    }

    items.push({
      checkpointID: cpID,
      sessionID: sessionIDs[0] ?? '',
      message: message.trim(),
      date,
      isTaskCheckpoint: message.includes('[task]'),
      sessionCount: sessionIDs.length,
      sessionIDs,
    });
  }

  return items;
}

/**
 * Get detailed information about a specific checkpoint.
 */
export async function getCheckpointDetail(
  checkpointID: CheckpointID,
  options: ExplainOptions = {},
): Promise<CheckpointDetail | null> {
  const cwd = options.cwd;
  const repoConfig = await resolveSessionRepoConfig(cwd);
  const cpBranch = repoConfig.checkpointsBranch ?? CHECKPOINTS_BRANCH;
  const targetCwd = repoConfig.sessionRepoCwd ?? cwd;

  // Try to read committed metadata from the checkpoints branch
  const metadataPath = `${checkpointIDPath(checkpointID)}/metadata.json`;

  try {
    const content = await catFile(`${cpBranch}:${metadataPath}`, targetCwd);
    const metadata = JSON.parse(content) as CommittedMetadata;

    return {
      checkpointID: metadata.checkpointID,
      sessionID: metadata.sessionID,
      agent: metadata.agent,
      strategy: metadata.strategy,
      createdAt: metadata.createdAt,
      branch: metadata.branch,
      checkpointsCount: metadata.checkpointsCount,
      filesTouched: metadata.filesTouched,
      tokenUsage: metadata.tokenUsage,
      summary: metadata.summary,
      isTaskCheckpoint: metadata.isTask,
      turnID: metadata.turnID,
      transcriptIdentifierAtStart: metadata.transcriptIdentifierAtStart,
      checkpointTranscriptStart: metadata.checkpointTranscriptStart,
    };
  } catch {
    return null;
  }
}

/**
 * Get the transcript content for a checkpoint.
 */
export async function getCheckpointTranscript(
  checkpointID: CheckpointID,
  options: ExplainOptions = {},
): Promise<Buffer | null> {
  const cwd = options.cwd;
  const repoConfig = await resolveSessionRepoConfig(cwd);
  const cpBranch = repoConfig.checkpointsBranch ?? CHECKPOINTS_BRANCH;
  const targetCwd = repoConfig.sessionRepoCwd ?? cwd;
  const transcriptPath = `${checkpointIDPath(checkpointID)}/transcript`;

  try {
    const content = await catFile(`${cpBranch}:${transcriptPath}`, targetCwd);
    return Buffer.from(content, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Explain a specific commit by finding its associated checkpoint.
 */
export async function explainCommit(
  commitRef: string,
  options: ExplainOptions = {},
): Promise<CommitExplainResult | null> {
  const cwd = options.cwd;

  let fullMessage: string;
  try {
    fullMessage = await git(['log', '-1', '--format=%B', commitRef], { cwd });
  } catch {
    return null;
  }

  const [cpID] = parseCheckpoint(fullMessage);

  let sha: string;
  try {
    sha = (await git(['rev-parse', commitRef], { cwd })).trim();
  } catch {
    return null;
  }

  const message = fullMessage.split('\n')[0] ?? '';

  let detail: CheckpointDetail | null = null;
  if (cpID) {
    detail = await getCheckpointDetail(cpID, options);
  }

  return {
    commitSHA: sha,
    commitMessage: message,
    checkpointID: cpID,
    detail,
  };
}

/**
 * Find a checkpoint by ID prefix (partial match).
 */
export async function findCheckpointByPrefix(
  prefix: string,
  options: ExplainOptions = {},
): Promise<CheckpointID | null> {
  const cwd = options.cwd;
  const repoConfig = await resolveSessionRepoConfig(cwd);
  const cpBranch = repoConfig.checkpointsBranch ?? CHECKPOINTS_BRANCH;
  const targetCwd = repoConfig.sessionRepoCwd ?? cwd;

  // For full IDs, just return directly
  if (prefix.length === 12) return prefix as CheckpointID;

  // Need at least 2 chars for shard prefix
  if (prefix.length < 2) return null;

  const shardPrefix = prefix.slice(0, 2);
  const remainder = prefix.slice(2);

  try {
    const entries = await lsTree(cpBranch, shardPrefix, targetCwd);

    for (const entry of entries) {
      if (entry.name.startsWith(remainder)) {
        return `${shardPrefix}${entry.name}` as CheckpointID;
      }
    }
  } catch {
    // Shard doesn't exist
  }

  return null;
}
