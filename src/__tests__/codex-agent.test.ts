/**
 * Tests for Codex Agent
 *
 * Ported from the Go reference tests in the Entire CLI
 * (cmd/entire/cli/agent/codex/{codex,hooks,transcript}_test.go).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createCodexAgent,
  extractFilesFromApplyPatch,
  classifyApplyPatchPaths,
  sanitizePortableTranscript,
} from '../agent/agents/codex.js';
import { EventType } from '../types.js';

// A representative Codex rollout transcript (canonical { timestamp, type,
// payload } JSONL format).
const SAMPLE_ROLLOUT = `{"timestamp":"2026-03-25T11:31:11.752Z","type":"session_meta","payload":{"id":"019d24c3","timestamp":"2026-03-25T11:31:10.922Z","cwd":"/tmp/repo","originator":"codex_exec","cli_version":"0.116.0","source":"exec"}}
{"timestamp":"2026-03-25T11:31:11.754Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}
{"timestamp":"2026-03-25T11:31:11.754Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Create a file called hello.txt"}]}}
{"timestamp":"2026-03-25T11:31:12.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5000,"cached_input_tokens":4000,"output_tokens":100,"reasoning_output_tokens":20,"total_tokens":5100}}}}
{"timestamp":"2026-03-25T11:31:13.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Creating the file now."}]}}
{"timestamp":"2026-03-25T11:31:14.000Z","type":"response_item","payload":{"type":"custom_tool_call","status":"completed","call_id":"call_1","name":"apply_patch","input":"*** Begin Patch\\n*** Add File: hello.txt\\n+Hello World\\n*** End Patch\\n"}}
{"timestamp":"2026-03-25T11:31:14.500Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_1","output":{"type":"text","text":"Success. Updated: A hello.txt"}}}
{"timestamp":"2026-03-25T11:31:15.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10000,"cached_input_tokens":8000,"output_tokens":200,"reasoning_output_tokens":50,"total_tokens":10200}}}}
{"timestamp":"2026-03-25T11:31:16.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Now create docs/readme.md too"}]}}
{"timestamp":"2026-03-25T11:31:17.000Z","type":"response_item","payload":{"type":"custom_tool_call","status":"completed","call_id":"call_2","name":"apply_patch","input":"*** Begin Patch\\n*** Add File: docs/readme.md\\n+# Readme\\n*** Update File: hello.txt\\n-Hello World\\n+Hello World!\\n*** End Patch\\n"}}
{"timestamp":"2026-03-25T11:31:18.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":15000,"cached_input_tokens":12000,"output_tokens":300,"reasoning_output_tokens":80,"total_tokens":15300}}}}
{"timestamp":"2026-03-25T11:31:19.000Z","type":"event_msg","payload":{"type":"task_complete"}}
`;

function writeSampleRollout(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, SAMPLE_ROLLOUT);
  return { dir, file };
}

describe('Codex Agent', () => {
  const agent = createCodexAgent();

  describe('basic properties', () => {
    it('should have correct name and type', () => {
      expect(agent.name).toBe('codex');
      expect(agent.type).toBe('Codex');
      expect(agent.isPreview).toBe(true);
    });

    it('should protect .codex directory', () => {
      expect(agent.protectedDirs).toContain('.codex');
    });
  });

  describe('detectPresence', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-detect-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should detect presence when .codex dir exists', async () => {
      fs.mkdirSync(path.join(tmpDir, '.codex'));
      expect(await agent.detectPresence(tmpDir)).toBe(true);
    });

    it('should return false when .codex dir does not exist', async () => {
      expect(await agent.detectPresence(tmpDir)).toBe(false);
    });
  });

  describe('formatResumeCommand', () => {
    it('should produce a codex resume command', () => {
      expect(agent.formatResumeCommand('550e8400-e29b-41d4-a716-446655440000')).toBe(
        'codex resume 550e8400-e29b-41d4-a716-446655440000',
      );
    });
  });

  describe('getSessionDir', () => {
    const prevHome = process.env.CODEX_HOME;
    const prevTestDir = process.env.SESSIONLOG_TEST_CODEX_SESSION_DIR;

    afterEach(() => {
      if (prevHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevHome;
      if (prevTestDir === undefined) delete process.env.SESSIONLOG_TEST_CODEX_SESSION_DIR;
      else process.env.SESSIONLOG_TEST_CODEX_SESSION_DIR = prevTestDir;
    });

    it('should honor CODEX_HOME', async () => {
      delete process.env.SESSIONLOG_TEST_CODEX_SESSION_DIR;
      process.env.CODEX_HOME = '/custom/codex';
      expect(await agent.getSessionDir('')).toBe(path.join('/custom/codex', 'sessions'));
    });
  });

  describe('hookNames', () => {
    it('should return the three lifecycle hooks', () => {
      const names = agent.hookNames();
      expect(names).toEqual(['session-start', 'user-prompt-submit', 'stop']);
    });
  });

  describe('parseHookEvent', () => {
    it('should map session-start to SessionStart', () => {
      const event = agent.parseHookEvent(
        'session-start',
        JSON.stringify({
          session_id: 'sess-1',
          transcript_path: '/tmp/rollout.jsonl',
          model: 'gpt-5',
          source: 'startup',
        }),
      );
      expect(event?.type).toBe(EventType.SessionStart);
      expect(event?.sessionID).toBe('sess-1');
      expect(event?.sessionRef).toBe('/tmp/rollout.jsonl');
    });

    it('should map user-prompt-submit to TurnStart with prompt', () => {
      const event = agent.parseHookEvent(
        'user-prompt-submit',
        JSON.stringify({ session_id: 'sess-1', prompt: 'do the thing' }),
      );
      expect(event?.type).toBe(EventType.TurnStart);
      expect(event?.prompt).toBe('do the thing');
    });

    it('should map stop to TurnEnd', () => {
      const event = agent.parseHookEvent('stop', JSON.stringify({ session_id: 'sess-1' }));
      expect(event?.type).toBe(EventType.TurnEnd);
    });

    it('should handle null transcript_path (ephemeral mode)', () => {
      const event = agent.parseHookEvent(
        'session-start',
        JSON.stringify({ session_id: 'sess-1', transcript_path: null }),
      );
      expect(event?.sessionRef).toBe('');
    });

    it('should return null for unknown hooks and bad JSON', () => {
      expect(agent.parseHookEvent('pre-tool-use', '{}')).toBeNull();
      expect(agent.parseHookEvent('session-start', 'not json')).toBeNull();
    });
  });

  describe('hook installation', () => {
    let repoDir: string;

    beforeEach(() => {
      repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hooks-'));
    });

    afterEach(() => {
      fs.rmSync(repoDir, { recursive: true, force: true });
    });

    it('should install hooks.json and enable the feature flag', async () => {
      const count = await agent.installHooks(repoDir);
      expect(count).toBe(3);

      const hooksFile = JSON.parse(
        fs.readFileSync(path.join(repoDir, '.codex', 'hooks.json'), 'utf-8'),
      );
      expect(hooksFile.hooks.SessionStart[0].hooks[0].command).toBe(
        'sessionlog hooks codex session-start',
      );
      expect(hooksFile.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
        'sessionlog hooks codex user-prompt-submit',
      );
      expect(hooksFile.hooks.Stop[0].hooks[0].command).toBe('sessionlog hooks codex stop');

      const config = fs.readFileSync(path.join(repoDir, '.codex', 'config.toml'), 'utf-8');
      expect(config).toContain('[features]');
      expect(config).toContain('hooks = true');
    });

    it('should be idempotent', async () => {
      await agent.installHooks(repoDir);
      const second = await agent.installHooks(repoDir);
      expect(second).toBe(0);
      expect(await agent.areHooksInstalled(repoDir)).toBe(true);
    });

    it('should preserve unknown top-level keys and foreign hooks', async () => {
      const hooksPath = path.join(repoDir, '.codex', 'hooks.json');
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(
        hooksPath,
        JSON.stringify({
          $schema: 'https://example/schema.json',
          hooks: {
            SessionStart: [
              { matcher: null, hooks: [{ type: 'command', command: 'other-tool start' }] },
            ],
          },
        }),
      );

      await agent.installHooks(repoDir);
      const result = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
      expect(result.$schema).toBe('https://example/schema.json');
      const commands = result.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) =>
        g.hooks.map((h) => h.command),
      );
      expect(commands).toContain('other-tool start');
      expect(commands).toContain('sessionlog hooks codex session-start');
    });

    it('should rewrite the legacy codex_hooks flag', async () => {
      const configPath = path.join(repoDir, '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, '[features]\ncodex_hooks = true\n');

      await agent.installHooks(repoDir);
      const config = fs.readFileSync(configPath, 'utf-8');
      expect(config).toContain('hooks = true');
      expect(config).not.toContain('codex_hooks = true');
    });

    it('should uninstall hooks and leave foreign hooks intact', async () => {
      const hooksPath = path.join(repoDir, '.codex', 'hooks.json');
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(
        hooksPath,
        JSON.stringify({
          hooks: {
            SessionStart: [
              { matcher: null, hooks: [{ type: 'command', command: 'other-tool start' }] },
            ],
          },
        }),
      );

      await agent.installHooks(repoDir);
      await agent.uninstallHooks(repoDir);

      const result = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
      const commands = (result.hooks?.SessionStart ?? []).flatMap(
        (g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command),
      );
      expect(commands).toContain('other-tool start');
      expect(commands.some((c: string) => c.startsWith('sessionlog '))).toBe(false);
      expect(await agent.areHooksInstalled(repoDir)).toBe(false);
    });
  });

  describe('getTranscriptPosition', () => {
    it('should count rollout lines', async () => {
      const { dir, file } = writeSampleRollout();
      try {
        expect(await agent.getTranscriptPosition(file)).toBe(12);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should return 0 for empty path and missing files', async () => {
      expect(await agent.getTranscriptPosition('')).toBe(0);
      expect(await agent.getTranscriptPosition('/nonexistent/file.jsonl')).toBe(0);
    });
  });

  describe('extractModifiedFilesFromOffset', () => {
    it('should find all files from the start', async () => {
      const { dir, file } = writeSampleRollout();
      try {
        const { files, currentPosition } = await agent.extractModifiedFilesFromOffset(file, 0);
        expect(currentPosition).toBe(12);
        expect(files.sort()).toEqual(['docs/readme.md', 'hello.txt']);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should respect the offset', async () => {
      const { dir, file } = writeSampleRollout();
      try {
        const { files } = await agent.extractModifiedFilesFromOffset(file, 7);
        expect(files.sort()).toEqual(['docs/readme.md', 'hello.txt']);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should return empty past the end', async () => {
      const { dir, file } = writeSampleRollout();
      try {
        const { files, currentPosition } = await agent.extractModifiedFilesFromOffset(file, 100);
        expect(currentPosition).toBe(12);
        expect(files).toEqual([]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('calculateTokenUsage', () => {
    it('should return full cumulative total from offset 0', async () => {
      const usage = await agent.calculateTokenUsage(Buffer.from(SAMPLE_ROLLOUT), 0);
      expect(usage.inputTokens).toBe(3000); // 15000 - 12000 cached
      expect(usage.cacheReadTokens).toBe(12000);
      expect(usage.outputTokens).toBe(300);
      expect(usage.apiCallCount).toBe(3);
      expect(usage.inputTokens + usage.cacheReadTokens + usage.outputTokens).toBe(15300);
    });

    it('should compute the delta against a baseline offset', async () => {
      const usage = await agent.calculateTokenUsage(Buffer.from(SAMPLE_ROLLOUT), 4);
      expect(usage.inputTokens).toBe(2000); // (15000-5000) - (12000-4000)
      expect(usage.cacheReadTokens).toBe(8000); // 12000 - 4000
      expect(usage.outputTokens).toBe(200); // 300 - 100
      expect(usage.apiCallCount).toBe(2);
    });

    it('should return zeroed usage when there is no token data', async () => {
      const usage = await agent.calculateTokenUsage(
        Buffer.from('{"timestamp":"t","type":"session_meta","payload":{}}'),
        0,
      );
      expect(usage.apiCallCount).toBe(0);
      expect(usage.inputTokens).toBe(0);
      expect(usage.outputTokens).toBe(0);
    });
  });

  describe('extractPrompts', () => {
    it('should extract user prompts in order', async () => {
      const { dir, file } = writeSampleRollout();
      try {
        const prompts = await agent.extractPrompts(file, 0);
        expect(prompts).toEqual([
          'Create a file called hello.txt',
          'Now create docs/readme.md too',
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should respect the offset', async () => {
      const { dir, file } = writeSampleRollout();
      try {
        const prompts = await agent.extractPrompts(file, 8);
        expect(prompts).toEqual(['Now create docs/readme.md too']);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should return empty for missing files', async () => {
      expect(await agent.extractPrompts('/nonexistent/file.jsonl', 0)).toEqual([]);
    });
  });

  describe('extractSummary', () => {
    it('should return the last assistant message', async () => {
      const { dir, file } = writeSampleRollout();
      try {
        expect(await agent.extractSummary(file)).toBe('Creating the file now.');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('apply_patch parsing', () => {
    it('extractFilesFromApplyPatch handles add/update/delete and dedup', () => {
      expect(
        extractFilesFromApplyPatch(
          '*** Begin Patch\n*** Add File: hello.txt\n+content\n*** End Patch',
        ),
      ).toEqual(['hello.txt']);
      expect(
        extractFilesFromApplyPatch(
          '*** Begin Patch\n*** Add File: a.txt\n+x\n*** Update File: b.txt\n-old\n+new\n*** End Patch',
        ).sort(),
      ).toEqual(['a.txt', 'b.txt']);
      expect(
        extractFilesFromApplyPatch('*** Begin Patch\n*** Delete File: old.txt\n*** End Patch'),
      ).toEqual(['old.txt']);
      expect(extractFilesFromApplyPatch('*** Add File: a.txt\n*** Update File: a.txt')).toEqual([
        'a.txt',
      ]);
      expect(extractFilesFromApplyPatch('some random text')).toEqual([]);
    });

    it('classifyApplyPatchPaths buckets verbs', () => {
      const { added, modified, deleted } = classifyApplyPatchPaths(
        '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** Update File: b.txt\n@@\n-old\n+new\n*** Delete File: c.txt\n*** End Patch\n',
      );
      expect(added).toEqual(['a.txt']);
      expect(modified).toEqual(['b.txt']);
      expect(deleted).toEqual(['c.txt']);
    });

    it('classifyApplyPatchPaths: Add wins over Update (sticky)', () => {
      const { added, modified, deleted } = classifyApplyPatchPaths(
        '*** Add File: a.txt\n*** Update File: a.txt\n',
      );
      expect(added).toEqual(['a.txt']);
      expect(modified).toEqual([]);
      expect(deleted).toEqual([]);
    });

    it('classifyApplyPatchPaths: Move to becomes delete-source + add-dest', () => {
      const { added, modified, deleted } = classifyApplyPatchPaths(
        '*** Begin Patch\n*** Update File: src/old.rs\n*** Move to: src/new.rs\n@@\n-old\n+new\n*** End Patch\n',
      );
      expect(added).toEqual(['src/new.rs']);
      expect(modified).toEqual([]);
      expect(deleted).toEqual(['src/old.rs']);
    });

    it('classifyApplyPatchPaths: Move with sibling hunks scopes to last Update', () => {
      const { added, modified, deleted } = classifyApplyPatchPaths(
        '*** Begin Patch\n' +
          '*** Delete File: gone.txt\n' +
          '*** Update File: a.rs\n' +
          '*** Move to: b.rs\n' +
          '@@\n-x\n+y\n' +
          '*** Add File: brand-new.go\n' +
          '+package main\n' +
          '*** End Patch\n',
      );
      expect(added).toEqual(['b.rs', 'brand-new.go']);
      expect(modified).toEqual([]);
      expect(deleted).toEqual(['a.rs', 'gone.txt']);
    });

    it('classifyApplyPatchPaths: empty envelope', () => {
      const { added, modified, deleted } = classifyApplyPatchPaths(
        '*** Begin Patch\n*** End Patch\n',
      );
      expect(added).toEqual([]);
      expect(modified).toEqual([]);
      expect(deleted).toEqual([]);
    });
  });

  describe('restore support (Plan B)', () => {
    it('resolveRestoredSessionFile builds the canonical dated rollout path', () => {
      const sessionDir = '/home/u/.codex/sessions';
      const transcript =
        '{"timestamp":"2026-03-25T11:31:11.752Z","type":"session_meta","payload":{"id":"019d24c3","timestamp":"2026-03-25T11:31:10.922Z"}}';
      const codex = agent as ReturnType<typeof createCodexAgent>;
      const result = codex.resolveRestoredSessionFile(
        sessionDir,
        '019d6c43-1537-7343-9691-1f8cee04fe59',
        transcript,
      );
      expect(result).toBe(
        path.join(
          sessionDir,
          '2026',
          '03',
          '25',
          'rollout-2026-03-25T11-31-10-019d6c43-1537-7343-9691-1f8cee04fe59.jsonl',
        ),
      );
    });

    it('resolveRestoredSessionFile rejects bad session IDs and empty transcripts', () => {
      const codex = agent as ReturnType<typeof createCodexAgent>;
      expect(codex.resolveRestoredSessionFile('/d', '../escape', 'x')).toBeNull();
      expect(codex.resolveRestoredSessionFile('/d', 'ok-id', '')).toBeNull();
    });

    it('sanitizePortableTranscript strips encrypted reasoning and compaction items', () => {
      const input = `{"timestamp":"2026-03-25T11:31:11.752Z","type":"session_meta","payload":{"id":"019d24c3","timestamp":"2026-03-25T11:31:10.922Z"}}
{"timestamp":"2026-03-25T11:31:11.754Z","type":"response_item","payload":{"type":"reasoning","summary":[{"text":"brief"}],"encrypted_content":"REDACTED"}}
{"timestamp":"2026-03-25T11:31:11.755Z","type":"response_item","payload":{"type":"compaction","encrypted_content":"REDACTED"}}
{"timestamp":"2026-03-25T11:31:11.756Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}
`;
      const got = sanitizePortableTranscript(input).toString('utf-8');
      expect(got).toContain('"type":"reasoning"');
      expect(got).not.toContain('"encrypted_content":"REDACTED"');
      expect(got).not.toContain('"type":"compaction"');
      expect(got).toContain('"type":"message"');
    });

    it('sanitizePortableTranscript cleans compacted replacement_history', () => {
      const input = `{"timestamp":"2026-03-25T11:31:11.752Z","type":"session_meta","payload":{"id":"019d24c3","timestamp":"2026-03-25T11:31:10.922Z"}}
{"timestamp":"2026-03-25T11:31:11.754Z","type":"compacted","payload":{"message":"","replacement_history":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]},{"type":"reasoning","summary":[{"text":"brief"}],"encrypted_content":"REDACTED"},{"type":"compaction","encrypted_content":"REDACTED"},{"type":"compaction_summary","encrypted_content":"REDACTED"}]}}
`;
      const got = sanitizePortableTranscript(input).toString('utf-8');
      expect(got).toContain('"type":"compacted"');
      expect(got).toContain('"type":"reasoning"');
      expect(got).toContain('"type":"message"');
      expect(got).not.toContain('"encrypted_content":"REDACTED"');
      expect(got).not.toContain('"type":"compaction"');
      expect(got).not.toContain('"type":"compaction_summary"');
    });
  });

  describe('chunkTranscript / reassembleTranscript', () => {
    it('should round-trip a JSONL transcript', async () => {
      const buf = Buffer.from(SAMPLE_ROLLOUT);
      const chunks = await agent.chunkTranscript(buf, 256);
      expect(chunks.length).toBeGreaterThan(1);
      const reassembled = await agent.reassembleTranscript(chunks);
      // Line content is preserved across the round trip.
      const original = SAMPLE_ROLLOUT.split('\n').filter(Boolean);
      const restored = reassembled.toString('utf-8').split('\n').filter(Boolean);
      expect(restored).toEqual(original);
    });
  });
});
