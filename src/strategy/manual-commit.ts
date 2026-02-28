/**
 * Manual Commit Strategy
 *
 * Core strategy implementation that orchestrates session tracking,
 * checkpoint creation, condensation, and git hook integration.
 *
 * Data flow:
 * 1. InitializeSession -> Creates SessionState, calculates initial attribution
 * 2. SaveStep/SaveTaskStep -> Writes to shadow branch via CheckpointStore
 * 3. PrepareCommitMsg -> Adds Entire-Checkpoint trailer to commit messages
 * 4. PostCommit -> Condenses session data, handles carry-forward
 * 5. PrePush -> Pushes metadata branch alongside user push
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionStore } from '../store/session-store.js';
import type { CheckpointStore } from '../store/checkpoint-store.js';
import type { SessionState, CheckpointID } from '../types.js';
import {
  addTokenUsage,
  CHECKPOINTS_BRANCH,
  SHADOW_BRANCH_PREFIX,
  validateCheckpointID,
} from '../types.js';
import {
  git,
  gitSafe,
  getHead,
  getCurrentBranch,
  getWorktreeRoot,
  getGitAuthor,
  getUntrackedFiles,
  refExists,
  pushBranch,
  hasUncommittedChanges,
  listBranches,
  showFile,
  lsTree,
  deleteBranch,
  updateRef,
  diffNameOnly,
} from '../git-operations.js';
import { parseCheckpoint, formatShadowCommit, CheckpointTrailerKey } from '../utils/trailers.js';
import {
  filesOverlapWithContent,
  stagedFilesOverlapWithContent,
  filesWithRemainingAgentChanges,
} from './content-overlap.js';
import type {
  Strategy,
  StepContext,
  TaskStepContext,
  CondensationResult,
  RewindPoint,
  OrphanedItem,
} from './types.js';
import { STRATEGY_NAME_MANUAL_COMMIT, formatSubagentEndMessage } from './types.js';

// ============================================================================
// ManualCommitStrategy
// ============================================================================

export interface ManualCommitStrategyConfig {
  sessionStore: SessionStore;
  checkpointStore: CheckpointStore;
  cwd?: string;
  /** When a separate session repo is configured, this is its working directory.
   *  Used for pushing the checkpoints branch from the correct repo. */
  sessionRepoCwd?: string;
  /** Override for the checkpoints branch name (e.g. project-namespaced). */
  checkpointsBranch?: string;
}

export function createManualCommitStrategy(config: ManualCommitStrategyConfig): Strategy {
  const { sessionStore, checkpointStore, cwd, sessionRepoCwd } = config;
  /** The cwd for operations on the committed checkpoints branch */
  const committedCwd = sessionRepoCwd ?? cwd;
  /** Branch name for committed checkpoints */
  const cpBranch = config.checkpointsBranch ?? CHECKPOINTS_BRANCH;

  // ========================================================================
  // Session State Helpers
  // ========================================================================

  async function loadSession(sessionID: string): Promise<SessionState | null> {
    return sessionStore.load(sessionID);
  }

  async function saveSession(state: SessionState): Promise<void> {
    await sessionStore.save(state);
  }

  async function listAllSessions(): Promise<SessionState[]> {
    return sessionStore.list();
  }

  async function findSessionsForCommit(baseCommitSHA: string): Promise<SessionState[]> {
    const all = await listAllSessions();
    return all.filter((s) => s.baseCommit === baseCommitSHA);
  }

  function getShadowBranchName(baseCommit: string, worktreeID?: string): string {
    return checkpointStore.getShadowBranchName(baseCommit, worktreeID);
  }

  // ========================================================================
  // File Merging Helpers
  // ========================================================================

  function mergeFilesTouched(existing: string[], ...fileLists: string[][]): string[] {
    const seen = new Set(existing);
    for (const list of fileLists) {
      for (const f of list) seen.add(f);
    }
    return Array.from(seen).sort();
  }

  // ========================================================================
  // Strategy Implementation
  // ========================================================================

  const strategy: Strategy = {
    name: STRATEGY_NAME_MANUAL_COMMIT,

    // ======================================================================
    // PrepareCommitMsg - Add checkpoint trailer to commit messages
    // ======================================================================
    async prepareCommitMsg(commitMsgFile: string, source: string, _sha: string): Promise<void> {
      // Read the current commit message
      const commitMsg = fs.readFileSync(commitMsgFile, 'utf-8');

      // Skip merge commits
      if (source === 'merge') return;

      // Handle amend: preserve existing checkpoint trailer
      if (source === 'commit') {
        const [cpID, found] = parseCheckpoint(commitMsg);
        if (found && cpID) {
          // Trailer already present, nothing to do
          return;
        }
      }

      // Get current HEAD
      const head = await getHead(cwd);

      // Find active sessions for this commit
      const sessions = await findSessionsForCommit(head);
      if (sessions.length === 0) return;

      // Get staged files
      const stagedOutput = await gitSafe(
        ['diff', '--cached', '--name-only', '--diff-filter=ACMRD'],
        { cwd },
      );
      if (!stagedOutput) return;
      const stagedFiles = stagedOutput
        .trim()
        .split('\n')
        .filter((f) => f.length > 0);
      if (stagedFiles.length === 0) return;

      // Check if any session has overlapping work
      let hasOverlap = false;
      let overlappingSession: SessionState | null = null;

      for (const state of sessions) {
        if (state.stepCount === 0 || state.filesTouched.length === 0) continue;

        const shadowBranch = getShadowBranchName(state.baseCommit, state.worktreeID);
        const exists = await refExists(`refs/heads/${shadowBranch}`, cwd);
        if (!exists) continue;

        // Content-aware overlap check
        const overlap = await stagedFilesOverlapWithContent(
          shadowBranch,
          stagedFiles,
          state.filesTouched,
          cwd,
        );

        if (overlap) {
          hasOverlap = true;
          overlappingSession = state;
          break;
        }
      }

      if (!hasOverlap || !overlappingSession) return;

      // Generate or reuse checkpoint ID
      let cpID: CheckpointID;
      if (
        overlappingSession.lastCheckpointID &&
        validateCheckpointID(overlappingSession.lastCheckpointID)
      ) {
        cpID = overlappingSession.lastCheckpointID;
      } else {
        cpID = await checkpointStore.generateID();
      }

      // Inject trailer into commit message
      const trailer = `${CheckpointTrailerKey}: ${cpID}`;
      const injected = injectCheckpointTrailer(commitMsg, trailer);
      fs.writeFileSync(commitMsgFile, injected, 'utf-8');
    },

    // ======================================================================
    // PostCommit - Condense session data after commit
    // ======================================================================
    async postCommit(): Promise<void> {
      // Read HEAD commit message
      const headHash = await getHead(cwd);
      const commitMsg = await git(['log', '-1', '--format=%B', headHash], { cwd });

      // Check for checkpoint trailer
      const [cpID, found] = parseCheckpoint(commitMsg);
      if (!found || !cpID) return;

      // Find sessions for the parent commit (our base)
      const parentHash = await gitSafe(['rev-parse', `${headHash}^`], { cwd });
      if (!parentHash) return;

      const sessions = await findSessionsForCommit(parentHash.trim());
      if (sessions.length === 0) return;

      // Get files changed in this commit
      const { added, modified, deleted } = await diffNameOnly(`${headHash}^`, headHash, cwd);
      const committedFiles = new Set([...added, ...modified, ...deleted]);

      // Process each session
      for (const state of sessions) {
        if (state.stepCount === 0 || state.filesTouched.length === 0) continue;

        const shadowBranch = getShadowBranchName(state.baseCommit, state.worktreeID);
        const exists = await refExists(`refs/heads/${shadowBranch}`, cwd);
        if (!exists) continue;

        // Check overlap with committed files
        const overlap = await filesOverlapWithContent(
          shadowBranch,
          headHash,
          parentHash.trim(),
          state.filesTouched,
          cwd,
        );
        if (!overlap) continue;

        // Condense this session
        try {
          await condenseSession(state, cpID, committedFiles);
        } catch {
          // Log but continue with other sessions
        }

        // Handle carry-forward for remaining files
        const remaining = await filesWithRemainingAgentChanges(
          shadowBranch,
          headHash,
          state.filesTouched,
          committedFiles,
          cwd,
        );

        if (remaining.length === 0) {
          // All files committed - clean up shadow branch
          try {
            await checkpointStore.deleteShadowBranch(shadowBranch);
          } catch {
            // Best effort cleanup
          }

          // Update session for new base commit
          state.baseCommit = headHash;
          state.stepCount = 0;
          state.filesTouched = [];
          state.promptAttributions = [];
          state.lastCheckpointID = cpID;
          await saveSession(state);
        } else {
          // Carry forward: update state for remaining files
          state.baseCommit = headHash;
          state.filesTouched = remaining;
          state.stepCount = 0;
          state.promptAttributions = [];
          state.lastCheckpointID = cpID;
          await saveSession(state);
        }
      }
    },

    // ======================================================================
    // CommitMsg - Strip trailer if no user content (prevents empty commits)
    // ======================================================================
    async commitMsg(commitMsgFile: string): Promise<void> {
      let content: string;
      try {
        content = fs.readFileSync(commitMsgFile, 'utf-8');
      } catch {
        return; // Hook must be silent on failure
      }

      // Check if our trailer is present
      const [, found] = parseCheckpoint(content);
      if (!found) return;

      // Check if there's any user content (non-comment, non-trailer lines)
      if (!hasUserContent(content)) {
        // No user content - strip the trailer so git aborts the commit
        const stripped = stripCheckpointTrailer(content);
        try {
          fs.writeFileSync(commitMsgFile, stripped, 'utf-8');
        } catch {
          // Hook must be silent on failure
        }
      }
    },

    // ======================================================================
    // PrePush - Push metadata branch alongside user push
    // ======================================================================
    async prePush(remote: string): Promise<void> {
      const pushCwd = committedCwd;
      const branchExists = await refExists(`refs/heads/${cpBranch}`, pushCwd);
      if (!branchExists) return;

      try {
        await pushBranch(remote, cpBranch, false, pushCwd);
      } catch {
        // Non-fatal: metadata push failure shouldn't block user push
      }
    },

    // ======================================================================
    // SaveStep - Create session checkpoint on shadow branch
    // ======================================================================
    async saveStep(step: StepContext): Promise<void> {
      const sessionID = path.basename(step.metadataDir);
      let state = await loadSession(sessionID);

      // Initialize if needed
      if (!state || !state.baseCommit) {
        const head = await getHead(cwd);
        const untrackedFiles = await getUntrackedFiles(cwd);
        const worktreeRoot = await getWorktreeRoot(cwd);

        state = {
          sessionID,
          baseCommit: head,
          attributionBaseCommit: head,
          startedAt: new Date().toISOString(),
          phase: 'active',
          turnCheckpointIDs: [],
          stepCount: 0,
          checkpointTranscriptStart: 0,
          untrackedFilesAtStart: untrackedFiles,
          filesTouched: [],
          agentType: step.agentType,
          worktreePath: worktreeRoot,
        };
        await saveSession(state);
      }

      // Migrate shadow branch if HEAD changed (rebase/pull mid-session)
      await migrateAndPersist(state);

      // Write temporary checkpoint
      const isFirstCheckpoint = state.stepCount === 0;
      const result = await checkpointStore.writeTemporary({
        sessionID,
        baseCommit: state.baseCommit,
        worktreeID: state.worktreeID,
        modifiedFiles: step.modifiedFiles,
        newFiles: step.newFiles,
        deletedFiles: step.deletedFiles,
        metadataDir: step.metadataDir,
        metadataDirAbs: step.metadataDirAbs,
        commitMessage: step.commitMessage,
        authorName: step.authorName,
        authorEmail: step.authorEmail,
        isFirstCheckpoint,
      });

      if (result.skipped) return;

      // Update session state
      state.stepCount++;
      state.filesTouched = mergeFilesTouched(
        state.filesTouched,
        step.modifiedFiles,
        step.newFiles,
        step.deletedFiles,
      );

      if (state.stepCount === 1 && step.stepTranscriptIdentifier) {
        state.transcriptIdentifierAtStart = step.stepTranscriptIdentifier;
      }

      if (step.tokenUsage) {
        state.tokenUsage = state.tokenUsage
          ? addTokenUsage(state.tokenUsage, step.tokenUsage)
          : step.tokenUsage;
      }

      await saveSession(state);
    },

    // ======================================================================
    // SaveTaskStep - Create task checkpoint on shadow branch
    // ======================================================================
    async saveTaskStep(step: TaskStepContext): Promise<void> {
      let state = await loadSession(step.sessionID);

      if (!state || !state.baseCommit) {
        const head = await getHead(cwd);
        const untrackedFiles = await getUntrackedFiles(cwd);
        const worktreeRoot = await getWorktreeRoot(cwd);

        state = {
          sessionID: step.sessionID,
          baseCommit: head,
          attributionBaseCommit: head,
          startedAt: new Date().toISOString(),
          phase: 'active',
          turnCheckpointIDs: [],
          stepCount: 0,
          checkpointTranscriptStart: 0,
          untrackedFilesAtStart: untrackedFiles,
          filesTouched: [],
          agentType: step.agentType,
          worktreePath: worktreeRoot,
        };
        await saveSession(state);
      }

      // Migrate shadow branch if HEAD changed (rebase/pull mid-session)
      await migrateAndPersist(state);

      // Generate commit message for task checkpoint
      const shortToolUseID =
        step.toolUseID.length > 7 ? step.toolUseID.slice(0, 7) : step.toolUseID;
      const messageSubject = formatSubagentEndMessage(
        step.subagentType,
        step.taskDescription,
        shortToolUseID,
      );
      const metadataDir = `.entire/metadata/${step.sessionID}/tasks/${step.toolUseID}`;
      const commitMsg = formatShadowCommit(messageSubject, metadataDir, step.sessionID);

      // Write temporary checkpoint
      await checkpointStore.writeTemporary({
        sessionID: step.sessionID,
        baseCommit: state.baseCommit,
        worktreeID: state.worktreeID,
        modifiedFiles: step.modifiedFiles,
        newFiles: step.newFiles,
        deletedFiles: step.deletedFiles,
        metadataDir,
        metadataDirAbs: path.resolve(cwd ?? '.', metadataDir),
        commitMessage: commitMsg,
        authorName: step.authorName,
        authorEmail: step.authorEmail,
        isFirstCheckpoint: state.stepCount === 0,
      });

      // Update session state
      state.filesTouched = mergeFilesTouched(
        state.filesTouched,
        step.modifiedFiles,
        step.newFiles,
        step.deletedFiles,
      );
      await saveSession(state);
    },

    // ======================================================================
    // Rewind operations
    // ======================================================================
    async getRewindPoints(limit: number): Promise<RewindPoint[]> {
      const head = await getHead(cwd);
      const sessions = await findSessionsForCommit(head);
      const allPoints: RewindPoint[] = [];

      for (const state of sessions) {
        const shadowBranch = getShadowBranchName(state.baseCommit, state.worktreeID);
        const exists = await refExists(`refs/heads/${shadowBranch}`, cwd);
        if (!exists) continue;

        // List temporary checkpoints
        const temps = await checkpointStore.listTemporary();
        for (const temp of temps) {
          if (temp.baseCommit !== state.baseCommit) continue;

          allPoints.push({
            id: temp.latestCommit,
            message: `Checkpoint on ${shadowBranch}`,
            date: new Date(temp.timestamp),
            isTaskCheckpoint: false,
            isLogsOnly: false,
            agent: state.agentType,
            sessionID: state.sessionID,
            sessionPrompt: state.firstPrompt,
            sessionCount: 1,
            sessionIDs: [state.sessionID],
          });
        }
      }

      // Sort by date descending
      allPoints.sort((a, b) => b.date.getTime() - a.date.getTime());

      // Also add logs-only points from commit history
      const logsOnlyPoints = await getLogsOnlyRewindPoints(limit);
      const existingIDs = new Set(allPoints.map((p) => p.id));
      for (const p of logsOnlyPoints) {
        if (!existingIDs.has(p.id)) {
          allPoints.push(p);
        }
      }

      // Re-sort and trim
      allPoints.sort((a, b) => b.date.getTime() - a.date.getTime());
      return allPoints.slice(0, limit);
    },

    async rewind(point: RewindPoint): Promise<void> {
      if (point.isLogsOnly) {
        throw new Error('Use restoreLogsOnly for logs-only rewind points');
      }

      // Read checkpoint tree and restore files
      const treeEntries = await lsTree(point.id, undefined, cwd);
      const worktreeRoot = await getWorktreeRoot(cwd);

      for (const entry of treeEntries) {
        if (entry.name.startsWith('.entire/')) continue;

        try {
          const content = await showFile(point.id, entry.name, cwd);
          const absPath = path.join(worktreeRoot, entry.name);
          const dir = path.dirname(absPath);
          fs.mkdirSync(dir, { recursive: true });

          const perm = entry.mode === '100755' ? 0o755 : 0o644;
          fs.writeFileSync(absPath, content, { mode: perm });
        } catch {
          // Skip files that can't be restored
        }
      }
    },

    async canRewind(): Promise<[boolean, string]> {
      const hasChanges = await hasUncommittedChanges(cwd);
      if (hasChanges) {
        return [
          true,
          'Warning: You have uncommitted changes that will be overwritten by the rewind.',
        ];
      }
      return [true, ''];
    },

    // ======================================================================
    // Condensation
    // ======================================================================
    async condense(sessionID: string): Promise<CondensationResult> {
      const state = await loadSession(sessionID);
      if (!state) {
        throw new Error(`Session not found: ${sessionID}`);
      }

      const cpID = await checkpointStore.generateID();
      const committedFiles = new Set(state.filesTouched);
      return condenseSession(state, cpID, committedFiles);
    },

    // ======================================================================
    // Validation & Cleanup
    // ======================================================================

    async validateRepository(): Promise<void> {
      const { validateRepository: validate } = await import('./common.js');
      await validate(cwd);
    },

    async listOrphanedItems(): Promise<OrphanedItem[]> {
      const items: OrphanedItem[] = [];

      // Find orphaned shadow branches
      const allBranches = await listBranches(cwd);
      for (const branch of allBranches) {
        if (branch.startsWith(SHADOW_BRANCH_PREFIX) && branch !== CHECKPOINTS_BRANCH) {
          items.push({
            type: 'shadow-branch',
            id: branch,
            reason: 'shadow branch (should have been auto-cleaned)',
          });
        }
      }

      return items;
    },
  };

  // ========================================================================
  // Internal: Condensation
  // ========================================================================

  async function condenseSession(
    state: SessionState,
    checkpointID: CheckpointID,
    committedFiles: Set<string>,
  ): Promise<CondensationResult> {
    const author = await getGitAuthor(cwd);
    const branch = await getCurrentBranch(cwd);

    // Filter filesTouched to committed subset
    const filesTouched = state.filesTouched.filter((f) => committedFiles.has(f));

    // Build transcript and prompts from shadow branch
    let transcript = Buffer.alloc(0);
    let prompts: string[] = [];
    let context = Buffer.alloc(0);

    const shadowBranch = getShadowBranchName(state.baseCommit, state.worktreeID);
    const shadowExists = await refExists(`refs/heads/${shadowBranch}`, cwd);

    if (shadowExists) {
      // Read transcript from shadow branch metadata
      try {
        const metadataDir = `.entire/metadata/${state.sessionID}`;
        const fullContent = await gitSafe(
          ['show', `refs/heads/${shadowBranch}:${metadataDir}/full.jsonl`],
          { cwd },
        );
        if (fullContent) {
          transcript = Buffer.from(fullContent, 'utf-8');
        }
      } catch {
        // Use empty transcript
      }

      // Read prompts
      try {
        const metadataDir = `.entire/metadata/${state.sessionID}`;
        const promptContent = await gitSafe(
          ['show', `refs/heads/${shadowBranch}:${metadataDir}/prompt.txt`],
          { cwd },
        );
        if (promptContent) {
          prompts = promptContent.split('\n---\n').filter((p) => p.trim().length > 0);
        }
      } catch {
        // Use empty prompts
      }
    }

    // If we have a live transcript path, try to read from there
    if (transcript.length === 0 && state.transcriptPath) {
      try {
        transcript = fs.readFileSync(state.transcriptPath);
      } catch {
        // Keep empty
      }
    }

    // Generate context from prompts
    if (prompts.length > 0) {
      const contextLines = prompts.map((p, i) => `## Prompt ${i + 1}\n\n${p}`);
      context = Buffer.from(contextLines.join('\n\n---\n\n'), 'utf-8');
    }

    // Write committed checkpoint
    await checkpointStore.writeCommitted({
      checkpointID,
      sessionID: state.sessionID,
      strategy: STRATEGY_NAME_MANUAL_COMMIT,
      branch: branch ?? undefined,
      transcript,
      prompts,
      context,
      filesTouched,
      checkpointsCount: state.stepCount,
      authorName: author.name,
      authorEmail: author.email,
      agent: state.agentType,
      turnID: state.turnID,
      transcriptIdentifierAtStart: state.transcriptIdentifierAtStart,
      checkpointTranscriptStart: state.checkpointTranscriptStart,
      tokenUsage: state.tokenUsage,
    });

    return {
      checkpointID,
      sessionsCondensed: 1,
      checkpointsCount: state.stepCount,
      filesTouched,
      tokenUsage: state.tokenUsage,
    };
  }

  // ========================================================================
  // Internal: Logs-only rewind points from commit history
  // ========================================================================

  async function getLogsOnlyRewindPoints(limit: number): Promise<RewindPoint[]> {
    const points: RewindPoint[] = [];

    // Check if checkpoints branch exists (in session repo if configured)
    const branchExists = await refExists(`refs/heads/${cpBranch}`, committedCwd);
    if (!branchExists) return points;

    // Get committed checkpoints
    const committed = await checkpointStore.listCommitted(limit);
    if (committed.length === 0) return points;

    // Build map of checkpoint IDs
    const cpMap = new Map<string, (typeof committed)[0]>();
    for (const cp of committed) {
      if (cp.checkpointID) {
        cpMap.set(cp.checkpointID, cp);
      }
    }

    // Walk commit history looking for checkpoint trailers
    const head = await getHead(cwd);
    const logOutput = await gitSafe(
      ['log', '--format=%H %s%n%b', `--max-count=${limit * 2}`, head],
      { cwd },
    );
    if (!logOutput) return points;

    // Parse log output looking for checkpoint trailers
    const commits = logOutput.split('\n\n').filter((c) => c.trim().length > 0);

    for (const commitBlock of commits) {
      const lines = commitBlock.split('\n');
      if (lines.length === 0) continue;

      const firstLine = lines[0];
      const spaceIdx = firstLine.indexOf(' ');
      if (spaceIdx < 0) continue;

      const sha = firstLine.slice(0, spaceIdx);
      const message = firstLine.slice(spaceIdx + 1);
      const body = lines.slice(1).join('\n');
      const fullMessage = `${message}\n${body}`;

      const [cpID, found] = parseCheckpoint(fullMessage);
      if (!found || !cpID) continue;

      const cpInfo = cpMap.get(cpID);
      if (!cpInfo) continue;

      points.push({
        id: sha,
        message,
        date: new Date(),
        isLogsOnly: true,
        isTaskCheckpoint: false,
        checkpointID: cpID,
        sessionCount: cpInfo.sessions?.length ?? 1,
        sessionIDs: [],
      });

      if (points.length >= limit) break;
    }

    return points;
  }

  // ========================================================================
  // Internal: Shadow branch migration
  // ========================================================================

  /**
   * Check if HEAD has changed since the session started and migrate the
   * shadow branch to the new base commit if needed.
   *
   * This handles the scenario where the agent performs a rebase, pull, or
   * other git operation that changes HEAD mid-session. Without migration,
   * checkpoints would be saved to an orphaned shadow branch.
   */
  async function migrateShadowBranchIfNeeded(state: SessionState): Promise<boolean> {
    if (!state.baseCommit) return false;

    const currentHead = await getHead(cwd);
    if (state.baseCommit === currentHead) return false;

    const oldShadowBranch = getShadowBranchName(state.baseCommit, state.worktreeID);
    const newShadowBranch = getShadowBranchName(currentHead, state.worktreeID);

    // Guard: if both commits produce the same shadow branch name
    // (same 7-char prefix), just update state
    if (oldShadowBranch === newShadowBranch) {
      state.baseCommit = currentHead;
      return true;
    }

    const oldExists = await refExists(`refs/heads/${oldShadowBranch}`, cwd);
    if (!oldExists) {
      // Old shadow branch doesn't exist — just update baseCommit
      state.baseCommit = currentHead;
      return true;
    }

    // Old shadow branch exists — rename it to the new base
    try {
      // Read the current tip of the old branch
      const oldTip = await git(['rev-parse', `refs/heads/${oldShadowBranch}`], { cwd });

      // Create new branch pointing to same commit
      await updateRef(`refs/heads/${newShadowBranch}`, oldTip.trim(), cwd);

      // Delete old branch (best effort)
      try {
        await deleteBranch(oldShadowBranch, false, cwd);
      } catch {
        // Non-fatal
      }
    } catch {
      // If rename fails, just update state
    }

    state.baseCommit = currentHead;
    return true;
  }

  /**
   * Check for HEAD changes, migrate shadow branch if needed, and persist.
   */
  async function migrateAndPersist(state: SessionState): Promise<void> {
    const migrated = await migrateShadowBranchIfNeeded(state);
    if (migrated) {
      await saveSession(state);
    }
  }

  return strategy;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Inject a checkpoint trailer before any git comments in the commit message.
 */
function injectCheckpointTrailer(message: string, trailer: string): string {
  const lines = message.split('\n');

  // Find where git comments start (lines beginning with #)
  let insertIndex = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#')) {
      insertIndex = i;
      break;
    }
  }

  // Insert trailer before comments, with a blank line separator
  const before = lines.slice(0, insertIndex);
  const after = lines.slice(insertIndex);

  // Ensure there's a blank line before the trailer
  while (before.length > 0 && before[before.length - 1].trim() === '') {
    before.pop();
  }

  return [...before, '', trailer, '', ...after].join('\n');
}

/**
 * Check if a commit message has any content besides comments and our trailer.
 */
export function hasUserContent(message: string): boolean {
  const trailerPrefix = CheckpointTrailerKey + ':';
  for (const line of message.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith(trailerPrefix)) continue;
    return true;
  }
  return false;
}

/**
 * Remove the Entire-Checkpoint trailer line from a commit message.
 */
export function stripCheckpointTrailer(message: string): string {
  const trailerPrefix = CheckpointTrailerKey + ':';
  return message
    .split('\n')
    .filter((line) => !line.trim().startsWith(trailerPrefix))
    .join('\n');
}
