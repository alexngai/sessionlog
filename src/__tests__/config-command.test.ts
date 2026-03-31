/**
 * Tests for the `sessionlog config` CLI command and session repo config resolution.
 *
 * Covers:
 * - `sessionlog config get` (all settings / specific key)
 * - `sessionlog config set` (local vs project, with auto-init)
 * - `sessionlog config set sessionRepoPath` defaults to settings.local.json
 * - SESSIONLOG_REPO_PATH env var overrides file settings
 * - resolveSessionRepoConfig utility used by commands
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

// ============================================================================
// Helpers
// ============================================================================

let tmpDir: string;

beforeEach(() => {
  const realTmp = fs.realpathSync(os.tmpdir());
  tmpDir = fs.mkdtempSync(path.join(realTmp, 'sessionlog-config-test-'));
  // Init a git repo so sessionlog commands work
  execSync('git init -q', { cwd: tmpDir });
  execSync('git config user.email "test@test.com"', { cwd: tmpDir });
  execSync('git config user.name "Test"', { cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test');
  execSync('git add . && git commit -m "init"', { cwd: tmpDir });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function enableSessionlog(dir: string): void {
  const slDir = path.join(dir, '.sessionlog');
  fs.mkdirSync(slDir, { recursive: true });
  fs.writeFileSync(
    path.join(slDir, 'settings.json'),
    JSON.stringify({ enabled: true, strategy: 'manual-commit' }),
  );
}

function runCLI(
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): { stdout: string; stderr: string; exitCode: number } {
  const cliPath = path.resolve(__dirname, '../../dist/cli.js');
  try {
    const result = execSync(`node ${cliPath} ${args.join(' ')}`, {
      cwd: opts.cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
    });
    return { stdout: result, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
      exitCode: e.status ?? 1,
    };
  }
}

function readSettings(dir: string, filename = 'settings.json'): Record<string, unknown> {
  const filePath = path.join(dir, '.sessionlog', filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// ============================================================================
// config get
// ============================================================================

describe('sessionlog config get', () => {
  it('should show all effective settings as JSON', () => {
    enableSessionlog(tmpDir);
    const result = runCLI(['config', 'get'], { cwd: tmpDir });
    expect(result.exitCode).toBe(0);

    const settings = JSON.parse(result.stdout);
    expect(settings.enabled).toBe(true);
    expect(settings.strategy).toBe('manual-commit');
  });

  it('should show a specific setting value', () => {
    enableSessionlog(tmpDir);
    const result = runCLI(['config', 'get', 'strategy'], { cwd: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('manual-commit');
  });

  it('should exit 1 for unknown key', () => {
    enableSessionlog(tmpDir);
    const result = runCLI(['config', 'get', 'nonexistent'], { cwd: tmpDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown setting');
  });
});

// ============================================================================
// config set
// ============================================================================

describe('sessionlog config set', () => {
  it('should set a boolean value in settings.local.json', () => {
    enableSessionlog(tmpDir);
    const result = runCLI(['config', 'set', 'summarizationEnabled', 'true'], { cwd: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('settings.local.json');

    const local = readSettings(tmpDir, 'settings.local.json');
    expect(local.summarizationEnabled).toBe(true);
  });

  it('should set a value in settings.json with --project flag', () => {
    enableSessionlog(tmpDir);
    const result = runCLI(['config', 'set', 'strategy', 'auto-commit', '--project'], { cwd: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('settings.json');

    const project = readSettings(tmpDir);
    expect(project.strategy).toBe('auto-commit');
  });

  it('should reject unknown setting keys', () => {
    enableSessionlog(tmpDir);
    const result = runCLI(['config', 'set', 'badKey', 'value'], { cwd: tmpDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown setting');
  });
});

// ============================================================================
// sessionRepoPath defaults to local
// ============================================================================

describe('sessionRepoPath routing', () => {
  it('should write sessionRepoPath to settings.local.json by default', () => {
    enableSessionlog(tmpDir);
    const repoPath = path.join(tmpDir, 'sessions-repo');

    const result = runCLI(['config', 'set', 'sessionRepoPath', repoPath], { cwd: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('settings.local.json');

    const local = readSettings(tmpDir, 'settings.local.json');
    expect(local.sessionRepoPath).toBe(repoPath);

    // Should NOT appear in project settings
    const project = readSettings(tmpDir);
    expect(project.sessionRepoPath).toBeUndefined();
  });

  it('should write sessionRepoPath to settings.json with --project flag', () => {
    enableSessionlog(tmpDir);
    const result = runCLI(
      ['config', 'set', 'sessionRepoPath', '../shared-sessions', '--project'],
      { cwd: tmpDir },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('settings.json');

    const project = readSettings(tmpDir);
    expect(project.sessionRepoPath).toBe('../shared-sessions');
  });

  it('should auto-initialize session repo when setting sessionRepoPath', () => {
    enableSessionlog(tmpDir);
    const repoPath = path.join(tmpDir, 'auto-init-repo');

    const result = runCLI(['config', 'set', 'sessionRepoPath', repoPath], { cwd: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('initialized');

    // Verify repo was actually created
    expect(fs.existsSync(path.join(repoPath, '.git'))).toBe(true);
  });
});

// ============================================================================
// SESSIONLOG_REPO_PATH env var override
// ============================================================================

describe('SESSIONLOG_REPO_PATH env var', () => {
  it('should override file-based sessionRepoPath', () => {
    enableSessionlog(tmpDir);

    // Set a path in settings.json
    const slDir = path.join(tmpDir, '.sessionlog');
    fs.writeFileSync(
      path.join(slDir, 'settings.json'),
      JSON.stringify({ enabled: true, strategy: 'manual-commit', sessionRepoPath: '/from-file' }),
    );

    // Env var should take priority
    const result = runCLI(['config', 'get', 'sessionRepoPath'], {
      cwd: tmpDir,
      env: { SESSIONLOG_REPO_PATH: '/from-env' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('/from-env');
  });

  it('should override local settings too', () => {
    enableSessionlog(tmpDir);

    const slDir = path.join(tmpDir, '.sessionlog');
    fs.writeFileSync(
      path.join(slDir, 'settings.local.json'),
      JSON.stringify({ sessionRepoPath: '/from-local' }),
    );

    const result = runCLI(['config', 'get', 'sessionRepoPath'], {
      cwd: tmpDir,
      env: { SESSIONLOG_REPO_PATH: '/from-env' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('/from-env');
  });
});

// ============================================================================
// config help
// ============================================================================

describe('sessionlog config help', () => {
  it('should show help with no subcommand', () => {
    enableSessionlog(tmpDir);
    const result = runCLI(['config'], { cwd: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('sessionRepoPath');
    expect(result.stdout).toContain('--project');
  });
});
