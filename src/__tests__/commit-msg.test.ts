/**
 * Tests for commit-msg hook helpers
 */

import { describe, it, expect } from 'vitest';
import { hasUserContent, stripCheckpointTrailer } from '../strategy/manual-commit.js';

describe('commit-msg hook helpers', () => {
  describe('hasUserContent', () => {
    it('should return true for message with user text', () => {
      expect(hasUserContent('feat: add login\n\nRunlog-Checkpoint: abc123def456')).toBe(true);
    });

    it('should return false for trailer-only message', () => {
      expect(hasUserContent('\nRunlog-Checkpoint: abc123def456\n')).toBe(false);
    });

    it('should return false for comments and trailer only', () => {
      const msg = [
        '',
        '# Please enter the commit message',
        '# Lines starting with # are ignored',
        '',
        'Runlog-Checkpoint: abc123def456',
        '',
      ].join('\n');
      expect(hasUserContent(msg)).toBe(false);
    });

    it('should return true for message with user text and comments', () => {
      const msg = [
        'fix: resolve race condition',
        '',
        '# Please enter the commit message',
        'Runlog-Checkpoint: abc123def456',
      ].join('\n');
      expect(hasUserContent(msg)).toBe(true);
    });

    it('should return false for empty message', () => {
      expect(hasUserContent('')).toBe(false);
    });

    it('should return false for comments only', () => {
      expect(hasUserContent('# This is a comment\n# Another comment\n')).toBe(false);
    });

    it('should return false for blank lines only', () => {
      expect(hasUserContent('\n\n\n')).toBe(false);
    });
  });

  describe('stripCheckpointTrailer', () => {
    it('should remove the trailer line', () => {
      const msg = 'feat: add feature\n\nRunlog-Checkpoint: abc123def456\n';
      const result = stripCheckpointTrailer(msg);
      expect(result).not.toContain('Runlog-Checkpoint');
      expect(result).toContain('feat: add feature');
    });

    it('should preserve other lines', () => {
      const msg = [
        'feat: add feature',
        '',
        'Some body text',
        'Runlog-Checkpoint: abc123def456',
        '# A comment',
      ].join('\n');
      const result = stripCheckpointTrailer(msg);
      expect(result).toContain('feat: add feature');
      expect(result).toContain('Some body text');
      expect(result).toContain('# A comment');
      expect(result).not.toContain('Runlog-Checkpoint');
    });

    it('should handle message without trailer', () => {
      const msg = 'feat: add feature\n\nSome body\n';
      expect(stripCheckpointTrailer(msg)).toBe(msg);
    });

    it('should handle trailer-only message', () => {
      const result = stripCheckpointTrailer('Runlog-Checkpoint: abc123def456');
      expect(result.trim()).toBe('');
    });
  });
});
