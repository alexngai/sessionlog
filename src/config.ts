/**
 * Configuration Management
 *
 * Loads and manages Runlog settings from .runlog/settings.json
 * and .runlog/settings.local.json (local overrides).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type RunlogSettings,
  DEFAULT_SETTINGS,
  RUNLOG_SETTINGS_FILE,
  RUNLOG_SETTINGS_LOCAL_FILE,
  RUNLOG_DIR,
} from './types.js';
import { getWorktreeRoot } from './git-operations.js';
import { atomicWriteFile } from './git-operations.js';

// ============================================================================
// Load Settings
// ============================================================================

/**
 * Load effective settings (project merged with local overrides)
 */
export async function loadSettings(cwd?: string): Promise<RunlogSettings> {
  const project = await loadProjectSettings(cwd);
  const local = await loadLocalSettings(cwd);
  return mergeSettings(project, local);
}

/**
 * Load project-level settings (.runlog/settings.json)
 */
export async function loadProjectSettings(cwd?: string): Promise<RunlogSettings> {
  const root = cwd ?? (await getWorktreeRoot());
  const settingsPath = path.join(root, RUNLOG_SETTINGS_FILE);
  return loadSettingsFile(settingsPath);
}

/**
 * Load local settings (.runlog/settings.local.json)
 */
export async function loadLocalSettings(cwd?: string): Promise<RunlogSettings> {
  const root = cwd ?? (await getWorktreeRoot());
  const settingsPath = path.join(root, RUNLOG_SETTINGS_LOCAL_FILE);
  return loadSettingsFile(settingsPath);
}

function loadSettingsFile(filePath: string): RunlogSettings {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as Partial<RunlogSettings>;
    return { ...DEFAULT_SETTINGS, ...data };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function mergeSettings(project: RunlogSettings, local: RunlogSettings): RunlogSettings {
  return {
    enabled: local.enabled !== DEFAULT_SETTINGS.enabled ? local.enabled : project.enabled,
    strategy: local.strategy !== DEFAULT_SETTINGS.strategy ? local.strategy : project.strategy,
    logLevel: local.logLevel ?? project.logLevel,
    skipPushSessions: local.skipPushSessions ?? project.skipPushSessions,
    telemetryEnabled: local.telemetryEnabled ?? project.telemetryEnabled,
    summarizationEnabled: local.summarizationEnabled ?? project.summarizationEnabled,
    sessionRepoPath: local.sessionRepoPath ?? project.sessionRepoPath,
  };
}

// ============================================================================
// Save Settings
// ============================================================================

/**
 * Save project-level settings
 */
export async function saveProjectSettings(
  settings: Partial<RunlogSettings>,
  cwd?: string,
): Promise<void> {
  const root = cwd ?? (await getWorktreeRoot());
  const settingsPath = path.join(root, RUNLOG_SETTINGS_FILE);
  await ensureRunlogDir(root);
  await atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * Save local settings
 */
export async function saveLocalSettings(
  settings: Partial<RunlogSettings>,
  cwd?: string,
): Promise<void> {
  const root = cwd ?? (await getWorktreeRoot());
  const settingsPath = path.join(root, RUNLOG_SETTINGS_LOCAL_FILE);
  await ensureRunlogDir(root);
  await atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2));
}

// ============================================================================
// Queries
// ============================================================================

/**
 * Check if Runlog is enabled in the current repository
 */
export async function isEnabled(cwd?: string): Promise<boolean> {
  const settings = await loadSettings(cwd);
  return settings.enabled;
}

/**
 * Get the current strategy name
 */
export async function getStrategy(cwd?: string): Promise<string> {
  const settings = await loadSettings(cwd);
  return settings.strategy;
}

// ============================================================================
// Helpers
// ============================================================================

async function ensureRunlogDir(root: string): Promise<void> {
  const dir = path.join(root, RUNLOG_DIR);
  await fs.promises.mkdir(dir, { recursive: true });
}

/**
 * Ensure the .runlog directory is gitignored for local files
 */
export async function ensureGitignore(cwd?: string): Promise<void> {
  const root = cwd ?? (await getWorktreeRoot());
  const gitignorePath = path.join(root, RUNLOG_DIR, '.gitignore');

  const content = [
    '# Runlog local files (not committed)',
    'settings.local.json',
    'tmp/',
    'logs/',
    '',
  ].join('\n');

  try {
    await fs.promises.access(gitignorePath);
    // Already exists
  } catch {
    await ensureRunlogDir(root);
    await fs.promises.writeFile(gitignorePath, content);
  }
}
