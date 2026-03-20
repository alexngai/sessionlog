/**
 * Team Query Helpers
 *
 * Functions for querying sessions by team relationships:
 * parent→child links, team name grouping, and cross-session aggregation.
 */

import type { SessionState, TokenUsage, SpawnedAgentRef } from '../types.js';
import { addTokenUsage, emptyTokenUsage } from '../types.js';
import type { SessionStore } from './session-store.js';

/**
 * Get all sessions belonging to a team (by teamName field).
 */
export async function getTeamSessions(
  store: SessionStore,
  teamName: string,
): Promise<SessionState[]> {
  const all = await store.list();
  return all.filter((s) => s.teamName === teamName);
}

/**
 * Get all child sessions spawned by a parent session.
 * Matches on `parentSessionID` field.
 */
export async function getChildSessions(
  store: SessionStore,
  parentSessionID: string,
): Promise<SessionState[]> {
  const all = await store.list();
  return all.filter((s) => s.parentSessionID === parentSessionID);
}

/**
 * Get the parent session for a child session.
 */
export async function getParentSession(
  store: SessionStore,
  childSessionID: string,
): Promise<SessionState | null> {
  const child = await store.load(childSessionID);
  if (!child?.parentSessionID) return null;
  return store.load(child.parentSessionID);
}

/**
 * Aggregate all unique files touched across multiple sessions.
 */
export function aggregateTeamFiles(sessions: SessionState[]): string[] {
  const fileSet = new Set<string>();
  for (const session of sessions) {
    for (const file of session.filesTouched) {
      fileSet.add(file);
    }
  }
  return Array.from(fileSet);
}

/**
 * Aggregate token usage across multiple sessions.
 */
export function aggregateTeamTokens(sessions: SessionState[]): TokenUsage {
  let total = emptyTokenUsage();
  for (const session of sessions) {
    if (session.tokenUsage) {
      total = addTokenUsage(total, session.tokenUsage);
    }
  }
  return total;
}

/**
 * Get all spawned agent refs across sessions, optionally filtered by team.
 */
export function collectSpawnedAgents(
  sessions: SessionState[],
  teamName?: string,
): SpawnedAgentRef[] {
  const refs: SpawnedAgentRef[] = [];
  for (const session of sessions) {
    if (!session.spawnedAgents) continue;
    for (const ref of session.spawnedAgents) {
      if (teamName === undefined || ref.teamName === teamName) {
        refs.push(ref);
      }
    }
  }
  return refs;
}

/**
 * Get distinct team names across all sessions.
 */
export async function listTeamNames(store: SessionStore): Promise<string[]> {
  const all = await store.list();
  const names = new Set<string>();
  for (const session of all) {
    if (session.teamName) names.add(session.teamName);
    if (session.spawnedAgents) {
      for (const ref of session.spawnedAgents) {
        if (ref.teamName) names.add(ref.teamName);
      }
    }
  }
  return Array.from(names);
}
