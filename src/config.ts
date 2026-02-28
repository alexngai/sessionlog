/**
 * Configuration Management
 *
 * Loads and manages Entire settings from .entire/settings.json
 * and .entire/settings.local.json (local overrides).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type EntireSettings,
  DEFAULT_SETTINGS,
  ENTIRE_SETTINGS_FILE,
  ENTIRE_SETTINGS_LOCAL_FILE,
  ENTIRE_DIR,
} from './types.js';
import { getWorktreeRoot } from './git-operations.js';
import { atomicWriteFile } from './git-operations.js';

// ============================================================================
// Load Settings
// ============================================================================

/**
 * Load effective settings (project merged with local overrides)
 */
export async function loadSettings(cwd?: string): Promise<EntireSettings> {
  const project = await loadProjectSettings(cwd);
  const local = await loadLocalSettings(cwd);
  return mergeSettings(project, local);
}

/**
 * Load project-level settings (.entire/settings.json)
 */
export async function loadProjectSettings(cwd?: string): Promise<EntireSettings> {
  const root = cwd ?? (await getWorktreeRoot());
  const settingsPath = path.join(root, ENTIRE_SETTINGS_FILE);
  return loadSettingsFile(settingsPath);
}

/**
 * Load local settings (.entire/settings.local.json)
 */
export async function loadLocalSettings(cwd?: string): Promise<EntireSettings> {
  const root = cwd ?? (await getWorktreeRoot());
  const settingsPath = path.join(root, ENTIRE_SETTINGS_LOCAL_FILE);
  return loadSettingsFile(settingsPath);
}

function loadSettingsFile(filePath: string): EntireSettings {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as Partial<EntireSettings>;
    return { ...DEFAULT_SETTINGS, ...data };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function mergeSettings(project: EntireSettings, local: EntireSettings): EntireSettings {
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
  settings: Partial<EntireSettings>,
  cwd?: string,
): Promise<void> {
  const root = cwd ?? (await getWorktreeRoot());
  const settingsPath = path.join(root, ENTIRE_SETTINGS_FILE);
  await ensureEntireDir(root);
  await atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * Save local settings
 */
export async function saveLocalSettings(
  settings: Partial<EntireSettings>,
  cwd?: string,
): Promise<void> {
  const root = cwd ?? (await getWorktreeRoot());
  const settingsPath = path.join(root, ENTIRE_SETTINGS_LOCAL_FILE);
  await ensureEntireDir(root);
  await atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2));
}

// ============================================================================
// Queries
// ============================================================================

/**
 * Check if Entire is enabled in the current repository
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

async function ensureEntireDir(root: string): Promise<void> {
  const dir = path.join(root, ENTIRE_DIR);
  await fs.promises.mkdir(dir, { recursive: true });
}

/**
 * Ensure the .entire directory is gitignored for local files
 */
export async function ensureGitignore(cwd?: string): Promise<void> {
  const root = cwd ?? (await getWorktreeRoot());
  const gitignorePath = path.join(root, ENTIRE_DIR, '.gitignore');

  const content = [
    '# Entire local files (not committed)',
    'settings.local.json',
    'tmp/',
    'logs/',
    '',
  ].join('\n');

  try {
    await fs.promises.access(gitignorePath);
    // Already exists
  } catch {
    await ensureEntireDir(root);
    await fs.promises.writeFile(gitignorePath, content);
  }
}
