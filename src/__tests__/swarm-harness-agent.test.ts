/**
 * Tests for the Swarm Harness agent adapter.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSwarmHarnessAgent } from '../agent/agents/swarm-harness.js';
import { getAgent } from '../agent/registry.js';
import { AGENT_NAMES, AGENT_TYPES } from '../types.js';
import { hasTranscriptAnalyzer } from '../agent/types.js';

function writeTranscript(dir: string, sessionID: string, lines: object[]): string {
  const sessionDir = path.join(dir, sessionID);
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, 'events.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const SAMPLE = [
  { ts: 1, agentId: 'w1', type: 'turn_start', payload: { prompt: 'add a db migration' } },
  { ts: 2, agentId: 'w1', type: 'text_delta', payload: { text: 'Let me edit the file.' } },
  { ts: 3, agentId: 'w1', type: 'tool_use_start', payload: { id: 't1', name: 'Write' } },
  {
    ts: 4,
    agentId: 'w1',
    type: 'tool_use_input',
    payload: { id: 't1', jsonDelta: '{"file_path":"src/' },
  },
  {
    ts: 5,
    agentId: 'w1',
    type: 'tool_use_input',
    payload: { id: 't1', jsonDelta: 'db.ts","content":"x"}' },
  },
  { ts: 6, agentId: 'w1', type: 'tool_use_end', payload: { id: 't1' } },
  { ts: 7, agentId: 'w1', type: 'message_stop', payload: { stopReason: 'end_turn' } },
];

describe('SwarmHarnessAgent', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-harness-agent-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.SWARM_HARNESS_SESSION_DIR;
  });

  it('registers in the agent registry', () => {
    const agent = getAgent(AGENT_NAMES.SWARM_HARNESS);
    expect(agent).not.toBeNull();
    expect(agent!.type).toBe(AGENT_TYPES.SWARM_HARNESS);
    expect(agent!.protectedDirs).toContain('.swarm');
  });

  it('detects presence via SWARM_HARNESS_SESSION_DIR', async () => {
    const agent = createSwarmHarnessAgent();
    expect(await agent.detectPresence('/no/such/repo')).toBe(false);
    process.env.SWARM_HARNESS_SESSION_DIR = tmp;
    expect(await agent.detectPresence('/no/such/repo')).toBe(true);
  });

  it('resolves the per-session events.jsonl path', () => {
    const agent = createSwarmHarnessAgent();
    expect(agent.resolveSessionFile('/sessions', 's1')).toBe(
      path.join('/sessions', 's1', 'events.jsonl'),
    );
  });

  it('extracts modified files by reassembling streamed tool input', async () => {
    const agent = createSwarmHarnessAgent();
    expect(hasTranscriptAnalyzer(agent)).toBe(true);
    const file = writeTranscript(tmp, 's1', SAMPLE);
    const { files, currentPosition } = await agent.extractModifiedFilesFromOffset(file, 0);
    expect(files).toContain('src/db.ts');
    expect(currentPosition).toBe(fs.statSync(file).size);
  });

  it('extracts the task prompt from turn_start', async () => {
    const agent = createSwarmHarnessAgent();
    const file = writeTranscript(tmp, 's1', SAMPLE);
    expect(await agent.extractPrompts(file, 0)).toEqual(['add a db migration']);
  });

  it('summarizes from assistant text', async () => {
    const agent = createSwarmHarnessAgent();
    const file = writeTranscript(tmp, 's1', SAMPLE);
    expect(await agent.extractSummary(file)).toBe('Let me edit the file.');
  });

  it('is resilient to malformed lines and missing files', async () => {
    const agent = createSwarmHarnessAgent();
    expect(await agent.getTranscriptPosition('/no/such/file')).toBe(0);
    const sessionDir = path.join(tmp, 's2');
    fs.mkdirSync(sessionDir, { recursive: true });
    const file = path.join(sessionDir, 'events.jsonl');
    fs.writeFileSync(file, 'not json\n{"type":"text_delta","payload":{"text":"ok"}}\n');
    expect(await agent.extractSummary(file)).toBe('ok');
  });
});
