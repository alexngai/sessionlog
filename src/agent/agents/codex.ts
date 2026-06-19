/**
 * Codex Agent
 *
 * Implementation of the Sessionlog agent interface for OpenAI's Codex CLI.
 *
 * Codex hosts Claude-compatible lifecycle hooks via `.codex/hooks.json`
 * (matcher groups, JSON over stdin/stdout). The hook system is gated behind a
 * feature flag, so installation also writes `[features] hooks = true` into the
 * project-level `.codex/config.toml`.
 *
 * Transcripts are JSONL "rollout" files stored under `CODEX_HOME/sessions/
 * YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl`. Each line is
 * `{ timestamp, type, payload }` where `type` is one of `session_meta`,
 * `response_item`, `event_msg`, `turn_context`, or `compacted`.
 *
 * Ported from the Go reference implementation in the Entire CLI
 * (cmd/entire/cli/agent/codex).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  AGENT_NAMES,
  AGENT_TYPES,
  type HookInput,
  type Event,
  type TokenUsage,
  EventType,
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

const CODEX_DIR = '.codex';
const HOOKS_FILE_NAME = 'hooks.json';
const CONFIG_FILE_NAME = 'config.toml';

const SESSIONLOG_HOOK_PREFIX = 'sessionlog ';

/** Hook verbs Codex supports — these become `sessionlog hooks codex <verb>`. */
const HOOK_NAME_SESSION_START = 'session-start';
const HOOK_NAME_USER_PROMPT_SUBMIT = 'user-prompt-submit';
const HOOK_NAME_STOP = 'stop';

const HOOK_NAMES = [HOOK_NAME_SESSION_START, HOOK_NAME_USER_PROMPT_SUBMIT, HOOK_NAME_STOP] as const;

/**
 * The TOML line that enables the hooks feature. Codex renamed the flag from
 * `codex_hooks` to `hooks` in 0.129.0; the legacy form still works but emits a
 * deprecation warning, so we rewrite it when seen.
 */
const FEATURE_LINE = 'hooks = true';
const LEGACY_FEATURE_LINE = 'codex_hooks = true';

// ============================================================================
// hooks.json structure
// ============================================================================

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
}

interface MatcherGroup {
  matcher: string | null;
  hooks: HookEntry[];
}

/** Event types we manage in hooks.json. */
const MANAGED_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'] as const;

/** Maps a hooks.json event key to its `sessionlog hooks codex <verb>` subcommand. */
const HOOK_EVENT_TO_VERB: Record<(typeof MANAGED_HOOK_EVENTS)[number], string> = {
  SessionStart: HOOK_NAME_SESSION_START,
  UserPromptSubmit: HOOK_NAME_USER_PROMPT_SUBMIT,
  Stop: HOOK_NAME_STOP,
};

// ============================================================================
// Rollout transcript types (JSONL)
// ============================================================================

interface RolloutLine {
  timestamp?: string;
  type?: string; // "session_meta" | "response_item" | "event_msg" | "turn_context" | "compacted"
  payload?: unknown;
}

const ROLLOUT_TYPE_RESPONSE_ITEM = 'response_item';
const ROLLOUT_TYPE_EVENT_MSG = 'event_msg';
const ROLLOUT_TYPE_SESSION_META = 'session_meta';

interface SessionMetaPayload {
  id?: string;
  timestamp?: string;
}

interface ResponseItemPayload {
  type?: string; // "message" | "custom_tool_call" | "custom_tool_call_output" | "reasoning" | ...
  role?: string;
  name?: string;
  input?: string; // apply_patch input (plain text, not JSON)
  content?: ContentItem[];
}

interface ContentItem {
  type?: string; // "input_text" | "output_text"
  text?: string;
}

interface EventMsgPayload {
  type?: string; // "token_count" | "task_started" | "task_complete" | ...
  info?: { total_token_usage?: TokenUsageData };
}

interface TokenUsageData {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

// apply_patch envelope verbs (codex-rs/apply-patch/src/parser.rs).
const APPLY_PATCH_VERB_ADD = 'Add';
const APPLY_PATCH_VERB_UPDATE = 'Update';
const APPLY_PATCH_VERB_DELETE = 'Delete';

const applyPatchFileRegex = /\*\*\* (Add|Update|Delete) File: (.+)/;
const applyPatchMoveRegex = /\*\*\* Move to: (.+)/;

// ============================================================================
// Codex Agent Implementation
// ============================================================================

class CodexAgent
  implements Agent, HookSupport, TranscriptAnalyzer, TokenCalculator, TranscriptChunker
{
  readonly name = AGENT_NAMES.CODEX;
  readonly type = AGENT_TYPES.CODEX;
  readonly description = "Codex - OpenAI's CLI coding agent";
  readonly isPreview = true;
  readonly protectedDirs = [CODEX_DIR];

  async detectPresence(cwd?: string): Promise<boolean> {
    const repoRoot = cwd ?? process.cwd();
    const codexDir = path.join(repoRoot, CODEX_DIR);
    try {
      const stat = await fs.promises.stat(codexDir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async getSessionDir(_repoPath: string): Promise<string> {
    if (process.env.SESSIONLOG_TEST_CODEX_SESSION_DIR) {
      return process.env.SESSIONLOG_TEST_CODEX_SESSION_DIR;
    }
    return path.join(resolveCodexHome(), 'sessions');
  }

  getSessionID(input: HookInput): string {
    return input.sessionID;
  }

  resolveSessionFile(sessionDir: string, agentSessionID: string): string {
    // Codex hands us an absolute transcript path directly in hook payloads.
    if (path.isAbsolute(agentSessionID)) {
      return agentSessionID;
    }
    const found = findRolloutBySessionID(sessionDir, agentSessionID);
    if (found) return found;
    if (sessionDir) {
      return path.join(sessionDir, `${agentSessionID}.jsonl`);
    }
    return agentSessionID;
  }

  async readTranscript(sessionRef: string): Promise<Buffer> {
    return fs.promises.readFile(sessionRef);
  }

  formatResumeCommand(sessionID: string): string {
    return `codex resume ${sessionID}`;
  }

  // ===========================================================================
  // HookSupport
  // ===========================================================================

  hookNames(): string[] {
    return [...HOOK_NAMES];
  }

  parseHookEvent(hookName: string, stdin: string): Event | null {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(stdin) as Record<string, unknown>;
    } catch {
      return null;
    }

    const sessionID = String(data.session_id ?? '');
    const sessionRef = derefString(data.transcript_path);
    const model = data.model != null ? String(data.model) : undefined;

    switch (hookName) {
      case HOOK_NAME_SESSION_START:
        return {
          type: EventType.SessionStart,
          sessionID,
          sessionRef,
          timestamp: new Date(),
          ...(model ? { metadata: { model } } : {}),
        };

      case HOOK_NAME_USER_PROMPT_SUBMIT:
        return {
          type: EventType.TurnStart,
          sessionID,
          sessionRef,
          prompt: String(data.prompt ?? ''),
          timestamp: new Date(),
          ...(model ? { metadata: { model } } : {}),
        };

      case HOOK_NAME_STOP:
        return {
          type: EventType.TurnEnd,
          sessionID,
          sessionRef,
          timestamp: new Date(),
          ...(model ? { metadata: { model } } : {}),
        };

      default:
        return null;
    }
  }

  async installHooks(repoPath: string, force = false): Promise<number> {
    const hooksPath = path.join(repoPath, CODEX_DIR, HOOKS_FILE_NAME);

    // Read-modify-write, preserving unknown top-level keys ($schema) and
    // unknown hook event types (future Codex events).
    let topLevel: Record<string, unknown> = {};
    try {
      const content = await fs.promises.readFile(hooksPath, 'utf-8');
      topLevel = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // No existing hooks.json
    }

    const hooks = (topLevel.hooks ?? {}) as Record<string, MatcherGroup[]>;

    // Idempotency check: if not forcing and every managed event already has a
    // sessionlog hook, skip the rewrite (but still ensure the feature flag).
    if (!force) {
      const allInstalled = MANAGED_HOOK_EVENTS.every((evt) => hasSessionlogHook(hooks[evt] ?? []));
      if (allInstalled) {
        await ensureProjectFeatureEnabled(repoPath);
        return 0;
      }
    }

    if (force) {
      for (const evt of MANAGED_HOOK_EVENTS) {
        if (hooks[evt]) hooks[evt] = removeSessionlogHooks(hooks[evt]);
      }
    }

    let count = 0;
    for (const evt of MANAGED_HOOK_EVENTS) {
      const cmd = `${SESSIONLOG_HOOK_PREFIX}hooks codex ${HOOK_EVENT_TO_VERB[evt]}`;
      const groups = hooks[evt] ?? [];
      if (!hookCommandExists(groups, cmd)) {
        hooks[evt] = addHook(groups, cmd);
        count++;
      }
    }

    // Drop any empty event arrays for tidiness.
    for (const evt of MANAGED_HOOK_EVENTS) {
      if (hooks[evt] && hooks[evt].length === 0) delete hooks[evt];
    }

    topLevel.hooks = hooks;

    await fs.promises.mkdir(path.dirname(hooksPath), { recursive: true });
    await fs.promises.writeFile(hooksPath, JSON.stringify(topLevel, null, 2) + '\n');

    // Hooks are gated behind a feature flag in the project config.toml.
    await ensureProjectFeatureEnabled(repoPath);

    return count;
  }

  async uninstallHooks(repoPath: string): Promise<void> {
    const hooksPath = path.join(repoPath, CODEX_DIR, HOOKS_FILE_NAME);

    let topLevel: Record<string, unknown>;
    try {
      const content = await fs.promises.readFile(hooksPath, 'utf-8');
      topLevel = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return; // Nothing to uninstall
    }

    const hooks = (topLevel.hooks ?? {}) as Record<string, MatcherGroup[]>;

    for (const evt of MANAGED_HOOK_EVENTS) {
      if (!hooks[evt]) continue;
      hooks[evt] = removeSessionlogHooks(hooks[evt]);
      if (hooks[evt].length === 0) delete hooks[evt];
    }

    if (Object.keys(hooks).length === 0) {
      delete topLevel.hooks;
    } else {
      topLevel.hooks = hooks;
    }

    await fs.promises.writeFile(hooksPath, JSON.stringify(topLevel, null, 2) + '\n');
  }

  async areHooksInstalled(repoPath: string): Promise<boolean> {
    const hooksPath = path.join(repoPath, CODEX_DIR, HOOKS_FILE_NAME);

    try {
      const content = await fs.promises.readFile(hooksPath, 'utf-8');
      const topLevel = JSON.parse(content) as Record<string, unknown>;
      const hooks = (topLevel.hooks ?? {}) as Record<string, MatcherGroup[]>;
      // Consider installed when every managed event has a sessionlog hook.
      return MANAGED_HOOK_EVENTS.every((evt) => hasSessionlogHook(hooks[evt] ?? []));
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // TranscriptAnalyzer
  // ===========================================================================

  async getTranscriptPosition(transcriptPath: string): Promise<number> {
    if (!transcriptPath) return 0;
    try {
      const data = await fs.promises.readFile(transcriptPath);
      return splitJSONL(data).length;
    } catch {
      return 0;
    }
  }

  async extractModifiedFilesFromOffset(
    transcriptPath: string,
    startOffset: number,
  ): Promise<{ files: string[]; currentPosition: number }> {
    if (!transcriptPath) return { files: [], currentPosition: 0 };

    let data: Buffer;
    try {
      data = await fs.promises.readFile(transcriptPath);
    } catch {
      return { files: [], currentPosition: 0 };
    }

    const lines = splitJSONL(data);
    const seen = new Set<string>();
    const files: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (i + 1 <= startOffset) continue; // line numbers are 1-based
      for (const f of extractFilesFromLine(lines[i])) {
        if (!seen.has(f)) {
          seen.add(f);
          files.push(f);
        }
      }
    }

    return { files, currentPosition: lines.length };
  }

  async extractPrompts(sessionRef: string, fromOffset: number): Promise<string[]> {
    let data: Buffer;
    try {
      data = await fs.promises.readFile(sessionRef);
    } catch {
      return [];
    }

    const prompts: string[] = [];
    const lines = splitJSONL(data);

    for (let i = 0; i < lines.length; i++) {
      if (i + 1 <= fromOffset) continue;
      const payload = responseItemPayload(lines[i]);
      if (!payload || payload.type !== 'message' || payload.role !== 'user') continue;

      for (const item of payload.content ?? []) {
        const text = (item.text ?? '').trim();
        if (text && item.type === 'input_text') {
          prompts.push(text);
        }
      }
    }

    return prompts;
  }

  async extractSummary(sessionRef: string): Promise<string> {
    let data: Buffer;
    try {
      data = await fs.promises.readFile(sessionRef);
    } catch {
      return '';
    }

    const lines = splitJSONL(data);
    // The last assistant message is the closest thing to a turn summary.
    for (let i = lines.length - 1; i >= 0; i--) {
      const payload = responseItemPayload(lines[i]);
      if (!payload || payload.type !== 'message' || payload.role !== 'assistant') continue;
      const texts = (payload.content ?? [])
        .filter((c) => c.type === 'output_text' && c.text)
        .map((c) => c.text!.trim())
        .filter(Boolean);
      if (texts.length > 0) return texts.join('\n');
    }

    return '';
  }

  // ===========================================================================
  // TokenCalculator
  // ===========================================================================

  /**
   * Codex reports cumulative `total_token_usage`, so usage for a checkpoint
   * range is the delta between the last token_count at/before the offset
   * (baseline) and the last token_count after it.
   */
  async calculateTokenUsage(transcriptData: Buffer, fromOffset: number): Promise<TokenUsage> {
    let baseline: TokenUsageData | null = null;
    let last: TokenUsageData | null = null;
    let apiCalls = 0;

    const lines = splitJSONL(transcriptData);
    for (let i = 0; i < lines.length; i++) {
      const line = parseRolloutLine(lines[i]);
      if (!line || line.type !== ROLLOUT_TYPE_EVENT_MSG) continue;

      const evt = line.payload as EventMsgPayload | undefined;
      if (!evt || evt.type !== 'token_count') continue;
      const usage = evt.info?.total_token_usage;
      if (!usage) continue;

      if (i + 1 <= fromOffset) {
        baseline = usage;
      } else {
        last = usage;
        apiCalls++;
      }
    }

    if (!last) {
      return {
        inputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        apiCallCount: 0,
      };
    }

    let inputTokens = last.input_tokens ?? 0;
    let cacheReadTokens = last.cached_input_tokens ?? 0;
    let outputTokens = last.output_tokens ?? 0;
    if (baseline) {
      inputTokens -= baseline.input_tokens ?? 0;
      cacheReadTokens -= baseline.cached_input_tokens ?? 0;
      outputTokens -= baseline.output_tokens ?? 0;
    }

    // Codex's input_tokens is inclusive of cached tokens; split out the fresh
    // (uncached) portion so it lines up with other agents' input accounting.
    let freshInputTokens = inputTokens - cacheReadTokens;
    if (freshInputTokens < 0) freshInputTokens = 0;

    return {
      inputTokens: freshInputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens,
      outputTokens,
      apiCallCount: apiCalls,
    };
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

  // ===========================================================================
  // Restore support (Plan B)
  //
  // These give a future "restore transcript to the agent's session dir" feature
  // the Codex-specific pieces it would need. sessionlog has no such call site
  // yet (resume relies on the native rollout still existing + `codex resume`),
  // so they are standalone, tested capabilities rather than wired-in behavior.
  // ===========================================================================

  /**
   * Compute the canonical rollout path Codex expects for a restored session so
   * `codex resume <id>` can rediscover it:
   * `<sessionDir>/YYYY/MM/DD/rollout-<UTC timestamp>-<id>.jsonl`.
   *
   * Returns null when the session ID is invalid or the transcript has no
   * parseable session_meta start time.
   */
  resolveRestoredSessionFile(
    sessionDir: string,
    agentSessionID: string,
    transcript: Buffer | string,
  ): string | null {
    if (!isValidAgentSessionID(agentSessionID)) return null;
    const startTime = parseSessionStartTime(transcript);
    if (!startTime) return null;
    return restoredRolloutPath(sessionDir, agentSessionID, startTime);
  }
}

// ============================================================================
// Codex home / rollout discovery
// ============================================================================

function resolveCodexHome(): string {
  const override = process.env.CODEX_HOME;
  if (override) return override;
  return path.join(os.homedir(), CODEX_DIR);
}

/**
 * Find a rollout file by session ID, searching the flat layout, the
 * sessions/YYYY/MM/DD tree, and the archived_sessions sibling tree. Returns the
 * lexicographically latest match so newer restores win deterministically.
 */
function findRolloutBySessionID(sessionDir: string, agentSessionID: string): string {
  if (!sessionDir || !agentSessionID) return '';

  const candidates: string[] = [];
  const treeRoots = [sessionDir, path.join(path.dirname(sessionDir), 'archived_sessions')];
  for (const root of treeRoots) {
    candidates.push(...globRolloutTree(root, agentSessionID));
  }

  if (candidates.length === 0) return '';
  candidates.sort();
  return candidates[candidates.length - 1];
}

/**
 * Walk a sessions root looking for `rollout-*-<sessionID>.jsonl` at either the
 * top level or nested under date-sharded subdirectories.
 */
function globRolloutTree(root: string, sessionID: string): string[] {
  const suffix = `-${sessionID}.jsonl`;
  const matches: string[] = [];

  const visit = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        if (entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) {
          matches.push(full);
        }
      } else if (entry.isDirectory() && depth < 3) {
        visit(full, depth + 1);
      }
    }
  };

  visit(root, 0);
  return matches;
}

// ============================================================================
// hooks.json helpers
// ============================================================================

function isSessionlogHook(command: string): boolean {
  return command.startsWith(SESSIONLOG_HOOK_PREFIX);
}

function hasSessionlogHook(groups: MatcherGroup[]): boolean {
  return groups.some((g) => g.hooks.some((h) => isSessionlogHook(h.command)));
}

function hookCommandExists(groups: MatcherGroup[], command: string): boolean {
  return groups.some((g) => g.hooks.some((h) => h.command === command));
}

function addHook(groups: MatcherGroup[], command: string): MatcherGroup[] {
  const entry: HookEntry = { type: 'command', command, timeout: 30 };
  // Add to an existing null-matcher group, or create one.
  for (const group of groups) {
    if (group.matcher === null) {
      group.hooks.push(entry);
      return groups;
    }
  }
  groups.push({ matcher: null, hooks: [entry] });
  return groups;
}

function removeSessionlogHooks(groups: MatcherGroup[]): MatcherGroup[] {
  const result: MatcherGroup[] = [];
  for (const group of groups) {
    const filtered = group.hooks.filter((h) => !isSessionlogHook(h.command));
    if (filtered.length > 0) {
      result.push({ ...group, hooks: filtered });
    }
  }
  return result;
}

// ============================================================================
// config.toml feature flag
// ============================================================================

/**
 * Ensure `[features] hooks = true` exists in the project-level
 * `.codex/config.toml`, rewriting the deprecated `codex_hooks = true` form if
 * present. Without this flag Codex ignores hooks.json entirely.
 */
async function ensureProjectFeatureEnabled(repoPath: string): Promise<void> {
  const configPath = path.join(repoPath, CODEX_DIR, CONFIG_FILE_NAME);

  let content = '';
  try {
    content = await fs.promises.readFile(configPath, 'utf-8');
  } catch {
    // No existing config.toml
  }

  const hasNew = containsFeatureLine(content, FEATURE_LINE);
  const hasLegacy = containsFeatureLine(content, LEGACY_FEATURE_LINE);

  if (hasNew && hasLegacy) {
    content = stripLegacyFeatureLine(content);
  } else if (hasNew) {
    return;
  } else if (hasLegacy) {
    content = content.replace(LEGACY_FEATURE_LINE, FEATURE_LINE);
  } else if (content.includes('[features]')) {
    content = content.replace('[features]', `[features]\n${FEATURE_LINE}`);
  } else {
    if (content.length > 0 && !content.endsWith('\n')) content += '\n';
    content += `\n[features]\n${FEATURE_LINE}\n`;
  }

  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, content);
}

/**
 * Exact-line match. A plain `includes` is wrong because "hooks = true" is a
 * substring of "codex_hooks = true".
 */
function containsFeatureLine(content: string, line: string): boolean {
  return content.split('\n').some((raw) => raw.trim() === line);
}

function stripLegacyFeatureLine(content: string): string {
  const idx = content.indexOf(LEGACY_FEATURE_LINE);
  if (idx < 0) return content;
  let end = idx + LEGACY_FEATURE_LINE.length;
  if (end < content.length && content[end] === '\n') end++;
  return content.slice(0, idx) + content.slice(end);
}

// ============================================================================
// Rollout parsing helpers
// ============================================================================

/** Split JSONL bytes into trimmed, non-empty lines. */
export function splitJSONL(data: Buffer | string): string[] {
  const str = typeof data === 'string' ? data : data.toString('utf-8');
  const lines: string[] = [];
  for (const raw of str.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) lines.push(trimmed);
  }
  return lines;
}

function parseRolloutLine(line: string): RolloutLine | null {
  try {
    return JSON.parse(line) as RolloutLine;
  } catch {
    return null;
  }
}

/** Parse a line and return its response_item payload, or null. */
function responseItemPayload(line: string): ResponseItemPayload | null {
  const parsed = parseRolloutLine(line);
  if (!parsed || parsed.type !== ROLLOUT_TYPE_RESPONSE_ITEM) return null;
  return (parsed.payload ?? null) as ResponseItemPayload | null;
}

/** Extract modified file paths from a single rollout JSONL line. */
function extractFilesFromLine(line: string): string[] {
  const payload = responseItemPayload(line);
  if (!payload) return [];
  if (payload.type === 'custom_tool_call' && payload.name === 'apply_patch') {
    return extractFilesFromApplyPatch(payload.input ?? '');
  }
  return [];
}

/** Return every file path in an apply_patch envelope, deduplicated. */
export function extractFilesFromApplyPatch(input: string): string[] {
  const { added, modified, deleted } = classifyApplyPatchPaths(input);
  const total = added.length + modified.length + deleted.length;
  if (total === 0) return [];
  return [...added, ...modified, ...deleted];
}

/**
 * Split an apply_patch envelope into added/modified/deleted file paths.
 *
 * Renames ("*** Update File: old\n*** Move to: new") are reclassified as a
 * Delete on the source and an Add on the destination. Add and Delete are sticky
 * — a later Update on the same path does not downgrade them. Each bucket is
 * sorted for deterministic output.
 */
export function classifyApplyPatchPaths(input: string): {
  added: string[];
  modified: string[];
  deleted: string[];
} {
  const bucket = new Map<string, string>();
  let lastUpdate = '';

  for (const line of input.split('\n')) {
    const fileMatch = applyPatchFileRegex.exec(line);
    if (fileMatch) {
      const verb = fileMatch[1];
      const p = fileMatch[2].trim();
      if (!p) continue;
      lastUpdate = verb === APPLY_PATCH_VERB_UPDATE ? p : '';
      const existing = bucket.get(p);
      if (existing === APPLY_PATCH_VERB_ADD || existing === APPLY_PATCH_VERB_DELETE) {
        continue; // sticky
      }
      bucket.set(p, verb);
      continue;
    }

    const moveMatch = applyPatchMoveRegex.exec(line);
    if (moveMatch) {
      const target = moveMatch[1].trim();
      if (!target) continue;
      if (lastUpdate) {
        const existing = bucket.get(lastUpdate);
        if (existing !== APPLY_PATCH_VERB_ADD && existing !== APPLY_PATCH_VERB_DELETE) {
          bucket.set(lastUpdate, APPLY_PATCH_VERB_DELETE);
        }
      }
      const existingTarget = bucket.get(target);
      if (existingTarget !== APPLY_PATCH_VERB_ADD && existingTarget !== APPLY_PATCH_VERB_DELETE) {
        bucket.set(target, APPLY_PATCH_VERB_ADD);
      }
      lastUpdate = '';
    }
  }

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [p, verb] of bucket) {
    if (verb === APPLY_PATCH_VERB_ADD) added.push(p);
    else if (verb === APPLY_PATCH_VERB_UPDATE) modified.push(p);
    else if (verb === APPLY_PATCH_VERB_DELETE) deleted.push(p);
  }
  added.sort();
  modified.sort();
  deleted.sort();
  return { added, modified, deleted };
}

/** Parse the first line's session_meta timestamp into a Date. */
export function parseSessionStartTime(data: Buffer | string): Date | null {
  const lines = splitJSONL(data);
  if (lines.length === 0) return null;

  const line = parseRolloutLine(lines[0]);
  if (!line || line.type !== ROLLOUT_TYPE_SESSION_META) return null;

  const meta = line.payload as SessionMetaPayload | undefined;
  if (!meta?.timestamp) return null;

  const date = new Date(meta.timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
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

function derefString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ============================================================================
// Restore sanitization (Plan B)
// ============================================================================

/** Codex session IDs are UUIDs; reject anything path-like or otherwise unsafe. */
function isValidAgentSessionID(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes('..');
}

function restoredRolloutPath(sessionDir: string, agentSessionID: string, startTime: Date): string {
  const yyyy = String(startTime.getUTCFullYear()).padStart(4, '0');
  const mm = String(startTime.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(startTime.getUTCDate()).padStart(2, '0');
  const hh = String(startTime.getUTCHours()).padStart(2, '0');
  const min = String(startTime.getUTCMinutes()).padStart(2, '0');
  const ss = String(startTime.getUTCSeconds()).padStart(2, '0');
  const stamp = `${yyyy}-${mm}-${dd}T${hh}-${min}-${ss}`;
  return path.join(sessionDir, yyyy, mm, dd, `rollout-${stamp}-${agentSessionID}.jsonl`);
}

/**
 * Strip history fragments that cannot be replayed when a Codex rollout is
 * reconstructed outside its original session context: encrypted `reasoning`
 * content, and `compaction` / `compaction_summary` items (both as standalone
 * response_items and inside a `compacted` line's `replacement_history`).
 */
export function sanitizePortableTranscript(data: Buffer | string): Buffer {
  const lines = splitJSONL(data);
  if (lines.length === 0) {
    return typeof data === 'string' ? Buffer.from(data) : data;
  }

  const sanitized: string[] = [];
  for (const line of lines) {
    const result = sanitizeRolloutLine(line);
    if (result === null) continue; // dropped
    sanitized.push(result);
  }

  if (sanitized.length === 0) {
    return typeof data === 'string' ? Buffer.from(data) : data;
  }
  return Buffer.from(sanitized.join('\n') + '\n');
}

/** Returns the sanitized line, or null if the line should be dropped entirely. */
function sanitizeRolloutLine(line: string): string | null {
  const parsed = parseRolloutLine(line);
  if (!parsed) return line;

  if (parsed.type === 'compacted') {
    return sanitizeCompactedLine(parsed);
  }
  if (parsed.type !== ROLLOUT_TYPE_RESPONSE_ITEM) {
    return line;
  }

  const payload = parsed.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload.type !== 'string') return line;

  switch (payload.type) {
    case 'reasoning':
      delete payload.encrypted_content;
      break;
    case 'compaction':
    case 'compaction_summary':
      return null; // drop
    default:
      return line;
  }

  parsed.payload = payload;
  return JSON.stringify(parsed);
}

function sanitizeCompactedLine(line: RolloutLine): string {
  const payload = line.payload as Record<string, unknown> | undefined;
  if (!payload || !Array.isArray(payload.replacement_history)) {
    return JSON.stringify(line);
  }
  payload.replacement_history = sanitizeHistoryItems(payload.replacement_history);
  line.payload = payload;
  return JSON.stringify(line);
}

function sanitizeHistoryItems(items: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      result.push(item);
      continue;
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.type !== 'string') {
      result.push(obj);
      continue;
    }
    switch (obj.type) {
      case 'reasoning':
        delete obj.encrypted_content;
        break;
      case 'compaction':
      case 'compaction_summary':
        continue; // drop
    }
    result.push(obj);
  }
  return result;
}

// ============================================================================
// Registration
// ============================================================================

export function createCodexAgent(): CodexAgent {
  return new CodexAgent();
}

registerAgent(AGENT_NAMES.CODEX, () => new CodexAgent());
