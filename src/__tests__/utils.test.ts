/**
 * Tests for Utility Modules
 */

import { describe, it, expect } from 'vitest';
import {
  truncateRunes,
  collapseWhitespace,
  capitalizeFirst,
  countLines,
} from '../utils/string-utils.js';
import {
  parseFromBytes,
  parseFromBytesAtLine,
  sliceFromLine,
  extractUserContent,
} from '../utils/transcript-parse.js';
import { stripIDEContextTags } from '../utils/ide-tags.js';
import {
  parseCheckpoint,
  parseAllSessions,
  parseStrategy,
  formatStrategy,
  formatCheckpoint,
  formatShadowCommit,
} from '../utils/trailers.js';

describe('String Utils', () => {
  describe('truncateRunes', () => {
    it('should not truncate short strings', () => {
      expect(truncateRunes('hello', 10)).toBe('hello');
    });

    it('should truncate long strings with suffix', () => {
      expect(truncateRunes('hello world', 5)).toBe('hello...');
    });

    it('should use custom suffix', () => {
      expect(truncateRunes('hello world', 5, '…')).toBe('hello…');
    });

    it('should handle empty string', () => {
      expect(truncateRunes('', 5)).toBe('');
    });

    it('should handle multi-byte characters correctly', () => {
      const emoji = '😀😁😂🤣😃';
      expect(truncateRunes(emoji, 3)).toBe('😀😁😂...');
    });
  });

  describe('collapseWhitespace', () => {
    it('should collapse multiple spaces', () => {
      expect(collapseWhitespace('hello   world')).toBe('hello world');
    });

    it('should collapse newlines', () => {
      expect(collapseWhitespace('hello\n\nworld')).toBe('hello world');
    });

    it('should trim', () => {
      expect(collapseWhitespace('  hello  ')).toBe('hello');
    });
  });

  describe('capitalizeFirst', () => {
    it('should capitalize first letter', () => {
      expect(capitalizeFirst('hello')).toBe('Hello');
    });

    it('should handle empty string', () => {
      expect(capitalizeFirst('')).toBe('');
    });
  });

  describe('countLines', () => {
    it('should count 0 for empty', () => {
      expect(countLines('')).toBe(0);
    });

    it('should count 1 for no newline', () => {
      expect(countLines('hello')).toBe(1);
    });

    it('should count correctly with newlines', () => {
      expect(countLines('a\nb\nc\n')).toBe(3);
    });

    it('should count extra line without trailing newline', () => {
      expect(countLines('a\nb\nc')).toBe(3);
    });
  });
});

describe('Transcript Parse', () => {
  describe('parseFromBytes', () => {
    it('should parse JSONL content', () => {
      const jsonl = [
        JSON.stringify({ type: 'user', message: { content: 'Hello' } }),
        JSON.stringify({ type: 'assistant', message: { content: 'Hi' } }),
      ].join('\n');

      const lines = parseFromBytes(jsonl);
      expect(lines).toHaveLength(2);
      expect(lines[0].type).toBe('user');
      expect(lines[1].type).toBe('assistant');
    });

    it('should skip malformed JSON lines', () => {
      const input = '{"type":"user"}\nnot json\n{"type":"assistant"}\n';
      const lines = parseFromBytes(input);
      expect(lines).toHaveLength(2);
    });

    it('should handle buffer input', () => {
      const buf = Buffer.from('{"type":"user"}\n');
      const lines = parseFromBytes(buf);
      expect(lines).toHaveLength(1);
    });

    it('should normalize role to type (Cursor format)', () => {
      const input = JSON.stringify({ role: 'user', message: {} });
      const lines = parseFromBytes(input);
      expect(lines[0].type).toBe('user');
    });
  });

  describe('parseFromBytesAtLine', () => {
    it('should parse from a specific line', () => {
      const jsonl = [
        JSON.stringify({ type: 'user', message: { content: 'First' } }),
        JSON.stringify({ type: 'assistant', message: { content: 'Second' } }),
        JSON.stringify({ type: 'user', message: { content: 'Third' } }),
      ].join('\n');

      const lines = parseFromBytesAtLine(jsonl, 2);
      expect(lines).toHaveLength(1);
      expect(lines[0].type).toBe('user');
    });
  });

  describe('sliceFromLine', () => {
    it('should return full buffer for startLine 0', () => {
      const buf = Buffer.from('line0\nline1\nline2\n');
      const sliced = sliceFromLine(buf, 0);
      expect(sliced.toString()).toBe('line0\nline1\nline2\n');
    });

    it('should slice from line 1', () => {
      const buf = Buffer.from('line0\nline1\nline2\n');
      const sliced = sliceFromLine(buf, 1);
      expect(sliced.toString()).toBe('line1\nline2\n');
    });

    it('should slice from line 2', () => {
      const buf = Buffer.from('line0\nline1\nline2\n');
      const sliced = sliceFromLine(buf, 2);
      expect(sliced.toString()).toBe('line2\n');
    });

    it('should return empty for out-of-range', () => {
      const buf = Buffer.from('line0\nline1\n');
      const sliced = sliceFromLine(buf, 10);
      expect(sliced.length).toBe(0);
    });

    it('should handle empty buffer', () => {
      const sliced = sliceFromLine(Buffer.alloc(0), 0);
      expect(sliced.length).toBe(0);
    });
  });

  describe('extractUserContent', () => {
    it('should extract string content', () => {
      expect(extractUserContent({ content: 'Hello world' })).toBe('Hello world');
    });

    it('should extract array content', () => {
      const msg = {
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'image', data: 'base64' },
          { type: 'text', text: 'Part 2' },
        ],
      };
      expect(extractUserContent(msg)).toBe('Part 1\n\nPart 2');
    });

    it('should return empty for null', () => {
      expect(extractUserContent(null)).toBe('');
    });

    it('should strip IDE context tags', () => {
      const msg = { content: '<ide_opened_file>foo.ts</ide_opened_file>Hello' };
      const result = extractUserContent(msg);
      expect(result).not.toContain('ide_opened_file');
      expect(result).toContain('Hello');
    });
  });
});

describe('IDE Tags', () => {
  describe('stripIDEContextTags', () => {
    it('should strip ide_opened_file tags', () => {
      expect(stripIDEContextTags('<ide_opened_file>foo.ts</ide_opened_file>Code here')).toBe(
        'Code here',
      );
    });

    it('should strip ide_selection tags', () => {
      expect(stripIDEContextTags('Text <ide_selection>selected</ide_selection> more')).toBe(
        'Text  more',
      );
    });

    it('should strip system-reminder tags', () => {
      expect(stripIDEContextTags('<system-reminder>stuff</system-reminder>Content')).toBe(
        'Content',
      );
    });

    it('should strip user_query tags but keep content', () => {
      expect(stripIDEContextTags('<user_query>Hello world</user_query>')).toBe('Hello world');
    });

    it('should handle text without tags', () => {
      expect(stripIDEContextTags('Just normal text')).toBe('Just normal text');
    });
  });
});

describe('Trailers', () => {
  describe('parseCheckpoint', () => {
    it('should parse checkpoint from trailer', () => {
      const message = 'Some commit\n\nRunlog-Checkpoint: abc123def456';
      const [cpID, found] = parseCheckpoint(message);
      expect(found).toBe(true);
      expect(cpID).toBe('abc123def456');
    });

    it('should return null for no checkpoint', () => {
      const [cpID, found] = parseCheckpoint('Simple commit message');
      expect(found).toBe(false);
      expect(cpID).toBeNull();
    });
  });

  describe('parseAllSessions', () => {
    it('should parse session IDs from trailers', () => {
      const message = 'Commit\n\nRunlog-Session: session-1\nRunlog-Session: session-2';
      const sessions = parseAllSessions(message);
      expect(sessions).toContain('session-1');
      expect(sessions).toContain('session-2');
    });

    it('should return empty for no sessions', () => {
      const sessions = parseAllSessions('Simple message');
      expect(sessions).toHaveLength(0);
    });
  });

  describe('parseStrategy', () => {
    it('should parse strategy from trailer', () => {
      const message = 'Commit\n\nRunlog-Strategy: manual';
      const [strategy, found] = parseStrategy(message);
      expect(found).toBe(true);
      expect(strategy).toBe('manual');
    });

    it('should return empty for no strategy', () => {
      const [strategy, found] = parseStrategy('Simple message');
      expect(found).toBe(false);
      expect(strategy).toBe('');
    });
  });

  describe('format functions', () => {
    it('should format strategy trailer', () => {
      const result = formatStrategy('Fix bug', 'manual');
      expect(result).toContain('Fix bug');
      expect(result).toContain('Runlog-Strategy: manual');
    });

    it('should format checkpoint trailer', () => {
      const result = formatCheckpoint('Add feature', 'abc123def456' as any);
      expect(result).toContain('Add feature');
      expect(result).toContain('Runlog-Checkpoint: abc123def456');
    });

    it('should format shadow commit with session', () => {
      const result = formatShadowCommit('Update code', 'meta/dir', 'session-1');
      expect(result).toContain('Update code');
      expect(result).toContain('Runlog-Metadata: meta/dir');
      expect(result).toContain('Runlog-Session: session-1');
      expect(result).toContain('Runlog-Strategy: manual-commit');
    });
  });
});
