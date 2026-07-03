/**
 * Lifecycle Management
 *
 * Dispatches normalized agent events through the session state machine.
 * This is the orchestration layer between agent hooks and checkpoint operations.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fsSync from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Event, SessionState, TrackedSkill } from '../types.js';
import { EventType, addTokenUsage } from '../types.js';
import type { SessionStore } from '../store/session-store.js';
import type { CheckpointStore } from '../store/checkpoint-store.js';
import type { Agent } from '../agent/types.js';
import { hasTranscriptAnalyzer, hasTokenCalculator } from '../agent/types.js';
import { getHead, getCurrentBranch, getUntrackedFiles, getGitAuthor } from '../git-operations.js';
import { normalizeStoredPath } from '../utils/paths.js';
import {
  createSkillVersionResolverChain,
  type SkillVersionResolverChain,
  type SkillVersionResolverChainOptions,
} from './skill-version-resolver.js';
import { enrichTrackedSkill, mergeSkillsSurfaced } from './skill-tracking.js';

// ============================================================================
// Types
// ============================================================================

export interface LifecycleConfig {
  sessionStore: SessionStore;
  checkpointStore: CheckpointStore;
  cwd?: string;
  /** Options for the skill version resolver chain */
  skillResolverOptions?: SkillVersionResolverChainOptions;
}

export interface LifecycleHandler {
  /** Dispatch an event through the lifecycle state machine */
  dispatch(agent: Agent, event: Event): Promise<void>;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Convert an absolute file path to a repo-relative one. Resolves symlinks on
 * both sides (macOS `/tmp` → `/private/tmp`) so prefix matching is reliable.
 * Falls back to the original path when it lies outside the repo.
 */
function normalizeToRepoRelative(absFile: string, repoRoot: string): string {
  let realRoot = repoRoot;
  let realFile = absFile;
  try {
    realRoot = fsSync.realpathSync(repoRoot);
  } catch {
    // keep as-is
  }
  try {
    realFile = fsSync.realpathSync(absFile);
  } catch {
    // file may not exist anymore — normalize the parent instead
    const dir = path.dirname(absFile);
    try {
      realFile = path.join(fsSync.realpathSync(dir), path.basename(absFile));
    } catch {
      // keep as-is
    }
  }
  const rel = path.relative(realRoot, realFile);
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) return absFile;
  return rel;
}

export function createLifecycleHandler(config: LifecycleConfig): LifecycleHandler {
  const { sessionStore, cwd } = config;
  const skillResolverChain: SkillVersionResolverChain = createSkillVersionResolverChain(
    config.skillResolverOptions,
  );

  return {
    async dispatch(agent: Agent, event: Event): Promise<void> {
      switch (event.type) {
        case EventType.SessionStart:
          await handleSessionStart(agent, event);
          break;
        case EventType.TurnStart:
          await handleTurnStart(agent, event);
          break;
        case EventType.TurnEnd:
          await handleTurnEnd(agent, event);
          break;
        case EventType.SessionEnd:
          await handleSessionEnd(agent, event);
          break;
        case EventType.Compaction:
          await handleCompaction(agent, event);
          break;
        case EventType.SubagentStart:
          await handleSubagentStart(agent, event);
          break;
        case EventType.SubagentEnd:
          await handleSubagentEnd(agent, event);
          break;
        case EventType.TaskCreate:
          await handleTaskCreate(agent, event);
          break;
        case EventType.TaskUpdate:
          await handleTaskUpdate(agent, event);
          break;
        case EventType.PlanModeEnter:
          await handlePlanModeEnter(agent, event);
          break;
        case EventType.PlanModeExit:
          await handlePlanModeExit(agent, event);
          break;
        case EventType.SkillUse:
          await handleSkillUse(agent, event);
          break;
        case EventType.SkillsSurfaced:
          await handleSkillsSurfaced(agent, event);
          break;
      }
    },
  };

  async function handleSessionStart(agent: Agent, event: Event): Promise<void> {
    // Check if session already exists
    const existing = await sessionStore.load(event.sessionID);
    if (existing && existing.phase !== 'ended') {
      // Session already active, update interaction time
      existing.lastInteractionTime = new Date().toISOString();
      await sessionStore.save(existing);
      return;
    }

    // Create new session state
    const head = await getHead(cwd);
    const _branch = await getCurrentBranch(cwd);
    const untrackedFiles = await getUntrackedFiles(cwd);

    const state: SessionState = {
      sessionID: event.sessionID,
      baseCommit: head,
      attributionBaseCommit: head,
      startedAt: new Date().toISOString(),
      phase: 'idle',
      turnCheckpointIDs: [],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: untrackedFiles,
      filesTouched: [],
      agentType: agent.type,
      transcriptPath: event.sessionRef,
      worktreePath: cwd,
    };

    await sessionStore.save(state);
  }

  async function handleTurnStart(agent: Agent, event: Event): Promise<void> {
    let state = await sessionStore.load(event.sessionID);

    if (!state) {
      // Auto-create session on first turn
      await handleSessionStart(agent, {
        ...event,
        type: EventType.SessionStart,
      });
      state = await sessionStore.load(event.sessionID);
      if (!state) return;
    }

    // Generate a new turn ID
    state.turnID = crypto.randomUUID().slice(0, 8);
    state.phase = 'active';
    state.lastInteractionTime = new Date().toISOString();
    state.transcriptPath = event.sessionRef;

    if (event.prompt && !state.firstPrompt) {
      state.firstPrompt = event.prompt.slice(0, 500);
    }

    // Capture pre-prompt transcript position
    if (hasTranscriptAnalyzer(agent) && event.sessionRef) {
      try {
        state.checkpointTranscriptStart = await agent.getTranscriptPosition(event.sessionRef);
        state.transcriptIdentifierAtStart = event.sessionRef;
      } catch {
        // Ignore transcript position errors
      }
    }

    await sessionStore.save(state);
  }

  async function handleTurnEnd(agent: Agent, event: Event): Promise<void> {
    const state = await sessionStore.load(event.sessionID);
    if (!state) return;

    state.lastInteractionTime = new Date().toISOString();

    // Extract modified files from transcript
    if (hasTranscriptAnalyzer(agent) && state.transcriptPath) {
      try {
        const { files } = await agent.extractModifiedFilesFromOffset(
          state.transcriptPath,
          state.checkpointTranscriptStart,
        );

        // Merge new files into filesTouched. Normalize to repo-relative paths:
        // adapters that pull paths from tool inputs (e.g. openswarm lane
        // events) often carry absolute paths, but the commit-hook overlap
        // checks (prepareCommitMsg/postCommit) compare against `git diff
        // --name-only` output, which is repo-relative — absolute entries
        // would never match and the session would silently fail to condense.
        const repoRoot = path.resolve(cwd ?? process.cwd());
        const fileSet = new Set(state.filesTouched);
        for (const file of files) {
          fileSet.add(path.isAbsolute(file) ? normalizeToRepoRelative(file, repoRoot) : file);
        }
        state.filesTouched = Array.from(fileSet);
      } catch {
        // Ignore extraction errors
      }
    }

    // Create shadow branch checkpoint so prepareCommitMsg can detect overlap
    if (state.filesTouched.length > 0) {
      try {
        const { name: authorName, email: authorEmail } = await getGitAuthor(cwd);
        // Use flat name (no slashes) — mergeMetadataIntoTree can't handle nested paths
        const metadataDir = `sessionlog-${state.sessionID}`;
        const metadataDirAbs = path.resolve(cwd ?? '.', metadataDir);

        const result = await config.checkpointStore.writeTemporary({
          sessionID: state.sessionID,
          baseCommit: state.baseCommit,
          worktreeID: state.worktreeID,
          modifiedFiles: state.filesTouched,
          newFiles: [],
          deletedFiles: [],
          metadataDir,
          metadataDirAbs,
          commitMessage: `Checkpoint: ${state.filesTouched.length} file(s)\n\nSession: ${state.sessionID}`,
          authorName,
          authorEmail,
          isFirstCheckpoint: state.stepCount === 0,
        });

        if (!result.skipped) {
          state.stepCount++;
        }
      } catch (err) {
        // Non-fatal: shadow branch creation failure shouldn't break lifecycle

        if (process.env.SESSIONLOG_DEBUG) console.error('[sessionlog] shadow branch error:', err);
      }
    }

    // Calculate token usage
    if (hasTokenCalculator(agent) && state.transcriptPath) {
      try {
        const transcript = await agent.readTranscript(state.transcriptPath);
        const usage = await agent.calculateTokenUsage(transcript, state.checkpointTranscriptStart);
        state.tokenUsage = state.tokenUsage ? addTokenUsage(state.tokenUsage, usage) : usage;
      } catch {
        // Ignore token calculation errors
      }
    }

    // Transition to idle
    state.phase = 'idle';
    await sessionStore.save(state);
  }

  async function handleSessionEnd(agent: Agent, event: Event): Promise<void> {
    const state = await sessionStore.load(event.sessionID);
    if (!state) return;

    state.phase = 'ended';
    state.endedAt = new Date().toISOString();
    state.lastInteractionTime = new Date().toISOString();

    await sessionStore.save(state);
  }

  async function handleCompaction(agent: Agent, event: Event): Promise<void> {
    const state = await sessionStore.load(event.sessionID);
    if (!state) return;

    // Update transcript offset for next checkpoint
    if (hasTranscriptAnalyzer(agent) && state.transcriptPath) {
      try {
        state.checkpointTranscriptStart = await agent.getTranscriptPosition(state.transcriptPath);
      } catch {
        // Ignore
      }
    }

    state.lastInteractionTime = new Date().toISOString();
    await sessionStore.save(state);
  }

  async function handleSubagentStart(_agent: Agent, event: Event): Promise<void> {
    const state = await sessionStore.load(event.sessionID);
    if (!state) return;

    state.lastInteractionTime = new Date().toISOString();
    await sessionStore.save(state);
  }

  async function handleSubagentEnd(_agent: Agent, event: Event): Promise<void> {
    const state = await sessionStore.load(event.sessionID);
    if (!state) return;

    state.lastInteractionTime = new Date().toISOString();
    await sessionStore.save(state);
  }

  async function handleTaskCreate(_agent: Agent, event: Event): Promise<void> {
    const state = await sessionStore.load(event.sessionID);
    if (!state) return;

    if (!state.tasks) state.tasks = {};

    const taskID = event.taskID || event.toolUseID || '';
    if (taskID) {
      state.tasks[taskID] = {
        id: taskID,
        subject: event.taskSubject ?? '',
        description: event.taskDescription,
        status: 'pending',
        activeForm: event.taskActiveForm,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    state.lastInteractionTime = new Date().toISOString();
    await sessionStore.save(state);
  }

  async function handleTaskUpdate(_agent: Agent, event: Event): Promise<void> {
    const state = await sessionStore.load(event.sessionID);
    if (!state) return;

    if (!state.tasks) state.tasks = {};

    const taskID = event.taskID ?? '';
    if (taskID) {
      if (state.tasks[taskID]) {
        if (event.taskStatus) state.tasks[taskID].status = event.taskStatus;
        if (event.taskSubject) state.tasks[taskID].subject = event.taskSubject;
        if (event.taskDescription) state.tasks[taskID].description = event.taskDescription;
        state.tasks[taskID].updatedAt = new Date().toISOString();
      } else {
        // Task not previously tracked
        state.tasks[taskID] = {
          id: taskID,
          subject: event.taskSubject ?? '',
          description: event.taskDescription,
          status: event.taskStatus ?? 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
    }

    state.lastInteractionTime = new Date().toISOString();
    await sessionStore.save(state);
  }

  async function handlePlanModeEnter(_agent: Agent, event: Event): Promise<void> {
    const state = await sessionStore.load(event.sessionID);
    if (!state) return;

    state.inPlanMode = true;
    state.planModeEntries = (state.planModeEntries ?? 0) + 1;

    // Push a new plan entry (will be completed on exit)
    if (!state.planEntries) state.planEntries = [];
    state.planEntries.push({
      enteredAt: new Date().toISOString(),
    });

    state.lastInteractionTime = new Date().toISOString();
    await sessionStore.save(state);
  }

  async function handlePlanModeExit(_agent: Agent, event: Event): Promise<void> {
    const state = await sessionStore.load(event.sessionID);
    if (!state) return;

    state.inPlanMode = false;

    // Complete the last plan entry
    const lastEntry = (state.planEntries ?? []).at(-1);
    if (lastEntry && !lastEntry.exitedAt) {
      lastEntry.exitedAt = new Date().toISOString();

      if (event.planFilePath) {
        lastEntry.filePath = cwd
          ? normalizeStoredPath(event.planFilePath, cwd)
          : event.planFilePath;
        try {
          // Always read from the original absolute path
          const content = await readFile(event.planFilePath, 'utf-8');
          lastEntry.content = content;
        } catch {
          // File may have been cleaned up already — store path only
        }
      }

      if (event.planAllowedPrompts) {
        lastEntry.allowedPrompts = event.planAllowedPrompts;
      }
    }

    state.lastInteractionTime = new Date().toISOString();
    await sessionStore.save(state);
  }

  async function handleSkillUse(_agent: Agent, event: Event): Promise<void> {
    const state = await sessionStore.load(event.sessionID);
    if (!state) return;

    if (!state.skillsUsed) state.skillsUsed = [];

    if (event.skillName) {
      const tracked = await enrichTrackedSkill(
        event.skillName,
        skillResolverChain,
        { skillName: event.skillName, cwd: cwd ?? process.cwd() },
        {
          args: event.skillArgs,
          usedAt: new Date().toISOString(),
        },
      );

      state.skillsUsed.push(tracked);
    }

    state.lastInteractionTime = new Date().toISOString();
    await sessionStore.save(state);
  }

  async function handleSkillsSurfaced(_agent: Agent, event: Event): Promise<void> {
    const state = await sessionStore.load(event.sessionID);
    if (!state) return;

    const surfacedAt = new Date().toISOString();
    const resolveCtx = { skillName: '', cwd: cwd ?? process.cwd() };
    const incoming: TrackedSkill[] = [];

    if (event.skillsSurfaced?.length) {
      for (const skill of event.skillsSurfaced) {
        if (!skill.name) continue;
        incoming.push({
          ...skill,
          surfacedAt: skill.surfacedAt ?? surfacedAt,
        });
      }
    }

    if (event.surfacedSkillNames?.length) {
      for (const name of event.surfacedSkillNames) {
        if (!name.trim()) continue;
        incoming.push(
          await enrichTrackedSkill(
            name.trim(),
            skillResolverChain,
            {
              ...resolveCtx,
              skillName: name.trim(),
            },
            { surfacedAt },
          ),
        );
      }
    }

    if (incoming.length === 0) return;

    state.skillsSurfaced = mergeSkillsSurfaced(state.skillsSurfaced, incoming);
    state.lastInteractionTime = surfacedAt;
    await sessionStore.save(state);
  }
}
