/**
 * Tests for Separate Session Repository Support
 *
 * Covers: getProjectID, resolveSessionRepoPath, initSessionRepo,
 * createSessionStore with custom sessionsDir, createCheckpointStore
 * with sessionRepoCwd, and strategy sessionRepoCwd wiring.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getProjectID, resolveSessionRepoPath, initSessionRepo } from '../git-operations.js';
import { createSessionStore } from '../store/session-store.js';
import { createCheckpointStore } from '../store/checkpoint-store.js';

// ============================================================================
// getProjectID
// ============================================================================

describe('getProjectID', () => {
  it('should return <dir-name>-<hash> format', () => {
    const id = getProjectID('/home/user/my-project');
    expect(id).toMatch(/^my-project-[a-f0-9]{8}$/);
  });

  it('should sanitize directory name to lowercase', () => {
    const id = getProjectID('/home/user/MyProject');
    expect(id).toMatch(/^myproject-[a-f0-9]{8}$/);
  });

  it('should replace non-alphanumeric characters with hyphens', () => {
    const id = getProjectID('/home/user/my_project.v2');
    expect(id).toMatch(/^my-project-v2-[a-f0-9]{8}$/);
  });

  it('should collapse consecutive hyphens', () => {
    const id = getProjectID('/home/user/my---project');
    expect(id).toMatch(/^my-project-[a-f0-9]{8}$/);
  });

  it('should trim leading/trailing hyphens from sanitized name', () => {
    const id = getProjectID('/home/user/---project---');
    expect(id).toMatch(/^project-[a-f0-9]{8}$/);
  });

  it('should use "project" as fallback for empty directory name after sanitization', () => {
    const id = getProjectID('/home/user/...');
    expect(id).toMatch(/^project-[a-f0-9]{8}$/);
  });

  it('should produce different hashes for different absolute paths with same dir name', () => {
    const id1 = getProjectID('/home/alice/my-project');
    const id2 = getProjectID('/home/bob/my-project');
    // Same prefix, different hash
    expect(id1.startsWith('my-project-')).toBe(true);
    expect(id2.startsWith('my-project-')).toBe(true);
    expect(id1).not.toBe(id2);
  });

  it('should be deterministic for the same input', () => {
    const id1 = getProjectID('/home/user/repo');
    const id2 = getProjectID('/home/user/repo');
    expect(id1).toBe(id2);
  });

  it('should resolve relative paths consistently', () => {
    // path.resolve will make relative paths absolute based on cwd
    const id = getProjectID('relative/path');
    expect(id).toMatch(/^path-[a-f0-9]{8}$/);
  });
});

// ============================================================================
// resolveSessionRepoPath
// ============================================================================

describe('resolveSessionRepoPath', () => {
  it('should resolve relative path against project root', () => {
    const result = resolveSessionRepoPath('../session-data', '/home/user/project');
    expect(result).toBe('/home/user/session-data');
  });

  it('should return absolute path unchanged', () => {
    const result = resolveSessionRepoPath('/opt/session-data', '/home/user/project');
    expect(result).toBe('/opt/session-data');
  });

  it('should resolve relative paths within project root', () => {
    const result = resolveSessionRepoPath('.runlog-sessions', '/home/user/project');
    expect(result).toBe('/home/user/project/.runlog-sessions');
  });
});

// ============================================================================
// initSessionRepo
// ============================================================================

describe('initSessionRepo', () => {
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-repo-test-'));
    // Disable commit signing and system git config for test isolation
    savedEnv = {
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    };
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  });

  afterEach(() => {
    // Restore environment
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create a new git repo at the given path', async () => {
    const repoPath = path.join(tmpDir, 'sessions');
    const result = await initSessionRepo(repoPath);

    expect(result).toBe(path.resolve(repoPath));
    expect(fs.existsSync(path.join(repoPath, '.git'))).toBe(true);
  });

  it('should create an initial commit', async () => {
    const repoPath = path.join(tmpDir, 'sessions');
    await initSessionRepo(repoPath);

    // Verify there's at least one commit
    const log = execFileSync('git', ['log', '--oneline'], {
      cwd: repoPath,
      encoding: 'utf-8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    expect(log).toContain('Initialize session repository');
  });

  it('should be idempotent - not fail on existing repo', async () => {
    const repoPath = path.join(tmpDir, 'sessions');

    // Initialize once
    await initSessionRepo(repoPath);

    // Initialize again - should not throw
    const result = await initSessionRepo(repoPath);
    expect(result).toBe(path.resolve(repoPath));

    // Should still have only the initial commit
    const log = execFileSync('git', ['log', '--oneline'], {
      cwd: repoPath,
      encoding: 'utf-8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    const lines = log.trim().split('\n');
    expect(lines.length).toBe(1);
  });

  it('should create nested directories if needed', async () => {
    const repoPath = path.join(tmpDir, 'deep', 'nested', 'sessions');
    const result = await initSessionRepo(repoPath);

    expect(result).toBe(path.resolve(repoPath));
    expect(fs.existsSync(path.join(repoPath, '.git'))).toBe(true);
  });
});

// ============================================================================
// createSessionStore with custom sessionsDir
// ============================================================================

describe('createSessionStore with custom sessionsDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should use the custom sessionsDir for getDir()', async () => {
    const customDir = path.join(tmpDir, 'custom-sessions');
    fs.mkdirSync(customDir, { recursive: true });

    const store = createSessionStore(undefined, customDir);
    const dir = await store.getDir();
    expect(dir).toBe(customDir);
  });

  it('should save and load sessions from custom directory', async () => {
    const customDir = path.join(tmpDir, 'custom-sessions');
    fs.mkdirSync(customDir, { recursive: true });

    const store = createSessionStore(undefined, customDir);

    const state = {
      sessionID: 'test-session-123',
      baseCommit: 'abc123',
      startedAt: new Date().toISOString(),
      phase: 'active' as const,
      agentType: 'Claude Code',
      filesTouched: ['src/app.ts'],
      stepCount: 1,
      turnCheckpointIDs: [],
      untrackedFilesAtStart: [],
      checkpointTranscriptStart: 0,
    };

    await store.save(state);

    // Verify file exists in custom directory
    const filePath = path.join(customDir, 'test-session-123.json');
    expect(fs.existsSync(filePath)).toBe(true);

    // Verify load works
    const loaded = await store.load('test-session-123');
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionID).toBe('test-session-123');
    expect(loaded!.baseCommit).toBe('abc123');
    expect(loaded!.agentType).toBe('Claude Code');
  });

  it('should list sessions from custom directory', async () => {
    const customDir = path.join(tmpDir, 'custom-sessions');
    fs.mkdirSync(customDir, { recursive: true });

    const store = createSessionStore(undefined, customDir);

    // Save two sessions
    const state1 = {
      sessionID: 'session-a',
      baseCommit: 'abc',
      startedAt: new Date().toISOString(),
      phase: 'active' as const,
      agentType: 'Claude Code',
      filesTouched: [],
      stepCount: 0,
      turnCheckpointIDs: [],
      untrackedFilesAtStart: [],
      checkpointTranscriptStart: 0,
    };
    const state2 = {
      ...state1,
      sessionID: 'session-b',
    };

    await store.save(state1);
    await store.save(state2);

    const sessions = await store.list();
    const ids = sessions.map((s) => s.sessionID).sort();
    expect(ids).toEqual(['session-a', 'session-b']);
  });

  it('should delete sessions from custom directory', async () => {
    const customDir = path.join(tmpDir, 'custom-sessions');
    fs.mkdirSync(customDir, { recursive: true });

    const store = createSessionStore(undefined, customDir);

    const state = {
      sessionID: 'to-delete',
      baseCommit: 'abc',
      startedAt: new Date().toISOString(),
      phase: 'ended' as const,
      agentType: 'Claude Code',
      filesTouched: [],
      stepCount: 0,
      turnCheckpointIDs: [],
      untrackedFilesAtStart: [],
      checkpointTranscriptStart: 0,
    };

    await store.save(state);
    expect(await store.exists('to-delete')).toBe(true);

    await store.delete('to-delete');
    expect(await store.exists('to-delete')).toBe(false);
  });
});

// ============================================================================
// createCheckpointStore with sessionRepoCwd and checkpointsBranch
// ============================================================================

describe('createCheckpointStore with sessionRepoCwd', () => {
  it('should accept sessionRepoCwd and checkpointsBranch parameters', () => {
    // Verify the function doesn't throw when given these parameters
    const store = createCheckpointStore(
      '/tmp/project',
      '/tmp/session-repo',
      'runlog/checkpoints/v1/my-project-abc123',
    );
    expect(store).toBeDefined();
    expect(store.generateID).toBeInstanceOf(Function);
    expect(store.writeTemporary).toBeInstanceOf(Function);
    expect(store.writeCommitted).toBeInstanceOf(Function);
    expect(store.readCommitted).toBeInstanceOf(Function);
    expect(store.listCommitted).toBeInstanceOf(Function);
  });

  it('should generate valid checkpoint IDs regardless of repo config', async () => {
    const store = createCheckpointStore(undefined, '/tmp/session-repo', 'custom/branch');
    const id = await store.generateID();
    expect(id).toMatch(/^[a-f0-9]+$/);
  });
});

// ============================================================================
// Project namespacing integration
// ============================================================================

describe('Project Namespacing', () => {
  it('should produce correct namespaced checkpoints branch', () => {
    const projectID = getProjectID('/home/user/my-project');
    const cpBranch = `runlog/checkpoints/v1/${projectID}`;
    expect(cpBranch).toMatch(/^runlog\/checkpoints\/v1\/my-project-[a-f0-9]{8}$/);
  });

  it('should produce correct namespaced sessions directory', () => {
    const projectID = getProjectID('/home/user/my-project');
    const sessionsDir = `/opt/session-repo/runlog-sessions/${projectID}`;
    expect(sessionsDir).toMatch(/^\/opt\/session-repo\/runlog-sessions\/my-project-[a-f0-9]{8}$/);
  });

  it('should keep different projects isolated', () => {
    const id1 = getProjectID('/home/user/project-a');
    const id2 = getProjectID('/home/user/project-b');

    const branch1 = `runlog/checkpoints/v1/${id1}`;
    const branch2 = `runlog/checkpoints/v1/${id2}`;

    expect(branch1).not.toBe(branch2);

    const dir1 = `runlog-sessions/${id1}`;
    const dir2 = `runlog-sessions/${id2}`;

    expect(dir1).not.toBe(dir2);
  });
});
