/**
 * Gemini CLI Agent
 *
 * Implementation of the Runlog agent interface for Google's Gemini CLI.
 * Handles JSON transcript format with messages array, Gemini-specific
 * hook installation, and session lifecycle management.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  AGENT_NAMES,
  AGENT_TYPES,
  type HookInput,
  type Event,
  type TokenUsage,
  EventType,
  emptyTokenUsage,
} from '../../types.js';
import type {
  Agent,
  HookSupport,
  TranscriptAnalyzer,
  TokenCalculator,
  TranscriptChunker,
} from '../types.js';
import { registerAgent } from '../registry.js';

// ============================================================================
// Constants
// ============================================================================

const GEMINI_DIR = '.gemini';
const SETTINGS_FILE_NAME = 'settings.json';

const HOOK_NAMES = [
  'session-start',
  'session-end',
  'before-agent',
  'after-agent',
  'before-model',
  'after-model',
  'before-tool-selection',
  'before-tool',
  'after-tool',
  'pre-compress',
  'notification',
] as const;

const RUNLOG_HOOK_PREFIX = 'runlog ';

/** Tools that modify files in Gemini CLI */
const FILE_MODIFICATION_TOOLS = new Set(['write_file', 'edit_file', 'save_file', 'replace']);

// ============================================================================
// Gemini Transcript Types (JSON)
// ============================================================================

export interface GeminiTranscript {
  messages: GeminiMessage[];
}

export interface GeminiMessage {
  id?: string;
  type: string;
  content: string;
  toolCalls?: GeminiToolCall[];
}

export interface GeminiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status?: string;
}

// ============================================================================
// Gemini Settings Types
// ============================================================================

interface GeminiHookEntry {
  name: string;
  type: string;
  command: string;
}

interface GeminiHookMatcher {
  matcher?: string;
  hooks: GeminiHookEntry[];
}

// ============================================================================
// Gemini CLI Agent Implementation
// ============================================================================

class GeminiCLIAgent
  implements Agent, HookSupport, TranscriptAnalyzer, TokenCalculator, TranscriptChunker
{
  readonly name = AGENT_NAMES.GEMINI;
  readonly type = AGENT_TYPES.GEMINI;
  readonly description = "Gemini CLI - Google's AI coding assistant";
  readonly isPreview = true;
  readonly protectedDirs = [GEMINI_DIR];

  async detectPresence(cwd?: string): Promise<boolean> {
    const repoRoot = cwd ?? process.cwd();
    const geminiDir = path.join(repoRoot, GEMINI_DIR);
    try {
      const stat = await fs.promises.stat(geminiDir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async getSessionDir(repoPath: string): Promise<string> {
    if (process.env.RUNLOG_TEST_GEMINI_PROJECT_DIR) {
      return process.env.RUNLOG_TEST_GEMINI_PROJECT_DIR;
    }
    const projectDir = getProjectHash(repoPath);
    return path.join(os.homedir(), '.gemini', 'tmp', projectDir, 'chats');
  }

  getSessionID(input: HookInput): string {
    return input.sessionID;
  }

  resolveSessionFile(sessionDir: string, agentSessionID: string): string {
    // Gemini names files as session-<date>-<shortid>.json
    const shortID = agentSessionID.length > 8 ? agentSessionID.slice(0, 8) : agentSessionID;

    // Try to find existing file
    try {
      const files = fs.readdirSync(sessionDir);
      const pattern = `session-.*-${shortID}\\.json`;
      const regex = new RegExp(pattern);
      const matches = files.filter((f) => regex.test(f)).sort();
      if (matches.length > 0) {
        return path.join(sessionDir, matches[matches.length - 1]);
      }
    } catch {
      // Directory doesn't exist yet
    }

    // Fallback: construct filename matching Gemini's convention
    const timestamp = new Date().toISOString().slice(0, 16).replace(/:/g, '-');
    return path.join(sessionDir, `session-${timestamp}-${shortID}.json`);
  }

  async readTranscript(sessionRef: string): Promise<Buffer> {
    return fs.promises.readFile(sessionRef);
  }

  formatResumeCommand(sessionID: string): string {
    return `gemini --resume ${sessionID}`;
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

      const sessionID = String(data.session_id ?? data.sessionID ?? '');
      const sessionRef = String(data.transcript_path ?? data.transcriptPath ?? '');

      switch (hookName) {
        case 'session-start':
          return {
            type: EventType.SessionStart,
            sessionID,
            sessionRef,
            timestamp: new Date(),
          };

        case 'before-agent':
          return {
            type: EventType.TurnStart,
            sessionID,
            sessionRef,
            prompt: String(data.prompt ?? ''),
            timestamp: new Date(),
          };

        case 'after-agent':
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

        case 'pre-compress':
          return {
            type: EventType.Compaction,
            sessionID,
            sessionRef,
            timestamp: new Date(),
          };

        // Pass-through hooks with no lifecycle action
        case 'before-tool':
        case 'after-tool':
        case 'before-model':
        case 'after-model':
        case 'before-tool-selection':
        case 'notification':
          return null;

        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  async installHooks(repoPath: string, force = false): Promise<number> {
    const settingsPath = path.join(repoPath, GEMINI_DIR, SETTINGS_FILE_NAME);
    let rawSettings: Record<string, unknown> = {};

    try {
      const content = await fs.promises.readFile(settingsPath, 'utf-8');
      rawSettings = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // No existing settings
    }

    // Ensure hooksConfig.enabled is true
    const hooksConfig = (rawSettings.hooksConfig ?? {}) as Record<string, unknown>;
    hooksConfig.enabled = true;
    rawSettings.hooksConfig = hooksConfig;

    const hooks = (rawSettings.hooks ?? {}) as Record<string, GeminiHookMatcher[]>;

    const hookDefs = [
      { key: 'SessionStart', hookName: 'session-start', matcher: '', name: 'runlog-session-start' },
      {
        key: 'SessionEnd',
        hookName: 'session-end',
        matcher: 'exit',
        name: 'runlog-session-end-exit',
      },
      {
        key: 'SessionEnd',
        hookName: 'session-end',
        matcher: 'logout',
        name: 'runlog-session-end-logout',
      },
      { key: 'BeforeAgent', hookName: 'before-agent', matcher: '', name: 'runlog-before-agent' },
      { key: 'AfterAgent', hookName: 'after-agent', matcher: '', name: 'runlog-after-agent' },
      { key: 'BeforeModel', hookName: 'before-model', matcher: '', name: 'runlog-before-model' },
      { key: 'AfterModel', hookName: 'after-model', matcher: '', name: 'runlog-after-model' },
      {
        key: 'BeforeToolSelection',
        hookName: 'before-tool-selection',
        matcher: '',
        name: 'runlog-before-tool-selection',
      },
      { key: 'BeforeTool', hookName: 'before-tool', matcher: '*', name: 'runlog-before-tool' },
      { key: 'AfterTool', hookName: 'after-tool', matcher: '*', name: 'runlog-after-tool' },
      { key: 'PreCompress', hookName: 'pre-compress', matcher: '', name: 'runlog-pre-compress' },
      { key: 'Notification', hookName: 'notification', matcher: '', name: 'runlog-notification' },
    ];

    // If not force, check idempotency
    if (!force) {
      const sessionStartMatchers = hooks['SessionStart'] ?? [];
      for (const m of sessionStartMatchers) {
        for (const h of m.hooks) {
          if (h.command === `runlog hooks gemini session-start`) {
            return 0; // Already installed
          }
        }
      }
    }

    // Remove existing runlog hooks
    for (const key of Object.keys(hooks)) {
      hooks[key] = removeRunlogGeminiHooks(hooks[key] ?? []);
      if (hooks[key].length === 0) delete hooks[key];
    }

    // Install all hooks
    for (const def of hookDefs) {
      const matchers = hooks[def.key] ?? [];
      const cmd = `runlog hooks gemini ${def.hookName}`;
      const entry: GeminiHookEntry = { name: def.name, type: 'command', command: cmd };

      // Find or create matcher
      let found = false;
      for (const m of matchers) {
        if ((m.matcher ?? '') === def.matcher) {
          m.hooks.push(entry);
          found = true;
          break;
        }
      }
      if (!found) {
        const newMatcher: GeminiHookMatcher = { hooks: [entry] };
        if (def.matcher) newMatcher.matcher = def.matcher;
        matchers.push(newMatcher);
      }
      hooks[def.key] = matchers;
    }

    rawSettings.hooks = hooks;

    const dir = path.dirname(settingsPath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(settingsPath, JSON.stringify(rawSettings, null, 2));

    return 12; // Total hooks installed
  }

  async uninstallHooks(repoPath: string): Promise<void> {
    const settingsPath = path.join(repoPath, GEMINI_DIR, SETTINGS_FILE_NAME);

    try {
      const content = await fs.promises.readFile(settingsPath, 'utf-8');
      const rawSettings = JSON.parse(content) as Record<string, unknown>;
      const hooks = (rawSettings.hooks ?? {}) as Record<string, GeminiHookMatcher[]>;

      for (const key of Object.keys(hooks)) {
        hooks[key] = removeRunlogGeminiHooks(hooks[key] ?? []);
        if (hooks[key].length === 0) delete hooks[key];
      }

      if (Object.keys(hooks).length === 0) {
        delete rawSettings.hooks;
      } else {
        rawSettings.hooks = hooks;
      }

      await fs.promises.writeFile(settingsPath, JSON.stringify(rawSettings, null, 2));
    } catch {
      // No file to modify
    }
  }

  async areHooksInstalled(repoPath: string): Promise<boolean> {
    const settingsPath = path.join(repoPath, GEMINI_DIR, SETTINGS_FILE_NAME);

    try {
      const content = await fs.promises.readFile(settingsPath, 'utf-8');
      const rawSettings = JSON.parse(content) as Record<string, unknown>;
      const hooks = (rawSettings.hooks ?? {}) as Record<string, GeminiHookMatcher[]>;

      for (const key of Object.keys(hooks)) {
        for (const m of hooks[key] ?? []) {
          for (const h of m.hooks) {
            if (h.command.startsWith(RUNLOG_HOOK_PREFIX)) return true;
          }
        }
      }
    } catch {
      // No file
    }

    return false;
  }

  // ===========================================================================
  // TranscriptAnalyzer
  // ===========================================================================

  async getTranscriptPosition(transcriptPath: string): Promise<number> {
    try {
      const data = await fs.promises.readFile(transcriptPath, 'utf-8');
      const transcript = JSON.parse(data) as GeminiTranscript;
      return transcript.messages?.length ?? 0;
    } catch {
      return 0;
    }
  }

  async extractModifiedFilesFromOffset(
    transcriptPath: string,
    startOffset: number,
  ): Promise<{ files: string[]; currentPosition: number }> {
    const data = await fs.promises.readFile(transcriptPath, 'utf-8');
    const transcript = parseGeminiTranscript(data);
    const files = new Set<string>();

    for (let i = startOffset; i < transcript.messages.length; i++) {
      const msg = transcript.messages[i];
      if (msg.type !== 'gemini') continue;

      for (const tc of msg.toolCalls ?? []) {
        if (!FILE_MODIFICATION_TOOLS.has(tc.name)) continue;
        const filePath = extractGeminiFilePath(tc.args);
        if (filePath) files.add(filePath);
      }
    }

    return { files: Array.from(files), currentPosition: transcript.messages.length };
  }

  async extractPrompts(sessionRef: string, fromOffset: number): Promise<string[]> {
    const data = await fs.promises.readFile(sessionRef, 'utf-8');
    const transcript = parseGeminiTranscript(data);
    const prompts: string[] = [];

    for (let i = fromOffset; i < transcript.messages.length; i++) {
      const msg = transcript.messages[i];
      if (msg.type === 'user' && msg.content) {
        prompts.push(msg.content);
      }
    }

    return prompts;
  }

  async extractSummary(sessionRef: string): Promise<string> {
    const data = await fs.promises.readFile(sessionRef, 'utf-8');
    const transcript = parseGeminiTranscript(data);

    for (let i = transcript.messages.length - 1; i >= 0; i--) {
      if (transcript.messages[i].type === 'gemini' && transcript.messages[i].content) {
        return transcript.messages[i].content;
      }
    }

    return '';
  }

  // ===========================================================================
  // TokenCalculator
  // ===========================================================================

  async calculateTokenUsage(transcriptData: Buffer, fromOffset: number): Promise<TokenUsage> {
    const data = transcriptData.toString('utf-8');
    const usage = emptyTokenUsage();

    try {
      const parsed = JSON.parse(data) as {
        messages: Array<{
          type: string;
          tokens?: { input: number; output: number; cached: number };
        }>;
      };

      for (let i = fromOffset; i < parsed.messages.length; i++) {
        const msg = parsed.messages[i];
        if (msg.type !== 'gemini' || !msg.tokens) continue;

        usage.apiCallCount++;
        usage.inputTokens += msg.tokens.input ?? 0;
        usage.outputTokens += msg.tokens.output ?? 0;
        usage.cacheReadTokens += msg.tokens.cached ?? 0;
      }
    } catch {
      // Invalid transcript data
    }

    return usage;
  }

  // ===========================================================================
  // TranscriptChunker
  // ===========================================================================

  async chunkTranscript(content: Buffer, maxSize: number): Promise<Buffer[]> {
    try {
      const transcript = JSON.parse(content.toString('utf-8')) as GeminiTranscript;
      if (!transcript.messages?.length) return [content];

      const chunks: Buffer[] = [];
      let currentMessages: GeminiMessage[] = [];
      const baseSize = Buffer.byteLength('{"messages":[]}');
      let currentSize = baseSize;

      for (const msg of transcript.messages) {
        const msgBytes = Buffer.byteLength(JSON.stringify(msg));
        const msgSize = msgBytes + 1; // +1 for comma

        if (currentSize + msgSize > maxSize && currentMessages.length > 0) {
          chunks.push(Buffer.from(JSON.stringify({ messages: currentMessages })));
          currentMessages = [];
          currentSize = baseSize;
        }

        currentMessages.push(msg);
        currentSize += msgSize;
      }

      if (currentMessages.length > 0) {
        chunks.push(Buffer.from(JSON.stringify({ messages: currentMessages })));
      }

      return chunks.length > 0 ? chunks : [content];
    } catch {
      // Fall back to raw content
      return [content];
    }
  }

  async reassembleTranscript(chunks: Buffer[]): Promise<Buffer> {
    const allMessages: GeminiMessage[] = [];

    for (const chunk of chunks) {
      const transcript = JSON.parse(chunk.toString('utf-8')) as GeminiTranscript;
      allMessages.push(...(transcript.messages ?? []));
    }

    return Buffer.from(JSON.stringify({ messages: allMessages }));
  }
}

// ============================================================================
// Helpers
// ============================================================================

function getProjectHash(projectRoot: string): string {
  return crypto.createHash('sha256').update(projectRoot).digest('hex');
}

function removeRunlogGeminiHooks(matchers: GeminiHookMatcher[]): GeminiHookMatcher[] {
  const result: GeminiHookMatcher[] = [];
  for (const m of matchers) {
    const filteredHooks = m.hooks.filter((h) => !h.command.startsWith(RUNLOG_HOOK_PREFIX));
    if (filteredHooks.length > 0) {
      result.push({ ...m, hooks: filteredHooks });
    }
  }
  return result;
}

function extractGeminiFilePath(args: Record<string, unknown>): string {
  if (typeof args.file_path === 'string' && args.file_path) return args.file_path;
  if (typeof args.path === 'string' && args.path) return args.path;
  if (typeof args.filename === 'string' && args.filename) return args.filename;
  return '';
}

/**
 * Parse Gemini JSON transcript, handling both string and array content formats.
 */
function parseGeminiTranscript(data: string): GeminiTranscript {
  const raw = JSON.parse(data) as { messages: Array<Record<string, unknown>> };
  const messages: GeminiMessage[] = [];

  for (const rawMsg of raw.messages ?? []) {
    const msg: GeminiMessage = {
      id: rawMsg.id as string | undefined,
      type: rawMsg.type as string,
      content: '',
      toolCalls: rawMsg.toolCalls as GeminiToolCall[] | undefined,
    };

    // Handle both string and array content formats
    const content = rawMsg.content;
    if (typeof content === 'string') {
      msg.content = content;
    } else if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const part of content) {
        if (
          part &&
          typeof part === 'object' &&
          typeof (part as Record<string, unknown>).text === 'string'
        ) {
          texts.push((part as Record<string, unknown>).text as string);
        }
      }
      msg.content = texts.join('\n');
    }

    messages.push(msg);
  }

  return { messages };
}

// ============================================================================
// Exported Helpers (for summarize module)
// ============================================================================

export { parseGeminiTranscript, FILE_MODIFICATION_TOOLS as GEMINI_FILE_MODIFICATION_TOOLS };

export type { GeminiTranscript as ParsedGeminiTranscript };

// ============================================================================
// Registration
// ============================================================================

export function createGeminiCLIAgent(): GeminiCLIAgent {
  return new GeminiCLIAgent();
}

registerAgent(AGENT_NAMES.GEMINI, () => new GeminiCLIAgent());
