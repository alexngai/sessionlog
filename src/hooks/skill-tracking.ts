/**
 * Shared helpers for tracking skill invocations and surfaced (injected) skills.
 */

import type { TrackedSkill } from '../types.js';
import type {
  ResolvedSkillVersion,
  SkillVersionResolverChain,
  SkillResolveContext,
} from './skill-version-resolver.js';

/** Apply resolved version/provenance fields onto a TrackedSkill record. */
export function applyResolvedSkillMetadata(
  tracked: TrackedSkill,
  resolved: ResolvedSkillVersion,
): void {
  tracked.sourceType = resolved.sourceType;
  tracked.filePath = resolved.filePath;
  tracked.version = resolved.version;
  tracked.commitSha = resolved.commitSha;
  if (resolved.plugin) {
    tracked.pluginPackage = resolved.plugin.packageName;
  }
  if (resolved.upstream) {
    tracked.upstreamVersion = resolved.upstream.version;
    tracked.upstreamSkillId = resolved.upstream.skillId;
  }
}

/** Resolve version/provenance for a skill name (best-effort). */
export async function enrichTrackedSkill(
  skillName: string,
  resolver: SkillVersionResolverChain,
  ctx: SkillResolveContext,
  extras: Partial<TrackedSkill> = {},
): Promise<TrackedSkill> {
  const tracked: TrackedSkill = {
    name: skillName,
    ...extras,
  };

  try {
    const resolved = await resolver.resolve(ctx);
    if (resolved) {
      applyResolvedSkillMetadata(tracked, resolved);
    }
  } catch {
    // Version resolution is best-effort — don't block skill tracking
  }

  return tracked;
}

/** Merge surfaced skills by canonical name (latest entry wins). */
export function mergeSkillsSurfaced(
  existing: TrackedSkill[] | undefined,
  incoming: TrackedSkill[],
): TrackedSkill[] {
  const byName = new Map<string, TrackedSkill>();
  for (const skill of existing ?? []) {
    byName.set(skill.name, skill);
  }
  for (const skill of incoming) {
    byName.set(skill.name, skill);
  }
  return Array.from(byName.values());
}

/** Normalize annotate()/API payloads into TrackedSkill records. */
export function normalizeSurfacedSkillsInput(value: unknown): TrackedSkill[] | null {
  if (!Array.isArray(value)) return null;

  const result: TrackedSkill[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) {
      result.push({
        name: entry.trim(),
        surfacedAt: new Date().toISOString(),
      });
      continue;
    }
    if (entry && typeof entry === 'object' && typeof (entry as TrackedSkill).name === 'string') {
      const skill = entry as TrackedSkill;
      result.push({
        ...skill,
        surfacedAt: skill.surfacedAt ?? new Date().toISOString(),
      });
    }
  }

  return result.length > 0 ? result : null;
}
