/**
 * Path Classification Helpers
 *
 * Utilities for classifying and normalizing paths within the Runlog system.
 *
 * Ported from Go: paths/paths.go
 */

import * as path from 'node:path';
import { RUNLOG_DIR } from '../types.js';

/**
 * Returns true if the path is part of Runlog's infrastructure
 * (i.e., inside the `.runlog/` directory).
 */
export function isInfrastructurePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized === RUNLOG_DIR || normalized.startsWith(RUNLOG_DIR + '/');
}

/**
 * Converts an absolute path to a repository-relative path.
 * Returns empty string if the path is outside the working directory.
 */
export function toRelativePath(absPath: string, cwd: string): string {
  if (!path.isAbsolute(absPath)) return absPath;

  const relPath = path.relative(cwd, absPath);
  if (relPath.startsWith('..')) return '';

  return relPath;
}

/**
 * Returns the absolute path for a relative path within the repository.
 * If the path is already absolute, it is returned as-is.
 */
export function absPath(relPath: string, repoRoot: string): string {
  if (path.isAbsolute(relPath)) return relPath;
  return path.join(repoRoot, relPath);
}

/**
 * Extract the session ID from a transcript file path.
 * Expects paths like `/path/to/<sessionID>.jsonl` or `/path/to/<sessionID>.json`.
 */
export function extractSessionIDFromPath(transcriptPath: string): string {
  const base = path.basename(transcriptPath);
  // Remove extension (.jsonl, .json, etc.)
  const dotIndex = base.indexOf('.');
  return dotIndex > 0 ? base.slice(0, dotIndex) : base;
}

/**
 * Returns the session metadata directory path for a given session ID.
 */
export function sessionMetadataDir(metadataRoot: string, sessionID: string): string {
  return path.join(metadataRoot, 'sessions', sessionID);
}
