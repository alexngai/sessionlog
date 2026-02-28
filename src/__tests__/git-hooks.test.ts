/**
 * Tests for git-hooks.ts commit-msg hook addition
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { installGitHooks, uninstallGitHooks, areGitHooksInstalled } from '../hooks/git-hooks.js';

describe('Git Hooks (with commit-msg)', () => {
  let tmpDir: string;

  function initRepo(dir: string): void {
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hooks-'));
    initRepo(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should install 4 hooks including commit-msg', async () => {
    const installed = await installGitHooks(tmpDir);
    expect(installed).toBe(4);

    const hooksDir = path.join(tmpDir, '.git', 'hooks');

    // Check all 4 hooks exist
    expect(fs.existsSync(path.join(hooksDir, 'prepare-commit-msg'))).toBe(true);
    expect(fs.existsSync(path.join(hooksDir, 'commit-msg'))).toBe(true);
    expect(fs.existsSync(path.join(hooksDir, 'post-commit'))).toBe(true);
    expect(fs.existsSync(path.join(hooksDir, 'pre-push'))).toBe(true);
  });

  it('should generate commit-msg hook with exit 1 on failure', async () => {
    await installGitHooks(tmpDir);

    const hooksDir = path.join(tmpDir, '.git', 'hooks');
    const commitMsgHook = fs.readFileSync(path.join(hooksDir, 'commit-msg'), 'utf-8');

    expect(commitMsgHook).toContain('# Runlog CLI hook');
    expect(commitMsgHook).toContain('runlog hooks git commit-msg "$1" || exit 1');
    expect(commitMsgHook).toContain('strip trailer');
  });

  it('should not double-install hooks', async () => {
    await installGitHooks(tmpDir);
    const second = await installGitHooks(tmpDir);
    expect(second).toBe(0);
  });

  it('should detect hooks as installed', async () => {
    await installGitHooks(tmpDir);
    const installed = await areGitHooksInstalled(tmpDir);
    expect(installed).toBe(true);
  });

  it('should uninstall all 4 hooks', async () => {
    await installGitHooks(tmpDir);
    await uninstallGitHooks(tmpDir);

    const hooksDir = path.join(tmpDir, '.git', 'hooks');

    // All hooks should be removed (files deleted since they only had Runlog content)
    expect(fs.existsSync(path.join(hooksDir, 'prepare-commit-msg'))).toBe(false);
    expect(fs.existsSync(path.join(hooksDir, 'commit-msg'))).toBe(false);
    expect(fs.existsSync(path.join(hooksDir, 'post-commit'))).toBe(false);
    expect(fs.existsSync(path.join(hooksDir, 'pre-push'))).toBe(false);
  });
});
