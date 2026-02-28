/**
 * Cursor Agent
 *
 * Implementation of the Runlog agent interface for Cursor IDE.
 * Handles JSONL transcript format, Cursor-specific hook installation,
 * and session lifecycle management.
 *
 * Note: Cursor does NOT implement TranscriptAnalyzer because Cursor
 * transcripts lack tool_use blocks. File detection relies on git status.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AGENT_NAMES, AGENT_TYPES, type HookInput, type Event, EventType } from '../../types.js';
import type { Agent, HookSupport, TranscriptChunker } from '../types.js';
import { registerAgent } from '../registry.js';

// ============================================================================
// Constants
// ============================================================================

const CURSOR_DIR = '.cursor';
const HOOKS_FILE_NAME = 'hooks.json';

const HOOK_NAMES = [
  'session-start',
  'session-end',
  'before-submit-prompt',
  'stop',
  'pre-compact',
  'subagent-start',
  'subagent-stop',
] as const;

const RUNLOG_HOOK_PREFIX = 'runlog ';

// ============================================================================
// Cursor Hook Types
// ============================================================================

interface CursorHookEntry {
  command: string;
  matcher?: string;
}

interface CursorHooksFile {
  version: number;
  hooks: Record<string, CursorHookEntry[]>;
  [key: string]: unknown;
}

// ============================================================================
// Cursor Agent Implementation
// ============================================================================

class CursorAgent implements Agent, HookSupport, TranscriptChunker {
  readonly name = AGENT_NAMES.CURSOR;
  readonly type = AGENT_TYPES.CURSOR;
  readonly description = 'Cursor - AI-powered code editor';
  readonly isPreview = true;
  readonly protectedDirs = [CURSOR_DIR];

  async detectPresence(cwd?: string): Promise<boolean> {
    const repoRoot = cwd ?? process.cwd();
    const cursorDir = path.join(repoRoot, CURSOR_DIR);
    try {
      const stat = await fs.promises.stat(cursorDir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async getSessionDir(repoPath: string): Promise<string> {
    if (process.env.RUNLOG_TEST_CURSOR_PROJECT_DIR) {
      return process.env.RUNLOG_TEST_CURSOR_PROJECT_DIR;
    }
    const projectDir = sanitizePathForCursor(repoPath);
    return path.join(os.homedir(), '.cursor', 'projects', projectDir);
  }

  getSessionID(input: HookInput): string {
    return input.sessionID;
  }

  resolveSessionFile(sessionDir: string, agentSessionID: string): string {
    return path.join(sessionDir, `${agentSessionID}.jsonl`);
  }

  async readTranscript(sessionRef: string): Promise<Buffer> {
    return fs.promises.readFile(sessionRef);
  }

  formatResumeCommand(_sessionID: string): string {
    return 'Open this project in Cursor IDE to continue the session.';
  }

  // ===========================================================================
  // HookSupport
  // ===========================================================================

  hookNames(): string[] {
    return [...HOOK_NAMES];
  }

  parseHookEvent(hookName: string, stdin: string): Event | null {
    try {
      const data = JSON.parse(stdin) as Record<string, unknown>;

      // Cursor uses conversation_id instead of session_id
      const sessionID = String(data.conversation_id ?? data.session_id ?? data.sessionID ?? '');
      const sessionRef = String(data.transcript_path ?? data.transcriptPath ?? '');

      switch (hookName) {
        case 'session-start':
          return {
            type: EventType.SessionStart,
            sessionID,
            sessionRef,
            timestamp: new Date(),
          };

        case 'before-submit-prompt':
          return {
            type: EventType.TurnStart,
            sessionID,
            sessionRef,
            prompt: String(data.prompt ?? ''),
            timestamp: new Date(),
          };

        case 'stop':
          return {
            type: EventType.TurnEnd,
            sessionID,
            sessionRef,
            timestamp: new Date(),
          };

        case 'session-end':
          return {
            type: EventType.SessionEnd,
            sessionID,
            sessionRef,
            timestamp: new Date(),
          };

        case 'pre-compact':
          return {
            type: EventType.Compaction,
            sessionID,
            sessionRef,
            timestamp: new Date(),
          };

        case 'subagent-start': {
          const task = String(data.task ?? '');
          if (!task) return null;
          return {
            type: EventType.SubagentStart,
            sessionID,
            sessionRef,
            toolUseID: String(data.subagent_id ?? ''),
            subagentType: String(data.subagent_type ?? ''),
            taskDescription: task,
            timestamp: new Date(),
          };
        }

        case 'subagent-stop': {
          const task = String(data.task ?? '');
          if (!task) return null;
          return {
            type: EventType.SubagentEnd,
            sessionID,
            sessionRef,
            toolUseID: String(data.subagent_id ?? ''),
            subagentID: String(data.subagent_id ?? ''),
            subagentType: String(data.subagent_type ?? ''),
            taskDescription: task,
            timestamp: new Date(),
          };
        }

        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  async installHooks(repoPath: string, force = false): Promise<number> {
    const hooksPath = path.join(repoPath, CURSOR_DIR, HOOKS_FILE_NAME);
    let rawFile: Record<string, unknown> = { version: 1 };

    try {
      const content = await fs.promises.readFile(hooksPath, 'utf-8');
      rawFile = JSON.parse(content) as Record<string, unknown>;
      if (!rawFile.version) rawFile.version = 1;
    } catch {
      // No existing file
    }

    const hooks = (rawFile.hooks ?? {}) as Record<string, CursorHookEntry[]>;

    const hookTypes = [
      { key: 'sessionStart', hookName: 'session-start' },
      { key: 'sessionEnd', hookName: 'session-end' },
      { key: 'beforeSubmitPrompt', hookName: 'before-submit-prompt' },
      { key: 'stop', hookName: 'stop' },
      { key: 'preCompact', hookName: 'pre-compact' },
      { key: 'subagentStart', hookName: 'subagent-start' },
      { key: 'subagentStop', hookName: 'subagent-stop' },
    ];

    let installed = 0;

    for (const { key, hookName } of hookTypes) {
      let entries: CursorHookEntry[] = hooks[key] ?? [];

      if (force) {
        entries = entries.filter((e) => !isRunlogHook(e.command));
      }

      const cmd = `runlog hooks cursor ${hookName}`;
      if (!entries.some((e) => e.command === cmd)) {
        entries.push({ command: cmd });
        installed++;
      }

      hooks[key] = entries;
    }

    if (installed === 0) return 0;

    rawFile.hooks = hooks;
    const dir = path.dirname(hooksPath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(hooksPath, JSON.stringify(rawFile, null, 2));

    return installed;
  }

  async uninstallHooks(repoPath: string): Promise<void> {
    const hooksPath = path.join(repoPath, CURSOR_DIR, HOOKS_FILE_NAME);

    try {
      const content = await fs.promises.readFile(hooksPath, 'utf-8');
      const rawFile = JSON.parse(content) as Record<string, unknown>;
      const hooks = (rawFile.hooks ?? {}) as Record<string, CursorHookEntry[]>;

      for (const key of Object.keys(hooks)) {
        hooks[key] = (hooks[key] ?? []).filter((e) => !isRunlogHook(e.command));
        if (hooks[key].length === 0) {
          delete hooks[key];
        }
      }

      if (Object.keys(hooks).length === 0) {
        delete rawFile.hooks;
      } else {
        rawFile.hooks = hooks;
      }

      await fs.promises.writeFile(hooksPath, JSON.stringify(rawFile, null, 2));
    } catch {
      // No file to modify
    }
  }

  async areHooksInstalled(repoPath: string): Promise<boolean> {
    const hooksPath = path.join(repoPath, CURSOR_DIR, HOOKS_FILE_NAME);

    try {
      const content = await fs.promises.readFile(hooksPath, 'utf-8');
      const rawFile = JSON.parse(content) as CursorHooksFile;
      const hooks = rawFile.hooks ?? {};

      for (const key of Object.keys(hooks)) {
        const entries = hooks[key];
        if (Array.isArray(entries) && entries.some((e) => isRunlogHook(e.command))) {
          return true;
        }
      }
    } catch {
      // No file
    }

    return false;
  }

  // ===========================================================================
  // TranscriptChunker
  // ===========================================================================

  async chunkTranscript(content: Buffer, maxSize: number): Promise<Buffer[]> {
    return chunkJSONL(content, maxSize);
  }

  async reassembleTranscript(chunks: Buffer[]): Promise<Buffer> {
    return Buffer.concat(chunks);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isRunlogHook(command: string): boolean {
  return command.startsWith(RUNLOG_HOOK_PREFIX);
}

const nonAlphanumericRegex = /[^a-zA-Z0-9]/g;

function sanitizePathForCursor(repoPath: string): string {
  return repoPath.replace(nonAlphanumericRegex, '-');
}

function chunkJSONL(content: Buffer, maxSize: number): Buffer[] {
  if (content.length <= maxSize) return [content];

  const str = content.toString('utf-8');
  const lines = str.split('\n');
  const chunks: Buffer[] = [];
  let current: string[] = [];
  let currentSize = 0;

  for (const line of lines) {
    const lineSize = Buffer.byteLength(line + '\n');

    if (currentSize + lineSize > maxSize && current.length > 0) {
      chunks.push(Buffer.from(current.join('\n') + '\n'));
      current = [];
      currentSize = 0;
    }

    current.push(line);
    currentSize += lineSize;
  }

  if (current.length > 0) {
    const remaining = current.join('\n');
    if (remaining.trim()) {
      chunks.push(Buffer.from(remaining + '\n'));
    }
  }

  return chunks;
}

// ============================================================================
// Registration
// ============================================================================

export function createCursorAgent(): CursorAgent {
  return new CursorAgent();
}

registerAgent(AGENT_NAMES.CURSOR, () => new CursorAgent());
