/**
 * Runlog Provider Types
 *
 * These types define the public interface for accessing Runlog session
 * and checkpoint data. They are the contract between the Runlog module
 * and external consumers (providers, daemon, etc.).
 *
 * This file is the canonical source of truth — external code should
 * import these types from the runlog package rather than redefining them.
 */

// ============================================================================
// Session
// ============================================================================

/**
 * Runlog session state (from .git/runlog-sessions/<id>.json)
 */
export interface RunlogSession {
  id: string;
  agent: string;
  phase: 'ACTIVE' | 'IDLE' | 'ENDED';
  baseCommit?: string;
  branch?: string;
  startedAt?: string;
  endedAt?: string;
  checkpoints?: string[];
  tokenUsage?: RunlogTokenUsage;
  filesTouched?: string[];
  summary?: string;

  /** Skills used during this session (populated by SkillTracker) */
  skillsUsed?: RunlogSkillUsage;
}

/**
 * Skill usage data embedded in session metadata
 */
export interface RunlogSkillUsage {
  /** Distinct skill names used */
  skills: string[];

  /** Total invocation count across all skills */
  totalInvocations: number;

  /** Per-skill invocation counts */
  counts: Record<string, number>;

  /** Per-skill success/failure counts */
  outcomes: Record<string, { success: number; failure: number }>;
}

// ============================================================================
// Checkpoint
// ============================================================================

/**
 * Runlog checkpoint metadata
 */
export interface RunlogCheckpoint {
  id: string;
  sessionId?: string;
  commitHash?: string;
  commitMessage?: string;
  promptCount?: number;
  filesModified?: string[];
  filesNew?: string[];
  filesDeleted?: string[];
  tokenUsage?: RunlogTokenUsage;
  context?: string;
}

// ============================================================================
// Token Usage
// ============================================================================

/**
 * Token usage statistics (provider-facing, simplified)
 */
export interface RunlogTokenUsage {
  input?: number;
  output?: number;
  cache?: number;
}

// ============================================================================
// Store Interface
// ============================================================================

/**
 * Interface for accessing Runlog data (CLI or direct reads)
 */
export interface RunlogStore {
  getSession(id: string): Promise<RunlogSession | null>;
  listSessions(): Promise<RunlogSession[]>;
  getCheckpoint(id: string): Promise<RunlogCheckpoint | null>;
  listCheckpoints(): Promise<RunlogCheckpoint[]>;
  search(query: string): Promise<Array<RunlogSession | RunlogCheckpoint>>;
}
