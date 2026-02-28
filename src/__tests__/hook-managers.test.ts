/**
 * Tests for Hook Manager Detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { detectHookManagers, hookManagerWarning } from '../utils/hook-managers.js';

describe('Hook Manager Detection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-managers-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('detectHookManagers', () => {
    it('should detect Husky', () => {
      fs.mkdirSync(path.join(tmpDir, '.husky'));
      const managers = detectHookManagers(tmpDir);
      expect(managers).toHaveLength(1);
      expect(managers[0].name).toBe('Husky');
      expect(managers[0].overwritesHooks).toBe(true);
    });

    it('should detect pre-commit', () => {
      fs.writeFileSync(path.join(tmpDir, '.pre-commit-config.yaml'), '');
      const managers = detectHookManagers(tmpDir);
      expect(managers).toHaveLength(1);
      expect(managers[0].name).toBe('pre-commit');
      expect(managers[0].overwritesHooks).toBe(false);
    });

    it('should detect Overcommit', () => {
      fs.writeFileSync(path.join(tmpDir, '.overcommit.yml'), '');
      const managers = detectHookManagers(tmpDir);
      expect(managers).toHaveLength(1);
      expect(managers[0].name).toBe('Overcommit');
    });

    it('should detect Lefthook (lefthook.yml)', () => {
      fs.writeFileSync(path.join(tmpDir, 'lefthook.yml'), '');
      const managers = detectHookManagers(tmpDir);
      expect(managers).toHaveLength(1);
      expect(managers[0].name).toBe('Lefthook');
    });

    it('should detect Lefthook (.lefthook.yaml)', () => {
      fs.writeFileSync(path.join(tmpDir, '.lefthook.yaml'), '');
      const managers = detectHookManagers(tmpDir);
      expect(managers).toHaveLength(1);
      expect(managers[0].name).toBe('Lefthook');
    });

    it('should detect Lefthook (lefthook-local.toml)', () => {
      fs.writeFileSync(path.join(tmpDir, 'lefthook-local.toml'), '');
      const managers = detectHookManagers(tmpDir);
      expect(managers).toHaveLength(1);
      expect(managers[0].name).toBe('Lefthook');
    });

    it('should not double-count Lefthook', () => {
      fs.writeFileSync(path.join(tmpDir, 'lefthook.yml'), '');
      fs.writeFileSync(path.join(tmpDir, '.lefthook.yaml'), '');
      const managers = detectHookManagers(tmpDir);
      expect(managers).toHaveLength(1);
      expect(managers[0].name).toBe('Lefthook');
    });

    it('should detect multiple managers', () => {
      fs.mkdirSync(path.join(tmpDir, '.husky'));
      fs.writeFileSync(path.join(tmpDir, '.pre-commit-config.yaml'), '');
      const managers = detectHookManagers(tmpDir);
      expect(managers).toHaveLength(2);
      const names = managers.map((m) => m.name);
      expect(names).toContain('Husky');
      expect(names).toContain('pre-commit');
    });

    it('should return empty for clean repo', () => {
      const managers = detectHookManagers(tmpDir);
      expect(managers).toHaveLength(0);
    });
  });

  describe('hookManagerWarning', () => {
    it('should return empty for no managers', () => {
      expect(hookManagerWarning([])).toBe('');
    });

    it('should warn about hook-overwriting managers', () => {
      const managers = [{ name: 'Husky', configPath: '.husky/', overwritesHooks: true }];
      const warning = hookManagerWarning(managers);
      expect(warning).toContain('Warning: Husky detected');
      expect(warning).toContain('may overwrite hooks');
      expect(warning).toContain('prepare-commit-msg');
      expect(warning).toContain('post-commit');
      expect(warning).toContain('pre-push');
    });

    it('should note non-overwriting managers', () => {
      const managers = [
        { name: 'pre-commit', configPath: '.pre-commit-config.yaml', overwritesHooks: false },
      ];
      const warning = hookManagerWarning(managers);
      expect(warning).toContain('Note: pre-commit detected');
      expect(warning).toContain("run 'runlog enable'");
    });

    it('should use custom executable name', () => {
      const managers = [{ name: 'Husky', configPath: '.husky/', overwritesHooks: true }];
      const warning = hookManagerWarning(managers, 'npx runlog');
      expect(warning).toContain('npx runlog hooks git');
    });
  });
});
