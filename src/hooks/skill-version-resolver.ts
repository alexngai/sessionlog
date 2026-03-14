/**
 * Skill Version Resolver
 *
 * Pluggable strategy chain for resolving version/provenance metadata
 * from skill names at invocation time. Each resolver attempts to locate
 * the skill on disk and extract version information from the appropriate
 * source (git SHA, YAML frontmatter, package.json, etc.).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { gitSafe } from '../git-operations.js';

// ============================================================================
// Types
// ============================================================================

/** The source type that resolved the skill version */
export type SkillSourceType =
  | 'repo-skill' // .claude/skills/ in the project repo
  | 'user-skill' // ~/.claude/skills/ in user home
  | 'skill-tree' // .skilltree/skills/ managed by skill-tree
  | 'plugin' // npm package / namespaced plugin
  | 'unknown';

/** Resolved version/provenance metadata for a skill invocation */
export interface ResolvedSkillVersion {
  /** How the skill was resolved */
  sourceType: SkillSourceType;
  /** Resolved file path (if found on disk) */
  filePath?: string;
  /** Semantic version from frontmatter or package.json */
  version?: string;
  /** Git commit SHA of the skill file (for repo-level skills) */
  commitSha?: string;
  /** Author from skill frontmatter */
  author?: string;
  /** Status from skill frontmatter (draft/active/deprecated/experimental) */
  status?: string;
  /** For skill-tree skills: upstream remote info */
  upstream?: {
    remote: string;
    skillId: string;
    version: string;
    syncedAt: string;
  };
  /** For skill-tree skills: source/origin info */
  source?: {
    type: string;
    location?: string;
  };
  /** For skill-tree skills: namespace/scope info (v0.1.5+) */
  namespace?: {
    scope: string;
    owner?: string;
  };
  /** For plugin skills: package name and version */
  plugin?: {
    packageName: string;
    packageVersion: string;
  };
}

/** Context passed to resolvers at resolution time */
export interface SkillResolveContext {
  /** The skill name as received from the hook (e.g., "commit", "ns:name") */
  skillName: string;
  /** Project/repo root directory */
  cwd: string;
}

/** A single strategy for resolving skill version info */
export interface SkillVersionResolver {
  /** Human-readable name for this resolver (for logging/debugging) */
  readonly name: string;
  /** Attempt to resolve version info. Return null if this resolver can't handle the skill. */
  resolve(ctx: SkillResolveContext): Promise<ResolvedSkillVersion | null>;
}

// ============================================================================
// Frontmatter Parsing
// ============================================================================

/** Parse YAML frontmatter from a markdown file's content */
export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}

/** Parse YAML frontmatter including nested metadata block */
export function parseFrontmatterWithMetadata(content: string): {
  top: Record<string, string>;
  metadata: Record<string, string>;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { top: {}, metadata: {} };

  const top: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  let inMetadata = false;

  for (const line of match[1].split('\n')) {
    if (line.match(/^metadata\s*:/)) {
      inMetadata = true;
      continue;
    }
    if (inMetadata && line.match(/^\s{2,}\w/)) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key && value) metadata[key] = value;
      continue;
    }
    if (inMetadata && !line.match(/^\s/)) {
      inMetadata = false;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) top[key] = value;
  }

  return { top, metadata };
}

// ============================================================================
// Skill Name Parsing
// ============================================================================

/** Parse a skill name into namespace and base name components */
export function parseSkillName(skillName: string): {
  namespace?: string;
  baseName: string;
} {
  const colonIdx = skillName.indexOf(':');
  if (colonIdx === -1) return { baseName: skillName };
  return {
    namespace: skillName.slice(0, colonIdx),
    baseName: skillName.slice(colonIdx + 1),
  };
}

// ============================================================================
// File Discovery
// ============================================================================

/** Candidate file patterns to check for a given skill name within a directory */
const SKILL_FILE_PATTERNS = (name: string) => [
  `${name}.md`,
  `${name}/SKILL.md`,
  `${name}/index.md`,
  `${name}/${name}.md`,
];

/** Find the first matching skill file in a directory */
export function findSkillFile(dir: string, skillName: string): string | null {
  const { baseName } = parseSkillName(skillName);
  for (const pattern of SKILL_FILE_PATTERNS(baseName)) {
    const candidate = path.join(dir, pattern);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ============================================================================
// Resolver: Repo-Level Skills (.claude/skills/)
// ============================================================================

export class RepoSkillResolver implements SkillVersionResolver {
  readonly name = 'repo-skill';

  async resolve(ctx: SkillResolveContext): Promise<ResolvedSkillVersion | null> {
    const skillsDir = path.join(ctx.cwd, '.claude', 'skills');
    const filePath = findSkillFile(skillsDir, ctx.skillName);
    if (!filePath) return null;

    // Check if this is a materialized skill-tree skill (symlink or copy).
    // skill-tree's Materializer creates symlinks from .claude/skills/<id> → .skilltree/skills/<id>,
    // or copies the directory and adds a .skilltree-managed marker file.
    // In either case, we should skip and let the SkillTreeResolver handle it
    // so that upstream/source metadata from .skilltree.json is preserved.
    if (isMaterializedSkillTree(filePath, ctx.cwd)) {
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const { top, metadata } = parseFrontmatterWithMetadata(content);

    // Get git commit SHA for this file
    let commitSha: string | undefined;
    const relativePath = path.relative(ctx.cwd, filePath);
    const result = await gitSafe(['log', '-1', '--format=%H', '--', relativePath], {
      cwd: ctx.cwd,
    });
    if (result !== null && result.trim()) {
      commitSha = result.trim();
    }

    return {
      sourceType: 'repo-skill',
      filePath: relativePath,
      version: top.version ?? metadata.version,
      commitSha,
      author: top.author ?? metadata.author,
      status: top.status ?? metadata.status,
    };
  }
}

/**
 * Detect whether a skill file in .claude/skills/ was materialized by skill-tree.
 *
 * Returns true if:
 * 1. The file (or its parent directory) is a symlink pointing into .skilltree/skills/, OR
 * 2. The skill directory contains a .skilltree-managed marker file (copy mode), OR
 * 3. The skill directory contains a .skilltree.json sidecar (copied from .skilltree/skills/)
 */
function isMaterializedSkillTree(filePath: string, cwd: string): boolean {
  const skilltreeSkillsDir = path.join(cwd, '.skilltree', 'skills');

  // Check if the file or its parent directory is a symlink pointing to .skilltree/
  const skillDir = path.dirname(filePath);
  try {
    const stat = fs.lstatSync(skillDir);
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(skillDir);
      if (target.startsWith(skilltreeSkillsDir)) {
        return true;
      }
    }
  } catch {
    // Ignore stat errors
  }

  // Check for .skilltree-managed marker (copy mode)
  if (fs.existsSync(path.join(skillDir, '.skilltree-managed'))) {
    return true;
  }

  // Check for .skilltree.json sidecar in the skill directory
  // (present when skill-tree copies a skill dir including its metadata)
  if (fs.existsSync(path.join(skillDir, '.skilltree.json'))) {
    return true;
  }

  return false;
}

// ============================================================================
// Resolver: skill-tree Managed Skills (.skilltree/skills/)
// ============================================================================

export class SkillTreeResolver implements SkillVersionResolver {
  readonly name = 'skill-tree';

  async resolve(ctx: SkillResolveContext): Promise<ResolvedSkillVersion | null> {
    // skill-tree can store skills in multiple locations
    const { baseName } = parseSkillName(ctx.skillName);
    const candidates = [
      path.join(ctx.cwd, '.skilltree', 'skills', baseName),
      path.join(homedir(), '.skill-tree', '.skilltree', 'skills', baseName),
    ];

    for (const skillDir of candidates) {
      const skillMd = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;

      const content = fs.readFileSync(skillMd, 'utf-8');
      const frontmatter = parseFrontmatter(content);

      // Read .skilltree.json sidecar for richer metadata
      const metadataPath = path.join(skillDir, '.skilltree.json');
      let sidecar: Record<string, unknown> = {};
      if (fs.existsSync(metadataPath)) {
        try {
          sidecar = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        } catch {
          // Corrupted sidecar — continue with frontmatter only
        }
      }

      const upstream = sidecar.upstream as
        | { remote: string; skillId: string; version: string; syncedAt: string }
        | undefined;
      const source = sidecar.source as { type: string; location?: string } | undefined;
      const namespace = sidecar.namespace as { scope: string; owner?: string } | undefined;

      return {
        sourceType: 'skill-tree',
        filePath: path.relative(ctx.cwd, skillMd),
        version: frontmatter.version,
        author: frontmatter.author,
        status: frontmatter.status,
        upstream: upstream ?? undefined,
        source: source ?? undefined,
        namespace: namespace ?? undefined,
      };
    }

    return null;
  }
}

// ============================================================================
// Resolver: User-Level Skills (~/.claude/skills/)
// ============================================================================

export class UserSkillResolver implements SkillVersionResolver {
  readonly name = 'user-skill';

  async resolve(ctx: SkillResolveContext): Promise<ResolvedSkillVersion | null> {
    const skillsDir = path.join(homedir(), '.claude', 'skills');
    const filePath = findSkillFile(skillsDir, ctx.skillName);
    if (!filePath) return null;

    const content = fs.readFileSync(filePath, 'utf-8');
    const { top, metadata } = parseFrontmatterWithMetadata(content);

    // Check if user skills dir is a git repo (dotfiles repo)
    let commitSha: string | undefined;
    const userClaudeDir = path.join(homedir(), '.claude');
    const gitCheck = await gitSafe(['rev-parse', '--git-dir'], { cwd: userClaudeDir });
    if (gitCheck !== null) {
      const relativePath = path.relative(userClaudeDir, filePath);
      const result = await gitSafe(['log', '-1', '--format=%H', '--', relativePath], {
        cwd: userClaudeDir,
      });
      if (result !== null && result.trim()) {
        commitSha = result.trim();
      }
    }

    return {
      sourceType: 'user-skill',
      filePath,
      version: top.version ?? metadata.version,
      commitSha,
      author: top.author ?? metadata.author,
      status: top.status ?? metadata.status,
    };
  }
}

// ============================================================================
// Resolver: Plugin/Package Skills (namespace-based)
// ============================================================================

export class PluginSkillResolver implements SkillVersionResolver {
  readonly name = 'plugin';

  async resolve(ctx: SkillResolveContext): Promise<ResolvedSkillVersion | null> {
    const { namespace } = parseSkillName(ctx.skillName);
    if (!namespace) return null;

    // Look for a node_modules package matching the namespace
    const packageCandidates = [
      path.join(ctx.cwd, 'node_modules', namespace, 'package.json'),
      path.join(ctx.cwd, 'node_modules', `@${namespace}`, 'package.json'),
      path.join(ctx.cwd, 'node_modules', `claude-skill-${namespace}`, 'package.json'),
      path.join(ctx.cwd, 'node_modules', `@claude-skills`, namespace, 'package.json'),
    ];

    for (const pkgPath of packageCandidates) {
      if (!fs.existsSync(pkgPath)) continue;

      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return {
          sourceType: 'plugin',
          filePath: path.dirname(pkgPath),
          version: pkg.version,
          author: typeof pkg.author === 'string' ? pkg.author : pkg.author?.name,
          plugin: {
            packageName: pkg.name,
            packageVersion: pkg.version,
          },
        };
      } catch {
        continue;
      }
    }

    return null;
  }
}

// ============================================================================
// Resolver Chain
// ============================================================================

export interface SkillVersionResolverChainOptions {
  /** Override the default resolver list */
  resolvers?: SkillVersionResolver[];
  /** Additional resolvers to append after the defaults */
  extraResolvers?: SkillVersionResolver[];
}

/**
 * Runs resolvers in priority order, returning the first successful result.
 * Default order: repo-skill → skill-tree → user-skill → plugin
 */
export class SkillVersionResolverChain {
  private readonly resolvers: SkillVersionResolver[];

  constructor(options: SkillVersionResolverChainOptions = {}) {
    if (options.resolvers) {
      this.resolvers = [...options.resolvers];
    } else {
      this.resolvers = [
        new RepoSkillResolver(),
        new SkillTreeResolver(),
        new UserSkillResolver(),
        new PluginSkillResolver(),
      ];
    }
    if (options.extraResolvers) {
      this.resolvers.push(...options.extraResolvers);
    }
  }

  /** Resolve version info for a skill, trying each resolver in order */
  async resolve(ctx: SkillResolveContext): Promise<ResolvedSkillVersion | null> {
    for (const resolver of this.resolvers) {
      try {
        const result = await resolver.resolve(ctx);
        if (result) return result;
      } catch {
        // Individual resolver failures are non-fatal — try next
        continue;
      }
    }
    return null;
  }

  /** Get the list of registered resolver names (for debugging) */
  get resolverNames(): string[] {
    return this.resolvers.map((r) => r.name);
  }
}

/** Create a resolver chain with default resolvers */
export function createSkillVersionResolverChain(
  options?: SkillVersionResolverChainOptions,
): SkillVersionResolverChain {
  return new SkillVersionResolverChain(options);
}
