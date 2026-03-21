/**
 * Sessionlog Core Types
 *
 * Core type definitions for the Sessionlog session tracking system.
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
  TaskCreate = 8,
  TaskUpdate = 9,
  PlanModeEnter = 10,
  PlanModeExit = 11,
  SkillUse = 12,
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
  /** Task ID (from tool_response for TaskCreate, from tool_input for TaskUpdate) */
  taskID?: string;
  /** Task subject/title */
  taskSubject?: string;
  /** Task status: 'pending' | 'in_progress' | 'completed' */
  taskStatus?: string;
  /** Task active form (present continuous label) */
  taskActiveForm?: string;
  /** Plan mode allowed prompts from ExitPlanMode */
  planAllowedPrompts?: Array<{ tool: string; prompt: string }>;
  /** Path to the plan file (extracted from ExitPlanMode tool_response) */
  planFilePath?: string;
  /** Skill name (from Skill tool_input) */
  skillName?: string;
  /** Skill arguments (from Skill tool_input) */
  skillArgs?: string;
}

// ============================================================================
// Session Types
// ============================================================================

export type SessionPhase = 'idle' | 'active' | 'ended';

/** Tracked task state (lightweight, for session metadata) */
export interface TrackedTask {
  id: string;
  subject: string;
  description?: string;
  status: string;
  activeForm?: string;
  createdAt: string;
  updatedAt: string;
}

/** Tracked skill usage (lightweight, for session metadata) */
export interface TrackedSkill {
  name: string;
  args?: string;
  usedAt: string;
}

/** A single plan mode enter/exit cycle */
export interface PlanEntry {
  /** ISO timestamp when plan mode was entered */
  enteredAt: string;
  /** ISO timestamp when plan mode was exited (undefined if still in plan mode) */
  exitedAt?: string;
  /** Path to the plan file (captured on exit) */
  filePath?: string;
  /** Content of the plan file (captured on exit) */
  content?: string;
  /** Allowed prompts from ExitPlanMode (captured on exit) */
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
}

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
  /** Tracked tasks during the session */
  tasks?: Record<string, TrackedTask>;
  /** Whether the session is currently in plan mode */
  inPlanMode?: boolean;
  /** Number of times plan mode was entered */
  planModeEntries?: number;
  /** All plan mode entries (enter/exit cycles) */
  planEntries?: PlanEntry[];
  /** Skills used during the session */
  skillsUsed?: TrackedSkill[];
  /** Extensible annotations from external systems (e.g., swarm metadata) */
  annotations?: Record<string, unknown>;
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
  /** Tasks that were active/completed during this checkpoint */
  tasks?: Record<string, TrackedTask>;
  /** Whether plan mode was used during this checkpoint */
  planModeUsed?: boolean;
  /** Number of plan mode entries during this checkpoint */
  planModeEntries?: number;
  /** All plan mode entries */
  planEntries?: PlanEntry[];
  /** Skills used during this checkpoint */
  skillsUsed?: TrackedSkill[];
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
  /** Tasks tracked during this checkpoint */
  tasks?: Record<string, TrackedTask>;
  /** Whether plan mode was used */
  planModeUsed?: boolean;
  /** Number of plan mode entries */
  planModeEntries?: number;
  /** All plan mode entries */
  planEntries?: PlanEntry[];
  /** Skills used */
  skillsUsed?: TrackedSkill[];
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

export interface SessionlogSettings {
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
  /** Enable the JSONL event log (.sessionlog/events.jsonl).
   *  When true, checkpoint events are appended to the log file for
   *  consumption by external systems. Defaults to false. */
  eventLogEnabled?: boolean;
  /** Maximum number of events to retain in the event log file.
   *  When set, the log is pruned to this many entries after each write.
   *  When undefined or 0, all events are kept. */
  eventLogMaxEvents?: number;
}

export const DEFAULT_SETTINGS: SessionlogSettings = {
  enabled: false,
  strategy: 'manual-commit',
  logLevel: 'warn',
  telemetryEnabled: false,
  summarizationEnabled: false,
};

// ============================================================================
// Constants
// ============================================================================

export const SESSIONLOG_DIR = '.sessionlog';
export const SESSIONLOG_TMP_DIR = '.sessionlog/tmp';
export const SESSIONLOG_METADATA_DIR = '.sessionlog/metadata';
export const SESSIONLOG_SETTINGS_FILE = '.sessionlog/settings.json';
export const SESSIONLOG_SETTINGS_LOCAL_FILE = '.sessionlog/settings.local.json';
export const SESSIONLOG_EVENTS_FILE = '.sessionlog/events.jsonl';
export const CHECKPOINTS_BRANCH = 'sessionlog/checkpoints/v1';
export const SHADOW_BRANCH_PREFIX = 'sessionlog/';
export const SHADOW_BRANCH_HASH_LENGTH = 7;
export const SESSION_DIR_NAME = 'sessionlog-sessions';
export const MAX_CHUNK_SIZE = 50 * 1024 * 1024; // 50MB
export const STALE_SESSION_DAYS = 7;
