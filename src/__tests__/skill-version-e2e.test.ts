/**
 * End-to-end tests for Skill Version Resolution
 *
 * Tests the full pipeline: hook event → lifecycle dispatch → version resolver chain → session state on disk.
 * Uses a real git repo and real session/checkpoint stores with realistic skill directory layouts
 * matching .claude/skills/, .skilltree/skills/, and node_modules/ plugin patterns.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createClaudeCodeAgent } from '../agent/agents/claude-code.js';
import { createLifecycleHandler } from '../hooks/lifecycle.js';
import { createSessionStore } from '../store/session-store.js';
import { createCheckpointStore } from '../store/checkpoint-store.js';
import { EventType, type Event, type TrackedSkill } from '../types.js';

// ============================================================================
// Helpers
// ============================================================================

function initRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'pipe' });
}

function writeFile(dir: string, relPath: string, content: string): void {
  const absPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function commitFile(dir: string, relPath: string, content: string): string {
  writeFile(dir, relPath, content);
  execFileSync('git', ['add', relPath], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', `Add ${relPath}`], { cwd: dir, stdio: 'pipe' });
  return execFileSync('git', ['log', '-1', '--format=%H'], { cwd: dir, stdio: 'pipe' })
    .toString()
    .trim();
}

function makeEvent(overrides: Partial<Event> & { type: EventType }): Event {
  return {
    sessionID: 'e2e-version-session',
    sessionRef: '/path/to/transcript.jsonl',
    timestamp: new Date(),
    ...overrides,
  };
}

function setupLifecycle(tmpDir: string) {
  const sessionsDir = path.join(tmpDir, '.git', 'sessionlog-sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionStore = createSessionStore(tmpDir, sessionsDir);
  const checkpointStore = createCheckpointStore(tmpDir);
  const lifecycle = createLifecycleHandler({
    sessionStore,
    checkpointStore,
    cwd: tmpDir,
  });
  return { sessionStore, lifecycle };
}

async function startSession(
  lifecycle: ReturnType<typeof createLifecycleHandler>,
  agent: ReturnType<typeof createClaudeCodeAgent>,
): Promise<void> {
  await lifecycle.dispatch(agent, makeEvent({ type: EventType.SessionStart }));
}

async function dispatchSkillUse(
  lifecycle: ReturnType<typeof createLifecycleHandler>,
  agent: ReturnType<typeof createClaudeCodeAgent>,
  skillName: string,
  args?: string,
): Promise<void> {
  const hookStdin = JSON.stringify({
    session_id: 'e2e-version-session',
    transcript_path: '/path/to/transcript.jsonl',
    tool_use_id: `toolu_${Date.now()}`,
    tool_input: {
      skill: skillName,
      ...(args ? { args } : {}),
    },
    tool_response: 'Skill executed successfully',
  });

  const event = agent.parseHookEvent('post-skill', hookStdin);
  expect(event).not.toBeNull();
  await lifecycle.dispatch(agent, event!);
}

// ============================================================================
// Tests: .claude/skills/ (Repo-Level Claude Skills)
// ============================================================================

describe('Skill Version Resolution — E2E', () => {
  let tmpDir: string;
  let agent: ReturnType<typeof createClaudeCodeAgent>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionlog-skill-version-e2e-'));
    initRepo(tmpDir);
    agent = createClaudeCodeAgent();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // .claude/skills/ — Repo-level skills
  // ==========================================================================

  describe('.claude/skills/ — repo-level skills', () => {
    it('should resolve version and git SHA from a repo skill with frontmatter', async () => {
      const sha = commitFile(
        tmpDir,
        '.claude/skills/commit.md',
        `---
name: commit
version: 1.2.0
author: alice
status: active
---

# Commit Skill

Creates well-formatted git commits from staged changes.

## Instructions
- Review staged changes
- Generate a conventional commit message
`,
      );

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'commit', '-m "Add feature"');

      const state = await sessionStore.load('e2e-version-session');
      expect(state).not.toBeNull();
      expect(state!.skillsUsed).toBeDefined();
      expect(state!.skillsUsed).toHaveLength(1);

      const skill = state!.skillsUsed![0];
      expect(skill.name).toBe('commit');
      expect(skill.args).toBe('-m "Add feature"');
      expect(skill.sourceType).toBe('repo-skill');
      expect(skill.version).toBe('1.2.0');
      expect(skill.commitSha).toBe(sha);
      expect(skill.filePath).toBe('.claude/skills/commit.md');
    });

    it('should resolve skill in SKILL.md subdirectory layout', async () => {
      commitFile(
        tmpDir,
        '.claude/skills/review-pr/SKILL.md',
        `---
name: review-pr
version: 2.0.0
author: bob
status: active
---

# Review PR Skill
`,
      );

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'review-pr');

      const state = await sessionStore.load('e2e-version-session');
      const skill = state!.skillsUsed![0];
      expect(skill.sourceType).toBe('repo-skill');
      expect(skill.version).toBe('2.0.0');
      expect(skill.filePath).toContain('review-pr/SKILL.md');
    });

    it('should resolve version from nested metadata block in frontmatter', async () => {
      commitFile(
        tmpDir,
        '.claude/skills/deploy.md',
        `---
name: deploy
description: Deploy to production
metadata:
  version: 3.1.0
  author: carol
  status: experimental
---

# Deploy Skill
`,
      );

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'deploy');

      const state = await sessionStore.load('e2e-version-session');
      const skill = state!.skillsUsed![0];
      expect(skill.sourceType).toBe('repo-skill');
      expect(skill.version).toBe('3.1.0');
    });

    it('should handle skill without version frontmatter — still captures git SHA', async () => {
      const sha = commitFile(
        tmpDir,
        '.claude/skills/quick-fix.md',
        `# Quick Fix

No frontmatter at all — just raw markdown instructions.
`,
      );

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'quick-fix');

      const state = await sessionStore.load('e2e-version-session');
      const skill = state!.skillsUsed![0];
      expect(skill.sourceType).toBe('repo-skill');
      expect(skill.version).toBeUndefined();
      expect(skill.commitSha).toBe(sha);
      expect(skill.filePath).toBe('.claude/skills/quick-fix.md');
    });
  });

  // ==========================================================================
  // .skilltree/skills/ — skill-tree managed skills
  // ==========================================================================

  describe('.skilltree/skills/ — skill-tree managed skills', () => {
    it('should resolve a skill-tree skill from SKILL.md frontmatter', async () => {
      writeFile(
        tmpDir,
        '.skilltree/skills/database-migration/SKILL.md',
        `---
name: Database Migration
version: 2.3.0
author: carol
status: active
date: 2025-06-15
---

## Problem
Database schema needs to be migrated safely.

## Solution
Use Prisma/Drizzle migration patterns.

## Steps
1. Generate migration SQL
2. Review changes
3. Apply migration
`,
      );

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'database-migration');

      const state = await sessionStore.load('e2e-version-session');
      const skill = state!.skillsUsed![0];
      expect(skill.sourceType).toBe('skill-tree');
      expect(skill.version).toBe('2.3.0');
      expect(skill.filePath).toContain('.skilltree/skills/database-migration/SKILL.md');
    });

    it('should read .skilltree.json sidecar for upstream/source metadata', async () => {
      writeFile(
        tmpDir,
        '.skilltree/skills/api-design/SKILL.md',
        `---
name: API Design
version: 1.5.0
author: team-platform
status: active
---

# API Design Skill

Design RESTful APIs following company standards.
`,
      );

      writeFile(
        tmpDir,
        '.skilltree/skills/api-design/.skilltree.json',
        JSON.stringify(
          {
            source: {
              type: 'imported',
              location: 'https://github.com/company/shared-skills',
            },
            upstream: {
              remote: 'company-skills',
              skillId: 'api-design',
              version: '1.5.0',
              syncedAt: '2025-06-01T10:00:00Z',
            },
            installedAt: '2025-06-01T10:00:00Z',
            lastUpdated: '2025-06-01T10:00:00Z',
          },
          null,
          2,
        ),
      );

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'api-design');

      const state = await sessionStore.load('e2e-version-session');
      const skill = state!.skillsUsed![0];
      expect(skill.sourceType).toBe('skill-tree');
      expect(skill.version).toBe('1.5.0');
      expect(skill.upstreamVersion).toBe('1.5.0');
    });

    it('should handle skill-tree skill with missing .skilltree.json gracefully', async () => {
      writeFile(
        tmpDir,
        '.skilltree/skills/simple-skill/SKILL.md',
        `---
name: Simple Skill
version: 1.0.0
---

Just a simple skill without sidecar metadata.
`,
      );

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'simple-skill');

      const state = await sessionStore.load('e2e-version-session');
      const skill = state!.skillsUsed![0];
      expect(skill.sourceType).toBe('skill-tree');
      expect(skill.version).toBe('1.0.0');
      expect(skill.upstreamVersion).toBeUndefined();
    });

    it('should handle corrupted .skilltree.json without failing', async () => {
      writeFile(
        tmpDir,
        '.skilltree/skills/broken-meta/SKILL.md',
        `---
name: Broken Meta
version: 0.9.0
---

Has corrupted sidecar.
`,
      );
      writeFile(tmpDir, '.skilltree/skills/broken-meta/.skilltree.json', '{{not valid json!!');

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'broken-meta');

      const state = await sessionStore.load('e2e-version-session');
      const skill = state!.skillsUsed![0];
      expect(skill.sourceType).toBe('skill-tree');
      expect(skill.version).toBe('0.9.0');
      // Corrupted sidecar should not prevent resolution
    });
  });

  // ==========================================================================
  // node_modules/ — Plugin/package skills (openskills pattern)
  // ==========================================================================

  describe('node_modules/ — plugin/package skills', () => {
    it('should resolve a namespaced skill from node_modules package.json', async () => {
      writeFile(
        tmpDir,
        'node_modules/frontend-design/package.json',
        JSON.stringify(
          {
            name: 'frontend-design',
            version: '4.2.1',
            description: 'Frontend design skills for Claude',
            author: 'Design Team',
            main: 'index.js',
            keywords: ['claude-skill', 'frontend'],
          },
          null,
          2,
        ),
      );

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'frontend-design:frontend-design');

      const state = await sessionStore.load('e2e-version-session');
      const skill = state!.skillsUsed![0];
      expect(skill.name).toBe('frontend-design:frontend-design');
      expect(skill.sourceType).toBe('plugin');
      expect(skill.version).toBe('4.2.1');
      expect(skill.pluginPackage).toBe('frontend-design');
    });

    it('should resolve a claude-skill-<name> package pattern', async () => {
      writeFile(
        tmpDir,
        'node_modules/claude-skill-testing/package.json',
        JSON.stringify({
          name: 'claude-skill-testing',
          version: '1.0.3',
          author: { name: 'QA Team', email: 'qa@example.com' },
        }),
      );

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'testing:unit');

      const state = await sessionStore.load('e2e-version-session');
      const skill = state!.skillsUsed![0];
      expect(skill.sourceType).toBe('plugin');
      expect(skill.version).toBe('1.0.3');
      expect(skill.pluginPackage).toBe('claude-skill-testing');
    });

    it('should not resolve non-namespaced skills as plugins', async () => {
      writeFile(
        tmpDir,
        'node_modules/commit/package.json',
        JSON.stringify({ name: 'commit', version: '9.9.9' }),
      );

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'commit');

      const state = await sessionStore.load('e2e-version-session');
      const skill = state!.skillsUsed![0];
      // Should NOT be resolved as plugin (no namespace colon)
      expect(skill.sourceType).not.toBe('plugin');
    });
  });

  // ==========================================================================
  // Priority / Fallthrough
  // ==========================================================================

  describe('Resolver priority and fallthrough', () => {
    it('should prefer repo-skill over skill-tree when both exist', async () => {
      // Same skill in both .claude/skills/ and .skilltree/skills/
      commitFile(
        tmpDir,
        '.claude/skills/shared-skill.md',
        `---
name: shared-skill
version: 1.0.0
---

Repo version.
`,
      );
      writeFile(
        tmpDir,
        '.skilltree/skills/shared-skill/SKILL.md',
        `---
name: shared-skill
version: 2.0.0
---

Skill-tree version.
`,
      );

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'shared-skill');

      const state = await sessionStore.load('e2e-version-session');
      const skill = state!.skillsUsed![0];
      // Repo-skill has higher priority
      expect(skill.sourceType).toBe('repo-skill');
      expect(skill.version).toBe('1.0.0');
    });

    it('should fall through to skill-tree when not in .claude/skills/', async () => {
      // Only in .skilltree/skills/
      writeFile(
        tmpDir,
        '.skilltree/skills/tree-only/SKILL.md',
        `---
name: tree-only
version: 5.0.0
---
`,
      );

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'tree-only');

      const state = await sessionStore.load('e2e-version-session');
      const skill = state!.skillsUsed![0];
      expect(skill.sourceType).toBe('skill-tree');
      expect(skill.version).toBe('5.0.0');
    });

    it('should still track skill when no resolver matches (unknown skill)', async () => {
      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'completely-unknown-skill', '--flag');

      const state = await sessionStore.load('e2e-version-session');
      expect(state!.skillsUsed).toHaveLength(1);
      const skill = state!.skillsUsed![0];
      // Basic tracking still works even without version resolution
      expect(skill.name).toBe('completely-unknown-skill');
      expect(skill.args).toBe('--flag');
      expect(skill.usedAt).toBeDefined();
      // No version info populated
      expect(skill.sourceType).toBeUndefined();
      expect(skill.version).toBeUndefined();
      expect(skill.commitSha).toBeUndefined();
    });
  });

  // ==========================================================================
  // Multi-skill session (mixed sources)
  // ==========================================================================

  describe('Multi-skill session with mixed sources', () => {
    it('should resolve multiple skills from different sources in one session', async () => {
      // 1. Repo skill
      commitFile(
        tmpDir,
        '.claude/skills/commit.md',
        `---
name: commit
version: 1.0.0
author: alice
---

# Commit
`,
      );

      // 2. Skill-tree skill with sidecar
      writeFile(
        tmpDir,
        '.skilltree/skills/api-design/SKILL.md',
        `---
name: API Design
version: 2.0.0
author: team
status: active
---
`,
      );
      writeFile(
        tmpDir,
        '.skilltree/skills/api-design/.skilltree.json',
        JSON.stringify({
          upstream: {
            remote: 'company',
            skillId: 'api-design',
            version: '2.0.0',
            syncedAt: '2025-01-01T00:00:00Z',
          },
          source: { type: 'imported', location: 'https://github.com/company/skills' },
        }),
      );

      // 3. Plugin skill
      writeFile(
        tmpDir,
        'node_modules/frontend-design/package.json',
        JSON.stringify({
          name: 'frontend-design',
          version: '3.5.0',
          author: 'Design Team',
        }),
      );

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);

      // Invoke all three
      await dispatchSkillUse(lifecycle, agent, 'commit', '-m "feat: add API"');
      await dispatchSkillUse(lifecycle, agent, 'api-design');
      await dispatchSkillUse(lifecycle, agent, 'frontend-design:frontend-design');
      await dispatchSkillUse(lifecycle, agent, 'nonexistent-skill');

      const state = await sessionStore.load('e2e-version-session');
      expect(state!.skillsUsed).toHaveLength(4);

      const skills = state!.skillsUsed! as TrackedSkill[];

      // Skill 1: repo
      expect(skills[0].name).toBe('commit');
      expect(skills[0].sourceType).toBe('repo-skill');
      expect(skills[0].version).toBe('1.0.0');
      expect(skills[0].commitSha).toBeDefined();
      expect(skills[0].commitSha).toHaveLength(40);

      // Skill 2: skill-tree
      expect(skills[1].name).toBe('api-design');
      expect(skills[1].sourceType).toBe('skill-tree');
      expect(skills[1].version).toBe('2.0.0');
      expect(skills[1].upstreamVersion).toBe('2.0.0');

      // Skill 3: plugin
      expect(skills[2].name).toBe('frontend-design:frontend-design');
      expect(skills[2].sourceType).toBe('plugin');
      expect(skills[2].version).toBe('3.5.0');
      expect(skills[2].pluginPackage).toBe('frontend-design');

      // Skill 4: unresolved
      expect(skills[3].name).toBe('nonexistent-skill');
      expect(skills[3].sourceType).toBeUndefined();
      expect(skills[3].version).toBeUndefined();
    });
  });

  // ==========================================================================
  // Version evolution (commit SHA changes)
  // ==========================================================================

  describe('Version evolution — git SHA tracking', () => {
    it('should capture different git SHAs when skill file is modified between uses', async () => {
      // Version 1
      const sha1 = commitFile(
        tmpDir,
        '.claude/skills/evolving.md',
        `---
name: evolving
version: 1.0.0
---

# Version 1
`,
      );

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'evolving');

      // Modify skill file (new version)
      const sha2 = commitFile(
        tmpDir,
        '.claude/skills/evolving.md',
        `---
name: evolving
version: 2.0.0
---

# Version 2 — improved
`,
      );

      await dispatchSkillUse(lifecycle, agent, 'evolving');

      const state = await sessionStore.load('e2e-version-session');
      const skills = state!.skillsUsed! as TrackedSkill[];
      expect(skills).toHaveLength(2);

      expect(skills[0].version).toBe('1.0.0');
      expect(skills[0].commitSha).toBe(sha1);
      expect(skills[1].version).toBe('2.0.0');
      expect(skills[1].commitSha).toBe(sha2);

      // SHAs should be different
      expect(sha1).not.toBe(sha2);
    });
  });

  // ==========================================================================
  // Openskills-style registry layout
  // ==========================================================================

  describe('Openskills-style skill registry layout', () => {
    it('should resolve skill from .skilltree with full openskills frontmatter', async () => {
      // Simulate an openskills-style skill with rich frontmatter
      writeFile(
        tmpDir,
        '.skilltree/skills/typescript-refactor/SKILL.md',
        `---
name: TypeScript Refactor
version: 1.3.0
author: openskills-community
status: active
tags: [typescript, refactoring, code-quality]
license: MIT
---

## Problem
Legacy TypeScript code needs modernization.

## Solution
Systematically refactor using latest TS patterns:
- Replace \`any\` with proper types
- Use discriminated unions
- Leverage template literal types
- Apply satisfies operator where appropriate

## Steps
1. Analyze current type coverage
2. Identify refactoring candidates
3. Apply changes incrementally
4. Verify with tsc --noEmit

## Examples
\`\`\`typescript
// Before
function process(data: any): any { ... }

// After
function process(data: UserInput): ProcessedResult { ... }
\`\`\`
`,
      );

      writeFile(
        tmpDir,
        '.skilltree/skills/typescript-refactor/.skilltree.json',
        JSON.stringify({
          source: {
            type: 'registry',
            location: 'https://openskills.dev/skills/typescript-refactor',
          },
          upstream: {
            remote: 'openskills',
            skillId: 'typescript-refactor',
            version: '1.3.0',
            syncedAt: '2025-08-15T12:00:00Z',
          },
          installedAt: '2025-08-15T12:00:00Z',
          lastUpdated: '2025-08-15T12:00:00Z',
        }),
      );

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'typescript-refactor');

      const state = await sessionStore.load('e2e-version-session');
      const skill = state!.skillsUsed![0];
      expect(skill.sourceType).toBe('skill-tree');
      expect(skill.version).toBe('1.3.0');
      expect(skill.upstreamVersion).toBe('1.3.0');
    });

    it('should correctly resolve materialized skill (symlink from .skilltree to .claude/skills)', async () => {
      // skill-tree v0.1.5 materializer can symlink/copy skills to .claude/skills/
      // When this happens, RepoSkillResolver finds the skill first and misclassifies
      // it as 'repo-skill', losing upstream/source metadata from .skilltree.json

      // Source skill in .skilltree/skills/ with sidecar metadata
      writeFile(
        tmpDir,
        '.skilltree/skills/materialized-skill/SKILL.md',
        `---
name: Materialized Skill
version: 3.0.0
author: upstream-team
status: active
---

# Materialized via skill-tree

This skill was imported and materialized.
`,
      );
      writeFile(
        tmpDir,
        '.skilltree/skills/materialized-skill/.skilltree.json',
        JSON.stringify({
          source: { type: 'imported', location: 'https://github.com/team/skills' },
          upstream: {
            remote: 'team',
            skillId: 'materialized-skill',
            version: '3.0.0',
            syncedAt: '2025-09-01T00:00:00Z',
          },
          namespace: { scope: 'team', owner: 'platform' },
        }),
      );

      // Simulate materialization: create a symlink in .claude/skills/ pointing to .skilltree/skills/
      const symlinkTarget = path.join(tmpDir, '.claude', 'skills', 'materialized-skill');
      fs.mkdirSync(path.dirname(symlinkTarget), { recursive: true });
      fs.symlinkSync(
        path.join(tmpDir, '.skilltree', 'skills', 'materialized-skill'),
        symlinkTarget,
        'dir',
      );
      // Commit the symlink so git log works
      execFileSync('git', ['add', '.claude/skills/materialized-skill'], {
        cwd: tmpDir,
        stdio: 'pipe',
      });
      execFileSync('git', ['commit', '-m', 'Add materialized skill'], {
        cwd: tmpDir,
        stdio: 'pipe',
      });

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'materialized-skill');

      const state = await sessionStore.load('e2e-version-session');
      const skill = state!.skillsUsed![0];
      // RepoSkillResolver detects the symlink/sidecar and skips it,
      // allowing SkillTreeResolver to handle it with full upstream metadata.
      expect(skill.sourceType).toBe('skill-tree');
      expect(skill.version).toBe('3.0.0');
      expect(skill.upstreamVersion).toBe('3.0.0');
    });

    it('should correctly resolve materialized skill (copy mode with .skilltree-managed marker)', async () => {
      // In copy mode, skill-tree v0.1.5 copies the skill dir and adds a .skilltree-managed marker
      writeFile(
        tmpDir,
        '.skilltree/skills/copied-skill/SKILL.md',
        `---
name: Copied Skill
version: 2.0.0
author: team
status: active
---

# Copied skill
`,
      );
      writeFile(
        tmpDir,
        '.skilltree/skills/copied-skill/.skilltree.json',
        JSON.stringify({
          source: { type: 'imported', location: 'https://github.com/org/skills' },
          upstream: {
            remote: 'org',
            skillId: 'copied-skill',
            version: '2.0.0',
            syncedAt: '2025-09-15T00:00:00Z',
          },
        }),
      );

      // Simulate copy-mode materialization to .claude/skills/
      const copyTarget = path.join(tmpDir, '.claude', 'skills', 'copied-skill');
      fs.mkdirSync(copyTarget, { recursive: true });
      fs.cpSync(path.join(tmpDir, '.skilltree', 'skills', 'copied-skill'), copyTarget, {
        recursive: true,
      });
      // Add .skilltree-managed marker (as skill-tree v0.1.5 does in copy mode)
      fs.writeFileSync(
        path.join(copyTarget, '.skilltree-managed'),
        JSON.stringify({
          source: path.join(tmpDir, '.skilltree', 'skills', 'copied-skill'),
          copiedAt: new Date().toISOString(),
        }),
      );
      // Commit the copied skill
      execFileSync('git', ['add', '.claude/skills/copied-skill'], {
        cwd: tmpDir,
        stdio: 'pipe',
      });
      execFileSync('git', ['commit', '-m', 'Add copied skill'], {
        cwd: tmpDir,
        stdio: 'pipe',
      });

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'copied-skill');

      const state = await sessionStore.load('e2e-version-session');
      const skill = state!.skillsUsed![0];
      // RepoSkillResolver detects the .skilltree-managed marker and .skilltree.json
      // sidecar, deferring to SkillTreeResolver which preserves upstream metadata.
      expect(skill.sourceType).toBe('skill-tree');
      expect(skill.version).toBe('2.0.0');
      expect(skill.upstreamVersion).toBe('2.0.0');
    });

    it('should detect version drift between local and upstream', async () => {
      // Local version modified after install (version drift)
      writeFile(
        tmpDir,
        '.skilltree/skills/drifted-skill/SKILL.md',
        `---
name: Drifted Skill
version: 2.1.0
author: local-dev
status: active
---

Modified locally — no longer matches upstream.
`,
      );

      writeFile(
        tmpDir,
        '.skilltree/skills/drifted-skill/.skilltree.json',
        JSON.stringify({
          upstream: {
            remote: 'openskills',
            skillId: 'drifted-skill',
            version: '2.0.0',
            syncedAt: '2025-06-01T00:00:00Z',
          },
          source: { type: 'registry' },
        }),
      );

      const { sessionStore, lifecycle } = setupLifecycle(tmpDir);
      await startSession(lifecycle, agent);
      await dispatchSkillUse(lifecycle, agent, 'drifted-skill');

      const state = await sessionStore.load('e2e-version-session');
      const skill = state!.skillsUsed![0];
      expect(skill.version).toBe('2.1.0'); // Local frontmatter
      expect(skill.upstreamVersion).toBe('2.0.0'); // Upstream from sidecar
      // Drift is detectable: version !== upstreamVersion
      expect(skill.version).not.toBe(skill.upstreamVersion);
    });
  });
});
