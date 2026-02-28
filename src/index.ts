/**
 * Entire - Native TypeScript Implementation
 *
 * A self-contained module that implements the Entire CLI's functionality
 * in TypeScript. Designed with clean boundaries for eventual extraction
 * into a standalone package.
 *
 * @packageDocumentation
 */

import { createRequire } from 'node:module';

// =============================================================================
// Version
// =============================================================================

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json') as { version: string };

/** Current package version */
export { VERSION };

/**
 * Get the current version string.
 */
export function getVersion(): string {
  return VERSION;
}

// =============================================================================
// Core Types
// =============================================================================

export type {
  AgentName,
  AgentType,
  HookType,
  HookInput,
  Event,
  SessionPhase,
  SessionState,
  PromptAttribution,
  TokenUsage,
  CheckpointID,
  Checkpoint,
  CheckpointSummary,
  CommittedMetadata,
  SessionFilePaths,
  Summary,
  LearningsSummary,
  CodeLearning,
  InitialAttribution,
  RewindPoint,
  WriteTemporaryOptions,
  WriteTemporaryResult,
  WriteCommittedOptions,
  UpdateCommittedOptions,
  SessionChange,
  EntireSettings,
} from './types.js';

export {
  AGENT_NAMES,
  AGENT_TYPES,
  DEFAULT_AGENT_NAME,
  EventType,
  CheckpointType,
  CHECKPOINT_ID_LENGTH,
  CHECKPOINT_ID_PATTERN,
  CHECKPOINTS_BRANCH,
  SHADOW_BRANCH_PREFIX,
  ENTIRE_DIR,
  ENTIRE_METADATA_DIR,
  ENTIRE_TMP_DIR,
  ENTIRE_SETTINGS_FILE,
  ENTIRE_SETTINGS_LOCAL_FILE,
  SESSION_DIR_NAME,
  MAX_CHUNK_SIZE,
  DEFAULT_SETTINGS,
  validateCheckpointID,
  checkpointIDPath,
  emptyTokenUsage,
  addTokenUsage,
} from './types.js';

// =============================================================================
// Git Operations
// =============================================================================

export {
  git,
  gitSafe,
  getGitDir,
  getGitCommonDir,
  getWorktreeRoot,
  isGitRepository,
  getSessionsDir,
  getHead,
  getShortHash,
  getCurrentBranch,
  refExists,
  getTreeHash,
  listBranches,
  hashObject,
  mktree,
  commitTree,
  lsTree,
  catFile,
  showFile,
  log,
  diffNameOnly,
  diffStat,
  hasUncommittedChanges,
  getUntrackedFiles,
  isOnDefaultBranch,
  pushBranch,
  getGitAuthor,
  resolveGitDirSync,
  atomicWriteFile,
  initSessionRepo,
  resolveSessionRepoPath,
  getProjectID,
  GitError,
  type GitAuthor,
  type GitExecOptions,
} from './git-operations.js';

// =============================================================================
// Session Store
// =============================================================================

export {
  createSessionStore,
  normalizeSessionState,
  type SessionStore,
} from './store/session-store.js';

// =============================================================================
// Checkpoint Store
// =============================================================================

export { createCheckpointStore, type CheckpointStore } from './store/checkpoint-store.js';

// =============================================================================
// Native Store (replaces CLI store)
// =============================================================================

export { createNativeEntireStore } from './store/native-store.js';

export type {
  EntireStore,
  EntireSession,
  EntireCheckpoint,
  EntireTokenUsage,
  EntireSkillUsage,
} from './store/provider-types.js';

// =============================================================================
// Agent System
// =============================================================================

export type {
  Agent,
  HookSupport,
  FileWatcher,
  TranscriptAnalyzer,
  TokenCalculator,
  TranscriptChunker,
  TranscriptPreparer,
  SubagentAwareExtractor,
  SessionChangeEvent,
} from './agent/types.js';

export {
  hasHookSupport,
  hasFileWatcher,
  hasTranscriptAnalyzer,
  hasTokenCalculator,
  hasTranscriptChunker,
  hasTranscriptPreparer,
  hasSubagentAwareExtractor,
} from './agent/types.js';

export {
  registerAgent,
  getAgent,
  listAgentNames,
  listAgents,
  detectAgents,
  detectAgent,
  getAgentByType,
  getDefaultAgent,
  allProtectedDirs,
  resolveAgent,
  resetRegistry,
  type AgentFactory,
} from './agent/registry.js';

// Agent Implementations
export {
  createClaudeCodeAgent,
  parseTranscript,
  extractModifiedFiles,
  extractLastUserPrompt,
  extractSpawnedAgentIDs,
  type TranscriptLine,
  type AssistantContent,
} from './agent/agents/claude-code.js';

export { createCursorAgent } from './agent/agents/cursor.js';

export {
  createGeminiCLIAgent,
  type GeminiTranscript,
  type GeminiMessage,
  type GeminiToolCall,
} from './agent/agents/gemini-cli.js';

export {
  createOpenCodeAgent,
  extractTextFromParts,
  parseExportSession,
  extractAllUserPrompts,
  type ExportSession,
  type ExportMessage,
  type SessionInfo as OpenCodeSessionInfo,
  type Part as OpenCodePart,
  type ToolState as OpenCodeToolState,
} from './agent/agents/opencode.js';

// =============================================================================
// Hooks
// =============================================================================

export {
  installGitHooks,
  uninstallGitHooks,
  areGitHooksInstalled,
  type GitHookName,
} from './hooks/git-hooks.js';

export {
  createLifecycleHandler,
  type LifecycleConfig,
  type LifecycleHandler,
} from './hooks/lifecycle.js';

// =============================================================================
// Security
// =============================================================================

export {
  shannonEntropy,
  detectSecrets,
  redactString,
  redactBuffer,
  redactJSONL,
} from './security/redaction.js';

// =============================================================================
// Configuration
// =============================================================================

export {
  loadSettings,
  loadProjectSettings,
  loadLocalSettings,
  saveProjectSettings,
  saveLocalSettings,
  isEnabled,
  getStrategy,
  ensureGitignore,
} from './config.js';

// =============================================================================
// Commands
// =============================================================================

export { enable, type EnableOptions, type EnableResult } from './commands/enable.js';

export { disable, type DisableOptions, type DisableResult } from './commands/disable.js';

export {
  status,
  formatStatusJSON,
  formatTokens,
  type StatusResult,
  type SessionStatus,
} from './commands/status.js';

export {
  listRewindPoints,
  rewindTo,
  listRewindPointsJSON,
  type RewindOptions,
  type RewindResult,
} from './commands/rewind.js';

export {
  diagnose,
  discardSession,
  doctor,
  type StuckSession,
  type DoctorResult,
  type DoctorOptions,
} from './commands/doctor.js';

export {
  findOrphaned,
  clean,
  type CleanupItem,
  type CleanResult,
  type CleanOptions,
} from './commands/clean.js';

export { reset, type ResetOptions, type ResetResult } from './commands/reset.js';

export {
  listCheckpoints,
  getCheckpointDetail,
  getCheckpointTranscript,
  explainCommit,
  findCheckpointByPrefix,
  type CheckpointDetail,
  type CheckpointListItem,
  type ExplainOptions,
  type CommitExplainResult,
} from './commands/explain.js';

export {
  discoverResumeInfo,
  listResumableBranches,
  type ResumeInfo,
  type ResumeOptions,
  type ResumeResult,
} from './commands/resume.js';

// =============================================================================
// Strategy Engine
// =============================================================================

export {
  createManualCommitStrategy,
  hasUserContent,
  stripCheckpointTrailer,
  type ManualCommitStrategyConfig,
} from './strategy/manual-commit.js';

export type { Strategy, OrphanedItem, OrphanedItemType } from './strategy/types.js';

export { STRATEGY_NAME_MANUAL_COMMIT, MAX_COMMIT_TRAVERSAL_DEPTH } from './strategy/types.js';

// =============================================================================
// Utilities
// =============================================================================

export {
  parseStrategy,
  parseMetadata,
  parseTaskMetadata,
  parseBaseCommit,
  parseCondensation,
  parseSession,
  parseCheckpoint as parseCheckpointTrailer,
  parseAllSessions,
  formatStrategy,
  formatMetadata,
  formatShadowCommit,
  formatShadowTaskCommit,
  formatCheckpoint as formatCheckpointTrailer,
  formatSourceRef,
  MetadataTrailerKey,
  StrategyTrailerKey,
  SessionTrailerKey,
  CheckpointTrailerKey,
  BaseCommitTrailerKey,
} from './utils/trailers.js';

export { stripIDEContextTags } from './utils/ide-tags.js';

export {
  truncateRunes,
  collapseWhitespace,
  capitalizeFirst,
  countLines,
} from './utils/string-utils.js';

export {
  parseFromBytes,
  parseFromBytesAtLine,
  sliceFromLine,
  extractUserContent,
  type TranscriptLine as ParsedTranscriptLine,
} from './utils/transcript-parse.js';

export { generateCommitMessage } from './utils/commit-message.js';

// =============================================================================
// Summarization
// =============================================================================

export {
  buildCondensedTranscriptFromBytes,
  buildCondensedTranscript,
  formatCondensedTranscript,
  buildSummarizationPrompt,
  extractJSONFromMarkdown,
  generateFromTranscript,
  type Entry as SummarizeEntry,
  type EntryType as SummarizeEntryType,
  type SummarizeInput,
  type SummaryGenerator,
} from './summarize/summarize.js';

// =============================================================================
// Attribution
// =============================================================================

export {
  diffLines,
  getAllChangedFiles,
  calculateAttributionWithAccumulated,
} from './strategy/attribution.js';

// =============================================================================
// Content Overlap
// =============================================================================

export {
  filesOverlapWithContent,
  stagedFilesOverlapWithContent,
  filesWithRemainingAgentChanges,
} from './strategy/content-overlap.js';

// =============================================================================
// Validation
// =============================================================================

export {
  validateSessionID,
  validateToolUseID,
  validateAgentID,
  validateAgentSessionID,
} from './utils/validation.js';

// =============================================================================
// Hook Manager Detection
// =============================================================================

export { detectHookManagers, hookManagerWarning, type HookManager } from './utils/hook-managers.js';

// =============================================================================
// Worktree Utilities
// =============================================================================

export { getWorktreeID } from './utils/worktree.js';

// =============================================================================
// Transcript Timestamps
// =============================================================================

export {
  parseTimestampFromJSONL,
  getLastTimestampFromBytes,
  getLastTimestampFromFile,
} from './utils/transcript-timestamp.js';

// =============================================================================
// Summary Generator (Claude CLI)
// =============================================================================

export {
  createClaudeGenerator,
  DEFAULT_SUMMARIZE_MODEL,
  type ClaudeGeneratorOptions,
} from './summarize/claude-generator.js';

// =============================================================================
// Session State Machine
// =============================================================================

export {
  transition,
  applyTransition,
  phaseFromString,
  eventToString,
  actionToString,
  isStale,
  normalizeAfterLoad,
  mermaidDiagram,
  NoOpActionHandler,
  STALE_SESSION_THRESHOLD_MS,
  StateMachineEvent,
  Action,
} from './session/state-machine.js';

export type {
  Phase,
  TransitionContext,
  TransitionResult,
  ActionHandler,
  StateMachineState,
} from './session/state-machine.js';

// =============================================================================
// Todo Extraction
// =============================================================================

export {
  extractLastCompletedTodo,
  extractInProgressTodo,
  countTodos,
  extractTodoContentFromToolInput,
  extractLastCompletedTodoFromToolInput,
  countTodosFromToolInput,
  formatIncrementalMessage,
} from './utils/todo-extract.js';

// =============================================================================
// Rewind Conflict Detection
// =============================================================================

export {
  classifyTimestamps,
  statusToText,
  hasConflicts,
  partitionConflicts,
  resolveAgentForRewind,
} from './utils/rewind-conflict.js';

export type { SessionRestoreInfo as RewindSessionRestoreInfo } from './utils/rewind-conflict.js';

// =============================================================================
// Chunk File Naming
// =============================================================================

export { chunkFileName, parseChunkIndex, sortChunkFiles } from './utils/chunk-files.js';

// =============================================================================
// Path Classification
// =============================================================================

export {
  isInfrastructurePath,
  toRelativePath,
  absPath,
  extractSessionIDFromPath,
  sessionMetadataDir,
} from './utils/paths.js';

// =============================================================================
// Agent Type Detection
// =============================================================================

export { detectAgentTypeFromContent } from './utils/detect-agent.js';

// =============================================================================
// TTY Interaction
// =============================================================================

export { hasTTY, askConfirmTTY } from './utils/tty.js';

// =============================================================================
// Shadow Branch Utilities
// =============================================================================

export {
  hashWorktreeID,
  shadowBranchNameForCommit,
  parseShadowBranchName,
  isShadowBranch,
  listShadowBranches,
  deleteShadowBranches,
} from './utils/shadow-branch.js';

// =============================================================================
// Rewind Preview
// =============================================================================

export {
  previewRewind,
  type RewindPreview as RewindPreviewResult,
} from './utils/preview-rewind.js';

// =============================================================================
// Normalized Agent Session
// =============================================================================

export { createAgentSession, EntryType } from './agent/session-types.js';

export type { AgentSession, SessionEntry } from './agent/session-types.js';

// =============================================================================
// Strategy Infrastructure
// =============================================================================

export {
  validateRepository,
  isEmptyRepository,
  isAncestorOf,
  isInsideWorktree,
  ensureMetadataBranch,
  readCheckpointMetadata,
  readSessionPromptFromTree,
  readAgentTypeFromTree,
  extractFirstPrompt,
  ensureSetup,
  getMainRepoRoot,
} from './strategy/common.js';

// =============================================================================
// Git Tree Manipulation
// =============================================================================

export { updateSubtree, applyTreeChanges, createTreeFromMap, MergeMode } from './utils/tree-ops.js';

export type { TreeEntry, TreeChange } from './utils/tree-ops.js';
