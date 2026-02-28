/**
 * Hook Manager Detection
 *
 * Detects third-party git hook managers (Husky, Lefthook, pre-commit,
 * Overcommit) in a repository and generates conflict warnings.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface HookManager {
  /** Name of the hook manager (e.g., "Husky", "Lefthook") */
  name: string;
  /** Relative path that triggered detection (e.g., ".husky/") */
  configPath: string;
  /** Whether the tool will overwrite Runlog's hooks on reinstall */
  overwritesHooks: boolean;
}

// ============================================================================
// Detection
// ============================================================================

/**
 * Detect third-party hook managers in a repository.
 * Detection is filesystem-only (stat checks, no file reads).
 */
export function detectHookManagers(repoRoot: string): HookManager[] {
  const checks: HookManager[] = [
    { name: 'Husky', configPath: '.husky/', overwritesHooks: true },
    { name: 'pre-commit', configPath: '.pre-commit-config.yaml', overwritesHooks: false },
    { name: 'Overcommit', configPath: '.overcommit.yml', overwritesHooks: false },
  ];

  // Lefthook supports {.,}lefthook{,-local}.{yml,yaml,json,toml}
  for (const prefix of ['', '.']) {
    for (const variant of ['', '-local']) {
      for (const ext of ['yml', 'yaml', 'json', 'toml']) {
        const name = `${prefix}lefthook${variant}.${ext}`;
        checks.push({ name: 'Lefthook', configPath: name, overwritesHooks: false });
      }
    }
  }

  const seen = new Set<string>();
  const managers: HookManager[] = [];

  for (const check of checks) {
    const fullPath = path.join(repoRoot, check.configPath);
    try {
      fs.statSync(fullPath);
      if (seen.has(check.name)) continue;
      seen.add(check.name);
      managers.push(check);
    } catch {
      // Not found
    }
  }

  return managers;
}

// ============================================================================
// Warning Generation
// ============================================================================

/**
 * Build a warning string for detected hook managers.
 */
export function hookManagerWarning(managers: HookManager[], runlogExecutable = 'runlog'): string {
  if (managers.length === 0) return '';

  const lines: string[] = [];

  for (const m of managers) {
    if (m.overwritesHooks) {
      lines.push(`Warning: ${m.name} detected (${m.configPath})`);
      lines.push('');
      lines.push(`  ${m.name} may overwrite hooks installed by Runlog on npm install.`);
      lines.push(`  To make Runlog hooks permanent, add these lines to your ${m.name} hook files:`);
      lines.push('');

      const hookDir = m.configPath;
      const hooks = [
        {
          name: 'prepare-commit-msg',
          cmd: `${runlogExecutable} hooks git prepare-commit-msg "$1" "$2" 2>/dev/null || true`,
        },
        { name: 'commit-msg', cmd: `${runlogExecutable} hooks git commit-msg "$1" || exit 1` },
        {
          name: 'post-commit',
          cmd: `${runlogExecutable} hooks git post-commit 2>/dev/null || true`,
        },
        {
          name: 'pre-push',
          cmd: `${runlogExecutable} hooks git pre-push "$@" 2>/dev/null || true`,
        },
      ];

      for (const hook of hooks) {
        lines.push(`    ${hookDir}${hook.name}:`);
        lines.push(`      ${hook.cmd}`);
        lines.push('');
      }
    } else {
      lines.push(`Note: ${m.name} detected (${m.configPath})`);
      lines.push('');
      lines.push(`  If ${m.name} reinstalls hooks, run 'runlog enable' to restore Runlog's hooks.`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
