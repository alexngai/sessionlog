/**
 * Tests for Agent Teams awareness and tracking
 *
 * Covers:
 * - pre-agent / post-agent hook parsing
 * - SpawnedAgentRef lifecycle tracking
 * - Team query helpers
 */

import { describe, it, expect } from 'vitest';
import { createClaudeCodeAgent } from '../agent/agents/claude-code.js';
import { createLifecycleHandler } from '../hooks/lifecycle.js';
import { EventType, type SessionState, type Event } from '../types.js';
import type { SessionStore } from '../store/session-store.js';
import type { CheckpointStore } from '../store/checkpoint-store.js';
import {
  getTeamSessions,
  getChildSessions,
  getParentSession,
  aggregateTeamFiles,
  aggregateTeamTokens,
  collectSpawnedAgents,
  listTeamNames,
} from '../store/team-queries.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createMockSessionStore(
  initial?: SessionState | SessionState[],
): SessionStore & { states: Map<string, SessionState> } {
  const states = new Map<string, SessionState>();
  const initials = Array.isArray(initial) ? initial : initial ? [initial] : [];
  for (const s of initials) states.set(s.sessionID, s);

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
    startedAt: '2026-03-20T12:00:00Z',
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

// ============================================================================
// Hook Parsing Tests
// ============================================================================

describe('Claude Code Agent — Agent Tool Hooks', () => {
  const agent = createClaudeCodeAgent();

  describe('hookNames', () => {
    it('should include pre-agent and post-agent', () => {
      const names = agent.hookNames();
      expect(names).toContain('pre-agent');
      expect(names).toContain('post-agent');
    });
  });

  describe('parseHookEvent — pre-agent', () => {
    it('should parse SubagentStart with team metadata', () => {
      const stdin = JSON.stringify({
        session_id: 'sess-parent',
        transcript_path: '/path/to/transcript.jsonl',
        tool_use_id: 'tu-001',
        tool_input: {
          prompt: 'Run the tests',
          subagent_type: 'general-purpose',
          team_name: 'my-team',
          name: 'test-runner',
          isolation: 'worktree',
          run_in_background: true,
        },
      });

      const event = agent.parseHookEvent('pre-agent', stdin);
      expect(event).not.toBeNull();
      expect(event!.type).toBe(EventType.SubagentStart);
      expect(event!.sessionID).toBe('sess-parent');
      expect(event!.toolUseID).toBe('tu-001');
      expect(event!.subagentType).toBe('general-purpose');
      expect(event!.teamName).toBe('my-team');
      expect(event!.agentName).toBe('test-runner');
      expect(event!.isolation).toBe('worktree');
      expect(event!.runInBackground).toBe(true);
      expect(event!.taskDescription).toBe('Run the tests');
    });

    it('should handle minimal pre-agent input', () => {
      const stdin = JSON.stringify({
        session_id: 'sess-parent',
        transcript_path: '/path/to/transcript.jsonl',
        tool_use_id: 'tu-002',
        tool_input: {
          prompt: 'Do something',
        },
      });

      const event = agent.parseHookEvent('pre-agent', stdin);
      expect(event).not.toBeNull();
      expect(event!.type).toBe(EventType.SubagentStart);
      expect(event!.teamName).toBeUndefined();
      expect(event!.agentName).toBeUndefined();
      expect(event!.isolation).toBeUndefined();
      expect(event!.runInBackground).toBeUndefined();
    });

    it('should handle malformed JSON', () => {
      expect(agent.parseHookEvent('pre-agent', 'bad')).toBeNull();
    });
  });

  describe('parseHookEvent — post-agent', () => {
    it('should parse SubagentEnd with agentId from response', () => {
      const stdin = JSON.stringify({
        session_id: 'sess-parent',
        transcript_path: '/path/to/transcript.jsonl',
        tool_use_id: 'tu-001',
        tool_input: {
          subagent_type: 'general-purpose',
          team_name: 'my-team',
          name: 'test-runner',
        },
        tool_response: {
          agentId: 'agent-abc123',
        },
      });

      const event = agent.parseHookEvent('post-agent', stdin);
      expect(event).not.toBeNull();
      expect(event!.type).toBe(EventType.SubagentEnd);
      expect(event!.subagentID).toBe('agent-abc123');
      expect(event!.teamName).toBe('my-team');
      expect(event!.agentName).toBe('test-runner');
    });

    it('should handle missing tool_response', () => {
      const stdin = JSON.stringify({
        session_id: 'sess-parent',
        transcript_path: '/path/to/transcript.jsonl',
        tool_use_id: 'tu-003',
        tool_input: {},
      });

      const event = agent.parseHookEvent('post-agent', stdin);
      expect(event).not.toBeNull();
      expect(event!.type).toBe(EventType.SubagentEnd);
      expect(event!.subagentID).toBeUndefined();
    });
  });

  describe('pre-task still works', () => {
    it('should parse pre-task with new fields too', () => {
      const stdin = JSON.stringify({
        session_id: 'sess-parent',
        transcript_path: '/path/to/transcript.jsonl',
        tool_use_id: 'tu-010',
        tool_input: {
          prompt: 'Legacy task',
        },
      });

      const event = agent.parseHookEvent('pre-task', stdin);
      expect(event).not.toBeNull();
      expect(event!.type).toBe(EventType.SubagentStart);
      expect(event!.taskDescription).toBe('Legacy task');
    });
  });
});

// ============================================================================
// Lifecycle Handler Tests
// ============================================================================

describe('Lifecycle — Spawned Agent Tracking', () => {
  const agent = createClaudeCodeAgent();

  it('should track spawned agent on SubagentStart', async () => {
    const store = createMockSessionStore(baseSessionState());
    const handler = createLifecycleHandler({
      sessionStore: store,
      checkpointStore: createMockCheckpointStore(),
    });

    await handler.dispatch(
      agent,
      makeEvent({
        type: EventType.SubagentStart,
        toolUseID: 'tu-100',
        subagentType: 'general-purpose',
        teamName: 'builders',
        agentName: 'builder-1',
        isolation: 'worktree',
        runInBackground: false,
      }),
    );

    const state = await store.load('test-session');
    expect(state!.spawnedAgents).toHaveLength(1);
    expect(state!.spawnedAgents![0].toolUseID).toBe('tu-100');
    expect(state!.spawnedAgents![0].subagentType).toBe('general-purpose');
    expect(state!.spawnedAgents![0].teamName).toBe('builders');
    expect(state!.spawnedAgents![0].agentName).toBe('builder-1');
    expect(state!.spawnedAgents![0].isolation).toBe('worktree');
    expect(state!.spawnedAgents![0].runInBackground).toBe(false);
    expect(state!.spawnedAgents![0].spawnedAt).toBeTruthy();
    expect(state!.spawnedAgents![0].completedAt).toBeUndefined();
  });

  it('should finalize spawned agent on SubagentEnd', async () => {
    const store = createMockSessionStore(
      baseSessionState({
        spawnedAgents: [
          {
            toolUseID: 'tu-100',
            agentName: 'builder-1',
            subagentType: 'general-purpose',
            teamName: 'builders',
            spawnedAt: '2026-03-20T12:00:00Z',
          },
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
        type: EventType.SubagentEnd,
        toolUseID: 'tu-100',
        subagentID: 'agent-xyz',
      }),
    );

    const state = await store.load('test-session');
    expect(state!.spawnedAgents![0].subagentID).toBe('agent-xyz');
    expect(state!.spawnedAgents![0].completedAt).toBeTruthy();
  });

  it('should handle SubagentEnd with no matching ref gracefully', async () => {
    const store = createMockSessionStore(baseSessionState());
    const handler = createLifecycleHandler({
      sessionStore: store,
      checkpointStore: createMockCheckpointStore(),
    });

    await handler.dispatch(
      agent,
      makeEvent({
        type: EventType.SubagentEnd,
        toolUseID: 'tu-nonexistent',
        subagentID: 'agent-orphan',
      }),
    );

    const state = await store.load('test-session');
    // Should not crash; spawnedAgents stays undefined
    expect(state!.spawnedAgents).toBeUndefined();
  });

  it('should accumulate multiple spawned agents', async () => {
    const store = createMockSessionStore(baseSessionState());
    const handler = createLifecycleHandler({
      sessionStore: store,
      checkpointStore: createMockCheckpointStore(),
    });

    await handler.dispatch(
      agent,
      makeEvent({
        type: EventType.SubagentStart,
        toolUseID: 'tu-a',
        agentName: 'agent-a',
        teamName: 'team-x',
      }),
    );

    await handler.dispatch(
      agent,
      makeEvent({
        type: EventType.SubagentStart,
        toolUseID: 'tu-b',
        agentName: 'agent-b',
        teamName: 'team-x',
      }),
    );

    const state = await store.load('test-session');
    expect(state!.spawnedAgents).toHaveLength(2);
    expect(state!.spawnedAgents![0].agentName).toBe('agent-a');
    expect(state!.spawnedAgents![1].agentName).toBe('agent-b');
  });
});

// ============================================================================
// Team Query Tests
// ============================================================================

describe('Team Query Helpers', () => {
  const parentSession = baseSessionState({
    sessionID: 'parent-1',
    filesTouched: ['src/a.ts', 'src/b.ts'],
    tokenUsage: {
      inputTokens: 1000,
      cacheCreationTokens: 0,
      cacheReadTokens: 500,
      outputTokens: 200,
      apiCallCount: 5,
    },
    spawnedAgents: [
      {
        toolUseID: 'tu-1',
        subagentID: 'agent-child-1',
        agentName: 'worker',
        teamName: 'builders',
        spawnedAt: '2026-03-20T12:00:00Z',
        completedAt: '2026-03-20T12:05:00Z',
      },
    ],
    teamName: 'builders',
  });

  const childSession = baseSessionState({
    sessionID: 'child-1',
    parentSessionID: 'parent-1',
    teamName: 'builders',
    filesTouched: ['src/c.ts', 'src/b.ts'],
    tokenUsage: {
      inputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 100,
      outputTokens: 80,
      apiCallCount: 2,
    },
  });

  const unrelatedSession = baseSessionState({
    sessionID: 'unrelated',
    filesTouched: ['README.md'],
  });

  describe('getTeamSessions', () => {
    it('should return sessions matching team name', async () => {
      const store = createMockSessionStore([parentSession, childSession, unrelatedSession]);
      const result = await getTeamSessions(store, 'builders');
      expect(result).toHaveLength(2);
      expect(result.map((s) => s.sessionID).sort()).toEqual(['child-1', 'parent-1']);
    });

    it('should return empty for unknown team', async () => {
      const store = createMockSessionStore([parentSession]);
      const result = await getTeamSessions(store, 'nonexistent');
      expect(result).toHaveLength(0);
    });
  });

  describe('getChildSessions', () => {
    it('should return sessions with matching parentSessionID', async () => {
      const store = createMockSessionStore([parentSession, childSession, unrelatedSession]);
      const result = await getChildSessions(store, 'parent-1');
      expect(result).toHaveLength(1);
      expect(result[0].sessionID).toBe('child-1');
    });
  });

  describe('getParentSession', () => {
    it('should return the parent session', async () => {
      const store = createMockSessionStore([parentSession, childSession]);
      const result = await getParentSession(store, 'child-1');
      expect(result).not.toBeNull();
      expect(result!.sessionID).toBe('parent-1');
    });

    it('should return null for sessions without parent', async () => {
      const store = createMockSessionStore([parentSession]);
      const result = await getParentSession(store, 'parent-1');
      expect(result).toBeNull();
    });

    it('should return null for unknown session', async () => {
      const store = createMockSessionStore([]);
      const result = await getParentSession(store, 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('aggregateTeamFiles', () => {
    it('should deduplicate files across sessions', () => {
      const result = aggregateTeamFiles([parentSession, childSession]);
      expect(result.sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    });
  });

  describe('aggregateTeamTokens', () => {
    it('should sum token usage across sessions', () => {
      const result = aggregateTeamTokens([parentSession, childSession]);
      expect(result.inputTokens).toBe(1500);
      expect(result.cacheReadTokens).toBe(600);
      expect(result.outputTokens).toBe(280);
      expect(result.apiCallCount).toBe(7);
    });

    it('should handle sessions without token usage', () => {
      const result = aggregateTeamTokens([unrelatedSession]);
      expect(result.inputTokens).toBe(0);
      expect(result.apiCallCount).toBe(0);
    });
  });

  describe('collectSpawnedAgents', () => {
    it('should collect all spawned agent refs', () => {
      const refs = collectSpawnedAgents([parentSession, childSession]);
      expect(refs).toHaveLength(1);
      expect(refs[0].agentName).toBe('worker');
    });

    it('should filter by team name', () => {
      const refs = collectSpawnedAgents([parentSession], 'nonexistent');
      expect(refs).toHaveLength(0);
    });
  });

  describe('listTeamNames', () => {
    it('should collect distinct team names from sessions and spawned agents', async () => {
      const store = createMockSessionStore([parentSession, childSession, unrelatedSession]);
      const names = await listTeamNames(store);
      expect(names).toEqual(['builders']);
    });

    it('should return empty for no teams', async () => {
      const store = createMockSessionStore([unrelatedSession]);
      const names = await listTeamNames(store);
      expect(names).toHaveLength(0);
    });
  });
});
