/**
 * Lifecycle Management
 *
 * Dispatches normalized agent events through the session state machine.
 * This is the orchestration layer between agent hooks and checkpoint operations.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
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

        // Merge new files into filesTouched
        const fileSet = new Set(state.filesTouched);
        for (const file of files) fileSet.add(file);
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
      const tracked: TrackedSkill = {
        name: event.skillName,
        args: event.skillArgs,
        usedAt: new Date().toISOString(),
      };

      // Attempt to resolve version/provenance info
      if (cwd) {
        try {
          const resolved = await skillResolverChain.resolve({
            skillName: event.skillName,
            cwd,
          });
          if (resolved) {
            tracked.sourceType = resolved.sourceType;
            tracked.filePath = resolved.filePath;
            tracked.version = resolved.version;
            tracked.commitSha = resolved.commitSha;
            if (resolved.plugin) {
              tracked.pluginPackage = resolved.plugin.packageName;
            }
            if (resolved.upstream) {
              tracked.upstreamVersion = resolved.upstream.version;
            }
          }
        } catch {
          // Version resolution is best-effort — don't block skill tracking
        }
      }

      state.skillsUsed.push(tracked);
    }

    state.lastInteractionTime = new Date().toISOString();
    await sessionStore.save(state);
  }
}
