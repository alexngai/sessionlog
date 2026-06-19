/**
 * Summarize Module
 *
 * AI-powered summarization of development sessions. Builds condensed
 * transcripts from various agent formats and generates structured
 * summaries using an LLM.
 */

import type { AgentType, Summary } from '../types.js';
import { AGENT_TYPES } from '../types.js';
import { classifyApplyPatchPaths } from '../agent/agents/codex.js';
import {
  parseFromBytes,
  extractUserContent,
  TYPE_USER,
  TYPE_ASSISTANT,
  CONTENT_TYPE_TEXT,
  CONTENT_TYPE_TOOL_USE,
  type TranscriptLine,
  type ContentBlock,
  type ToolInput,
} from '../utils/transcript-parse.js';

// ============================================================================
// Types
// ============================================================================

/** Type of a condensed transcript entry. */
export type EntryType = 'user' | 'assistant' | 'tool';

/** A single entry in a condensed transcript. */
export interface Entry {
  type: EntryType;
  content?: string;
  toolName?: string;
  toolDetail?: string;
}

/** Input for summary generation. */
export interface SummarizeInput {
  transcript: Entry[];
  filesTouched: string[];
}

/** Interface for summary generators (e.g., Claude CLI). */
export interface SummaryGenerator {
  generate(input: SummarizeInput): Promise<Summary>;
}

// ============================================================================
// Condensed Transcript Building
// ============================================================================

/** Tools that should only show minimal detail (path, URL, etc.) */
const minimalDetailTools = new Set(['Skill', 'Read', 'WebFetch']);

/** Content prefix for skill content injections (skipped in condensation). */
const skillContentPrefix = 'Base directory for this skill:';

/**
 * Build a condensed transcript from raw bytes based on agent type.
 */
export function buildCondensedTranscriptFromBytes(
  content: Buffer | string,
  agentType: AgentType,
): Entry[] {
  switch (agentType) {
    case AGENT_TYPES.GEMINI:
      return buildCondensedTranscriptFromGemini(content);
    case AGENT_TYPES.OPENCODE:
      return buildCondensedTranscriptFromOpenCode(content);
    case AGENT_TYPES.CODEX:
      return buildCondensedTranscriptFromCodex(content);
    default:
      // Claude Code, Cursor, Unknown - all use JSONL format
      return buildCondensedTranscriptFromJSONL(content);
  }
}

/**
 * Build condensed transcript from Codex rollout JSONL format.
 *
 * Each line is `{ timestamp, type, payload }`. User and assistant turns are
 * `response_item` messages; file mutations are `custom_tool_call` entries named
 * `apply_patch` whose `input` is a plain-text patch envelope.
 */
function buildCondensedTranscriptFromCodex(content: Buffer | string): Entry[] {
  const str = typeof content === 'string' ? content : content.toString('utf-8');
  const entries: Entry[] = [];

  for (const rawLine of str.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: { type?: string; payload?: Record<string, unknown> };
    try {
      parsed = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
    } catch {
      continue;
    }

    if (parsed.type !== 'response_item' || !parsed.payload) continue;
    const payload = parsed.payload;
    const payloadType = payload.type as string | undefined;

    if (payloadType === 'message') {
      const text = extractCodexMessageText(payload.content);
      const role = payload.role as string | undefined;
      if (text && role === 'user') {
        entries.push({ type: 'user', content: text });
      } else if (text && role === 'assistant') {
        entries.push({ type: 'assistant', content: text });
      }
    } else if (payloadType === 'custom_tool_call') {
      const name = (payload.name as string | undefined) ?? '';
      const input = (payload.input as string | undefined) ?? '';
      entries.push({
        type: 'tool',
        toolName: name,
        toolDetail: extractCodexToolDetail(name, input),
      });
    }
  }

  return entries;
}

function extractCodexMessageText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const item of content) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).text === 'string'
    ) {
      const type = (item as Record<string, unknown>).type;
      if (type === 'input_text' || type === 'output_text') {
        texts.push((item as Record<string, unknown>).text as string);
      }
    }
  }
  return texts.join('\n');
}

function extractCodexToolDetail(name: string, input: string): string {
  // apply_patch envelopes are long; summarize them as the affected file list.
  if (name === 'apply_patch') {
    const { added, modified, deleted } = classifyApplyPatchPaths(input);
    const files = [...added, ...modified, ...deleted];
    return files.join(', ');
  }
  return input.length > 120 ? input.slice(0, 120) : input;
}

/**
 * Build condensed transcript from JSONL format (Claude Code, Cursor).
 */
function buildCondensedTranscriptFromJSONL(content: Buffer | string): Entry[] {
  const lines = parseFromBytes(content);
  return buildCondensedTranscript(lines);
}

/**
 * Build condensed transcript from parsed JSONL transcript lines.
 */
export function buildCondensedTranscript(lines: TranscriptLine[]): Entry[] {
  const entries: Entry[] = [];

  for (const line of lines) {
    switch (line.type) {
      case TYPE_USER: {
        const entry = extractUserEntry(line);
        if (entry) entries.push(entry);
        break;
      }
      case TYPE_ASSISTANT: {
        const assistantEntries = extractAssistantEntries(line);
        entries.push(...assistantEntries);
        break;
      }
    }
  }

  return entries;
}

function extractUserEntry(line: TranscriptLine): Entry | null {
  const content = extractUserContent(line.message);
  if (!content) return null;

  // Skip skill content injections
  if (content.startsWith(skillContentPrefix)) return null;

  return { type: 'user', content };
}

function extractAssistantEntries(line: TranscriptLine): Entry[] {
  if (!line.message || typeof line.message !== 'object') return [];

  const msg = line.message as Record<string, unknown>;
  const contentArr = msg.content;
  if (!Array.isArray(contentArr)) return [];

  const entries: Entry[] = [];

  for (const block of contentArr as ContentBlock[]) {
    switch (block.type) {
      case CONTENT_TYPE_TEXT:
        if (block.text) {
          entries.push({ type: 'assistant', content: block.text });
        }
        break;
      case CONTENT_TYPE_TOOL_USE: {
        const input = (block.input ?? {}) as ToolInput;
        const detail = extractToolDetail(block.name ?? '', input);
        entries.push({
          type: 'tool',
          toolName: block.name ?? '',
          toolDetail: detail,
        });
        break;
      }
    }
  }

  return entries;
}

function extractToolDetail(toolName: string, input: ToolInput): string {
  if (minimalDetailTools.has(toolName)) {
    switch (toolName) {
      case 'Skill':
        return input.skill ?? '';
      case 'Read':
        return input.file_path ?? input.notebook_path ?? '';
      case 'WebFetch':
        return input.url ?? '';
    }
  }

  return (
    input.description ??
    input.command ??
    input.file_path ??
    input.notebook_path ??
    input.pattern ??
    ''
  );
}

/**
 * Build condensed transcript from Gemini JSON format.
 */
function buildCondensedTranscriptFromGemini(content: Buffer | string): Entry[] {
  const data = typeof content === 'string' ? content : content.toString('utf-8');
  const entries: Entry[] = [];

  try {
    const transcript = JSON.parse(data) as {
      messages: Array<{
        type: string;
        content: unknown;
        toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
      }>;
    };

    for (const msg of transcript.messages ?? []) {
      const msgContent = extractGeminiContent(msg.content);

      switch (msg.type) {
        case 'user':
          if (msgContent) entries.push({ type: 'user', content: msgContent });
          break;
        case 'gemini':
          if (msgContent) entries.push({ type: 'assistant', content: msgContent });
          for (const tc of msg.toolCalls ?? []) {
            entries.push({
              type: 'tool',
              toolName: tc.name,
              toolDetail: extractGenericToolDetail(tc.args),
            });
          }
          break;
      }
    }
  } catch {
    // Invalid JSON
  }

  return entries;
}

/**
 * Build condensed transcript from OpenCode export JSON format.
 */
function buildCondensedTranscriptFromOpenCode(content: Buffer | string): Entry[] {
  const data = typeof content === 'string' ? content : content.toString('utf-8');
  const entries: Entry[] = [];

  try {
    const session = JSON.parse(data) as {
      messages: Array<{
        info: { role: string };
        parts: Array<{
          type: string;
          text?: string;
          tool?: string;
          state?: { input?: Record<string, unknown> };
        }>;
      }>;
    };

    for (const msg of session.messages ?? []) {
      const text = extractOpenCodeText(msg.parts);

      switch (msg.info.role) {
        case 'user':
          if (text) entries.push({ type: 'user', content: text });
          break;
        case 'assistant':
          if (text) entries.push({ type: 'assistant', content: text });
          for (const part of msg.parts) {
            if (part.type === 'tool' && part.state) {
              entries.push({
                type: 'tool',
                toolName: part.tool ?? '',
                toolDetail: extractOpenCodeToolDetail(part.state.input ?? {}),
              });
            }
          }
          break;
      }
    }
  } catch {
    // Invalid JSON
  }

  return entries;
}

function extractGeminiContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
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
    return texts.join('\n');
  }
  return '';
}

function extractOpenCodeText(parts: Array<{ type: string; text?: string }>): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      texts.push(part.text);
    }
  }
  return texts.join('\n');
}

function extractGenericToolDetail(args: Record<string, unknown>): string {
  for (const key of ['description', 'command', 'file_path', 'path', 'pattern']) {
    if (typeof args[key] === 'string' && args[key]) return args[key] as string;
  }
  return '';
}

function extractOpenCodeToolDetail(input: Record<string, unknown>): string {
  for (const key of ['description', 'command', 'filePath', 'path', 'pattern']) {
    if (typeof input[key] === 'string' && input[key]) return input[key] as string;
  }
  return '';
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format a condensed transcript as human-readable text for LLM input.
 */
export function formatCondensedTranscript(input: SummarizeInput): string {
  const lines: string[] = [];

  for (const entry of input.transcript) {
    switch (entry.type) {
      case 'user':
        lines.push(`[User] ${entry.content}`);
        break;
      case 'assistant':
        lines.push(`[Assistant] ${entry.content}`);
        break;
      case 'tool':
        if (entry.toolDetail) {
          lines.push(`[Tool] ${entry.toolName}: ${entry.toolDetail}`);
        } else {
          lines.push(`[Tool] ${entry.toolName}`);
        }
        break;
    }
  }

  if (input.filesTouched.length > 0) {
    lines.push('');
    lines.push('[Files Modified]');
    for (const file of input.filesTouched) {
      lines.push(`- ${file}`);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Summary Generation
// ============================================================================

/** The prompt template used for summarization. */
const SUMMARIZATION_PROMPT_TEMPLATE = `Analyze this development session transcript and generate a structured summary.

<transcript>
%TRANSCRIPT%
</transcript>

Return a JSON object with this exact structure:
{
  "intent": "What the user was trying to accomplish (1-2 sentences)",
  "outcome": "What was actually achieved (1-2 sentences)",
  "learnings": {
    "repo": ["Codebase-specific patterns, conventions, or gotchas discovered"],
    "code": [{"path": "file/path.go", "line": 42, "end_line": 56, "finding": "What was learned"}],
    "workflow": ["General development practices or tool usage insights"]
  },
  "friction": ["Problems, blockers, or annoyances encountered"],
  "open_items": ["Tech debt, unfinished work, or things to revisit later"]
}

Guidelines:
- Be concise but specific
- Include line numbers for code learnings when the transcript references specific lines
- Friction should capture both blockers and minor annoyances
- Open items are things intentionally deferred, not failures
- Empty arrays are fine if a category doesn't apply
- Return ONLY the JSON object, no markdown formatting or explanation`;

/**
 * Build the summarization prompt from transcript text.
 */
export function buildSummarizationPrompt(transcriptText: string): string {
  return SUMMARIZATION_PROMPT_TEMPLATE.replace('%TRANSCRIPT%', transcriptText);
}

/**
 * Extract JSON from potential markdown code block wrapping.
 */
export function extractJSONFromMarkdown(s: string): string {
  let trimmed = s.trim();

  if (trimmed.startsWith('```json')) {
    trimmed = trimmed.slice(7);
    const idx = trimmed.lastIndexOf('```');
    if (idx !== -1) trimmed = trimmed.slice(0, idx);
    return trimmed.trim();
  }

  if (trimmed.startsWith('```')) {
    trimmed = trimmed.slice(3);
    const idx = trimmed.lastIndexOf('```');
    if (idx !== -1) trimmed = trimmed.slice(0, idx);
    return trimmed.trim();
  }

  return trimmed;
}

/**
 * Generate a summary from raw transcript bytes.
 */
export async function generateFromTranscript(
  transcriptBytes: Buffer | string,
  filesTouched: string[],
  agentType: AgentType,
  generator: SummaryGenerator,
): Promise<Summary> {
  const content =
    typeof transcriptBytes === 'string' ? transcriptBytes : transcriptBytes.toString('utf-8');
  if (!content.trim()) {
    throw new Error('empty transcript');
  }

  const condensed = buildCondensedTranscriptFromBytes(transcriptBytes, agentType);
  if (condensed.length === 0) {
    throw new Error('transcript has no content to summarize');
  }

  const input: SummarizeInput = {
    transcript: condensed,
    filesTouched,
  };

  return generator.generate(input);
}
