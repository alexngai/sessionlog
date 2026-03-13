/**
 * E2E Integration Tests for Skill Version Resolution
 *
 * Tests the resolver chain against REAL tool CLIs:
 *   - skill-tree CLI: import, list, show, versions, discoverSkills, fork
 *   - openskills CLI: list, read, cross-validation
 *   - Full lifecycle pipeline: hook → dispatch → resolver → session state
 *
 * Both tools are installed as devDependencies (skill-tree, openskills).
 *
 * Gated behind LIVE_SKILL_RESOLUTION=1 environment variable:
 *   LIVE_SKILL_RESOLUTION=1 npx vitest run src/__tests__/skill-version-live.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { createClaudeCodeAgent } from '../agent/agents/claude-code.js';
import { createLifecycleHandler } from '../hooks/lifecycle.js';
import { createSessionStore } from '../store/session-store.js';
import { createCheckpointStore } from '../store/checkpoint-store.js';
import { EventType, type Event, type TrackedSkill } from '../types.js';
import {
  SkillTreeResolver,
  UserSkillResolver,
  createSkillVersionResolverChain,
} from '../hooks/skill-version-resolver.js';

const LIVE = process.env.LIVE_SKILL_RESOLUTION === '1';

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

function commitAll(dir: string, msg: string): string {
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', msg], { cwd: dir, stdio: 'pipe' });
  return execFileSync('git', ['log', '-1', '--format=%H'], { cwd: dir, stdio: 'pipe' })
    .toString()
    .trim();
}

function makeEvent(overrides: Partial<Event> & { type: EventType }): Event {
  return {
    sessionID: 'live-version-session',
    sessionRef: '/path/to/transcript.jsonl',
    timestamp: new Date(),
    ...overrides,
  };
}

/** Run skill-tree CLI with a custom --path for isolation */
function skillTree(stPath: string, args: string): string {
  return execSync(`npx skill-tree --path ${stPath} ${args}`, {
    encoding: 'utf-8',
    timeout: 15_000,
  }).trim();
}

function skillTreeJson<T = unknown>(stPath: string, args: string): T {
  return JSON.parse(skillTree(stPath, `${args} --json`));
}

function openskillsAvailable(): boolean {
  try {
    execSync('npx openskills --version', { stdio: 'pipe', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** Create a skill-tree compatible JSON skill object for import */
function makeSkillTreeSkill(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-skill',
    version: '1.0.0',
    name: 'Test Skill',
    description: 'A test skill',
    problem: 'Testing problem',
    triggerConditions: [{ type: 'keyword', value: 'test' }],
    solution: 'Test solution',
    verification: 'Test verification',
    examples: [{ scenario: 'test', before: 'before', after: 'after' }],
    author: 'e2e-test',
    tags: ['test'],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    status: 'active',
    metrics: { usageCount: 0, successRate: 1.0, avgDuration: 0 },
    ...overrides,
  };
}

// ============================================================================
// E2E Tests
// ============================================================================

describe.skipIf(!LIVE)('E2E Integration — Skill Version Resolution', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionlog-e2e-'));
    initRepo(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // skill-tree CLI: import → list → show → versions → resolver
  // ==========================================================================

  describe('skill-tree CLI — import and resolve', () => {
    it('should import a skill via skill-tree and resolve it with SkillTreeResolver', async () => {
      const stPath = path.join(tmpDir, '.skilltree-store');

      // Import a skill via skill-tree CLI
      const skillJson = JSON.stringify([
        makeSkillTreeSkill({
          id: 'deploy-prod',
          version: '2.0.0',
          name: 'Deploy to Production',
          author: 'devops-team',
          tags: ['deploy', 'production'],
        }),
      ]);
      const importFile = path.join(tmpDir, 'import.json');
      fs.writeFileSync(importFile, skillJson);

      const importResult = skillTreeJson<{ imported: number; failed: number }>(
        stPath,
        `import ${importFile}`,
      );
      expect(importResult.imported).toBe(1);
      expect(importResult.failed).toBe(0);

      // Verify skill-tree list shows it
      const skills = skillTreeJson<Array<{ id: string; version: string }>>(stPath, 'list');
      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('deploy-prod');
      expect(skills[0].version).toBe('2.0.0');

      // Verify skill-tree show returns full details
      const detail = skillTreeJson<{ id: string; author: string; status: string }>(
        stPath,
        'show deploy-prod',
      );
      expect(detail.id).toBe('deploy-prod');
      expect(detail.author).toBe('devops-team');
      expect(detail.status).toBe('active');

      // skill-tree writes SKILL.md + .skilltree.json to disk
      // Our SkillTreeResolver should find these files
      const generatedSkillMd = path.join(stPath, '.skilltree', 'skills', 'deploy-prod', 'SKILL.md');
      expect(fs.existsSync(generatedSkillMd)).toBe(true);

      const generatedSidecar = path.join(
        stPath,
        '.skilltree',
        'skills',
        'deploy-prod',
        '.skilltree.json',
      );
      expect(fs.existsSync(generatedSidecar)).toBe(true);

      // Now copy the .skilltree/ dir into our test repo so the resolver can find it
      const srcSkilltree = path.join(stPath, '.skilltree');
      const destSkilltree = path.join(tmpDir, '.skilltree');
      fs.cpSync(srcSkilltree, destSkilltree, { recursive: true });
      commitAll(tmpDir, 'add skill-tree generated files');

      // Resolve with our SkillTreeResolver
      const resolver = new SkillTreeResolver();
      const resolved = await resolver.resolve({
        skillName: 'deploy-prod',
        cwd: tmpDir,
      });

      expect(resolved).not.toBeNull();
      expect(resolved!.sourceType).toBe('skill-tree');
      expect(resolved!.version).toBe('2.0.0');
      expect(resolved!.author).toBe('devops-team');
      expect(resolved!.status).toBe('active');
      expect(resolved!.filePath).toContain('deploy-prod/SKILL.md');

      console.log('skill-tree resolved:', JSON.stringify(resolved, null, 2));
    });

    it('should resolve versioned skills after skill-tree version bumps', async () => {
      const stPath = path.join(tmpDir, '.skilltree-store');

      // Import v1
      const v1 = [
        makeSkillTreeSkill({
          id: 'code-review',
          version: '1.0.0',
          name: 'Code Review',
          author: 'qa',
        }),
      ];
      fs.writeFileSync(path.join(tmpDir, 'v1.json'), JSON.stringify(v1));
      skillTree(stPath, `import ${path.join(tmpDir, 'v1.json')}`);

      // Get v1 versions
      const versionsV1 = skillTreeJson<Array<{ version: string }>>(stPath, 'versions code-review');
      expect(versionsV1).toHaveLength(1);
      expect(versionsV1[0].version).toBe('1.0.0');

      // Import v2 (same id, new version)
      const v2 = [
        makeSkillTreeSkill({
          id: 'code-review',
          version: '2.0.0',
          name: 'Code Review v2',
          author: 'qa',
          updatedAt: '2025-06-01T00:00:00Z',
        }),
      ];
      fs.writeFileSync(path.join(tmpDir, 'v2.json'), JSON.stringify(v2));
      skillTree(stPath, `import ${path.join(tmpDir, 'v2.json')}`);

      // Verify version history
      const versionsV2 = skillTreeJson<Array<{ version: string }>>(stPath, 'versions code-review');
      expect(versionsV2.length).toBeGreaterThanOrEqual(1);

      // The show command should return the latest
      const latest = skillTreeJson<{ version: string }>(stPath, 'show code-review');
      expect(latest.version).toBe('2.0.0');

      // Copy to repo and verify resolver picks up latest
      fs.cpSync(path.join(stPath, '.skilltree'), path.join(tmpDir, '.skilltree'), {
        recursive: true,
      });
      commitAll(tmpDir, 'add skill-tree v2');

      const resolver = new SkillTreeResolver();
      const resolved = await resolver.resolve({ skillName: 'code-review', cwd: tmpDir });

      expect(resolved).not.toBeNull();
      expect(resolved!.sourceType).toBe('skill-tree');
      // The SKILL.md on disk should reflect the latest version
      expect(resolved!.version).toBe('2.0.0');
    });

    it('should handle skill-tree fork and resolve the forked skill', async () => {
      const stPath = path.join(tmpDir, '.skilltree-store');

      // Import original
      fs.writeFileSync(
        path.join(tmpDir, 'original.json'),
        JSON.stringify([
          makeSkillTreeSkill({
            id: 'base-skill',
            version: '1.0.0',
            name: 'Base Skill',
          }),
        ]),
      );
      skillTree(stPath, `import ${path.join(tmpDir, 'original.json')}`);

      // Fork it (--new-id and --reason are required)
      const forkResult = skillTree(
        stPath,
        'fork base-skill --new-id base-skill-custom --name "Base Skill (Custom)" --reason "e2e test fork"',
      );
      expect(forkResult).toBeTruthy();

      // List should show both
      const skills = skillTreeJson<Array<{ id: string }>>(stPath, 'list');
      expect(skills.length).toBeGreaterThanOrEqual(2);

      const forkedSkill = skills.find((s) => s.id === 'base-skill-custom');
      expect(forkedSkill).toBeDefined();

      // Copy to repo
      fs.cpSync(path.join(stPath, '.skilltree'), path.join(tmpDir, '.skilltree'), {
        recursive: true,
      });
      commitAll(tmpDir, 'add forked skill');

      // Both original and fork should be resolvable
      const resolver = new SkillTreeResolver();

      const originalResolved = await resolver.resolve({ skillName: 'base-skill', cwd: tmpDir });
      expect(originalResolved).not.toBeNull();
      expect(originalResolved!.sourceType).toBe('skill-tree');

      const forkResolved = await resolver.resolve({
        skillName: forkedSkill!.id,
        cwd: tmpDir,
      });
      expect(forkResolved).not.toBeNull();
      expect(forkResolved!.sourceType).toBe('skill-tree');

      console.log('Fork resolved:', forkedSkill!.id, JSON.stringify(forkResolved, null, 2));
    });

    it('should read .skilltree.json sidecar metadata generated by skill-tree', async () => {
      const stPath = path.join(tmpDir, '.skilltree-store');

      // Import a skill
      fs.writeFileSync(
        path.join(tmpDir, 'skill.json'),
        JSON.stringify([
          makeSkillTreeSkill({
            id: 'sidecar-test',
            version: '1.5.0',
            author: 'sidecar-author',
          }),
        ]),
      );
      skillTree(stPath, `import ${path.join(tmpDir, 'skill.json')}`);

      // Verify sidecar exists and has expected structure
      const sidecarPath = path.join(
        stPath,
        '.skilltree',
        'skills',
        'sidecar-test',
        '.skilltree.json',
      );
      expect(fs.existsSync(sidecarPath)).toBe(true);

      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
      expect(sidecar.installedAt).toBeDefined();
      expect(sidecar.lineage).toBeDefined();
      expect(sidecar.lineage.rootId).toBe('sidecar-test');

      // Verify SKILL.md has frontmatter
      const skillMdPath = path.join(stPath, '.skilltree', 'skills', 'sidecar-test', 'SKILL.md');
      const skillMdContent = fs.readFileSync(skillMdPath, 'utf-8');
      expect(skillMdContent).toContain('version: 1.5.0');
      expect(skillMdContent).toContain('author: sidecar-author');
      expect(skillMdContent).toContain('status: active');

      // Copy to repo and resolve
      fs.cpSync(path.join(stPath, '.skilltree'), path.join(tmpDir, '.skilltree'), {
        recursive: true,
      });
      commitAll(tmpDir, 'add sidecar skill');

      const resolver = new SkillTreeResolver();
      const resolved = await resolver.resolve({ skillName: 'sidecar-test', cwd: tmpDir });

      expect(resolved).not.toBeNull();
      expect(resolved!.version).toBe('1.5.0');
      expect(resolved!.author).toBe('sidecar-author');
      expect(resolved!.status).toBe('active');
    });

    it('skill-tree stats should reflect imported skills', async () => {
      const stPath = path.join(tmpDir, '.skilltree-store');

      // Import multiple skills
      const skills = [
        makeSkillTreeSkill({ id: 'a', version: '1.0.0', status: 'active' }),
        makeSkillTreeSkill({ id: 'b', version: '1.0.0', status: 'active' }),
        makeSkillTreeSkill({ id: 'c', version: '1.0.0', status: 'draft' }),
      ];
      fs.writeFileSync(path.join(tmpDir, 'multi.json'), JSON.stringify(skills));
      skillTree(stPath, `import ${path.join(tmpDir, 'multi.json')}`);

      // Verify stats
      const stats = skillTreeJson<{
        totalSkills: number;
        byStatus: { active: number; draft: number };
      }>(stPath, 'stats');
      expect(stats.totalSkills).toBe(3);
      expect(stats.byStatus.active).toBe(2);
      expect(stats.byStatus.draft).toBe(1);
    });

    it('skill-tree deprecate should update status and resolver reflects it', async () => {
      const stPath = path.join(tmpDir, '.skilltree-store');

      // Import active skill
      fs.writeFileSync(
        path.join(tmpDir, 'skill.json'),
        JSON.stringify([
          makeSkillTreeSkill({ id: 'old-tool', version: '1.0.0', status: 'active' }),
        ]),
      );
      skillTree(stPath, `import ${path.join(tmpDir, 'skill.json')}`);

      // Deprecate it
      skillTree(stPath, 'deprecate old-tool');

      // Verify via show
      const detail = skillTreeJson<{ status: string }>(stPath, 'show old-tool');
      expect(detail.status).toBe('deprecated');

      // Copy to repo — SKILL.md frontmatter should reflect deprecated
      fs.cpSync(path.join(stPath, '.skilltree'), path.join(tmpDir, '.skilltree'), {
        recursive: true,
      });
      commitAll(tmpDir, 'add deprecated skill');

      const resolver = new SkillTreeResolver();
      const resolved = await resolver.resolve({ skillName: 'old-tool', cwd: tmpDir });

      expect(resolved).not.toBeNull();
      expect(resolved!.status).toBe('deprecated');
    });

    it('skill-tree export/import roundtrip preserves resolver-visible data', async () => {
      const stPath = path.join(tmpDir, '.skilltree-store');

      // Import skills
      const skills = [
        makeSkillTreeSkill({
          id: 'export-test-1',
          version: '3.0.0',
          author: 'export-author',
          tags: ['export', 'test'],
        }),
        makeSkillTreeSkill({
          id: 'export-test-2',
          version: '1.5.0',
          author: 'another-author',
        }),
      ];
      fs.writeFileSync(path.join(tmpDir, 'export-src.json'), JSON.stringify(skills));
      skillTree(stPath, `import ${path.join(tmpDir, 'export-src.json')}`);

      // Export
      const exportFile = path.join(tmpDir, 'exported.json');
      skillTree(stPath, `export -o ${exportFile}`);
      expect(fs.existsSync(exportFile)).toBe(true);

      // Import into a fresh store
      const stPath2 = path.join(tmpDir, '.skilltree-store-2');
      skillTree(stPath2, `import ${exportFile}`);

      // Both stores should produce identical results
      const list1 = skillTreeJson<Array<{ id: string; version: string }>>(stPath, 'list');
      const list2 = skillTreeJson<Array<{ id: string; version: string }>>(stPath2, 'list');

      expect(list1.map((s) => s.id).sort()).toEqual(list2.map((s) => s.id).sort());
      expect(list1.map((s) => s.version).sort()).toEqual(list2.map((s) => s.version).sort());

      // Copy store2's .skilltree to repo and verify resolver
      fs.cpSync(path.join(stPath2, '.skilltree'), path.join(tmpDir, '.skilltree'), {
        recursive: true,
      });
      commitAll(tmpDir, 'add roundtripped skills');

      const resolver = new SkillTreeResolver();
      const r1 = await resolver.resolve({ skillName: 'export-test-1', cwd: tmpDir });
      const r2 = await resolver.resolve({ skillName: 'export-test-2', cwd: tmpDir });

      expect(r1).not.toBeNull();
      expect(r1!.version).toBe('3.0.0');
      expect(r1!.author).toBe('export-author');
      expect(r2).not.toBeNull();
      expect(r2!.version).toBe('1.5.0');
    });
  });

  // ==========================================================================
  // openskills CLI: list → read → resolver cross-validation
  // ==========================================================================

  describe('openskills CLI — resolver compatibility', () => {
    let openskillsOk: boolean;

    beforeAll(() => {
      openskillsOk = openskillsAvailable();
      if (!openskillsOk) {
        console.warn('openskills CLI not available — skipping openskills tests');
      }
    });

    it('should resolve a skill that openskills recognizes via `openskills list`', async () => {
      if (!openskillsOk) return;

      const skillContent = `---
name: test-resolver-skill
description: Skill created to verify resolver picks it up
version: 1.0.0
author: integration-test
---

# Test Resolver Skill

This skill exists to verify that sessionlog's version resolver
correctly identifies skills managed by openskills.
`;
      commitFile(tmpDir, '.claude/skills/test-resolver-skill/SKILL.md', skillContent);

      // Verify openskills sees it
      const listOutput = execSync('npx openskills list', {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 15_000,
      });
      expect(listOutput).toContain('test-resolver-skill');

      // Verify openskills can read it
      const readOutput = execSync('npx openskills read test-resolver-skill', {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 15_000,
      });
      expect(readOutput).toContain('Test Resolver Skill');

      // Our resolver chain finds the same skill
      const chain = createSkillVersionResolverChain();
      const resolved = await chain.resolve({ skillName: 'test-resolver-skill', cwd: tmpDir });

      expect(resolved).not.toBeNull();
      expect(resolved!.sourceType).toBe('repo-skill');
      expect(resolved!.version).toBe('1.0.0');
      expect(resolved!.author).toBe('integration-test');
      expect(resolved!.filePath).toContain('test-resolver-skill/SKILL.md');
      expect(resolved!.commitSha).toBeDefined();
      expect(resolved!.commitSha).toHaveLength(40);
    });

    it('should resolve a skill with references/ that openskills reads', async () => {
      if (!openskillsOk) return;

      commitFile(
        tmpDir,
        '.claude/skills/api-tester/SKILL.md',
        `---
name: api-tester
description: Test API endpoints
version: 2.5.0
author: qa-team
---

# API Tester

Send HTTP requests and validate responses.
`,
      );
      writeFile(
        tmpDir,
        '.claude/skills/api-tester/references/openapi-spec.md',
        '# OpenAPI Spec Reference\n\nDetails here.',
      );
      commitAll(tmpDir, 'add api-tester with references');

      const readOutput = execSync('npx openskills read api-tester', {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 15_000,
      });
      expect(readOutput).toContain('API Tester');

      const chain = createSkillVersionResolverChain();
      const resolved = await chain.resolve({ skillName: 'api-tester', cwd: tmpDir });

      expect(resolved).not.toBeNull();
      expect(resolved!.sourceType).toBe('repo-skill');
      expect(resolved!.version).toBe('2.5.0');
    });

    it('every skill openskills lists as "project" should be resolvable', async () => {
      if (!openskillsOk) return;

      const skillNames = ['alpha', 'beta', 'gamma'];
      for (const name of skillNames) {
        commitFile(
          tmpDir,
          `.claude/skills/${name}/SKILL.md`,
          `---\nname: ${name}\nversion: 1.0.0\n---\n\n# ${name}\n`,
        );
      }

      const listOutput = execSync('npx openskills list', {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 15_000,
      });

      // Extract project skill names
      const projectSkills: string[] = [];
      for (const line of listOutput.split('\n')) {
        if (line.includes('(project)')) {
          const match = line.match(/^\s+(\S+)/);
          if (match) projectSkills.push(match[1]);
        }
      }

      expect(projectSkills.length).toBeGreaterThanOrEqual(skillNames.length);

      const chain = createSkillVersionResolverChain();
      const mismatches: string[] = [];
      for (const name of projectSkills) {
        const resolved = await chain.resolve({ skillName: name, cwd: tmpDir });
        if (!resolved) mismatches.push(name);
      }

      expect(mismatches).toEqual([]);
    });
  });

  // ==========================================================================
  // Cross-tool: skill-tree + openskills coexistence
  // ==========================================================================

  describe('Cross-tool — skill-tree + openskills coexistence', () => {
    let openskillsOk: boolean;

    beforeAll(() => {
      openskillsOk = openskillsAvailable();
    });

    it('resolver chain handles both .skilltree/ and .claude/skills/ in same repo', async () => {
      if (!openskillsOk) return;

      const stPath = path.join(tmpDir, '.skilltree-store');

      // Create an openskills-managed skill in .claude/skills/
      commitFile(
        tmpDir,
        '.claude/skills/linter/SKILL.md',
        `---
name: linter
description: Run linting
version: 1.0.0
---

# Linter
`,
      );

      // Create a skill-tree-managed skill
      fs.writeFileSync(
        path.join(tmpDir, 'st-import.json'),
        JSON.stringify([
          makeSkillTreeSkill({
            id: 'formatter',
            version: '2.0.0',
            name: 'Code Formatter',
            author: 'tooling',
          }),
        ]),
      );
      skillTree(stPath, `import ${path.join(tmpDir, 'st-import.json')}`);
      fs.cpSync(path.join(stPath, '.skilltree'), path.join(tmpDir, '.skilltree'), {
        recursive: true,
      });
      commitAll(tmpDir, 'add both tool types');

      // Verify openskills sees the .claude/skills/ skill
      const listOutput = execSync('npx openskills list', {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 15_000,
      });
      expect(listOutput).toContain('linter');

      // Verify the resolver chain finds both
      const chain = createSkillVersionResolverChain();

      const linterResolved = await chain.resolve({ skillName: 'linter', cwd: tmpDir });
      expect(linterResolved).not.toBeNull();
      expect(linterResolved!.sourceType).toBe('repo-skill');
      expect(linterResolved!.version).toBe('1.0.0');

      const formatterResolved = await chain.resolve({ skillName: 'formatter', cwd: tmpDir });
      expect(formatterResolved).not.toBeNull();
      expect(formatterResolved!.sourceType).toBe('skill-tree');
      expect(formatterResolved!.version).toBe('2.0.0');

      console.log(
        'Cross-tool results:',
        JSON.stringify({ linter: linterResolved, formatter: formatterResolved }, null, 2),
      );
    });

    it('resolver prioritizes repo-skill over skill-tree for same skill name', async () => {
      const stPath = path.join(tmpDir, '.skilltree-store');

      // Create same-named skill in both locations
      commitFile(
        tmpDir,
        '.claude/skills/deploy/SKILL.md',
        `---
name: deploy
version: 3.0.0
---

# Deploy (openskills)
`,
      );

      fs.writeFileSync(
        path.join(tmpDir, 'st-deploy.json'),
        JSON.stringify([
          makeSkillTreeSkill({
            id: 'deploy',
            version: '1.0.0',
            name: 'Deploy (skill-tree)',
          }),
        ]),
      );
      skillTree(stPath, `import ${path.join(tmpDir, 'st-deploy.json')}`);
      fs.cpSync(path.join(stPath, '.skilltree'), path.join(tmpDir, '.skilltree'), {
        recursive: true,
      });
      commitAll(tmpDir, 'add conflicting skill');

      // Resolver chain: repo-skill runs first → should win
      const chain = createSkillVersionResolverChain();
      const resolved = await chain.resolve({ skillName: 'deploy', cwd: tmpDir });

      expect(resolved).not.toBeNull();
      expect(resolved!.sourceType).toBe('repo-skill');
      expect(resolved!.version).toBe('3.0.0'); // openskills version wins
    });
  });

  // ==========================================================================
  // Full lifecycle pipeline with skill-tree + openskills
  // ==========================================================================

  describe('Full lifecycle pipeline', () => {
    let openskillsOk: boolean;

    beforeAll(() => {
      openskillsOk = openskillsAvailable();
    });

    it('skill-tree skill → lifecycle → persisted TrackedSkill', async () => {
      const stPath = path.join(tmpDir, '.skilltree-store');

      // Import via skill-tree
      fs.writeFileSync(
        path.join(tmpDir, 'lifecycle-skill.json'),
        JSON.stringify([
          makeSkillTreeSkill({
            id: 'build',
            version: '4.0.0',
            name: 'Build Project',
            author: 'ci-team',
          }),
        ]),
      );
      skillTree(stPath, `import ${path.join(tmpDir, 'lifecycle-skill.json')}`);
      fs.cpSync(path.join(stPath, '.skilltree'), path.join(tmpDir, '.skilltree'), {
        recursive: true,
      });
      commitAll(tmpDir, 'add build skill');

      // Run full lifecycle
      const sessionsDir = path.join(tmpDir, '.git', 'sessionlog-sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const sessionStore = createSessionStore(tmpDir, sessionsDir);
      const checkpointStore = createCheckpointStore(tmpDir);
      const lifecycle = createLifecycleHandler({ sessionStore, checkpointStore, cwd: tmpDir });
      const agent = createClaudeCodeAgent();

      await lifecycle.dispatch(agent, makeEvent({ type: EventType.SessionStart }));

      const hookStdin = JSON.stringify({
        session_id: 'live-version-session',
        transcript_path: '/path/to/transcript.jsonl',
        tool_use_id: 'toolu_st_1',
        tool_input: { skill: 'build', args: '--release' },
        tool_response: 'Build succeeded',
      });
      const event = agent.parseHookEvent('post-skill', hookStdin);
      expect(event).not.toBeNull();
      await lifecycle.dispatch(agent, event!);

      const state = await sessionStore.load('live-version-session');
      expect(state).not.toBeNull();
      expect(state!.skillsUsed).toHaveLength(1);

      const skill = state!.skillsUsed![0] as TrackedSkill;
      expect(skill.name).toBe('build');
      expect(skill.args).toBe('--release');
      expect(skill.sourceType).toBe('skill-tree');
      expect(skill.version).toBe('4.0.0');
      expect(skill.filePath).toContain('build/SKILL.md');

      console.log('skill-tree lifecycle result:', JSON.stringify(skill, null, 2));
    });

    it('openskills skill → lifecycle → persisted TrackedSkill', async () => {
      if (!openskillsOk) return;

      const sha = commitFile(
        tmpDir,
        '.claude/skills/deploy/SKILL.md',
        `---
name: deploy
description: Deploy to production
version: 3.0.0
author: devops
---

# Deploy Skill

## Steps
1. Build artifacts
2. Push to registry
3. Update deployment
`,
      );

      // Verify openskills sees it
      const listOutput = execSync('npx openskills list', {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 15_000,
      });
      expect(listOutput).toContain('deploy');

      // Run full lifecycle
      const sessionsDir = path.join(tmpDir, '.git', 'sessionlog-sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const sessionStore = createSessionStore(tmpDir, sessionsDir);
      const checkpointStore = createCheckpointStore(tmpDir);
      const lifecycle = createLifecycleHandler({ sessionStore, checkpointStore, cwd: tmpDir });
      const agent = createClaudeCodeAgent();

      await lifecycle.dispatch(agent, makeEvent({ type: EventType.SessionStart }));

      const hookStdin = JSON.stringify({
        session_id: 'live-version-session',
        transcript_path: '/path/to/transcript.jsonl',
        tool_use_id: 'toolu_os_1',
        tool_input: { skill: 'deploy', args: '--env production' },
        tool_response: 'Deployed successfully',
      });
      const event = agent.parseHookEvent('post-skill', hookStdin);
      expect(event).not.toBeNull();
      await lifecycle.dispatch(agent, event!);

      const state = await sessionStore.load('live-version-session');
      expect(state).not.toBeNull();
      expect(state!.skillsUsed).toHaveLength(1);

      const skill = state!.skillsUsed![0] as TrackedSkill;
      expect(skill.name).toBe('deploy');
      expect(skill.sourceType).toBe('repo-skill');
      expect(skill.version).toBe('3.0.0');
      expect(skill.commitSha).toBe(sha);
      expect(skill.filePath).toBe('.claude/skills/deploy/SKILL.md');
    });

    it('mixed skill-tree + openskills skills in single session', async () => {
      if (!openskillsOk) return;

      const stPath = path.join(tmpDir, '.skilltree-store');

      // openskills skill
      commitFile(
        tmpDir,
        '.claude/skills/lint/SKILL.md',
        `---\nname: lint\nversion: 1.0.0\n---\n\n# Lint\n`,
      );

      // skill-tree skill
      fs.writeFileSync(
        path.join(tmpDir, 'test-skill.json'),
        JSON.stringify([
          makeSkillTreeSkill({ id: 'test-runner', version: '2.0.0', name: 'Test Runner' }),
        ]),
      );
      skillTree(stPath, `import ${path.join(tmpDir, 'test-skill.json')}`);
      fs.cpSync(path.join(stPath, '.skilltree'), path.join(tmpDir, '.skilltree'), {
        recursive: true,
      });
      commitAll(tmpDir, 'add both skills');

      // Lifecycle
      const sessionsDir = path.join(tmpDir, '.git', 'sessionlog-sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const sessionStore = createSessionStore(tmpDir, sessionsDir);
      const checkpointStore = createCheckpointStore(tmpDir);
      const lifecycle = createLifecycleHandler({ sessionStore, checkpointStore, cwd: tmpDir });
      const agent = createClaudeCodeAgent();

      await lifecycle.dispatch(agent, makeEvent({ type: EventType.SessionStart }));

      // Use openskills skill first
      const hookStdin1 = JSON.stringify({
        session_id: 'live-version-session',
        transcript_path: '/path/to/transcript.jsonl',
        tool_use_id: 'toolu_1',
        tool_input: { skill: 'lint', args: '--fix' },
        tool_response: 'Linted',
      });
      const event1 = agent.parseHookEvent('post-skill', hookStdin1);
      await lifecycle.dispatch(agent, event1!);

      // Then skill-tree skill
      const hookStdin2 = JSON.stringify({
        session_id: 'live-version-session',
        transcript_path: '/path/to/transcript.jsonl',
        tool_use_id: 'toolu_2',
        tool_input: { skill: 'test-runner', args: '' },
        tool_response: 'Tests passed',
      });
      const event2 = agent.parseHookEvent('post-skill', hookStdin2);
      await lifecycle.dispatch(agent, event2!);

      // Verify both recorded with correct source types
      const state = await sessionStore.load('live-version-session');
      expect(state!.skillsUsed).toHaveLength(2);

      const lintSkill = state!.skillsUsed!.find((s) => s.name === 'lint') as TrackedSkill;
      const testSkill = state!.skillsUsed!.find((s) => s.name === 'test-runner') as TrackedSkill;

      expect(lintSkill.sourceType).toBe('repo-skill');
      expect(lintSkill.version).toBe('1.0.0');

      expect(testSkill.sourceType).toBe('skill-tree');
      expect(testSkill.version).toBe('2.0.0');

      console.log(
        'Mixed session result:',
        JSON.stringify({ lint: lintSkill, testRunner: testSkill }, null, 2),
      );
    });
  });

  // ==========================================================================
  // Global user skills (~/.claude/skills/)
  // ==========================================================================

  describe('Global user skills — ~/.claude/skills/', () => {
    it('should resolve real globally-installed skills', async () => {
      const globalSkillsDir = path.join(os.homedir(), '.claude', 'skills');
      if (!fs.existsSync(globalSkillsDir)) {
        console.warn('No ~/.claude/skills/ directory — skipping');
        return;
      }

      const entries = fs
        .readdirSync(globalSkillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() || e.name.endsWith('.md'));

      if (entries.length === 0) {
        console.warn('No global skills found — skipping');
        return;
      }

      console.log(
        'Found global skills:',
        entries.map((e) => e.name),
      );

      const resolver = new UserSkillResolver();
      for (const entry of entries) {
        const skillName = entry.name.replace(/\.md$/, '');
        const resolved = await resolver.resolve({ skillName, cwd: tmpDir });

        if (resolved) {
          console.log(
            `  ${skillName}: sourceType=${resolved.sourceType}, version=${resolved.version ?? 'none'}, author=${resolved.author ?? 'none'}`,
          );
          expect(resolved.sourceType).toBe('user-skill');
          expect(resolved.filePath).toBeDefined();
        }
      }
    });

    it('should resolve session-start-hook if installed globally', async () => {
      const skillPath = path.join(
        os.homedir(),
        '.claude',
        'skills',
        'session-start-hook',
        'SKILL.md',
      );
      if (!fs.existsSync(skillPath)) {
        console.warn('session-start-hook not installed globally — skipping');
        return;
      }

      const resolver = new UserSkillResolver();
      const resolved = await resolver.resolve({ skillName: 'session-start-hook', cwd: tmpDir });

      expect(resolved).not.toBeNull();
      expect(resolved!.sourceType).toBe('user-skill');
      expect(resolved!.filePath).toContain('session-start-hook');

      // Full chain should also find it via user-skill resolver
      const chain = createSkillVersionResolverChain();
      const chainResult = await chain.resolve({ skillName: 'session-start-hook', cwd: tmpDir });
      expect(chainResult).not.toBeNull();
      expect(chainResult!.sourceType).toBe('user-skill');
    });
  });

  // ==========================================================================
  // Real-world skill format compatibility
  // ==========================================================================

  describe('Real-world skill format compatibility', () => {
    it('openskills-style with scripts/ and references/ dirs', async () => {
      commitFile(
        tmpDir,
        '.claude/skills/pdf/SKILL.md',
        `---
name: pdf
description: Comprehensive PDF toolkit
version: 1.2.0
---

# PDF Skill

1. Install dependencies
2. Use the appropriate script
`,
      );
      writeFile(
        tmpDir,
        '.claude/skills/pdf/scripts/extract_text.py',
        '#!/usr/bin/env python3\nimport sys\nprint("extract")\n',
      );
      writeFile(tmpDir, '.claude/skills/pdf/references/pypdf2-api.md', '# PyPDF2 API Reference\n');
      commitAll(tmpDir, 'add pdf with extras');

      const chain = createSkillVersionResolverChain();
      const resolved = await chain.resolve({ skillName: 'pdf', cwd: tmpDir });

      expect(resolved).not.toBeNull();
      expect(resolved!.sourceType).toBe('repo-skill');
      expect(resolved!.version).toBe('1.2.0');
    });

    it('skill with no version in frontmatter still gets commitSha', async () => {
      const sha = commitFile(
        tmpDir,
        '.claude/skills/code-review/SKILL.md',
        `---
name: code-review
description: Review code for quality
---

# Code Review
`,
      );

      const chain = createSkillVersionResolverChain();
      const resolved = await chain.resolve({ skillName: 'code-review', cwd: tmpDir });

      expect(resolved).not.toBeNull();
      expect(resolved!.version).toBeUndefined();
      expect(resolved!.commitSha).toBe(sha);
    });

    it('minimal frontmatter (description-only)', async () => {
      commitFile(
        tmpDir,
        '.claude/skills/minimal/SKILL.md',
        `---
description: Does something
---

Instructions here.
`,
      );

      const chain = createSkillVersionResolverChain();
      const resolved = await chain.resolve({ skillName: 'minimal', cwd: tmpDir });

      expect(resolved).not.toBeNull();
      expect(resolved!.sourceType).toBe('repo-skill');
      expect(resolved!.commitSha).toBeDefined();
    });

    it('skill-tree generated SKILL.md with rich frontmatter', async () => {
      const stPath = path.join(tmpDir, '.skilltree-store');

      fs.writeFileSync(
        path.join(tmpDir, 'rich.json'),
        JSON.stringify([
          makeSkillTreeSkill({
            id: 'rich-skill',
            version: '5.0.0',
            name: 'Rich Skill',
            author: 'rich-author',
            status: 'active',
            tags: ['production', 'critical', 'ops'],
          }),
        ]),
      );
      skillTree(stPath, `import ${path.join(tmpDir, 'rich.json')}`);

      // Verify the generated SKILL.md has rich frontmatter
      const skillMd = fs.readFileSync(
        path.join(stPath, '.skilltree', 'skills', 'rich-skill', 'SKILL.md'),
        'utf-8',
      );
      expect(skillMd).toContain('version: 5.0.0');
      expect(skillMd).toContain('author: rich-author');
      expect(skillMd).toContain('status: active');
      expect(skillMd).toContain('production');

      // Copy to repo and resolve
      fs.cpSync(path.join(stPath, '.skilltree'), path.join(tmpDir, '.skilltree'), {
        recursive: true,
      });
      commitAll(tmpDir, 'add rich skill');

      const resolver = new SkillTreeResolver();
      const resolved = await resolver.resolve({ skillName: 'rich-skill', cwd: tmpDir });

      expect(resolved).not.toBeNull();
      expect(resolved!.version).toBe('5.0.0');
      expect(resolved!.author).toBe('rich-author');
      expect(resolved!.status).toBe('active');
    });
  });
});
