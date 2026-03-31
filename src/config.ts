/**
 * Configuration Management
 *
 * Loads and manages Sessionlog settings from .sessionlog/settings.json
 * and .sessionlog/settings.local.json (local overrides).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type SessionlogSettings,
  DEFAULT_SETTINGS,
} from './types.js';
import { getWorktreeRoot } from './git-operations.js';
import { atomicWriteFile } from './git-operations.js';

/**
 * Resolve the sessionlog directory for a given repo root.
 * Priority: SESSIONLOG_PROJECT_DIR env var > .swarm/sessionlog exists > .sessionlog
 */
export function resolveSessionlogDir(root: string): string {
  const envDir = process.env.SESSIONLOG_PROJECT_DIR;
  if (envDir) return path.join(root, envDir);
  const swarmDir = path.join(root, '.swarm', 'sessionlog');
  if (fs.existsSync(swarmDir)) return swarmDir;
  return path.join(root, '.sessionlog');
}

// ============================================================================
// Load Settings
// ============================================================================

/**
 * Load effective settings (project merged with local overrides)
 */
export async function loadSettings(cwd?: string): Promise<SessionlogSettings> {
  const project = await loadProjectSettings(cwd);
  const local = await loadLocalSettings(cwd);
  return mergeSettings(project, local);
}

/**
 * Load project-level settings (settings.json inside resolved sessionlog dir)
 */
export async function loadProjectSettings(cwd?: string): Promise<SessionlogSettings> {
  const root = cwd ?? (await getWorktreeRoot());
  const settingsPath = path.join(resolveSessionlogDir(root), 'settings.json');
  return loadSettingsFile(settingsPath);
}

/**
 * Load local settings (settings.local.json inside resolved sessionlog dir)
 */
export async function loadLocalSettings(cwd?: string): Promise<SessionlogSettings> {
  const root = cwd ?? (await getWorktreeRoot());
  const settingsPath = path.join(resolveSessionlogDir(root), 'settings.local.json');
  return loadSettingsFile(settingsPath);
}

function loadSettingsFile(filePath: string): SessionlogSettings {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as Partial<SessionlogSettings>;
    return { ...DEFAULT_SETTINGS, ...data };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function mergeSettings(project: SessionlogSettings, local: SessionlogSettings): SessionlogSettings {
  // Env var overrides for session repo configuration
  const envRepoPath = process.env.SESSIONLOG_REPO_PATH;
  const envRepoRemote = process.env.SESSIONLOG_REPO_REMOTE;

  // Deep-merge sessionRepo: remote+directory from project (committable),
  // localPath from local (machine-specific), env vars override both.
  const projectRepo = project.sessionRepo;
  const localRepo = local.sessionRepo;
  let sessionRepo: SessionlogSettings['sessionRepo'];

  if (projectRepo || localRepo || envRepoRemote || envRepoPath) {
    sessionRepo = {
      remote: envRepoRemote ?? localRepo?.remote ?? projectRepo?.remote,
      directory: localRepo?.directory ?? projectRepo?.directory,
      localPath: envRepoPath ?? localRepo?.localPath ?? projectRepo?.localPath,
      autoPush: localRepo?.autoPush ?? projectRepo?.autoPush,
    };
    // Strip undefined values
    if (!sessionRepo.remote) delete sessionRepo.remote;
    if (!sessionRepo.directory) delete sessionRepo.directory;
    if (!sessionRepo.localPath) delete sessionRepo.localPath;
    if (sessionRepo.autoPush === undefined) delete sessionRepo.autoPush;
    // If nothing meaningful is set, drop the whole object
    if (Object.keys(sessionRepo).length === 0) sessionRepo = undefined;
  }

  return {
    enabled: local.enabled !== DEFAULT_SETTINGS.enabled ? local.enabled : project.enabled,
    strategy: local.strategy !== DEFAULT_SETTINGS.strategy ? local.strategy : project.strategy,
    logLevel: local.logLevel ?? project.logLevel,
    skipPushSessions: local.skipPushSessions ?? project.skipPushSessions,
    telemetryEnabled: local.telemetryEnabled ?? project.telemetryEnabled,
    summarizationEnabled: local.summarizationEnabled ?? project.summarizationEnabled,
    // Legacy field — still supported for backward compat
    sessionRepoPath: envRepoPath ?? local.sessionRepoPath ?? project.sessionRepoPath,
    sessionRepo,
  };
}

// ============================================================================
// Save Settings
// ============================================================================

/**
 * Save project-level settings
 */
export async function saveProjectSettings(
  settings: Partial<SessionlogSettings>,
  cwd?: string,
): Promise<void> {
  const root = cwd ?? (await getWorktreeRoot());
  const sessionlogDir = resolveSessionlogDir(root);
  const settingsPath = path.join(sessionlogDir, 'settings.json');
  await ensureSessionlogDir(root);
  await atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * Save local settings
 */
export async function saveLocalSettings(
  settings: Partial<SessionlogSettings>,
  cwd?: string,
): Promise<void> {
  const root = cwd ?? (await getWorktreeRoot());
  const sessionlogDir = resolveSessionlogDir(root);
  const settingsPath = path.join(sessionlogDir, 'settings.local.json');
  await ensureSessionlogDir(root);
  await atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2));
}

// ============================================================================
// Queries
// ============================================================================

/**
 * Check if Sessionlog is enabled in the current repository
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

async function ensureSessionlogDir(root: string): Promise<void> {
  const dir = resolveSessionlogDir(root);
  await fs.promises.mkdir(dir, { recursive: true });
}

/**
 * Ensure the .sessionlog directory is gitignored for local files
 */
export async function ensureGitignore(cwd?: string): Promise<void> {
  const root = cwd ?? (await getWorktreeRoot());
  const gitignorePath = path.join(resolveSessionlogDir(root), '.gitignore');

  const content = [
    '# Sessionlog local files (not committed)',
    'settings.local.json',
    'tmp/',
    'logs/',
    '',
  ].join('\n');

  try {
    await fs.promises.access(gitignorePath);
    // Already exists
  } catch {
    await ensureSessionlogDir(root);
    await fs.promises.writeFile(gitignorePath, content);
  }
}
