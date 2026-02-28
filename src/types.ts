/**
 * Entire Core Types
 *
 * Core type definitions for the Entire session tracking system.
 * This module is designed with clean boundaries for future extraction
 * into a standalone package.
 */

// ============================================================================
// Agent Types
// ============================================================================

/** Registered agent identifier (e.g., 'claude-code', 'cursor') */
export type AgentName = string;

/** Human-readable agent type (e.g., 'Claude Code', 'Cursor IDE') */
export type AgentType = string;

export const AGENT_NAMES = {
  CLAUDE_CODE: 'claude-code' as AgentName,
  CURSOR: 'cursor' as AgentName,
  GEMINI: 'gemini' as AgentName,
  OPENCODE: 'opencode' as AgentName,
} as const;

export const AGENT_TYPES = {
  CLAUDE_CODE: 'Claude Code' as AgentType,
  CURSOR: 'Cursor IDE' as AgentType,
  GEMINI: 'Gemini CLI' as AgentType,
  OPENCODE: 'OpenCode' as AgentType,
  UNKNOWN: 'Agent' as AgentType,
} as const;

export const DEFAULT_AGENT_NAME = AGENT_NAMES.CLAUDE_CODE;

// ============================================================================
// Hook Types
// ============================================================================

export type HookType =
  | 'session_start'
  | 'session_end'
  | 'user_prompt_submit'
  | 'stop'
  | 'pre_tool_use'
  | 'post_tool_use';

export interface HookInput {
  hookType: HookType;
  sessionID: string;
  sessionRef: string;
  timestamp: Date;
  userPrompt?: string;
  toolName?: string;
  toolUseID?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  rawData?: Record<string, unknown>;
}

// ============================================================================
// Event Types
// ============================================================================

export enum EventType {
  SessionStart = 1,
  TurnStart = 2,
  TurnEnd = 3,
  Compaction = 4,
  SessionEnd = 5,
  SubagentStart = 6,
  SubagentEnd = 7,
}

export interface Event {
  type: EventType;
  sessionID: string;
  previousSessionID?: string;
  sessionRef: string;
  prompt?: string;
  timestamp: Date;
  toolUseID?: string;
  subagentID?: string;
  toolInput?: unknown;
  subagentType?: string;
  taskDescription?: string;
  responseMessage?: string;
  metadata?: Record<string, string>;
}

// ============================================================================
// Session Types
// ============================================================================

export type SessionPhase = 'idle' | 'active' | 'ended';

export interface SessionState {
  sessionID: string;
  cliVersion?: string;
  baseCommit: string;
  attributionBaseCommit?: string;
  worktreePath?: string;
  worktreeID?: string;
  startedAt: string;
  endedAt?: string;
  phase: SessionPhase;
  turnID?: string;
  turnCheckpointIDs: string[];
  lastInteractionTime?: string;
  stepCount: number;
  checkpointTranscriptStart: number;
  untrackedFilesAtStart: string[];
  filesTouched: string[];
  lastCheckpointID?: string;
  agentType: AgentType;
  tokenUsage?: TokenUsage;
  transcriptIdentifierAtStart?: string;
  transcriptPath?: string;
  firstPrompt?: string;
  promptAttributions?: PromptAttribution[];
  pendingPromptAttribution?: PromptAttribution;
}

export interface PromptAttribution {
  prompt: string;
  timestamp: string;
  agentLines: number;
  humanAdded: number;
  humanModified: number;
  humanRemoved: number;
}

// ============================================================================
// Token Usage
// ============================================================================

export interface TokenUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  apiCallCount: number;
  subagentTokens?: TokenUsage;
}

export function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    apiCallCount: 0,
  };
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    apiCallCount: a.apiCallCount + b.apiCallCount,
    subagentTokens:
      a.subagentTokens || b.subagentTokens
        ? addTokenUsage(
            a.subagentTokens ?? emptyTokenUsage(),
            b.subagentTokens ?? emptyTokenUsage(),
          )
        : undefined,
  };
}

// ============================================================================
// Checkpoint Types
// ============================================================================

export enum CheckpointType {
  Temporary = 0,
  Committed = 1,
}

export interface Checkpoint {
  id: string;
  sessionID: string;
  timestamp: string;
  type: CheckpointType;
  message: string;
}

/** Checkpoint ID is a 12-character hex string */
export type CheckpointID = string;

export const CHECKPOINT_ID_LENGTH = 12;
export const CHECKPOINT_ID_PATTERN = /^[0-9a-f]{12}$/;

export function validateCheckpointID(id: string): boolean {
  return CHECKPOINT_ID_PATTERN.test(id);
}

/** Shard a checkpoint ID for storage: "a3b2c4d5e6f7" → "a3/b2c4d5e6f7" */
export function checkpointIDPath(id: CheckpointID): string {
  return `${id.slice(0, 2)}/${id.slice(2)}`;
}

// ============================================================================
// Committed Checkpoint Metadata
// ============================================================================

export interface CheckpointSummary {
  cliVersion?: string;
  checkpointID: CheckpointID;
  strategy: string;
  branch?: string;
  checkpointsCount: number;
  filesTouched: string[];
  sessions: SessionFilePaths[];
  tokenUsage?: TokenUsage;
}

export interface SessionFilePaths {
  metadata: string;
  transcript: string;
  context: string;
  contentHash?: string;
  prompt: string;
}

export interface CommittedMetadata {
  cliVersion?: string;
  checkpointID: CheckpointID;
  sessionID: string;
  strategy: string;
  createdAt: string;
  branch?: string;
  checkpointsCount: number;
  filesTouched: string[];
  agent?: AgentType;
  turnID?: string;
  isTask?: boolean;
  toolUseID?: string;
  transcriptIdentifierAtStart?: string;
  checkpointTranscriptStart: number;
  tokenUsage?: TokenUsage;
  summary?: Summary;
  initialAttribution?: InitialAttribution;
}

export interface Summary {
  intent: string;
  outcome: string;
  learnings: LearningsSummary;
  friction: string[];
  openItems: string[];
}

export interface LearningsSummary {
  repo: string[];
  code: CodeLearning[];
  workflow: string[];
}

export interface CodeLearning {
  path: string;
  line?: number;
  endLine?: number;
  finding: string;
}

export interface InitialAttribution {
  calculatedAt: string;
  agentLines: number;
  humanAdded: number;
  humanModified: number;
  humanRemoved: number;
  totalCommitted: number;
  agentPercentage: number;
}

// ============================================================================
// Rewind Types
// ============================================================================

export interface RewindPoint {
  id: string;
  message: string;
  metadataDir?: string;
  date: string;
  isTaskCheckpoint: boolean;
  isLogsOnly: boolean;
  checkpointID?: CheckpointID;
  agent?: AgentType;
  sessionID?: string;
  sessionPrompt?: string;
  sessionCount: number;
  sessionIDs: string[];
}

// ============================================================================
// Write Options
// ============================================================================

export interface WriteTemporaryOptions {
  sessionID: string;
  baseCommit: string;
  worktreeID?: string;
  modifiedFiles: string[];
  newFiles: string[];
  deletedFiles: string[];
  metadataDir: string;
  metadataDirAbs: string;
  commitMessage: string;
  authorName: string;
  authorEmail: string;
  isFirstCheckpoint: boolean;
}

export interface WriteTemporaryResult {
  commitHash: string;
  skipped: boolean;
}

export interface WriteCommittedOptions {
  checkpointID: CheckpointID;
  sessionID: string;
  strategy: string;
  branch?: string;
  transcript: Buffer;
  prompts: string[];
  context: Buffer;
  filesTouched: string[];
  checkpointsCount: number;
  ephemeralBranch?: string;
  authorName: string;
  authorEmail: string;
  metadataDir?: string;
  isTask?: boolean;
  toolUseID?: string;
  agentID?: string;
  checkpointUUID?: string;
  transcriptPath?: string;
  subagentTranscriptPath?: string;
  isIncremental?: boolean;
  incrementalSequence?: number;
  incrementalType?: string;
  incrementalData?: Buffer;
  commitSubject?: string;
  agent: AgentType;
  turnID?: string;
  transcriptIdentifierAtStart?: string;
  checkpointTranscriptStart: number;
  tokenUsage?: TokenUsage;
  initialAttribution?: InitialAttribution;
  summary?: Summary;
}

export interface UpdateCommittedOptions {
  checkpointID: CheckpointID;
  sessionID: string;
  transcript: Buffer;
  prompts: string[];
  context: Buffer;
  agent: AgentType;
}

// ============================================================================
// Session Change (File Watcher)
// ============================================================================

export interface SessionChange {
  sessionID: string;
  sessionRef: string;
  eventType: HookType;
  timestamp: Date;
}

// ============================================================================
// Settings
// ============================================================================

export interface EntireSettings {
  enabled: boolean;
  strategy: string;
  logLevel?: string;
  skipPushSessions?: boolean;
  telemetryEnabled?: boolean;
  summarizationEnabled?: boolean;
  /** Path to a separate git repository for storing session/checkpoint data.
   *  When set, committed checkpoints and session state files are stored
   *  in this repo instead of the project repo. Shadow branches (temporary
   *  checkpoints) remain in the project repo. */
  sessionRepoPath?: string;
}

export const DEFAULT_SETTINGS: EntireSettings = {
  enabled: false,
  strategy: 'manual-commit',
  logLevel: 'warn',
  telemetryEnabled: false,
  summarizationEnabled: false,
};

// ============================================================================
// Constants
// ============================================================================

export const ENTIRE_DIR = '.entire';
export const ENTIRE_TMP_DIR = '.entire/tmp';
export const ENTIRE_METADATA_DIR = '.entire/metadata';
export const ENTIRE_SETTINGS_FILE = '.entire/settings.json';
export const ENTIRE_SETTINGS_LOCAL_FILE = '.entire/settings.local.json';
export const CHECKPOINTS_BRANCH = 'entire/checkpoints/v1';
export const SHADOW_BRANCH_PREFIX = 'entire/';
export const SHADOW_BRANCH_HASH_LENGTH = 7;
export const SESSION_DIR_NAME = 'entire-sessions';
export const MAX_CHUNK_SIZE = 50 * 1024 * 1024; // 50MB
export const STALE_SESSION_DAYS = 7;
