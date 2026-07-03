/**
 * Tests for Lifecycle Handlers — task and plan mode events
 */

import { describe, it, expect } from 'vitest';
import { createLifecycleHandler } from '../hooks/lifecycle.js';
import { createClaudeCodeAgent } from '../agent/agents/claude-code.js';
import { EventType, type SessionState, type Event } from '../types.js';
import type { SessionStore } from '../store/session-store.js';
import type { CheckpointStore } from '../store/checkpoint-store.js';

// In-memory session store for testing
function createMockSessionStore(
  initial?: SessionState,
): SessionStore & { states: Map<string, SessionState> } {
  const states = new Map<string, SessionState>();
  if (initial) states.set(initial.sessionID, initial);

  return {
    states,
    async load(sessionID: string) {
      return states.get(sessionID) ?? null;
    },
    async list() {
      return Array.from(states.values());
    },
    async save(state: SessionState) {
      states.set(state.sessionID, { ...state });
    },
    async delete(sessionID: string) {
      states.delete(sessionID);
    },
    async getDir() {
      return '/tmp/test-sessions';
    },
    async exists(sessionID: string) {
      return states.has(sessionID);
    },
  };
}

function createMockCheckpointStore(): CheckpointStore {
  return {
    async generateID() {
      return 'abcdef123456';
    },
    async writeTemporary() {
      return { commitHash: 'abc', skipped: false };
    },
    async readTemporary() {
      return null;
    },
    async listTemporary() {
      return [];
    },
    async writeCommitted() {},
    async readCommitted() {
      return null;
    },
    async readSessionContent() {
      return null;
    },
    async listCommitted() {
      return [];
    },
    async deleteShadowBranch() {},
    getShadowBranchName() {
      return 'sessionlog/abc1234';
    },
  };
}

function baseSessionState(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionID: 'test-session',
    baseCommit: 'abc123',
    startedAt: '2026-02-13T12:00:00Z',
    phase: 'active',
    turnCheckpointIDs: [],
    stepCount: 0,
    checkpointTranscriptStart: 0,
    untrackedFilesAtStart: [],
    filesTouched: [],
    agentType: 'Claude Code',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<Event> & { type: EventType }): Event {
  return {
    sessionID: 'test-session',
    sessionRef: '/path/to/transcript.jsonl',
    timestamp: new Date(),
    ...overrides,
  };
}

describe('Lifecycle Handlers — Task & Plan Mode', () => {
  const agent = createClaudeCodeAgent();

  describe('TaskCreate', () => {
    it('should create a task in session state', async () => {
      const store = createMockSessionStore(baseSessionState());
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.TaskCreate,
          taskID: '1',
          taskSubject: 'Fix authentication bug',
          taskActiveForm: 'Fixing authentication bug',
        }),
      );

      const state = await store.load('test-session');
      expect(state!.tasks).toBeDefined();
      expect(state!.tasks!['1']).toBeDefined();
      expect(state!.tasks!['1'].subject).toBe('Fix authentication bug');
      expect(state!.tasks!['1'].status).toBe('pending');
      expect(state!.tasks!['1'].activeForm).toBe('Fixing authentication bug');
    });

    it('should use toolUseID as fallback when taskID is empty', async () => {
      const store = createMockSessionStore(baseSessionState());
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.TaskCreate,
          taskID: '',
          toolUseID: 'tu-fallback',
          taskSubject: 'Add tests',
        }),
      );

      const state = await store.load('test-session');
      expect(state!.tasks!['tu-fallback']).toBeDefined();
      expect(state!.tasks!['tu-fallback'].subject).toBe('Add tests');
    });

    it('should no-op when session not found', async () => {
      const store = createMockSessionStore();
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.TaskCreate,
          sessionID: 'nonexistent',
          taskID: '1',
          taskSubject: 'Test',
        }),
      );

      expect(store.states.size).toBe(0);
    });

    it('should accumulate multiple tasks', async () => {
      const store = createMockSessionStore(baseSessionState());
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.TaskCreate,
          taskID: '1',
          taskSubject: 'First task',
        }),
      );

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.TaskCreate,
          taskID: '2',
          taskSubject: 'Second task',
        }),
      );

      const state = await store.load('test-session');
      expect(Object.keys(state!.tasks!)).toHaveLength(2);
      expect(state!.tasks!['1'].subject).toBe('First task');
      expect(state!.tasks!['2'].subject).toBe('Second task');
    });

    it('should store task description when provided', async () => {
      const store = createMockSessionStore(baseSessionState());
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.TaskCreate,
          taskID: '1',
          taskSubject: 'Fix auth bug',
          taskDescription: 'The login form fails when passwords contain special characters',
        }),
      );

      const state = await store.load('test-session');
      expect(state!.tasks!['1'].description).toBe(
        'The login form fails when passwords contain special characters',
      );
    });

    it('should handle missing description gracefully', async () => {
      const store = createMockSessionStore(baseSessionState());
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.TaskCreate,
          taskID: '1',
          taskSubject: 'No description task',
        }),
      );

      const state = await store.load('test-session');
      expect(state!.tasks!['1'].description).toBeUndefined();
    });
  });

  describe('TaskUpdate', () => {
    it('should update existing task status', async () => {
      const store = createMockSessionStore(
        baseSessionState({
          tasks: {
            '1': {
              id: '1',
              subject: 'Fix bug',
              status: 'pending',
              createdAt: '2026-02-13T12:00:00Z',
              updatedAt: '2026-02-13T12:00:00Z',
            },
          },
        }),
      );
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.TaskUpdate,
          taskID: '1',
          taskStatus: 'completed',
        }),
      );

      const state = await store.load('test-session');
      expect(state!.tasks!['1'].status).toBe('completed');
    });

    it('should update task subject when provided', async () => {
      const store = createMockSessionStore(
        baseSessionState({
          tasks: {
            '1': {
              id: '1',
              subject: 'Old subject',
              status: 'pending',
              createdAt: '2026-02-13T12:00:00Z',
              updatedAt: '2026-02-13T12:00:00Z',
            },
          },
        }),
      );
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.TaskUpdate,
          taskID: '1',
          taskSubject: 'New subject',
        }),
      );

      const state = await store.load('test-session');
      expect(state!.tasks!['1'].subject).toBe('New subject');
      expect(state!.tasks!['1'].status).toBe('pending'); // unchanged
    });

    it('should create task entry if not previously tracked', async () => {
      const store = createMockSessionStore(baseSessionState());
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.TaskUpdate,
          taskID: '99',
          taskStatus: 'in_progress',
          taskSubject: 'Previously unknown task',
        }),
      );

      const state = await store.load('test-session');
      expect(state!.tasks!['99']).toBeDefined();
      expect(state!.tasks!['99'].status).toBe('in_progress');
      expect(state!.tasks!['99'].subject).toBe('Previously unknown task');
    });

    it('should no-op when session not found', async () => {
      const store = createMockSessionStore();
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.TaskUpdate,
          sessionID: 'nonexistent',
          taskID: '1',
          taskStatus: 'completed',
        }),
      );

      expect(store.states.size).toBe(0);
    });

    it('should update task description when provided', async () => {
      const store = createMockSessionStore(
        baseSessionState({
          tasks: {
            '1': {
              id: '1',
              subject: 'Fix bug',
              status: 'pending',
              createdAt: '2026-02-13T12:00:00Z',
              updatedAt: '2026-02-13T12:00:00Z',
            },
          },
        }),
      );
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.TaskUpdate,
          taskID: '1',
          taskDescription: 'Updated description with more details',
        }),
      );

      const state = await store.load('test-session');
      expect(state!.tasks!['1'].description).toBe('Updated description with more details');
    });

    it('should store description for previously unknown tasks', async () => {
      const store = createMockSessionStore(baseSessionState());
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.TaskUpdate,
          taskID: '99',
          taskStatus: 'in_progress',
          taskDescription: 'New task with description',
        }),
      );

      const state = await store.load('test-session');
      expect(state!.tasks!['99'].description).toBe('New task with description');
    });
  });

  describe('PlanModeEnter', () => {
    it('should set inPlanMode, increment counter, and push plan entry', async () => {
      const store = createMockSessionStore(baseSessionState());
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.PlanModeEnter,
        }),
      );

      const state = await store.load('test-session');
      expect(state!.inPlanMode).toBe(true);
      expect(state!.planModeEntries).toBe(1);
      expect(state!.planEntries).toHaveLength(1);
      expect(state!.planEntries![0].enteredAt).toBeDefined();
      expect(state!.planEntries![0].exitedAt).toBeUndefined();
    });

    it('should increment counter and append entry on repeated enters', async () => {
      const store = createMockSessionStore(
        baseSessionState({
          planModeEntries: 2,
          planEntries: [
            { enteredAt: '2026-01-01T00:00:00Z', exitedAt: '2026-01-01T00:05:00Z' },
            { enteredAt: '2026-01-01T01:00:00Z', exitedAt: '2026-01-01T01:05:00Z' },
          ],
        }),
      );
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.PlanModeEnter,
        }),
      );

      const state = await store.load('test-session');
      expect(state!.planModeEntries).toBe(3);
      expect(state!.planEntries).toHaveLength(3);
      expect(state!.planEntries![2].exitedAt).toBeUndefined();
    });

    it('should no-op when session not found', async () => {
      const store = createMockSessionStore();
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.PlanModeEnter,
          sessionID: 'nonexistent',
        }),
      );

      expect(store.states.size).toBe(0);
    });
  });

  describe('PlanModeExit', () => {
    it('should clear inPlanMode and complete last plan entry', async () => {
      const store = createMockSessionStore(
        baseSessionState({
          inPlanMode: true,
          planModeEntries: 1,
          planEntries: [{ enteredAt: '2026-01-01T00:00:00Z' }],
        }),
      );
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.PlanModeExit,
        }),
      );

      const state = await store.load('test-session');
      expect(state!.inPlanMode).toBe(false);
      expect(state!.planModeEntries).toBe(1);
      expect(state!.planEntries).toHaveLength(1);
      expect(state!.planEntries![0].exitedAt).toBeDefined();
    });

    it('should no-op when session not found', async () => {
      const store = createMockSessionStore();
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.PlanModeExit,
          sessionID: 'nonexistent',
        }),
      );

      expect(store.states.size).toBe(0);
    });

    it('should store plan file path and content in plan entry', async () => {
      const fs = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');
      const tmpDir = await fs.mkdtemp(path.join(os.default.tmpdir(), 'sessionlog-test-'));
      const planPath = path.join(tmpDir, 'test-plan.md');
      await fs.writeFile(planPath, '# My Plan\n\nStep 1: Do the thing\nStep 2: Verify');

      try {
        const store = createMockSessionStore(
          baseSessionState({
            inPlanMode: true,
            planModeEntries: 1,
            planEntries: [{ enteredAt: '2026-01-01T00:00:00Z' }],
          }),
        );
        const handler = createLifecycleHandler({
          sessionStore: store,
          checkpointStore: createMockCheckpointStore(),
        });

        await handler.dispatch(
          agent,
          makeEvent({
            type: EventType.PlanModeExit,
            planFilePath: planPath,
          }),
        );

        const state = await store.load('test-session');
        expect(state!.inPlanMode).toBe(false);
        expect(state!.planEntries).toHaveLength(1);
        expect(state!.planEntries![0].filePath).toBe(planPath);
        expect(state!.planEntries![0].content).toBe(
          '# My Plan\n\nStep 1: Do the thing\nStep 2: Verify',
        );
        expect(state!.planEntries![0].exitedAt).toBeDefined();
      } finally {
        await fs.rm(tmpDir, { recursive: true });
      }
    });

    it('should store path but not content when plan file is missing', async () => {
      const store = createMockSessionStore(
        baseSessionState({
          inPlanMode: true,
          planModeEntries: 1,
          planEntries: [{ enteredAt: '2026-01-01T00:00:00Z' }],
        }),
      );
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.PlanModeExit,
          planFilePath: '/nonexistent/path/to/plan.md',
        }),
      );

      const state = await store.load('test-session');
      expect(state!.inPlanMode).toBe(false);
      expect(state!.planEntries![0].filePath).toBe('/nonexistent/path/to/plan.md');
      expect(state!.planEntries![0].content).toBeUndefined();
    });

    it('should leave plan entry unchanged when no planFilePath provided', async () => {
      const store = createMockSessionStore(
        baseSessionState({
          inPlanMode: true,
          planModeEntries: 1,
          planEntries: [{ enteredAt: '2026-01-01T00:00:00Z' }],
        }),
      );
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.PlanModeExit,
        }),
      );

      const state = await store.load('test-session');
      expect(state!.planEntries![0].filePath).toBeUndefined();
      expect(state!.planEntries![0].content).toBeUndefined();
      expect(state!.planEntries![0].exitedAt).toBeDefined();
    });

    it('should store allowedPrompts in plan entry on exit', async () => {
      const store = createMockSessionStore(
        baseSessionState({
          inPlanMode: true,
          planModeEntries: 1,
          planEntries: [{ enteredAt: '2026-01-01T00:00:00Z' }],
        }),
      );
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      await handler.dispatch(
        agent,
        makeEvent({
          type: EventType.PlanModeExit,
          planAllowedPrompts: [
            { tool: 'Bash', prompt: 'run tests' },
            { tool: 'Bash', prompt: 'install dependencies' },
          ],
        }),
      );

      const state = await store.load('test-session');
      expect(state!.planEntries![0].allowedPrompts).toEqual([
        { tool: 'Bash', prompt: 'run tests' },
        { tool: 'Bash', prompt: 'install dependencies' },
      ]);
    });

    it('should normalize plan file path relative to CWD when inside project', async () => {
      const fs = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');
      const tmpDir = await fs.mkdtemp(path.join(os.default.tmpdir(), 'sessionlog-test-'));
      const planDir = path.join(tmpDir, '.claude', 'plans');
      await fs.mkdir(planDir, { recursive: true });
      const planPath = path.join(planDir, 'my-plan.md');
      await fs.writeFile(planPath, '# Plan');

      try {
        const store = createMockSessionStore(
          baseSessionState({
            inPlanMode: true,
            planModeEntries: 1,
            planEntries: [{ enteredAt: '2026-01-01T00:00:00Z' }],
          }),
        );
        // Pass cwd so path normalization kicks in
        const handler = createLifecycleHandler({
          sessionStore: store,
          checkpointStore: createMockCheckpointStore(),
          cwd: tmpDir,
        });

        await handler.dispatch(
          agent,
          makeEvent({
            type: EventType.PlanModeExit,
            planFilePath: planPath,
          }),
        );

        const state = await store.load('test-session');
        // Path should be relative to CWD
        expect(state!.planEntries![0].filePath).toBe(path.join('.claude', 'plans', 'my-plan.md'));
        // Content should still be read from the absolute path
        expect(state!.planEntries![0].content).toBe('# Plan');
      } finally {
        await fs.rm(tmpDir, { recursive: true });
      }
    });

    it('should keep plan file path absolute when outside CWD', async () => {
      const fs = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');
      // Create two separate temp dirs: one as CWD, one for the plan file
      const projectDir = await fs.mkdtemp(path.join(os.default.tmpdir(), 'sessionlog-proj-'));
      const planDir = await fs.mkdtemp(path.join(os.default.tmpdir(), 'sessionlog-plans-'));
      const planPath = path.join(planDir, 'plan.md');
      await fs.writeFile(planPath, '# Outside Plan');

      try {
        const store = createMockSessionStore(
          baseSessionState({
            inPlanMode: true,
            planModeEntries: 1,
            planEntries: [{ enteredAt: '2026-01-01T00:00:00Z' }],
          }),
        );
        const handler = createLifecycleHandler({
          sessionStore: store,
          checkpointStore: createMockCheckpointStore(),
          cwd: projectDir,
        });

        await handler.dispatch(
          agent,
          makeEvent({
            type: EventType.PlanModeExit,
            planFilePath: planPath,
          }),
        );

        const state = await store.load('test-session');
        // Path should stay absolute since it's outside CWD
        expect(state!.planEntries![0].filePath).toBe(planPath);
        expect(state!.planEntries![0].content).toBe('# Outside Plan');
      } finally {
        await fs.rm(projectDir, { recursive: true });
        await fs.rm(planDir, { recursive: true });
      }
    });

    it('should accumulate multiple plan entries across enter/exit cycles', async () => {
      const store = createMockSessionStore(baseSessionState());
      const handler = createLifecycleHandler({
        sessionStore: store,
        checkpointStore: createMockCheckpointStore(),
      });

      // Cycle 1
      await handler.dispatch(agent, makeEvent({ type: EventType.PlanModeEnter }));
      await handler.dispatch(agent, makeEvent({ type: EventType.PlanModeExit }));

      // Cycle 2
      await handler.dispatch(agent, makeEvent({ type: EventType.PlanModeEnter }));
      await handler.dispatch(agent, makeEvent({ type: EventType.PlanModeExit }));

      const state = await store.load('test-session');
      expect(state!.planModeEntries).toBe(2);
      expect(state!.planEntries).toHaveLength(2);
      expect(state!.planEntries![0].exitedAt).toBeDefined();
      expect(state!.planEntries![1].exitedAt).toBeDefined();
      // Both entries have valid timestamps (may be same ms in fast tests)
      expect(state!.planEntries![0].enteredAt).toBeDefined();
      expect(state!.planEntries![1].enteredAt).toBeDefined();
    });
  });

  describe('TurnEnd filesTouched normalization', () => {
    it('converts absolute transcript paths to repo-relative for hook overlap checks', async () => {
      const { mkdtempSync, realpathSync, writeFileSync, rmSync } = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');

      // A real directory so realpath resolution works (macOS /tmp symlink).
      const repo = mkdtempSync(path.join(os.tmpdir(), 'sl-lifecycle-'));
      try {
        writeFileSync(path.join(repo, 'hello.js'), 'x');

        // Agent whose transcript analyzer reports ABSOLUTE paths (like the
        // openswarm adapter, which pulls file_path from tool inputs).
        const absAgent = {
          name: 'AbsPaths',
          async detectPresence() {
            return true;
          },
          async getTranscriptPosition() {
            return 0;
          },
          async extractModifiedFilesFromOffset() {
            return {
              files: [realpathSync(path.join(repo, 'hello.js')), '/outside/other.ts'],
              currentPosition: 0,
            };
          },
        };

        const store = createMockSessionStore(
          baseSessionState({ transcriptPath: path.join(repo, 't.jsonl') }),
        );
        const handler = createLifecycleHandler({
          sessionStore: store,
          checkpointStore: createMockCheckpointStore(),
          cwd: repo,
        });

        await handler.dispatch(absAgent as never, makeEvent({ type: EventType.TurnEnd }));

        const state = await store.load('test-session');
        expect(state!.filesTouched).toContain('hello.js');
        // Paths outside the repo are left untouched rather than mangled.
        expect(state!.filesTouched).toContain('/outside/other.ts');
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});
