/**
 * Commit Message Trailers
 *
 * Parsing and formatting for Runlog commit message trailers.
 * Trailers are key-value metadata appended to git commit messages
 * following the git trailer convention (key: value format after a blank line).
 */

import { CHECKPOINT_ID_PATTERN, type CheckpointID } from '../types.js';

// ============================================================================
// Trailer Key Constants
// ============================================================================

export const MetadataTrailerKey = 'Runlog-Metadata';
export const MetadataTaskTrailerKey = 'Runlog-Metadata-Task';
export const StrategyTrailerKey = 'Runlog-Strategy';
export const BaseCommitTrailerKey = 'Base-Commit';
export const SessionTrailerKey = 'Runlog-Session';
export const CondensationTrailerKey = 'Runlog-Condensation';
export const SourceRefTrailerKey = 'Runlog-Source-Ref';
export const CheckpointTrailerKey = 'Runlog-Checkpoint';
export const EphemeralBranchTrailerKey = 'Ephemeral-branch';
export const AgentTrailerKey = 'Runlog-Agent';

// ============================================================================
// Pre-compiled Regex Patterns
// ============================================================================

const strategyTrailerRegex = new RegExp(`${StrategyTrailerKey}:\\s*(.+)`);
const metadataTrailerRegex = new RegExp(`${MetadataTrailerKey}:\\s*(.+)`);
const taskMetadataTrailerRegex = new RegExp(`${MetadataTaskTrailerKey}:\\s*(.+)`);
const baseCommitTrailerRegex = new RegExp(`${BaseCommitTrailerKey}:\\s*([a-f0-9]{40})`);
const condensationTrailerRegex = new RegExp(`${CondensationTrailerKey}:\\s*(.+)`);
const sessionTrailerRegexSingle = new RegExp(`${SessionTrailerKey}:\\s*(.+)`);
const checkpointTrailerRegex = new RegExp(`${CheckpointTrailerKey}:\\s*([0-9a-f]{12})(?:\\s|$)`);

// ============================================================================
// Parse Functions
// ============================================================================

export function parseStrategy(commitMessage: string): [string, boolean] {
  const matches = strategyTrailerRegex.exec(commitMessage);
  if (matches && matches[1]) {
    return [matches[1].trim(), true];
  }
  return ['', false];
}

export function parseMetadata(commitMessage: string): [string, boolean] {
  const matches = metadataTrailerRegex.exec(commitMessage);
  if (matches && matches[1]) {
    return [matches[1].trim(), true];
  }
  return ['', false];
}

export function parseTaskMetadata(commitMessage: string): [string, boolean] {
  const matches = taskMetadataTrailerRegex.exec(commitMessage);
  if (matches && matches[1]) {
    return [matches[1].trim(), true];
  }
  return ['', false];
}

export function parseBaseCommit(commitMessage: string): [string, boolean] {
  const matches = baseCommitTrailerRegex.exec(commitMessage);
  if (matches && matches[1]) {
    return [matches[1], true];
  }
  return ['', false];
}

export function parseCondensation(commitMessage: string): [string, boolean] {
  const matches = condensationTrailerRegex.exec(commitMessage);
  if (matches && matches[1]) {
    return [matches[1].trim(), true];
  }
  return ['', false];
}

export function parseSession(commitMessage: string): [string, boolean] {
  const matches = sessionTrailerRegexSingle.exec(commitMessage);
  if (matches && matches[1]) {
    return [matches[1].trim(), true];
  }
  return ['', false];
}

export function parseCheckpoint(commitMessage: string): [CheckpointID | null, boolean] {
  const matches = checkpointTrailerRegex.exec(commitMessage);
  if (matches && matches[1]) {
    const idStr = matches[1].trim();
    if (CHECKPOINT_ID_PATTERN.test(idStr)) {
      return [idStr as CheckpointID, true];
    }
  }
  return [null, false];
}

export function parseAllSessions(commitMessage: string): string[] {
  const seen = new Set<string>();
  const sessionIDs: string[] = [];
  const regex = new RegExp(`${SessionTrailerKey}:\\s*(.+)`, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(commitMessage)) !== null) {
    if (match[1]) {
      const sessionID = match[1].trim();
      if (!seen.has(sessionID)) {
        seen.add(sessionID);
        sessionIDs.push(sessionID);
      }
    }
  }
  return sessionIDs;
}

// ============================================================================
// Format Functions
// ============================================================================

export function formatStrategy(message: string, strategy: string): string {
  return `${message}\n\n${StrategyTrailerKey}: ${strategy}\n`;
}

export function formatTaskMetadata(message: string, taskMetadataDir: string): string {
  return `${message}\n\n${MetadataTaskTrailerKey}: ${taskMetadataDir}\n`;
}

export function formatTaskMetadataWithStrategy(
  message: string,
  taskMetadataDir: string,
  strategy: string,
): string {
  return `${message}\n\n${MetadataTaskTrailerKey}: ${taskMetadataDir}\n${StrategyTrailerKey}: ${strategy}\n`;
}

export function formatSourceRef(branch: string, commitHash: string): string {
  const shortHash = commitHash.length > 7 ? commitHash.slice(0, 7) : commitHash;
  return `${branch}@${shortHash}`;
}

export function formatMetadata(message: string, metadataDir: string): string {
  return `${message}\n\n${MetadataTrailerKey}: ${metadataDir}\n`;
}

export function formatMetadataWithStrategy(
  message: string,
  metadataDir: string,
  strategy: string,
): string {
  return `${message}\n\n${MetadataTrailerKey}: ${metadataDir}\n${StrategyTrailerKey}: ${strategy}\n`;
}

export function formatShadowCommit(
  message: string,
  metadataDir: string,
  sessionID: string,
): string {
  return [
    message,
    '',
    `${MetadataTrailerKey}: ${metadataDir}`,
    `${SessionTrailerKey}: ${sessionID}`,
    `${StrategyTrailerKey}: manual-commit`,
    '',
  ].join('\n');
}

export function formatShadowTaskCommit(
  message: string,
  taskMetadataDir: string,
  sessionID: string,
): string {
  return [
    message,
    '',
    `${MetadataTaskTrailerKey}: ${taskMetadataDir}`,
    `${SessionTrailerKey}: ${sessionID}`,
    `${StrategyTrailerKey}: manual-commit`,
    '',
  ].join('\n');
}

export function formatCheckpoint(message: string, cpID: CheckpointID): string {
  return `${message}\n\n${CheckpointTrailerKey}: ${cpID}\n`;
}
