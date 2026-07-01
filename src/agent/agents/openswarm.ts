/**
 * OpenSwarm Agent
 *
 * Sessionlog agent integration for openswarm — a multi-agent coding swarm
 * that runs its own engine (not an external IDE/CLI). Unlike the other agents,
 * openswarm drives the lifecycle programmatically (via
 * LifecycleHandler.dispatch) rather than via installed hooks, so this adapter
 * implements the core Agent + TranscriptAnalyzer surface but not HookSupport.
 *
 * Transcript format: openswarm writes one `events.jsonl` per worker session
 * — a stream of LaneEvent records:
 *   { ts, agentId, type, payload, ... }
 * where `type` is one of text_delta | tool_use_start | tool_use_input |
 * tool_use_end | tool_result | message_stop | turn_start | turn_end | ...
 * (wire-compatible with openswarm's NormalizedEvent).
 *
 * Session layout (see OPENSWARM_SESSION_DIR):
 *   <sessionDir>/<sessionID>/events.jsonl
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AGENT_NAMES, AGENT_TYPES, type HookInput } from '../../types.js';
import type { Agent, TranscriptAnalyzer } from '../types.js';
import { registerAgent } from '../registry.js';

const SWARM_DIR = '.swarm';
/** Per-repo sessions root (override with OPENSWARM_SESSION_DIR). */
const SESSIONS_SUBDIR = path.join(SWARM_DIR, 'openswarm', 'sessions');
const TRANSCRIPT_FILE = 'events.jsonl';

/** Tool-input keys that name a file the tool modifies. */
const FILE_PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path'];

// ===========================================================================
// LaneEvent parsing
// ===========================================================================

interface LaneEventRecord {
  type: string;
  payload?: unknown;
}

function parseLaneEvents(text: string): LaneEventRecord[] {
  const out: LaneEventRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as LaneEventRecord;
      if (rec && typeof rec.type === 'string') out.push(rec);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** Pull file paths out of a (reassembled) tool-input object. */
function filesFromToolInput(input: unknown, into: Set<string>): void {
  if (!input || typeof input !== 'object') return;
  const obj = input as Record<string, unknown>;
  for (const key of FILE_PATH_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) into.add(v);
  }
  // MultiEdit-style: edits[].file_path
  const edits = obj.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) filesFromToolInput(edit, into);
  }
}

/**
 * Walk lane events, reassembling streamed tool inputs
 * (tool_use_start -> tool_use_input* -> tool_use_end), and collect the files
 * touched by file-modifying tools.
 */
function collectModifiedFiles(events: LaneEventRecord[]): string[] {
  const pendingInput = new Map<string, string>(); // toolUseId -> accumulated jsonDelta
  const files = new Set<string>();

  for (const ev of events) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case 'tool_use_start': {
        const id = typeof p.id === 'string' ? p.id : undefined;
        if (id) pendingInput.set(id, '');
        break;
      }
      case 'tool_use_input': {
        const id = typeof p.id === 'string' ? p.id : undefined;
        const delta = typeof p.jsonDelta === 'string' ? p.jsonDelta : '';
        if (id !== undefined) pendingInput.set(id, (pendingInput.get(id) ?? '') + delta);
        break;
      }
      case 'tool_use_end': {
        const id = typeof p.id === 'string' ? p.id : undefined;
        if (id === undefined) break;
        const raw = pendingInput.get(id);
        pendingInput.delete(id);
        if (!raw) break;
        try {
          filesFromToolInput(JSON.parse(raw), files);
        } catch {
          // incomplete/invalid JSON — skip
        }
        break;
      }
      default:
        break;
    }
  }
  return Array.from(files);
}

function collectAssistantText(events: LaneEventRecord[]): string {
  const parts: string[] = [];
  for (const ev of events) {
    if (ev.type !== 'text_delta') continue;
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (typeof p.text === 'string') parts.push(p.text);
  }
  return parts.join('');
}

function collectPrompts(events: LaneEventRecord[]): string[] {
  // openswarm records the user/task prompt on turn_start (payload.prompt).
  const prompts: string[] = [];
  for (const ev of events) {
    if (ev.type !== 'turn_start') continue;
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (typeof p.prompt === 'string' && p.prompt.length > 0) prompts.push(p.prompt);
  }
  return prompts;
}

// ===========================================================================
// Agent implementation
// ===========================================================================

class OpenSwarmAgent implements Agent, TranscriptAnalyzer {
  readonly name = AGENT_NAMES.OPENSWARM;
  readonly type = AGENT_TYPES.OPENSWARM;
  readonly description = 'openswarm — multi-agent coding swarm';
  readonly isPreview = true;
  readonly protectedDirs = [SWARM_DIR];

  async detectPresence(cwd?: string): Promise<boolean> {
    if (process.env.OPENSWARM_SESSION_DIR) return true;
    const repoRoot = cwd ?? process.cwd();
    try {
      const stat = await fs.promises.stat(path.join(repoRoot, SWARM_DIR, 'openswarm'));
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async getSessionDir(repoPath: string): Promise<string> {
    const override = process.env.OPENSWARM_SESSION_DIR;
    if (override) return override;
    return path.join(repoPath, SESSIONS_SUBDIR);
  }

  getSessionID(input: HookInput): string {
    return input.sessionID;
  }

  resolveSessionFile(sessionDir: string, agentSessionID: string): string {
    return path.join(sessionDir, agentSessionID, TRANSCRIPT_FILE);
  }

  async readTranscript(sessionRef: string): Promise<Buffer> {
    return fs.promises.readFile(sessionRef);
  }

  formatResumeCommand(sessionID: string): string {
    return `openswarm --resume ${sessionID}`;
  }

  // =========================================================================
  // TranscriptAnalyzer
  // =========================================================================

  async getTranscriptPosition(transcriptPath: string): Promise<number> {
    try {
      return (await fs.promises.stat(transcriptPath)).size;
    } catch {
      return 0;
    }
  }

  async extractModifiedFilesFromOffset(
    transcriptPath: string,
    startOffset: number,
  ): Promise<{ files: string[]; currentPosition: number }> {
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(transcriptPath);
    } catch {
      return { files: [], currentPosition: startOffset };
    }
    const slice = buf.subarray(Math.max(0, startOffset)).toString('utf-8');
    const files = collectModifiedFiles(parseLaneEvents(slice));
    return { files, currentPosition: buf.length };
  }

  async extractPrompts(sessionRef: string, fromOffset: number): Promise<string[]> {
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(sessionRef);
    } catch {
      return [];
    }
    const slice = buf.subarray(Math.max(0, fromOffset)).toString('utf-8');
    return collectPrompts(parseLaneEvents(slice));
  }

  async extractSummary(sessionRef: string): Promise<string> {
    let text: string;
    try {
      text = (await fs.promises.readFile(sessionRef)).toString('utf-8');
    } catch {
      return '';
    }
    const events = parseLaneEvents(text);
    const assistant = collectAssistantText(events).trim();
    if (assistant) return assistant.slice(0, 500);
    const tools = events.filter((e) => e.type === 'tool_use_start').length;
    const turns = events.filter((e) => e.type === 'turn_start').length;
    return `openswarm session: ${turns} turn(s), ${tools} tool call(s)`;
  }
}

export function createOpenSwarmAgent(): OpenSwarmAgent {
  return new OpenSwarmAgent();
}

registerAgent(AGENT_NAMES.OPENSWARM, () => new OpenSwarmAgent());
