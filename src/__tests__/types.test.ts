/**
 * Tests for Runlog Core Types
 */

import { describe, it, expect } from 'vitest';
import {
  validateCheckpointID,
  checkpointIDPath,
  emptyTokenUsage,
  addTokenUsage,
  CHECKPOINT_ID_LENGTH,
  CHECKPOINT_ID_PATTERN,
  AGENT_NAMES,
  AGENT_TYPES,
  DEFAULT_AGENT_NAME,
} from '../types.js';

describe('Runlog Types', () => {
  describe('Agent Constants', () => {
    it('should have expected agent names', () => {
      expect(AGENT_NAMES.CLAUDE_CODE).toBe('claude-code');
      expect(AGENT_NAMES.CURSOR).toBe('cursor');
      expect(AGENT_NAMES.GEMINI).toBe('gemini');
      expect(AGENT_NAMES.OPENCODE).toBe('opencode');
    });

    it('should have expected agent types', () => {
      expect(AGENT_TYPES.CLAUDE_CODE).toBe('Claude Code');
      expect(AGENT_TYPES.CURSOR).toBe('Cursor IDE');
      expect(AGENT_TYPES.GEMINI).toBe('Gemini CLI');
    });

    it('should have Claude Code as default agent', () => {
      expect(DEFAULT_AGENT_NAME).toBe('claude-code');
    });
  });

  describe('Checkpoint ID', () => {
    it('should validate correct checkpoint IDs', () => {
      expect(validateCheckpointID('a3b2c4d5e6f7')).toBe(true);
      expect(validateCheckpointID('000000000000')).toBe(true);
      expect(validateCheckpointID('abcdef123456')).toBe(true);
    });

    it('should reject invalid checkpoint IDs', () => {
      expect(validateCheckpointID('')).toBe(false);
      expect(validateCheckpointID('short')).toBe(false);
      expect(validateCheckpointID('a3b2c4d5e6f7g')).toBe(false); // too long
      expect(validateCheckpointID('ABCDEF123456')).toBe(false); // uppercase
      expect(validateCheckpointID('xxxxxxxxxxxx')).toBe(false); // non-hex
    });

    it('should shard checkpoint ID into path', () => {
      expect(checkpointIDPath('a3b2c4d5e6f7')).toBe('a3/b2c4d5e6f7');
      expect(checkpointIDPath('00abcdef1234')).toBe('00/abcdef1234');
    });

    it('should have correct ID length constant', () => {
      expect(CHECKPOINT_ID_LENGTH).toBe(12);
    });

    it('should have correct ID pattern', () => {
      expect(CHECKPOINT_ID_PATTERN.test('a3b2c4d5e6f7')).toBe(true);
      expect(CHECKPOINT_ID_PATTERN.test('invalid')).toBe(false);
    });
  });

  describe('Token Usage', () => {
    it('should create empty token usage', () => {
      const usage = emptyTokenUsage();
      expect(usage.inputTokens).toBe(0);
      expect(usage.outputTokens).toBe(0);
      expect(usage.cacheCreationTokens).toBe(0);
      expect(usage.cacheReadTokens).toBe(0);
      expect(usage.apiCallCount).toBe(0);
      expect(usage.subagentTokens).toBeUndefined();
    });

    it('should add token usage', () => {
      const a = {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 10,
        cacheReadTokens: 5,
        apiCallCount: 2,
      };
      const b = {
        inputTokens: 200,
        outputTokens: 100,
        cacheCreationTokens: 20,
        cacheReadTokens: 10,
        apiCallCount: 3,
      };

      const result = addTokenUsage(a, b);
      expect(result.inputTokens).toBe(300);
      expect(result.outputTokens).toBe(150);
      expect(result.cacheCreationTokens).toBe(30);
      expect(result.cacheReadTokens).toBe(15);
      expect(result.apiCallCount).toBe(5);
    });

    it('should handle subagent tokens in addition', () => {
      const a = {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        apiCallCount: 1,
        subagentTokens: {
          inputTokens: 50,
          outputTokens: 25,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          apiCallCount: 1,
        },
      };
      const b = {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        apiCallCount: 1,
      };

      const result = addTokenUsage(a, b);
      expect(result.subagentTokens).toBeDefined();
      expect(result.subagentTokens!.inputTokens).toBe(50);
    });

    it('should return undefined subagent when neither has it', () => {
      const a = emptyTokenUsage();
      const b = emptyTokenUsage();
      const result = addTokenUsage(a, b);
      expect(result.subagentTokens).toBeUndefined();
    });
  });
});
