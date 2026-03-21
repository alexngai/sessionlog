/**
 * Tests for the Skill Version Resolver chain.
 *
 * Unit tests that create temporary directories with skill files
 * in various formats and verify that the correct resolver picks them up.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  parseFrontmatter,
  parseFrontmatterWithMetadata,
  parseSkillName,
  findSkillFile,
  RepoSkillResolver,
  SkillTreeResolver,
  PluginSkillResolver,
  createSkillVersionResolverChain,
} from '../hooks/skill-version-resolver.js';

// ============================================================================
// Helpers
// ============================================================================

function initRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'pipe' });
}

function commitFile(dir: string, filePath: string, content: string): string {
  const absPath = path.join(dir, filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
  execFileSync('git', ['add', filePath], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', `Add ${filePath}`], { cwd: dir, stdio: 'pipe' });
  return execFileSync('git', ['log', '-1', '--format=%H'], { cwd: dir, stdio: 'pipe' })
    .toString()
    .trim();
}

function writeFile(dir: string, filePath: string, content: string): void {
  const absPath = path.join(dir, filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

// ============================================================================
// Frontmatter Parsing
// ============================================================================

describe('parseFrontmatter', () => {
  it('should parse simple YAML frontmatter', () => {
    const content = `---
name: my-skill
version: 1.2.3
author: alice
status: active
---

# My Skill
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe('my-skill');
    expect(result.version).toBe('1.2.3');
    expect(result.author).toBe('alice');
    expect(result.status).toBe('active');
  });

  it('should return empty object for content without frontmatter', () => {
    const result = parseFrontmatter('# Just a heading\nSome text');
    expect(result).toEqual({});
  });

  it('should handle multiline description (takes first line only)', () => {
    const content = `---
name: test
description: |
  A long description
version: 2.0.0
---
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe('test');
    expect(result.version).toBe('2.0.0');
    // description has value "|" which is the YAML multiline indicator
    expect(result.description).toBe('|');
  });
});

describe('parseFrontmatterWithMetadata', () => {
  it('should parse nested metadata block', () => {
    const content = `---
name: my-skill
description: Does stuff
metadata:
  author: bob
  version: 3.0.0
  tags: [typescript, testing]
---

# Content
`;
    const { top, metadata } = parseFrontmatterWithMetadata(content);
    expect(top.name).toBe('my-skill');
    expect(metadata.author).toBe('bob');
    expect(metadata.version).toBe('3.0.0');
  });

  it('should handle frontmatter with no metadata block', () => {
    const content = `---
name: simple
version: 1.0.0
---
`;
    const { top, metadata } = parseFrontmatterWithMetadata(content);
    expect(top.name).toBe('simple');
    expect(top.version).toBe('1.0.0');
    expect(metadata).toEqual({});
  });
});

// ============================================================================
// Skill Name Parsing
// ============================================================================

describe('parseSkillName', () => {
  it('should parse simple skill name', () => {
    expect(parseSkillName('commit')).toEqual({ baseName: 'commit' });
  });

  it('should parse namespaced skill name', () => {
    expect(parseSkillName('frontend-design:frontend-design')).toEqual({
      namespace: 'frontend-design',
      baseName: 'frontend-design',
    });
  });

  it('should handle namespace different from skill name', () => {
    expect(parseSkillName('my-plugin:do-thing')).toEqual({
      namespace: 'my-plugin',
      baseName: 'do-thing',
    });
  });
});

// ============================================================================
// File Discovery
// ============================================================================

describe('findSkillFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-find-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should find <name>.md', () => {
    writeFile(tmpDir, 'commit.md', '# Commit skill');
    expect(findSkillFile(tmpDir, 'commit')).toBe(path.join(tmpDir, 'commit.md'));
  });

  it('should find <name>/SKILL.md', () => {
    writeFile(tmpDir, 'commit/SKILL.md', '# Commit skill');
    expect(findSkillFile(tmpDir, 'commit')).toBe(path.join(tmpDir, 'commit', 'SKILL.md'));
  });

  it('should find <name>/index.md', () => {
    writeFile(tmpDir, 'commit/index.md', '# Commit skill');
    expect(findSkillFile(tmpDir, 'commit')).toBe(path.join(tmpDir, 'commit', 'index.md'));
  });

  it('should find <name>/<name>.md', () => {
    writeFile(tmpDir, 'commit/commit.md', '# Commit skill');
    expect(findSkillFile(tmpDir, 'commit')).toBe(path.join(tmpDir, 'commit', 'commit.md'));
  });

  it('should return null when no match found', () => {
    expect(findSkillFile(tmpDir, 'nonexistent')).toBeNull();
  });

  it('should strip namespace from skill name', () => {
    writeFile(tmpDir, 'do-thing.md', '# Do thing');
    expect(findSkillFile(tmpDir, 'my-plugin:do-thing')).toBe(path.join(tmpDir, 'do-thing.md'));
  });

  it('should prefer <name>.md over directory patterns (first match wins)', () => {
    writeFile(tmpDir, 'commit.md', '# flat');
    writeFile(tmpDir, 'commit/SKILL.md', '# dir');
    expect(findSkillFile(tmpDir, 'commit')).toBe(path.join(tmpDir, 'commit.md'));
  });
});

// ============================================================================
// RepoSkillResolver
// ============================================================================

describe('RepoSkillResolver', () => {
  let tmpDir: string;
  const resolver = new RepoSkillResolver();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-repo-'));
    initRepo(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should resolve a repo-level skill with version and git SHA', async () => {
    const skillContent = `---
name: commit
version: 1.0.0
author: alice
status: active
---

# Commit Skill
`;
    const sha = commitFile(tmpDir, '.claude/skills/commit.md', skillContent);

    const result = await resolver.resolve({ skillName: 'commit', cwd: tmpDir });
    expect(result).not.toBeNull();
    expect(result!.sourceType).toBe('repo-skill');
    expect(result!.version).toBe('1.0.0');
    expect(result!.author).toBe('alice');
    expect(result!.commitSha).toBe(sha);
    expect(result!.filePath).toBe('.claude/skills/commit.md');
  });

  it('should resolve skill in subdirectory (SKILL.md pattern)', async () => {
    const skillContent = `---
name: review
version: 2.1.0
---

# Review
`;
    commitFile(tmpDir, '.claude/skills/review/SKILL.md', skillContent);

    const result = await resolver.resolve({ skillName: 'review', cwd: tmpDir });
    expect(result).not.toBeNull();
    expect(result!.version).toBe('2.1.0');
    expect(result!.filePath).toContain('review/SKILL.md');
  });

  it('should resolve version from nested metadata block', async () => {
    const skillContent = `---
name: deploy
metadata:
  version: 3.0.0
  author: bob
---

# Deploy
`;
    commitFile(tmpDir, '.claude/skills/deploy.md', skillContent);

    const result = await resolver.resolve({ skillName: 'deploy', cwd: tmpDir });
    expect(result).not.toBeNull();
    expect(result!.version).toBe('3.0.0');
    expect(result!.author).toBe('bob');
  });

  it('should return null for unknown skill', async () => {
    const result = await resolver.resolve({ skillName: 'nonexistent', cwd: tmpDir });
    expect(result).toBeNull();
  });

  it('should skip skill materialized via symlink from .skilltree', async () => {
    // Create source in .skilltree/skills/
    writeFile(
      tmpDir,
      '.skilltree/skills/linked-skill/SKILL.md',
      `---
name: Linked
version: 1.0.0
---
`,
    );
    writeFile(
      tmpDir,
      '.skilltree/skills/linked-skill/.skilltree.json',
      JSON.stringify({
        upstream: { remote: 'r', skillId: 'x', version: '1.0.0', syncedAt: '2025-01-01T00:00:00Z' },
      }),
    );

    // Symlink into .claude/skills/
    const target = path.join(tmpDir, '.claude', 'skills', 'linked-skill');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.join(tmpDir, '.skilltree', 'skills', 'linked-skill'), target, 'dir');

    const result = await resolver.resolve({ skillName: 'linked-skill', cwd: tmpDir });
    // Should return null so SkillTreeResolver can handle it
    expect(result).toBeNull();
  });

  it('should skip skill with .skilltree-managed marker (copy mode)', async () => {
    const skillDir = path.join(tmpDir, '.claude', 'skills', 'copied-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    writeFile(
      tmpDir,
      '.claude/skills/copied-skill/SKILL.md',
      `---
name: Copied
version: 2.0.0
---
`,
    );
    fs.writeFileSync(path.join(skillDir, '.skilltree-managed'), '{}');

    commitFile(
      tmpDir,
      '.claude/skills/copied-skill/SKILL.md',
      `---
name: Copied
version: 2.0.0
---
`,
    );

    const result = await resolver.resolve({ skillName: 'copied-skill', cwd: tmpDir });
    expect(result).toBeNull();
  });

  it('should skip skill with .skilltree.json sidecar in .claude/skills/', async () => {
    writeFile(
      tmpDir,
      '.claude/skills/sidecar-skill/SKILL.md',
      `---
name: Sidecar
version: 3.0.0
---
`,
    );
    writeFile(
      tmpDir,
      '.claude/skills/sidecar-skill/.skilltree.json',
      JSON.stringify({ source: { type: 'imported' } }),
    );

    commitFile(
      tmpDir,
      '.claude/skills/sidecar-skill/SKILL.md',
      `---
name: Sidecar
version: 3.0.0
---
`,
    );

    const result = await resolver.resolve({ skillName: 'sidecar-skill', cwd: tmpDir });
    expect(result).toBeNull();
  });
});

// ============================================================================
// SkillTreeResolver
// ============================================================================

describe('SkillTreeResolver', () => {
  let tmpDir: string;
  const resolver = new SkillTreeResolver();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-tree-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should resolve a skill-tree managed skill from frontmatter', async () => {
    const skillContent = `---
name: My Skill
version: 2.0.0
author: carol
status: active
date: 2025-01-15
---

## Problem
Something
`;
    writeFile(tmpDir, '.skilltree/skills/my-skill/SKILL.md', skillContent);

    const result = await resolver.resolve({ skillName: 'my-skill', cwd: tmpDir });
    expect(result).not.toBeNull();
    expect(result!.sourceType).toBe('skill-tree');
    expect(result!.version).toBe('2.0.0');
    expect(result!.author).toBe('carol');
    expect(result!.status).toBe('active');
  });

  it('should read .skilltree.json sidecar for upstream/source info', async () => {
    writeFile(
      tmpDir,
      '.skilltree/skills/federated-skill/SKILL.md',
      `---
name: Federated
version: 1.5.0
---

Content
`,
    );
    writeFile(
      tmpDir,
      '.skilltree/skills/federated-skill/.skilltree.json',
      JSON.stringify({
        source: { type: 'imported', location: 'https://github.com/team/skills' },
        upstream: {
          remote: 'team',
          skillId: 'federated-skill',
          version: '1.5.0',
          syncedAt: '2025-01-01T00:00:00Z',
        },
        installedAt: '2025-01-01T00:00:00Z',
      }),
    );

    const result = await resolver.resolve({ skillName: 'federated-skill', cwd: tmpDir });
    expect(result).not.toBeNull();
    expect(result!.version).toBe('1.5.0');
    expect(result!.source).toEqual({
      type: 'imported',
      location: 'https://github.com/team/skills',
    });
    expect(result!.upstream).toEqual({
      remote: 'team',
      skillId: 'federated-skill',
      version: '1.5.0',
      syncedAt: '2025-01-01T00:00:00Z',
    });
  });

  it('should handle corrupted .skilltree.json gracefully', async () => {
    writeFile(
      tmpDir,
      '.skilltree/skills/broken/SKILL.md',
      `---
name: Broken
version: 1.0.0
---
`,
    );
    writeFile(tmpDir, '.skilltree/skills/broken/.skilltree.json', 'not json{{{');

    const result = await resolver.resolve({ skillName: 'broken', cwd: tmpDir });
    expect(result).not.toBeNull();
    expect(result!.version).toBe('1.0.0');
    expect(result!.upstream).toBeUndefined();
    expect(result!.source).toBeUndefined();
  });

  it('should extract namespace field from .skilltree.json sidecar (v0.1.5+)', async () => {
    writeFile(
      tmpDir,
      '.skilltree/skills/scoped-skill/SKILL.md',
      `---
name: Scoped Skill
version: 1.0.0
author: team
status: active
---

Content
`,
    );
    writeFile(
      tmpDir,
      '.skilltree/skills/scoped-skill/.skilltree.json',
      JSON.stringify({
        source: { type: 'imported' },
        namespace: { scope: 'team', owner: 'platform-eng' },
        upstream: {
          remote: 'company',
          skillId: 'scoped-skill',
          version: '1.0.0',
          syncedAt: '2025-09-01T00:00:00Z',
        },
      }),
    );

    const result = await resolver.resolve({ skillName: 'scoped-skill', cwd: tmpDir });
    expect(result).not.toBeNull();
    expect(result!.namespace).toEqual({ scope: 'team', owner: 'platform-eng' });
    expect(result!.upstream).toBeDefined();
  });

  it('should return null when skill not found in .skilltree', async () => {
    const result = await resolver.resolve({ skillName: 'missing', cwd: tmpDir });
    expect(result).toBeNull();
  });
});

// ============================================================================
// PluginSkillResolver
// ============================================================================

describe('PluginSkillResolver', () => {
  let tmpDir: string;
  const resolver = new PluginSkillResolver();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-plugin-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should resolve plugin from namespace matching node_modules package', async () => {
    writeFile(
      tmpDir,
      'node_modules/frontend-design/package.json',
      JSON.stringify({
        name: 'frontend-design',
        version: '4.2.1',
        author: 'Design Team',
      }),
    );

    const result = await resolver.resolve({
      skillName: 'frontend-design:frontend-design',
      cwd: tmpDir,
    });
    expect(result).not.toBeNull();
    expect(result!.sourceType).toBe('plugin');
    expect(result!.version).toBe('4.2.1');
    expect(result!.plugin).toEqual({
      packageName: 'frontend-design',
      packageVersion: '4.2.1',
    });
  });

  it('should resolve claude-skill-<namespace> package', async () => {
    writeFile(
      tmpDir,
      'node_modules/claude-skill-review/package.json',
      JSON.stringify({ name: 'claude-skill-review', version: '0.5.0' }),
    );

    const result = await resolver.resolve({
      skillName: 'review:check',
      cwd: tmpDir,
    });
    expect(result).not.toBeNull();
    expect(result!.plugin!.packageName).toBe('claude-skill-review');
    expect(result!.plugin!.packageVersion).toBe('0.5.0');
  });

  it('should return null for non-namespaced skills', async () => {
    const result = await resolver.resolve({ skillName: 'commit', cwd: tmpDir });
    expect(result).toBeNull();
  });

  it('should return null when no matching package found', async () => {
    const result = await resolver.resolve({
      skillName: 'unknown:thing',
      cwd: tmpDir,
    });
    expect(result).toBeNull();
  });

  it('should handle author as object', async () => {
    writeFile(
      tmpDir,
      'node_modules/my-pkg/package.json',
      JSON.stringify({
        name: 'my-pkg',
        version: '1.0.0',
        author: { name: 'Bob', email: 'bob@example.com' },
      }),
    );

    const result = await resolver.resolve({
      skillName: 'my-pkg:skill',
      cwd: tmpDir,
    });
    expect(result).not.toBeNull();
    expect(result!.author).toBe('Bob');
  });
});

// ============================================================================
// SkillVersionResolverChain
// ============================================================================

describe('SkillVersionResolverChain', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-chain-'));
    initRepo(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return first successful resolver result', async () => {
    // Skill exists in both repo and skill-tree — repo should win (higher priority)
    commitFile(
      tmpDir,
      '.claude/skills/my-skill.md',
      `---
name: my-skill
version: 1.0.0
---
`,
    );
    writeFile(
      tmpDir,
      '.skilltree/skills/my-skill/SKILL.md',
      `---
name: my-skill
version: 2.0.0
---
`,
    );

    const chain = createSkillVersionResolverChain();
    const result = await chain.resolve({ skillName: 'my-skill', cwd: tmpDir });
    expect(result).not.toBeNull();
    expect(result!.sourceType).toBe('repo-skill');
    expect(result!.version).toBe('1.0.0');
  });

  it('should fall through to next resolver if first returns null', async () => {
    // Skill only in skill-tree — repo resolver returns null, skill-tree picks it up
    writeFile(
      tmpDir,
      '.skilltree/skills/tree-only/SKILL.md',
      `---
name: Tree Only
version: 3.0.0
---
`,
    );

    const chain = createSkillVersionResolverChain();
    const result = await chain.resolve({ skillName: 'tree-only', cwd: tmpDir });
    expect(result).not.toBeNull();
    expect(result!.sourceType).toBe('skill-tree');
    expect(result!.version).toBe('3.0.0');
  });

  it('should return null when no resolver matches', async () => {
    const chain = createSkillVersionResolverChain();
    const result = await chain.resolve({ skillName: 'ghost', cwd: tmpDir });
    expect(result).toBeNull();
  });

  it('should expose resolver names', () => {
    const chain = createSkillVersionResolverChain();
    expect(chain.resolverNames).toEqual(['repo-skill', 'skill-tree', 'user-skill', 'plugin']);
  });

  it('should accept custom resolvers', async () => {
    const custom = {
      name: 'custom',
      resolve: async () => ({
        sourceType: 'unknown' as const,
        version: '9.9.9',
      }),
    };

    const chain = createSkillVersionResolverChain({ resolvers: [custom] });
    const result = await chain.resolve({ skillName: 'anything', cwd: tmpDir });
    expect(result).not.toBeNull();
    expect(result!.version).toBe('9.9.9');
    expect(chain.resolverNames).toEqual(['custom']);
  });

  it('should support extraResolvers appended after defaults', async () => {
    const extra = {
      name: 'extra',
      resolve: async () => ({
        sourceType: 'unknown' as const,
        version: '0.0.1',
      }),
    };

    const chain = createSkillVersionResolverChain({ extraResolvers: [extra] });
    expect(chain.resolverNames).toEqual([
      'repo-skill',
      'skill-tree',
      'user-skill',
      'plugin',
      'extra',
    ]);

    // Extra only fires if defaults all return null
    const result = await chain.resolve({ skillName: 'not-found-anywhere', cwd: tmpDir });
    expect(result).not.toBeNull();
    expect(result!.version).toBe('0.0.1');
  });

  it('should handle resolver that throws', async () => {
    const broken = {
      name: 'broken',
      resolve: async () => {
        throw new Error('resolver exploded');
      },
    };
    const fallback = {
      name: 'fallback',
      resolve: async () => ({
        sourceType: 'unknown' as const,
        version: '1.0.0',
      }),
    };

    const chain = createSkillVersionResolverChain({ resolvers: [broken, fallback] });
    const result = await chain.resolve({ skillName: 'test', cwd: tmpDir });
    expect(result).not.toBeNull();
    expect(result!.version).toBe('1.0.0');
  });
});
