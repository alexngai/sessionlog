/**
 * Git Operations
 *
 * Low-level git operations that shell out to the git CLI.
 * This approach avoids a dependency on a full git library while
 * providing the operations needed for session and checkpoint management.
 */

import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

const execFileAsync = promisify(execFile);

/**
 * Execute a command with stdin input
 */
function execWithInput(
  cmd: string,
  args: string[],
  input: string,
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, options, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    if (child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

// ============================================================================
// Types
// ============================================================================

export interface GitAuthor {
  name: string;
  email: string;
}

export interface GitExecOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

// ============================================================================
// Core Git Execution
// ============================================================================

/**
 * Execute a git command and return stdout
 */
export async function git(args: string[], options: GitExecOptions = {}): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const timeout = options.timeout ?? 30000;

  try {
    const result = await execFileAsync('git', args, {
      cwd,
      timeout,
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 50 * 1024 * 1024, // 50MB
    });
    return result.stdout.trimEnd();
  } catch (error: unknown) {
    const execError = error as { code?: number; stderr?: string; message?: string };
    throw new GitError(
      `git ${args.join(' ')} failed: ${execError.stderr ?? execError.message ?? 'unknown error'}`,
      typeof execError.code === 'number' ? execError.code : null,
      String(execError.stderr ?? ''),
    );
  }
}

/**
 * Execute a git command, returning null on error instead of throwing
 */
export async function gitSafe(
  args: string[],
  options: GitExecOptions = {},
): Promise<string | null> {
  try {
    return await git(args, options);
  } catch {
    return null;
  }
}

// ============================================================================
// Repository Discovery
// ============================================================================

/**
 * Get the git directory for the working tree
 */
export async function getGitDir(cwd?: string): Promise<string> {
  return git(['rev-parse', '--git-dir'], { cwd });
}

/**
 * Get the git common directory (shared for worktrees)
 */
export async function getGitCommonDir(cwd?: string): Promise<string> {
  return git(['rev-parse', '--git-common-dir'], { cwd });
}

/**
 * Get the worktree root directory
 */
export async function getWorktreeRoot(cwd?: string): Promise<string> {
  return git(['rev-parse', '--show-toplevel'], { cwd });
}

/**
 * Check if we're inside a git repository
 */
export async function isGitRepository(cwd?: string): Promise<boolean> {
  const result = await gitSafe(['rev-parse', '--is-inside-work-tree'], { cwd });
  return result === 'true';
}

/**
 * Get the sessions directory path (.git/entire-sessions/)
 */
export async function getSessionsDir(cwd?: string): Promise<string> {
  const gitDir = await getGitDir(cwd);
  return path.resolve(cwd ?? process.cwd(), gitDir, 'entire-sessions');
}

// ============================================================================
// Session Repository
// ============================================================================

/**
 * Initialize a separate git repository for session/checkpoint storage.
 * Creates the repo if it doesn't already exist.
 * Returns the absolute path to the initialized repo.
 */
export async function initSessionRepo(repoPath: string): Promise<string> {
  const absPath = path.resolve(repoPath);
  try {
    await fs.promises.access(path.join(absPath, '.git'));
    // Already initialized
  } catch {
    await fs.promises.mkdir(absPath, { recursive: true });
    await execFileAsync('git', ['init'], {
      cwd: absPath,
      timeout: 30000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    // Create an initial empty commit so refs work properly
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'Initialize session repository'], {
      cwd: absPath,
      timeout: 30000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'Entire',
        GIT_AUTHOR_EMAIL: 'entire@localhost',
        GIT_COMMITTER_NAME: 'Entire',
        GIT_COMMITTER_EMAIL: 'entire@localhost',
      },
    });
  }
  return absPath;
}

/**
 * Resolve the session repo path to an absolute path (if configured).
 * If the path is relative, it's resolved relative to the project root.
 */
export function resolveSessionRepoPath(sessionRepoPath: string, projectRoot: string): string {
  return path.resolve(projectRoot, sessionRepoPath);
}

/**
 * Derive a stable, human-readable project identifier from the project's worktree root.
 * This is used to namespace data when multiple projects share a session repo.
 *
 * Format: `<dir-name>-<short-hash>` (e.g. "my-project-a1b2c3d4").
 * The directory name is sanitized to lowercase alphanumeric + hyphens,
 * and a short hash suffix ensures uniqueness when two projects share
 * the same directory name at different paths.
 */
export function getProjectID(projectRoot: string): string {
  const absRoot = path.resolve(projectRoot);
  const dirName = path.basename(absRoot);
  // Sanitize: lowercase, replace non-alphanumeric with hyphens, collapse/trim hyphens
  const sanitized = dirName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const shortHash = crypto.createHash('sha256').update(absRoot).digest('hex').slice(0, 8);
  const prefix = sanitized || 'project';
  return `${prefix}-${shortHash}`;
}

// ============================================================================
// Ref Operations
// ============================================================================

/**
 * Get the current HEAD commit hash
 */
export async function getHead(cwd?: string): Promise<string> {
  return git(['rev-parse', 'HEAD'], { cwd });
}

/**
 * Get the short hash of a commit
 */
export async function getShortHash(ref: string, cwd?: string): Promise<string> {
  return git(['rev-parse', '--short', ref], { cwd });
}

/**
 * Get current branch name, or null if detached HEAD
 */
export async function getCurrentBranch(cwd?: string): Promise<string | null> {
  const result = await gitSafe(['symbolic-ref', '--short', 'HEAD'], { cwd });
  return result;
}

/**
 * Check if a ref exists
 */
export async function refExists(ref: string, cwd?: string): Promise<boolean> {
  const result = await gitSafe(['rev-parse', '--verify', ref], { cwd });
  return result !== null;
}

/**
 * Get the tree hash for a commit
 */
export async function getTreeHash(ref: string, cwd?: string): Promise<string> {
  return git(['rev-parse', `${ref}^{tree}`], { cwd });
}

// ============================================================================
// Branch Operations
// ============================================================================

/**
 * List branches matching a pattern
 */
export async function listBranches(pattern?: string, cwd?: string): Promise<string[]> {
  const args = ['branch', '--list', '--format=%(refname:short)'];
  if (pattern) args.push(pattern);
  const result = await git(args, { cwd });
  if (!result) return [];
  return result.split('\n').filter(Boolean);
}

/**
 * Create a branch at a ref
 */
export async function createBranch(name: string, ref: string, cwd?: string): Promise<void> {
  await git(['branch', name, ref], { cwd });
}

/**
 * Delete a branch
 */
export async function deleteBranch(name: string, force = false, cwd?: string): Promise<void> {
  await git(['branch', force ? '-D' : '-d', name], { cwd });
}

/**
 * Update a branch ref to point to a new commit
 */
export async function updateRef(ref: string, commitHash: string, cwd?: string): Promise<void> {
  await git(['update-ref', `refs/heads/${ref}`, commitHash], { cwd });
}

// ============================================================================
// Commit & Tree Operations
// ============================================================================

/**
 * Get the git author from config
 */
export async function getGitAuthor(cwd?: string): Promise<GitAuthor> {
  const name = (await gitSafe(['config', 'user.name'], { cwd })) ?? 'Entire';
  const email = (await gitSafe(['config', 'user.email'], { cwd })) ?? 'entire@localhost';
  return { name, email };
}

/**
 * Create a tree object from a list of entries
 */
export async function mktree(
  entries: Array<{ mode: string; type: string; hash: string; name: string }>,
  cwd?: string,
): Promise<string> {
  const input = entries.map((e) => `${e.mode} ${e.type} ${e.hash}\t${e.name}`).join('\n') + '\n';
  const result = await execWithInput('git', ['mktree'], input, {
    cwd: cwd ?? process.cwd(),
    timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } as NodeJS.ProcessEnv,
  });
  return result.stdout.trim();
}

/**
 * Create a blob from content
 */
export async function hashObject(content: string | Buffer, cwd?: string): Promise<string> {
  const input = typeof content === 'string' ? content : content.toString('utf-8');
  const result = await execWithInput('git', ['hash-object', '-w', '--stdin'], input, {
    cwd: cwd ?? process.cwd(),
    timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } as NodeJS.ProcessEnv,
  });
  return result.stdout.trim();
}

/**
 * Create a commit object
 */
export async function commitTree(
  treeHash: string,
  parentHash: string | null,
  message: string,
  author: GitAuthor,
  cwd?: string,
): Promise<string> {
  const args = ['commit-tree', treeHash];
  if (parentHash) {
    args.push('-p', parentHash);
  }
  args.push('-m', message);

  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };

  return git(args, { cwd, env });
}

/**
 * List entries in a tree
 */
export async function lsTree(
  ref: string,
  treePath?: string,
  cwd?: string,
): Promise<Array<{ mode: string; type: string; hash: string; name: string }>> {
  const args = ['ls-tree', ref];
  if (treePath) args.push(treePath);

  const result = await gitSafe(args, { cwd });
  if (!result) return [];

  return result
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/);
      if (!match) throw new Error(`Unexpected ls-tree output: ${line}`);
      return { mode: match[1], type: match[2], hash: match[3], name: match[4] };
    });
}

/**
 * Read a blob from the object store
 */
export async function catFile(ref: string, cwd?: string): Promise<string> {
  return git(['cat-file', '-p', ref], { cwd });
}

/**
 * Read a file from a specific tree/commit
 */
export async function showFile(ref: string, filePath: string, cwd?: string): Promise<string> {
  return git(['show', `${ref}:${filePath}`], { cwd });
}

/**
 * Get log entries for a ref
 */
export async function log(
  ref: string,
  options: { maxCount?: number; format?: string } = {},
  cwd?: string,
): Promise<string> {
  const args = ['log', ref];
  if (options.maxCount) args.push(`-${options.maxCount}`);
  if (options.format) args.push(`--format=${options.format}`);
  return git(args, { cwd });
}

// ============================================================================
// Diff Operations
// ============================================================================

/**
 * Get list of files changed between two refs
 */
export async function diffNameOnly(
  refA: string,
  refB: string,
  cwd?: string,
): Promise<{ added: string[]; modified: string[]; deleted: string[] }> {
  const result = await git(['diff', '--name-status', refA, refB], { cwd });
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const line of result.split('\n').filter(Boolean)) {
    const [status, ...rest] = line.split('\t');
    const file = rest.join('\t');
    switch (status[0]) {
      case 'A':
        added.push(file);
        break;
      case 'D':
        deleted.push(file);
        break;
      default:
        modified.push(file);
        break;
    }
  }

  return { added, modified, deleted };
}

/**
 * Get stat of diff between two refs (line counts)
 */
export async function diffStat(
  refA: string,
  refB: string,
  cwd?: string,
): Promise<{ additions: number; deletions: number }> {
  const result = await git(['diff', '--shortstat', refA, refB], { cwd });
  let additions = 0;
  let deletions = 0;

  const addMatch = result.match(/(\d+) insertion/);
  const delMatch = result.match(/(\d+) deletion/);
  if (addMatch) additions = parseInt(addMatch[1], 10);
  if (delMatch) deletions = parseInt(delMatch[1], 10);

  return { additions, deletions };
}

// ============================================================================
// Working Tree Operations
// ============================================================================

/**
 * Check if the working tree has uncommitted changes
 */
export async function hasUncommittedChanges(cwd?: string): Promise<boolean> {
  const result = await git(['status', '--porcelain'], { cwd });
  return result.length > 0;
}

/**
 * Get list of untracked files
 */
export async function getUntrackedFiles(cwd?: string): Promise<string[]> {
  const result = await git(['ls-files', '--others', '--exclude-standard'], { cwd });
  if (!result) return [];
  return result.split('\n').filter(Boolean);
}

/**
 * Check if on the default branch (main/master)
 */
export async function isOnDefaultBranch(cwd?: string): Promise<[boolean, string]> {
  const branch = await getCurrentBranch(cwd);
  if (!branch) return [false, ''];
  const isDefault = branch === 'main' || branch === 'master';
  return [isDefault, branch];
}

// ============================================================================
// Push Operations
// ============================================================================

/**
 * Push a branch to a remote
 */
export async function pushBranch(
  remote: string,
  branch: string,
  force = false,
  cwd?: string,
): Promise<void> {
  const args = ['push', remote, branch];
  if (force) args.push('--force');
  await git(args, { cwd, timeout: 60000 });
}

// ============================================================================
// Filesystem Helpers
// ============================================================================

/**
 * Resolve the git directory from a path, handling worktrees
 */
export function resolveGitDirSync(startPath: string): string | null {
  let dir = startPath;
  const root = path.parse(dir).root;

  while (dir !== root) {
    const gitPath = path.join(dir, '.git');
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) return gitPath;
      if (stat.isFile()) {
        const content = fs.readFileSync(gitPath, 'utf-8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (match) return path.resolve(dir, match[1]);
      }
    } catch {
      // Not found at this level
    }
    dir = path.dirname(dir);
  }

  return null;
}

/**
 * Atomically write a file (write to tmp, then rename)
 */
export async function atomicWriteFile(filePath: string, content: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  await fs.promises.writeFile(tmpPath, content, 'utf-8');
  await fs.promises.rename(tmpPath, filePath);
}
