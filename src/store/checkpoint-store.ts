/**
 * Checkpoint Store
 *
 * Manages checkpoint data stored on git branches.
 * - Temporary checkpoints live on shadow branches (entire/<hash>)
 * - Committed checkpoints live on entire/checkpoints/v1 branch
 */

import * as crypto from 'node:crypto';
import {
  type CheckpointID,
  type CheckpointSummary,
  type CommittedMetadata,
  type WriteTemporaryOptions,
  type WriteTemporaryResult,
  type WriteCommittedOptions,
  CHECKPOINT_ID_LENGTH,
  CHECKPOINTS_BRANCH,
  SHADOW_BRANCH_PREFIX,
  SHADOW_BRANCH_HASH_LENGTH,
  checkpointIDPath,
} from '../types.js';
import {
  git,
  getHead,
  getGitAuthor,
  refExists,
  getTreeHash,
  lsTree,
  listBranches,
  hashObject,
  mktree,
  commitTree,
  updateRef,
  deleteBranch,
  showFile,
  log,
  type GitAuthor,
} from '../git-operations.js';

// ============================================================================
// Checkpoint Store Interface
// ============================================================================

export interface CheckpointStore {
  /** Generate a new checkpoint ID */
  generateID(): Promise<CheckpointID>;

  /** Write a temporary checkpoint (shadow branch) */
  writeTemporary(opts: WriteTemporaryOptions): Promise<WriteTemporaryResult>;

  /** Read the latest temporary checkpoint for a base commit */
  readTemporary(
    baseCommit: string,
    worktreeID?: string,
  ): Promise<{ commitHash: string; treeHash: string; sessionID: string } | null>;

  /** List all temporary (shadow) branches */
  listTemporary(): Promise<
    Array<{
      branchName: string;
      baseCommit: string;
      latestCommit: string;
      sessionID: string;
      timestamp: string;
    }>
  >;

  /** Write a committed checkpoint to the metadata branch */
  writeCommitted(opts: WriteCommittedOptions): Promise<void>;

  /** Read a committed checkpoint summary */
  readCommitted(checkpointID: CheckpointID): Promise<CheckpointSummary | null>;

  /** Read session content from a committed checkpoint */
  readSessionContent(
    checkpointID: CheckpointID,
    sessionIndex: number,
  ): Promise<{
    metadata: CommittedMetadata;
    transcript: string;
    prompts: string;
    context: string;
  } | null>;

  /** List committed checkpoints (most recent first) */
  listCommitted(limit?: number): Promise<CheckpointSummary[]>;

  /** Delete a shadow branch */
  deleteShadowBranch(branchName: string): Promise<void>;

  /** Get the shadow branch name for a base commit */
  getShadowBranchName(baseCommit: string, worktreeID?: string): string;
}

// ============================================================================
// Git-Based Checkpoint Store
// ============================================================================

/**
 * Create a checkpoint store.
 *
 * @param cwd - The project working directory (used for shadow branches / temporary checkpoints)
 * @param sessionRepoCwd - Optional separate repo directory for committed checkpoints.
 *   When provided, the `entire/checkpoints/v1` branch and its data are stored
 *   in this repo instead of the project repo. Shadow branches remain in the
 *   project repo since they reference the project's git objects.
 * @param checkpointsBranch - Optional override for the checkpoints branch name.
 *   Defaults to `entire/checkpoints/v1`. When multiple projects share a session
 *   repo, each project uses a unique branch like `entire/checkpoints/v1/<projectID>`.
 */
export function createCheckpointStore(
  cwd?: string,
  sessionRepoCwd?: string,
  checkpointsBranch?: string,
): CheckpointStore {
  /** Directory for committed checkpoint operations (separate repo or project repo) */
  const committedCwd = sessionRepoCwd ?? cwd;
  /** Branch name for committed checkpoints */
  const cpBranch = checkpointsBranch ?? CHECKPOINTS_BRANCH;

  function getShadowBranchName(baseCommit: string, worktreeID?: string): string {
    const shortHash = baseCommit.slice(0, SHADOW_BRANCH_HASH_LENGTH);
    if (worktreeID) {
      const worktreeHash = crypto.createHash('sha256').update(worktreeID).digest('hex').slice(0, 6);
      return `${SHADOW_BRANCH_PREFIX}${shortHash}-${worktreeHash}`;
    }
    return `${SHADOW_BRANCH_PREFIX}${shortHash}`;
  }

  return {
    async generateID(): Promise<CheckpointID> {
      const bytes = crypto.randomBytes(CHECKPOINT_ID_LENGTH / 2);
      return bytes.toString('hex');
    },

    async writeTemporary(opts: WriteTemporaryOptions): Promise<WriteTemporaryResult> {
      const branchName = getShadowBranchName(opts.baseCommit, opts.worktreeID);
      const branchExists = await refExists(`refs/heads/${branchName}`, cwd);

      // Get the current tree from HEAD
      const headHash = await getHead(cwd);
      let parentHash: string | null = null;
      let baseTreeHash: string;

      if (branchExists) {
        // Branch exists: use its tip as parent
        parentHash = await git(['rev-parse', branchName], { cwd });
        baseTreeHash = await getTreeHash(branchName, cwd);

        // Dedup: if tree hash matches, skip
        const headTreeHash = await getTreeHash('HEAD', cwd);
        if (baseTreeHash === headTreeHash) {
          return { commitHash: parentHash, skipped: true };
        }
      }

      // Create new tree from working directory state
      const headTreeHash = await getTreeHash('HEAD', cwd);

      // Build metadata tree entries
      const metadataEntries = await buildMetadataTree(opts, cwd);

      // Merge metadata into the head tree
      const newTree = await mergeMetadataIntoTree(
        headTreeHash,
        metadataEntries,
        opts.metadataDir,
        cwd,
      );

      // Create commit
      const author: GitAuthor = { name: opts.authorName, email: opts.authorEmail };
      const commitHash = await commitTree(
        newTree,
        parentHash ?? headHash,
        opts.commitMessage,
        author,
        cwd,
      );

      // Update branch ref
      if (branchExists) {
        await updateRef(branchName, commitHash, cwd);
      } else {
        await git(['branch', branchName, commitHash], { cwd });
      }

      return { commitHash, skipped: false };
    },

    async readTemporary(
      baseCommit: string,
      worktreeID?: string,
    ): Promise<{ commitHash: string; treeHash: string; sessionID: string } | null> {
      const branchName = getShadowBranchName(baseCommit, worktreeID);
      const exists = await refExists(`refs/heads/${branchName}`, cwd);
      if (!exists) return null;

      const commitHash = await git(['rev-parse', branchName], { cwd });
      const treeHash = await getTreeHash(branchName, cwd);

      // Try to extract sessionID from commit message
      const message = await git(['log', '-1', '--format=%B', branchName], { cwd });
      const sessionMatch = message.match(/Session:\s*(\S+)/);
      const sessionID = sessionMatch?.[1] ?? '';

      return { commitHash, treeHash, sessionID };
    },

    async listTemporary(): Promise<
      Array<{
        branchName: string;
        baseCommit: string;
        latestCommit: string;
        sessionID: string;
        timestamp: string;
      }>
    > {
      const branches = await listBranches(`${SHADOW_BRANCH_PREFIX}*`, cwd);
      const result = [];

      for (const branch of branches) {
        // Skip the checkpoints branch
        if (branch === CHECKPOINTS_BRANCH) continue;

        try {
          const latestCommit = await git(['rev-parse', branch], { cwd });
          const timestamp = await git(['log', '-1', '--format=%aI', branch], { cwd });
          const message = await git(['log', '-1', '--format=%B', branch], { cwd });

          // Extract base commit from branch name
          const hashPart = branch.slice(SHADOW_BRANCH_PREFIX.length);
          const baseCommit = hashPart.split('-')[0];

          const sessionMatch = message.match(/Session:\s*(\S+)/);

          result.push({
            branchName: branch,
            baseCommit,
            latestCommit,
            sessionID: sessionMatch?.[1] ?? '',
            timestamp,
          });
        } catch {
          // Skip branches we can't read
        }
      }

      return result;
    },

    async writeCommitted(opts: WriteCommittedOptions): Promise<void> {
      const checkpointPath = checkpointIDPath(opts.checkpointID);
      const branchRef = `refs/heads/${cpBranch}`;

      // Committed checkpoints go to the session repo (or project repo if no session repo)
      const targetCwd = committedCwd;

      // Ensure the metadata branch exists
      const branchExists = await refExists(branchRef, targetCwd);
      let parentHash: string | null = null;
      let baseTree: string | null = null;

      if (branchExists) {
        parentHash = await git(['rev-parse', cpBranch], { cwd: targetCwd });
        baseTree = await getTreeHash(cpBranch, targetCwd);
      }

      // Build session directory content
      const sessionIndex = '1'; // First session in this checkpoint

      const metadata: CommittedMetadata = {
        cliVersion: 'opentasks-entire',
        checkpointID: opts.checkpointID,
        sessionID: opts.sessionID,
        strategy: opts.strategy,
        createdAt: new Date().toISOString(),
        branch: opts.branch,
        checkpointsCount: opts.checkpointsCount,
        filesTouched: opts.filesTouched,
        agent: opts.agent,
        turnID: opts.turnID,
        isTask: opts.isTask,
        toolUseID: opts.toolUseID,
        transcriptIdentifierAtStart: opts.transcriptIdentifierAtStart,
        checkpointTranscriptStart: opts.checkpointTranscriptStart,
        tokenUsage: opts.tokenUsage,
        summary: opts.summary,
        initialAttribution: opts.initialAttribution,
      };

      // Create blob objects in the target repo
      const metadataBlob = await hashObject(JSON.stringify(metadata, null, 2), targetCwd);
      const transcriptBlob = await hashObject(opts.transcript, targetCwd);
      const promptBlob = await hashObject(opts.prompts.join('\n---\n'), targetCwd);
      const contextBlob = await hashObject(opts.context, targetCwd);

      // Build session subtree: <sessionIndex>/
      const sessionTree = await mktree(
        [
          { mode: '100644', type: 'blob', hash: metadataBlob, name: 'metadata.json' },
          { mode: '100644', type: 'blob', hash: transcriptBlob, name: 'full.jsonl' },
          { mode: '100644', type: 'blob', hash: promptBlob, name: 'prompt.txt' },
          { mode: '100644', type: 'blob', hash: contextBlob, name: 'context.md' },
        ],
        targetCwd,
      );

      // Build checkpoint summary
      const summary: CheckpointSummary = {
        cliVersion: 'opentasks-entire',
        checkpointID: opts.checkpointID,
        strategy: opts.strategy,
        branch: opts.branch,
        checkpointsCount: opts.checkpointsCount,
        filesTouched: opts.filesTouched,
        sessions: [
          {
            metadata: `${checkpointPath}/${sessionIndex}/metadata.json`,
            transcript: `${checkpointPath}/${sessionIndex}/full.jsonl`,
            context: `${checkpointPath}/${sessionIndex}/context.md`,
            prompt: `${checkpointPath}/${sessionIndex}/prompt.txt`,
          },
        ],
        tokenUsage: opts.tokenUsage,
      };

      const summaryBlob = await hashObject(JSON.stringify(summary, null, 2), targetCwd);

      // Build checkpoint tree: <id[:2]>/<id[2:]>/
      const checkpointTree = await mktree(
        [
          { mode: '100644', type: 'blob', hash: summaryBlob, name: 'metadata.json' },
          { mode: '040000', type: 'tree', hash: sessionTree, name: sessionIndex },
        ],
        targetCwd,
      );

      // Now we need to merge this into the existing tree on the branch
      // Path structure: <id[:2]>/<id[2:]>
      const shardDir = opts.checkpointID.slice(0, 2);
      const checkpointDir = opts.checkpointID.slice(2);

      // Build shard subtree
      let shardSubtreeEntries: Array<{ mode: string; type: string; hash: string; name: string }> =
        [];

      if (baseTree) {
        // Read existing shard if present
        const existingShardEntries = await lsTree(`${cpBranch}:${shardDir}`, undefined, targetCwd);
        if (existingShardEntries.length > 0) {
          shardSubtreeEntries = existingShardEntries.filter((e) => e.name !== checkpointDir);
        }
      }
      shardSubtreeEntries.push({
        mode: '040000',
        type: 'tree',
        hash: checkpointTree,
        name: checkpointDir,
      });

      const shardTree = await mktree(shardSubtreeEntries, targetCwd);

      // Build root tree
      let rootEntries: Array<{ mode: string; type: string; hash: string; name: string }> = [];

      if (baseTree) {
        const existingRoot = await lsTree(cpBranch, undefined, targetCwd);
        rootEntries = existingRoot.filter((e) => e.name !== shardDir);
      }
      rootEntries.push({ mode: '040000', type: 'tree', hash: shardTree, name: shardDir });

      const rootTree = await mktree(rootEntries, targetCwd);

      // Create commit
      const author = await getGitAuthor(targetCwd);
      const commitMessage = `Entire-Checkpoint: ${opts.checkpointID}\n\nSession: ${opts.sessionID}`;
      const commitHash = await commitTree(rootTree, parentHash, commitMessage, author, targetCwd);

      // Update branch ref
      if (branchExists) {
        await updateRef(cpBranch, commitHash, targetCwd);
      } else {
        await git(['branch', cpBranch, commitHash], { cwd: targetCwd });
      }
    },

    async readCommitted(checkpointID: CheckpointID): Promise<CheckpointSummary | null> {
      const exists = await refExists(`refs/heads/${cpBranch}`, committedCwd);
      if (!exists) return null;

      const checkpointPath = checkpointIDPath(checkpointID);
      try {
        const content = await showFile(cpBranch, `${checkpointPath}/metadata.json`, committedCwd);
        return JSON.parse(content) as CheckpointSummary;
      } catch {
        return null;
      }
    },

    async readSessionContent(
      checkpointID: CheckpointID,
      sessionIndex: number,
    ): Promise<{
      metadata: CommittedMetadata;
      transcript: string;
      prompts: string;
      context: string;
    } | null> {
      const checkpointPath = checkpointIDPath(checkpointID);
      const sessionPath = `${checkpointPath}/${sessionIndex + 1}`;

      try {
        const [metadataStr, transcript, prompts, context] = await Promise.all([
          showFile(cpBranch, `${sessionPath}/metadata.json`, committedCwd),
          showFile(cpBranch, `${sessionPath}/full.jsonl`, committedCwd),
          showFile(cpBranch, `${sessionPath}/prompt.txt`, committedCwd),
          showFile(cpBranch, `${sessionPath}/context.md`, committedCwd),
        ]);

        return {
          metadata: JSON.parse(metadataStr) as CommittedMetadata,
          transcript,
          prompts,
          context,
        };
      } catch {
        return null;
      }
    },

    async listCommitted(limit = 20): Promise<CheckpointSummary[]> {
      const exists = await refExists(`refs/heads/${cpBranch}`, committedCwd);
      if (!exists) return [];

      // Get recent commits on the metadata branch
      const logOutput = await log(cpBranch, { maxCount: limit, format: '%H %s' }, committedCwd);

      if (!logOutput) return [];

      const summaries: CheckpointSummary[] = [];
      for (const line of logOutput.split('\n').filter(Boolean)) {
        const match = line.match(/^([0-9a-f]+)\s+Entire-Checkpoint:\s+([0-9a-f]+)/);
        if (!match) continue;

        const id = match[2];
        const summary = await this.readCommitted(id);
        if (summary) summaries.push(summary);
      }

      return summaries;
    },

    async deleteShadowBranch(branchName: string): Promise<void> {
      try {
        await deleteBranch(branchName, true, cwd);
      } catch {
        // Ignore if branch doesn't exist
      }
    },

    getShadowBranchName,
  };
}

// ============================================================================
// Tree Building Helpers
// ============================================================================

async function buildMetadataTree(
  opts: WriteTemporaryOptions,
  cwd?: string,
): Promise<Array<{ mode: string; type: string; hash: string; name: string }>> {
  // Create a simple metadata file in the shadow branch
  const metadata = {
    sessionID: opts.sessionID,
    baseCommit: opts.baseCommit,
    timestamp: new Date().toISOString(),
    modifiedFiles: opts.modifiedFiles,
    newFiles: opts.newFiles,
    deletedFiles: opts.deletedFiles,
  };

  const blob = await hashObject(JSON.stringify(metadata, null, 2), cwd);
  return [{ mode: '100644', type: 'blob', hash: blob, name: 'checkpoint.json' }];
}

async function mergeMetadataIntoTree(
  baseTree: string,
  metadataEntries: Array<{ mode: string; type: string; hash: string; name: string }>,
  metadataDir: string,
  cwd?: string,
): Promise<string> {
  // Create the metadata subtree
  const metadataTree = await mktree(metadataEntries, cwd);

  // Get existing root entries
  const rootEntries = await lsTree(baseTree, undefined, cwd);
  const filtered = rootEntries.filter((e) => e.name !== metadataDir);
  filtered.push({ mode: '040000', type: 'tree', hash: metadataTree, name: metadataDir });

  return mktree(filtered, cwd);
}
