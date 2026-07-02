/**
 * End-to-end tests for skillsSurfaced tracking and checkpoint persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createClaudeCodeAgent } from '../agent/agents/claude-code.js';
import { createLifecycleHandler } from '../hooks/lifecycle.js';
import { createSessionStore } from '../store/session-store.js';
import { createCheckpointStore } from '../store/checkpoint-store.js';
import { EventType, type Event } from '../types.js';

function initRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'pipe' });
}

function writeFile(dir: string, relPath: string, content: string): void {
  const absPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function makeEvent(overrides: Partial<Event> & { type: EventType }): Event {
  return {
    sessionID: 'surfaced-session',
    sessionRef: '/path/to/transcript.jsonl',
    timestamp: new Date(),
    ...overrides,
  };
}

describe('skillsSurfaced tracking', () => {
  let tmpDir: string;
  const agent = createClaudeCodeAgent();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionlog-surfaced-'));
    initRepo(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup() {
    const sessionsDir = path.join(tmpDir, '.git', 'sessionlog-sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionStore = createSessionStore(tmpDir, sessionsDir);
    const checkpointStore = createCheckpointStore(tmpDir);
    const lifecycle = createLifecycleHandler({
      sessionStore,
      checkpointStore,
      cwd: tmpDir,
    });
    return { sessionStore, checkpointStore, lifecycle };
  }

  it('records surfaced skills separately from invoked skills', { timeout: 15000 }, async () => {
    writeFile(
      tmpDir,
      '.skilltree/skills/verification-before-completion/SKILL.md',
      `---
name: verification-before-completion
version: 1.0.0
---

# Verification
`,
    );
    writeFile(
      tmpDir,
      '.skilltree/skills/verification-before-completion/.skilltree.json',
      JSON.stringify({
        upstream: {
          remote: 'openskills',
          skillId: 'verification-before-completion',
          version: '1.0.0',
          syncedAt: '2026-01-01T00:00:00Z',
        },
      }),
    );

    const { sessionStore, lifecycle } = setup();

    await lifecycle.dispatch(agent, makeEvent({ type: EventType.SessionStart }));
    await lifecycle.dispatch(
      agent,
      makeEvent({
        type: EventType.SkillsSurfaced,
        surfacedSkillNames: ['verification-before-completion'],
      }),
    );
    await lifecycle.dispatch(
      agent,
      makeEvent({
        type: EventType.SkillUse,
        skillName: 'verification-before-completion',
        skillArgs: undefined,
      }),
    );

    const state = await sessionStore.load('surfaced-session');
    expect(state!.skillsSurfaced).toHaveLength(1);
    expect(state!.skillsUsed).toHaveLength(1);
    expect(state!.skillsSurfaced![0].surfacedAt).toBeDefined();
    expect(state!.skillsSurfaced![0].usedAt).toBeUndefined();
    expect(state!.skillsUsed![0].usedAt).toBeDefined();
    expect(state!.skillsUsed![0].surfacedAt).toBeUndefined();
    expect(state!.skillsSurfaced![0].upstreamSkillId).toBe('verification-before-completion');
  });

  it(
    'persists skillsSurfaced to committed checkpoint metadata.json',
    { timeout: 15000 },
    async () => {
      const { sessionStore, checkpointStore } = setup();

      await sessionStore.save({
        sessionID: 'surfaced-session',
        baseCommit: 'abc123',
        startedAt: '2026-01-01T00:00:00Z',
        phase: 'active',
        turnCheckpointIDs: [],
        stepCount: 1,
        checkpointTranscriptStart: 0,
        untrackedFilesAtStart: [],
        filesTouched: ['src/app.ts'],
        agentType: 'Claude Code',
        skillsSurfaced: [
          {
            name: 'verification-before-completion',
            surfacedAt: '2026-01-01T00:00:00Z',
            sourceType: 'skill-tree',
            upstreamSkillId: 'verification-before-completion',
            upstreamVersion: '1.0.0',
          },
        ],
      });

      const checkpointID = await checkpointStore.generateID();
      await checkpointStore.writeCommitted({
        checkpointID,
        sessionID: 'surfaced-session',
        strategy: 'manual-commit',
        transcript: Buffer.from('[]'),
        prompts: ['fix the bug'],
        context: Buffer.from('# Context'),
        filesTouched: ['src/app.ts'],
        checkpointsCount: 1,
        authorName: 'Test',
        authorEmail: 'test@test.com',
        agent: 'Claude Code',
        checkpointTranscriptStart: 0,
        skillsSurfaced: [
          {
            name: 'verification-before-completion',
            surfacedAt: '2026-01-01T00:00:00Z',
            sourceType: 'skill-tree',
            upstreamSkillId: 'verification-before-completion',
            upstreamVersion: '1.0.0',
          },
        ],
      });

      const content = await checkpointStore.readSessionContent(checkpointID, 0);
      expect(content).not.toBeNull();
      expect(content!.metadata.skillsSurfaced).toHaveLength(1);
      expect(content!.metadata.skillsSurfaced![0].name).toBe('verification-before-completion');
      expect(content!.metadata.skillsSurfaced![0].upstreamSkillId).toBe(
        'verification-before-completion',
      );
      expect(content!.metadata.skillsUsed).toBeUndefined();
    },
  );
});
