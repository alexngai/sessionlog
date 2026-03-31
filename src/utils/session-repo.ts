/**
 * Session Repo Resolution
 *
 * Shared helper for resolving session repo configuration from settings.
 * Used by commands that need to read/write from the correct session
 * and checkpoint stores when a separate session repo is configured.
 *
 * Resolution priority:
 * 1. sessionRepo.remote → clone to localPath or auto-clone to ~/.sessionlog/repos/<hash>/
 * 2. sessionRepoPath (legacy) → use as local path directly
 * 3. Neither → use project repo
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CHECKPOINTS_BRANCH, SESSION_DIR_NAME } from '../types.js';
import { loadSettings } from '../config.js';
import {
  getWorktreeRoot,
  initSessionRepo,
  resolveSessionRepoPath,
  getProjectID,
  getSessionRepoLocalPath,
  cloneSessionRepo,
  fetchSessionRepoAsync,
} from '../git-operations.js';

export interface SessionRepoConfig {
  /** Working directory for committed checkpoint operations (separate repo or undefined for project repo) */
  sessionRepoCwd?: string;
  /** Directory for session state files (separate repo namespaced path or undefined for default) */
  sessionsDir?: string;
  /** Branch name for committed checkpoints (namespaced or default) */
  checkpointsBranch?: string;
  /** Automatically push checkpoint commits to the remote */
  autoPush?: boolean;
  /** Git remote URL for the session repo (for push operations) */
  remote?: string;
}

/**
 * Resolve session repo configuration from settings.
 * Returns empty config if no session repo is configured or resolution fails.
 *
 * Handles three modes:
 * 1. Remote URL (sessionRepo.remote) — clone to local path, namespace by project
 * 2. Legacy local path (sessionRepoPath) — use directly, namespace by project
 * 3. No config — use project repo
 */
export async function resolveSessionRepoConfig(cwd?: string): Promise<SessionRepoConfig> {
  try {
    const settings = await loadSettings(cwd);
    const root = await getWorktreeRoot(cwd);
    const projectID = getProjectID(root);

    // Mode 1: Remote URL — clone or locate local checkout
    if (settings.sessionRepo?.remote) {
      const remote = settings.sessionRepo.remote;
      const directory = settings.sessionRepo.directory ?? projectID;

      // Resolve local path: explicit localPath > env var > auto-clone path
      const localPath = settings.sessionRepo.localPath
        ?? getSessionRepoLocalPath(remote);

      // Ensure the local checkout exists (blocking on first clone, then fire-and-forget fetch)
      let cloned = false;
      try {
        await fs.promises.access(path.join(localPath, '.git'));
      } catch {
        cloned = true;
      }
      const sessionRepoCwd = await cloneSessionRepo(remote, localPath);

      // If the clone already existed, fire a non-blocking background fetch
      // so we pick up checkpoints pushed by other team members
      if (!cloned) {
        fetchSessionRepoAsync(sessionRepoCwd);
      }

      return {
        sessionRepoCwd,
        sessionsDir: `${sessionRepoCwd}/${SESSION_DIR_NAME}/${directory}`,
        checkpointsBranch: `${CHECKPOINTS_BRANCH}/${directory}`,
        autoPush: settings.sessionRepo.autoPush ?? false,
        remote,
      };
    }

    // Mode 2: Legacy local path
    if (settings.sessionRepoPath) {
      const resolved = resolveSessionRepoPath(settings.sessionRepoPath, root);
      const sessionRepoCwd = await initSessionRepo(resolved);

      return {
        sessionRepoCwd,
        sessionsDir: `${sessionRepoCwd}/${SESSION_DIR_NAME}/${projectID}`,
        checkpointsBranch: `${CHECKPOINTS_BRANCH}/${projectID}`,
      };
    }

    // Mode 3: No session repo configured
    return {};
  } catch {
    // Fall back to project repo if session repo can't be resolved
    return {};
  }
}
