/**
 * Agent Types
 *
 * Interfaces for AI agent integrations. Each supported agent
 * (Claude Code, Cursor, Gemini CLI, OpenCode) implements these
 * interfaces to participate in the Runlog session tracking lifecycle.
 */

import type { AgentName, AgentType, HookInput, Event, TokenUsage } from '../types.js';

// ============================================================================
// Core Agent Interface
// ============================================================================

/**
 * Agent represents a supported AI coding agent
 */
export interface Agent {
  /** Registry key (e.g., 'claude-code') */
  readonly name: AgentName;

  /** Human-readable type (e.g., 'Claude Code') */
  readonly type: AgentType;

  /** Description of the agent */
  readonly description: string;

  /** Whether this agent integration is in preview */
  readonly isPreview: boolean;

  /** Directories that should never be modified/deleted by Runlog */
  readonly protectedDirs: string[];

  /** Check if this agent is present in the current environment */
  detectPresence(cwd?: string): Promise<boolean>;

  /** Get the session directory for this agent */
  getSessionDir(repoPath: string): Promise<string>;

  /** Get session ID from hook input */
  getSessionID(input: HookInput): string;

  /** Resolve transcript file path */
  resolveSessionFile(sessionDir: string, agentSessionID: string): string;

  /** Read the raw transcript for a session */
  readTranscript(sessionRef: string): Promise<Buffer>;

  /** Format a resume command for the user */
  formatResumeCommand(sessionID: string): string;
}

// ============================================================================
// Optional Agent Capabilities
// ============================================================================

/**
 * Agent supports lifecycle hooks
 */
export interface HookSupport {
  /** Hook names this agent supports */
  hookNames(): string[];

  /** Parse a hook event from stdin */
  parseHookEvent(hookName: string, stdin: string): Event | null;

  /** Install hooks for this agent in a repo */
  installHooks(repoPath: string, force?: boolean): Promise<number>;

  /** Remove hooks for this agent from a repo */
  uninstallHooks(repoPath: string): Promise<void>;

  /** Check if hooks are installed */
  areHooksInstalled(repoPath: string): Promise<boolean>;
}

/**
 * Agent supports file watching for session changes
 */
export interface FileWatcher {
  /** Get paths to watch for changes */
  getWatchPaths(repoPath: string): Promise<string[]>;

  /** Handle a file change event */
  onFileChange(filePath: string): Promise<SessionChangeEvent | null>;
}

/**
 * Agent supports transcript analysis
 */
export interface TranscriptAnalyzer {
  /** Get current position in the transcript */
  getTranscriptPosition(transcriptPath: string): Promise<number>;

  /** Extract modified files from a transcript segment */
  extractModifiedFilesFromOffset(
    transcriptPath: string,
    startOffset: number,
  ): Promise<{ files: string[]; currentPosition: number }>;

  /** Extract user prompts from a transcript segment */
  extractPrompts(sessionRef: string, fromOffset: number): Promise<string[]>;

  /** Extract a summary from the transcript */
  extractSummary(sessionRef: string): Promise<string>;
}

/**
 * Agent supports token usage calculation
 */
export interface TokenCalculator {
  /** Calculate token usage from a transcript segment */
  calculateTokenUsage(transcriptData: Buffer, fromOffset: number): Promise<TokenUsage>;
}

/**
 * Agent supports transcript preparation (e.g., waiting for async flush).
 *
 * Some agents write transcripts asynchronously. Before reading the transcript
 * for checkpoint creation, the agent can wait for a flush sentinel to ensure
 * the transcript is complete.
 */
export interface TranscriptPreparer {
  /** Wait for the transcript to be fully flushed before reading */
  prepareTranscript(sessionRef: string): Promise<void>;
}

/**
 * Agent supports subagent-aware extraction (e.g., Claude Code's Task tool).
 * Aggregates files and tokens from both the main session and spawned subagents.
 */
export interface SubagentAwareExtractor {
  /** Extract files modified by both the main agent and any spawned subagents */
  extractAllModifiedFiles(
    transcriptData: Buffer,
    fromOffset: number,
    subagentsDir: string,
  ): Promise<string[]>;

  /** Calculate token usage including all spawned subagents */
  calculateTotalTokenUsage(
    transcriptData: Buffer,
    fromOffset: number,
    subagentsDir: string,
  ): Promise<TokenUsage>;
}

/**
 * Agent supports transcript chunking for storage
 */
export interface TranscriptChunker {
  /** Split a transcript into storage-safe chunks */
  chunkTranscript(content: Buffer, maxSize: number): Promise<Buffer[]>;

  /** Reassemble chunked transcripts */
  reassembleTranscript(chunks: Buffer[]): Promise<Buffer>;
}

// ============================================================================
// Session Change Event (from FileWatcher)
// ============================================================================

export interface SessionChangeEvent {
  sessionID: string;
  sessionRef: string;
  eventType: string;
  timestamp: Date;
}

// ============================================================================
// Type Guards
// ============================================================================

export function hasHookSupport(agent: Agent): agent is Agent & HookSupport {
  return 'hookNames' in agent && typeof (agent as unknown as HookSupport).hookNames === 'function';
}

export function hasFileWatcher(agent: Agent): agent is Agent & FileWatcher {
  return (
    'getWatchPaths' in agent &&
    typeof (agent as unknown as FileWatcher).getWatchPaths === 'function'
  );
}

export function hasTranscriptAnalyzer(agent: Agent): agent is Agent & TranscriptAnalyzer {
  return (
    'getTranscriptPosition' in agent &&
    typeof (agent as unknown as TranscriptAnalyzer).getTranscriptPosition === 'function'
  );
}

export function hasTokenCalculator(agent: Agent): agent is Agent & TokenCalculator {
  return (
    'calculateTokenUsage' in agent &&
    typeof (agent as unknown as TokenCalculator).calculateTokenUsage === 'function'
  );
}

export function hasTranscriptPreparer(agent: Agent): agent is Agent & TranscriptPreparer {
  return (
    'prepareTranscript' in agent &&
    typeof (agent as unknown as TranscriptPreparer).prepareTranscript === 'function'
  );
}

export function hasSubagentAwareExtractor(agent: Agent): agent is Agent & SubagentAwareExtractor {
  return (
    'extractAllModifiedFiles' in agent &&
    typeof (agent as unknown as SubagentAwareExtractor).extractAllModifiedFiles === 'function' &&
    'calculateTotalTokenUsage' in agent &&
    typeof (agent as unknown as SubagentAwareExtractor).calculateTotalTokenUsage === 'function'
  );
}

export function hasTranscriptChunker(agent: Agent): agent is Agent & TranscriptChunker {
  return (
    'chunkTranscript' in agent &&
    typeof (agent as unknown as TranscriptChunker).chunkTranscript === 'function'
  );
}
