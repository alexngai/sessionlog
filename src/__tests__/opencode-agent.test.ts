/**
 * Tests for OpenCode Agent
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createOpenCodeAgent,
  extractTextFromParts,
  parseExportSession,
  extractAllUserPrompts,
} from '../agent/agents/opencode.js';
import { EventType } from '../types.js';

describe('OpenCode Agent', () => {
  const agent = createOpenCodeAgent();

  describe('basic properties', () => {
    it('should have correct name and type', () => {
      expect(agent.name).toBe('opencode');
      expect(agent.type).toBe('OpenCode');
      expect(agent.isPreview).toBe(true);
    });

    it('should protect .opencode directory', () => {
      expect(agent.protectedDirs).toContain('.opencode');
    });
  });

  describe('detectPresence', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should detect .opencode directory', async () => {
      fs.mkdirSync(path.join(tmpDir, '.opencode'));
      expect(await agent.detectPresence(tmpDir)).toBe(true);
    });

    it('should detect opencode.json', async () => {
      fs.writeFileSync(path.join(tmpDir, 'opencode.json'), '{}');
      expect(await agent.detectPresence(tmpDir)).toBe(true);
    });

    it('should return false when neither exists', async () => {
      expect(await agent.detectPresence(tmpDir)).toBe(false);
    });
  });

  describe('formatResumeCommand', () => {
    it('should include session ID', () => {
      const cmd = agent.formatResumeCommand('sess-abc');
      expect(cmd).toBe('opencode -s sess-abc');
    });

    it('should handle empty session ID', () => {
      const cmd = agent.formatResumeCommand('');
      expect(cmd).toBe('opencode');
    });
  });

  describe('resolveSessionFile', () => {
    it('should resolve to JSON file', () => {
      const result = agent.resolveSessionFile('/sessions', 'abc123');
      expect(result).toBe(path.join('/sessions', 'abc123.json'));
    });
  });

  describe('hookNames', () => {
    it('should return all 5 hooks', () => {
      const names = agent.hookNames();
      expect(names).toHaveLength(5);
      expect(names).toContain('session-start');
      expect(names).toContain('session-end');
      expect(names).toContain('turn-start');
      expect(names).toContain('turn-end');
      expect(names).toContain('compaction');
    });
  });

  describe('parseHookEvent', () => {
    it('should parse session-start', () => {
      const stdin = JSON.stringify({ session_id: 'oc-123' });
      const event = agent.parseHookEvent('session-start', stdin);
      expect(event).not.toBeNull();
      expect(event!.type).toBe(EventType.SessionStart);
      expect(event!.sessionID).toBe('oc-123');
    });

    it('should parse turn-start with prompt', () => {
      const stdin = JSON.stringify({ session_id: 'oc-456', prompt: 'Add tests' });
      const event = agent.parseHookEvent('turn-start', stdin);
      expect(event).not.toBeNull();
      expect(event!.type).toBe(EventType.TurnStart);
    });

    it('should parse turn-end', () => {
      const stdin = JSON.stringify({ session_id: 'oc-789' });
      const event = agent.parseHookEvent('turn-end', stdin);
      expect(event).not.toBeNull();
      expect(event!.type).toBe(EventType.TurnEnd);
    });

    it('should parse compaction', () => {
      const stdin = JSON.stringify({ session_id: 'oc-111' });
      const event = agent.parseHookEvent('compaction', stdin);
      expect(event).not.toBeNull();
      expect(event!.type).toBe(EventType.Compaction);
    });

    it('should parse session-end', () => {
      const stdin = JSON.stringify({ session_id: 'oc-222' });
      const event = agent.parseHookEvent('session-end', stdin);
      expect(event).not.toBeNull();
      expect(event!.type).toBe(EventType.SessionEnd);
    });

    it('should return null for unknown hook', () => {
      expect(agent.parseHookEvent('unknown', '{}')).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      expect(agent.parseHookEvent('session-start', 'bad')).toBeNull();
    });
  });

  describe('hook installation', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-hooks-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should install plugin file', async () => {
      const count = await agent.installHooks(tmpDir);
      expect(count).toBe(5);

      const pluginPath = path.join(tmpDir, '.opencode', 'plugins', 'runlog.ts');
      const content = fs.readFileSync(pluginPath, 'utf-8');
      expect(content).toContain('runlog enable --agent opencode');
    });

    it('should be idempotent', async () => {
      await agent.installHooks(tmpDir);
      const count = await agent.installHooks(tmpDir);
      expect(count).toBe(0);
    });

    it('should report hooks as installed', async () => {
      expect(await agent.areHooksInstalled(tmpDir)).toBe(false);
      await agent.installHooks(tmpDir);
      expect(await agent.areHooksInstalled(tmpDir)).toBe(true);
    });

    it('should uninstall hooks', async () => {
      await agent.installHooks(tmpDir);
      await agent.uninstallHooks(tmpDir);
      expect(await agent.areHooksInstalled(tmpDir)).toBe(false);
    });
  });

  describe('TranscriptAnalyzer', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-transcript-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const sampleSession = {
      info: { id: 'sess-1', title: 'Test' },
      messages: [
        {
          info: { id: 'msg-1', role: 'user', time: { created: 1000 } },
          parts: [{ type: 'text', text: 'Fix the bug' }],
        },
        {
          info: { id: 'msg-2', role: 'assistant', time: { created: 1001 } },
          parts: [
            { type: 'text', text: 'I will fix it.' },
            {
              type: 'tool',
              tool: 'edit',
              state: { status: 'completed', input: { filePath: 'src/app.ts' } },
            },
          ],
        },
        {
          info: { id: 'msg-3', role: 'user', time: { created: 1002 } },
          parts: [{ type: 'text', text: 'Thanks' }],
        },
      ],
    };

    it('should get transcript position', async () => {
      const transcriptPath = path.join(tmpDir, 'session.json');
      fs.writeFileSync(transcriptPath, JSON.stringify(sampleSession));
      const pos = await agent.getTranscriptPosition(transcriptPath);
      expect(pos).toBe(3);
    });

    it('should extract modified files', async () => {
      const transcriptPath = path.join(tmpDir, 'session.json');
      fs.writeFileSync(transcriptPath, JSON.stringify(sampleSession));
      const result = await agent.extractModifiedFilesFromOffset(transcriptPath, 0);
      expect(result.files).toContain('src/app.ts');
      expect(result.currentPosition).toBe(3);
    });

    it('should extract prompts', async () => {
      const transcriptPath = path.join(tmpDir, 'session.json');
      fs.writeFileSync(transcriptPath, JSON.stringify(sampleSession));
      const prompts = await agent.extractPrompts(transcriptPath, 0);
      expect(prompts).toEqual(['Fix the bug', 'Thanks']);
    });

    it('should extract summary from last assistant message', async () => {
      const transcriptPath = path.join(tmpDir, 'session.json');
      fs.writeFileSync(transcriptPath, JSON.stringify(sampleSession));
      const summary = await agent.extractSummary(transcriptPath);
      expect(summary).toBe('I will fix it.');
    });
  });

  describe('TokenCalculator', () => {
    it('should calculate token usage', async () => {
      const session = {
        info: { id: 'sess-1' },
        messages: [
          {
            info: {
              id: 'msg-1',
              role: 'assistant',
              time: { created: 1 },
              tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 3 } },
            },
            parts: [{ type: 'text', text: 'Hello' }],
          },
          {
            info: {
              id: 'msg-2',
              role: 'assistant',
              time: { created: 2 },
              tokens: { input: 200, output: 100, reasoning: 20, cache: { read: 10, write: 7 } },
            },
            parts: [{ type: 'text', text: 'World' }],
          },
        ],
      };

      const usage = await agent.calculateTokenUsage(Buffer.from(JSON.stringify(session)), 0);
      expect(usage.inputTokens).toBe(300);
      expect(usage.outputTokens).toBe(150);
      expect(usage.cacheReadTokens).toBe(15);
      expect(usage.cacheCreationTokens).toBe(10);
      expect(usage.apiCallCount).toBe(2);
    });
  });
});

describe('OpenCode Exported Helpers', () => {
  describe('extractTextFromParts', () => {
    it('should extract text from parts', () => {
      const parts = [
        { type: 'text', text: 'Hello' },
        { type: 'tool', tool: 'edit' },
        { type: 'text', text: 'World' },
      ];
      expect(extractTextFromParts(parts)).toBe('Hello\nWorld');
    });

    it('should return empty for no text parts', () => {
      const parts = [{ type: 'tool', tool: 'edit' }];
      expect(extractTextFromParts(parts)).toBe('');
    });
  });

  describe('parseExportSession', () => {
    it('should parse valid session JSON', () => {
      const data = JSON.stringify({
        info: { id: 'sess-1' },
        messages: [{ info: { id: 'msg-1', role: 'user', time: { created: 1 } }, parts: [] }],
      });
      const session = parseExportSession(data);
      expect(session).not.toBeNull();
      expect(session!.info.id).toBe('sess-1');
      expect(session!.messages).toHaveLength(1);
    });

    it('should return null for empty input', () => {
      expect(parseExportSession('')).toBeNull();
      expect(parseExportSession('  ')).toBeNull();
    });
  });

  describe('extractAllUserPrompts', () => {
    it('should extract user prompts from session', () => {
      const data = JSON.stringify({
        info: { id: 'sess-1' },
        messages: [
          {
            info: { id: 'msg-1', role: 'user', time: { created: 1 } },
            parts: [{ type: 'text', text: 'First' }],
          },
          {
            info: { id: 'msg-2', role: 'assistant', time: { created: 2 } },
            parts: [{ type: 'text', text: 'Response' }],
          },
          {
            info: { id: 'msg-3', role: 'user', time: { created: 3 } },
            parts: [{ type: 'text', text: 'Second' }],
          },
        ],
      });
      const prompts = extractAllUserPrompts(data);
      expect(prompts).toEqual(['First', 'Second']);
    });

    it('should return empty for empty data', () => {
      expect(extractAllUserPrompts('')).toEqual([]);
    });
  });
});
