/**
 * Tests for Session Store Normalization
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { normalizeSessionState, createSessionStore } from '../store/session-store.js';

describe('Session Store', () => {
  describe('normalizeSessionState', () => {
    it('should normalize standard fields', () => {
      const state = normalizeSessionState('test-id', {
        sessionID: 'test-id',
        baseCommit: 'abc123',
        startedAt: '2026-02-13T12:00:00Z',
        phase: 'active',
        agentType: 'Claude Code',
        filesTouched: ['src/app.ts'],
        stepCount: 3,
      });

      expect(state.sessionID).toBe('test-id');
      expect(state.baseCommit).toBe('abc123');
      expect(state.phase).toBe('active');
      expect(state.agentType).toBe('Claude Code');
      expect(state.filesTouched).toEqual(['src/app.ts']);
      expect(state.stepCount).toBe(3);
    });

    it('should handle alternative field names', () => {
      const state = normalizeSessionState('alt-id', {
        session_id: 'alt-id',
        base_commit: 'def456',
        started_at: '2026-02-13T12:00:00Z',
        state: 'ACTIVE',
        agent: 'Cursor IDE',
      });

      expect(state.sessionID).toBe('alt-id');
      expect(state.phase).toBe('active');
      expect(state.agentType).toBe('Cursor IDE');
    });

    it('should normalize phase values', () => {
      expect(normalizeSessionState('id', { phase: 'ACTIVE' }).phase).toBe('active');
      expect(normalizeSessionState('id', { phase: 'IDLE' }).phase).toBe('idle');
      expect(normalizeSessionState('id', { phase: 'ENDED' }).phase).toBe('ended');
      expect(normalizeSessionState('id', { phase: 'unknown' }).phase).toBe('idle');
      expect(normalizeSessionState('id', {}).phase).toBe('idle');
    });

    it('should default missing arrays to empty', () => {
      const state = normalizeSessionState('id', {});
      expect(state.filesTouched).toEqual([]);
      expect(state.turnCheckpointIDs).toEqual([]);
      expect(state.untrackedFilesAtStart).toEqual([]);
    });

    it('should default missing numbers to 0', () => {
      const state = normalizeSessionState('id', {});
      expect(state.stepCount).toBe(0);
      expect(state.checkpointTranscriptStart).toBe(0);
    });

    it('should use id parameter as fallback for sessionID', () => {
      const state = normalizeSessionState('fallback-id', {});
      expect(state.sessionID).toBe('fallback-id');
    });

    it('should preserve optional fields when present', () => {
      const state = normalizeSessionState('id', {
        firstPrompt: 'Build a REST API',
        transcriptPath: '/path/to/transcript.jsonl',
        endedAt: '2026-02-13T13:00:00Z',
        worktreeID: 'main',
      });

      expect(state.firstPrompt).toBe('Build a REST API');
      expect(state.transcriptPath).toBe('/path/to/transcript.jsonl');
      expect(state.endedAt).toBe('2026-02-13T13:00:00Z');
      expect(state.worktreeID).toBe('main');
    });

    it('should normalize task tracking fields', () => {
      const tasks = {
        '1': {
          id: '1',
          subject: 'Fix bug',
          status: 'completed',
          createdAt: '2026-02-13T12:00:00Z',
          updatedAt: '2026-02-13T12:30:00Z',
        },
      };
      const state = normalizeSessionState('id', {
        tasks,
        inPlanMode: true,
        planModeEntries: 2,
      });

      expect(state.tasks).toEqual(tasks);
      expect(state.inPlanMode).toBe(true);
      expect(state.planModeEntries).toBe(2);
    });

    it('should handle missing task/plan fields for backward compatibility', () => {
      const state = normalizeSessionState('id', {});
      expect(state.tasks).toBeUndefined();
      expect(state.inPlanMode).toBeUndefined();
      expect(state.planModeEntries).toBeUndefined();
      expect(state.planEntries).toBeUndefined();
    });

    it('should normalize planEntries array', () => {
      const entries = [
        {
          enteredAt: '2026-02-13T12:00:00Z',
          exitedAt: '2026-02-13T12:05:00Z',
          filePath: '/home/user/.claude/plans/my-plan.md',
          content: '# Plan\n\nStep 1: Do the thing',
        },
      ];
      const state = normalizeSessionState('id', { planEntries: entries });
      expect(state.planEntries).toEqual(entries);
    });

    it('should migrate old planFilePath/planContent to planEntries', () => {
      const state = normalizeSessionState('id', {
        planFilePath: '/home/user/.claude/plans/my-plan.md',
        planContent: '# Plan\n\nStep 1: Do the thing',
        startedAt: '2026-02-13T12:00:00Z',
      });
      expect(state.planEntries).toHaveLength(1);
      expect(state.planEntries![0].filePath).toBe('/home/user/.claude/plans/my-plan.md');
      expect(state.planEntries![0].content).toBe('# Plan\n\nStep 1: Do the thing');
    });

    it('should normalize multiple planEntries', () => {
      const entries = [
        { enteredAt: '2026-02-13T12:00:00Z', exitedAt: '2026-02-13T12:05:00Z' },
        {
          enteredAt: '2026-02-13T13:00:00Z',
          exitedAt: '2026-02-13T13:10:00Z',
          filePath: '/plans/v2.md',
          content: '# V2 Plan',
        },
      ];
      const state = normalizeSessionState('id', { planEntries: entries });
      expect(state.planEntries).toHaveLength(2);
      expect(state.planEntries![1].filePath).toBe('/plans/v2.md');
    });

    it('should normalize task description field', () => {
      const tasks = {
        '1': {
          id: '1',
          subject: 'Fix bug',
          description: 'Detailed description of the bug',
          status: 'pending',
          createdAt: '2026-02-13T12:00:00Z',
          updatedAt: '2026-02-13T12:00:00Z',
        },
      };
      const state = normalizeSessionState('id', { tasks });
      expect(state.tasks!['1'].description).toBe('Detailed description of the bug');
    });

    it('should preserve annotations when present', () => {
      const annotations = {
        swarmId: 'gsd-1710936000000',
        teamName: 'gsd',
        role: 'executor',
      };
      const state = normalizeSessionState('id', { annotations });
      expect(state.annotations).toEqual(annotations);
    });

    it('should drop annotations when not an object', () => {
      expect(normalizeSessionState('id', { annotations: 'string' }).annotations).toBeUndefined();
      expect(normalizeSessionState('id', { annotations: [1, 2] }).annotations).toBeUndefined();
      expect(normalizeSessionState('id', { annotations: null }).annotations).toBeUndefined();
    });

    it('should leave annotations undefined when absent', () => {
      const state = normalizeSessionState('id', {});
      expect(state.annotations).toBeUndefined();
    });
  });

  describe('annotate', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionlog-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeSession(id: string, data: Record<string, unknown>): void {
      fs.writeFileSync(
        path.join(tmpDir, `${id}.json`),
        JSON.stringify({ sessionID: id, baseCommit: '', phase: 'active', ...data }, null, 2),
      );
    }

    it('should merge annotations into a session without existing annotations', async () => {
      writeSession('sess-1', { startedAt: '2026-01-01T00:00:00Z' });
      const store = createSessionStore(undefined, tmpDir);

      const result = await store.annotate('sess-1', { swarmId: 'gsd-123', role: 'executor' });

      expect(result).toBe(true);
      const state = await store.load('sess-1');
      expect(state!.annotations).toEqual({ swarmId: 'gsd-123', role: 'executor' });
    });

    it('should merge with existing annotations without overwriting', async () => {
      writeSession('sess-2', {
        startedAt: '2026-01-01T00:00:00Z',
        annotations: { swarmId: 'gsd-123', teamName: 'gsd' },
      });
      const store = createSessionStore(undefined, tmpDir);

      await store.annotate('sess-2', { role: 'verifier' });

      const state = await store.load('sess-2');
      expect(state!.annotations).toEqual({ swarmId: 'gsd-123', teamName: 'gsd', role: 'verifier' });
    });

    it('should overwrite individual keys when they conflict', async () => {
      writeSession('sess-3', {
        startedAt: '2026-01-01T00:00:00Z',
        annotations: { role: 'executor' },
      });
      const store = createSessionStore(undefined, tmpDir);

      await store.annotate('sess-3', { role: 'verifier' });

      const state = await store.load('sess-3');
      expect(state!.annotations!.role).toBe('verifier');
    });

    it('should return false for non-existent session', async () => {
      const store = createSessionStore(undefined, tmpDir);
      const result = await store.annotate('does-not-exist', { swarmId: 'x' });
      expect(result).toBe(false);
    });

    it('should not modify other session fields', async () => {
      writeSession('sess-4', {
        startedAt: '2026-01-01T00:00:00Z',
        stepCount: 5,
        filesTouched: ['a.ts'],
      });
      const store = createSessionStore(undefined, tmpDir);

      await store.annotate('sess-4', { swarmId: 'gsd-123' });

      const state = await store.load('sess-4');
      expect(state!.stepCount).toBe(5);
      expect(state!.filesTouched).toEqual(['a.ts']);
    });
  });
});
