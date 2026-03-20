# Agent Teams Awareness & Tracking — Implementation Plan

## Context

Claude Code's Agent tool (renamed from Task in v2.1.63) can spawn subagents that
share the parent's session_id. But **agent teams** (experimental) spawn separate
Claude Code processes, each with its own session_id. Currently sessionlog:

- Hooks on `"Task"` matcher only — may not fire for `"Agent"` tool name
- Has no parent→child session linking
- Has no team-level grouping or aggregation
- Doesn't extract `team_name`, `subagent_type`, `isolation` from Agent tool_input

## Goals

1. Ensure the Agent tool (renamed Task) is properly hooked
2. Capture Agent tool metadata (subagent_type, team_name, isolation, name)
3. Link parent ↔ child sessions via a shared relationship
4. Support team-level queries (list team members, aggregate files/tokens)
5. Minimal, additive changes — don't break existing Task-based flows

---

## Step 1: Add `"Agent"` hook matcher alongside `"Task"`

**File:** `src/agent/agents/claude-code.ts`

The tool was renamed Task → Agent. The matcher `"Task"` may not fire for calls
logged as `"Agent"`. Add parallel matchers:

```
Hook names to add:
  'pre-agent'   → SubagentStart  (same as pre-task)
  'post-agent'  → SubagentEnd    (same as post-task)

Hook installation:
  { settingsKey: 'PreToolUse',  hookName: 'pre-agent',  matcher: 'Agent' }
  { settingsKey: 'PostToolUse', hookName: 'post-agent', matcher: 'Agent' }
```

- `parseHookEvent` maps `'pre-agent'` and `'post-agent'` to the same
  `SubagentStart`/`SubagentEnd` events as `pre-task`/`post-task`
- Additionally extract new fields from `tool_input`:
  - `subagentType` (from `tool_input.subagent_type`)
  - `teamName` (from `tool_input.team_name`)
  - `agentName` (from `tool_input.name`)
  - `isolation` (from `tool_input.isolation`)
  - `runInBackground` (from `tool_input.run_in_background`)

**Changes:**
- Add `'pre-agent'`, `'post-agent'` to `HOOK_NAMES`
- Add cases in `parseHookEvent` switch
- Add two entries to `taskHookMappings` array
- Extract extra fields from tool_input in both pre-agent and post-agent cases

---

## Step 2: Extend Event and SessionState types

**File:** `src/types.ts`

### Event additions:
```typescript
// On SubagentStart/SubagentEnd events:
subagentType?: string;     // already exists
teamName?: string;         // NEW — from tool_input.team_name
agentName?: string;        // NEW — from tool_input.name (the addressable name)
isolation?: string;        // NEW — 'worktree' or undefined
runInBackground?: boolean; // NEW
```

### SessionState additions:
```typescript
// Parent session tracking (populated when this session spawns agents)
spawnedAgents?: SpawnedAgentRef[];

// Child session tracking (populated when this session IS a spawned agent)
parentSessionID?: string;
teamName?: string;
```

### New interface:
```typescript
interface SpawnedAgentRef {
  toolUseID: string;
  subagentID?: string;      // from post-agent tool_response.agentId
  agentName?: string;       // addressable name
  subagentType?: string;
  teamName?: string;
  isolation?: string;
  spawnedAt: string;
  completedAt?: string;
  childSessionID?: string;  // linked when we can correlate
}
```

---

## Step 3: Track spawned agents in lifecycle handler

**File:** `src/hooks/lifecycle.ts`

### handleSubagentStart (updated):
- Create a `SpawnedAgentRef` entry from event metadata
- Append to `state.spawnedAgents[]`
- Store `toolUseID` as the key for later correlation

### handleSubagentEnd (updated):
- Find matching `SpawnedAgentRef` by `toolUseID`
- Set `subagentID` from `event.subagentID`
- Set `completedAt` timestamp

This gives the parent session a record of all agents it spawned, with timing and
metadata.

---

## Step 4: Parent-child session linking

**File:** `src/hooks/lifecycle.ts` (handleSessionStart)

When a new session starts, check if it's a child of an existing session:

### Strategy A — Worktree-based correlation
If the new session is in a git worktree (worktreeID is non-empty), scan active
parent sessions for a `SpawnedAgentRef` with `isolation: 'worktree'` that hasn't
been linked yet. This is heuristic but handles the common case.

### Strategy B — Environment variable (preferred, if available)
If Claude Code passes `SESSIONLOG_PARENT_SESSION_ID` or includes parent info in
hook data for spawned processes, use that directly. This requires upstream support
from Claude Code — note this as a future improvement.

### Strategy C — Transcript path correlation
Agent subagent transcripts live in a `subagentsDir` relative to the parent
transcript. If the new session's transcript path matches
`<parent_transcript_dir>/agent-<id>.jsonl`, we can infer the parent.

For now, implement Strategy A (worktree) + Strategy C (transcript path) as
best-effort. Set `state.parentSessionID` and `state.teamName` on the child, and
`ref.childSessionID` on the parent's `SpawnedAgentRef`.

---

## Step 5: Team-level queries

**File:** `src/store/session-store.ts` (or new `src/store/team-store.ts`)

Add helper functions:

```typescript
// Get all sessions that belong to a team
async function getTeamSessions(
  store: SessionStore, teamName: string
): Promise<SessionState[]>

// Get all child sessions spawned by a parent
async function getChildSessions(
  store: SessionStore, parentSessionID: string
): Promise<SessionState[]>

// Get the parent session for a child
async function getParentSession(
  store: SessionStore, childSessionID: string
): Promise<SessionState | null>

// Aggregate files touched across a team/parent+children
function aggregateTeamFiles(sessions: SessionState[]): string[]

// Aggregate token usage across a team/parent+children
function aggregateTeamTokens(sessions: SessionState[]): TokenUsage
```

These are query helpers only — no new storage format needed. They scan existing
session JSON files filtering by `teamName` or `parentSessionID`.

---

## Step 6: Update extractSpawnedAgentIDs for Agent tool

**File:** `src/agent/agents/claude-code.ts`

`extractSpawnedAgentIDs()` already parses `"agentId: <id>"` from tool_result text
regardless of tool name, so it should work for Agent tool results too. But verify:

- The Agent tool may return the agentId in a different format than Task
- Add a fallback to also check `tool_response.agentId` as a JSON field (not just
  text pattern matching)

---

## Step 7: Export new APIs

**File:** `src/index.ts`

Export:
- `SpawnedAgentRef` type
- Team query functions (`getTeamSessions`, `getChildSessions`, etc.)

---

## Step 8: Tests

1. **Hook parsing tests** — verify `pre-agent`/`post-agent` produce correct events
   with new metadata fields
2. **Lifecycle tests** — verify `spawnedAgents[]` is populated on SubagentStart/End
3. **Session linking tests** — verify parent↔child correlation via worktree and
   transcript path strategies
4. **Team query tests** — verify filtering and aggregation helpers
5. **Hook installation tests** — verify Agent matchers are added to settings.json

---

## Non-goals (for now)

- **Real-time team monitoring** — no WebSocket/polling for live team status
- **Team config parsing** — don't read `~/.claude/teams/` config files directly
- **SendMessage tracking** — don't track inter-agent messages (would need new hooks)
- **Upstream Claude Code changes** — don't depend on new hook fields not yet shipped

## Ordering

Steps 1-3 are the core and can ship independently. Steps 4-5 are the team linking
layer. Steps 6-7 are cleanup. Step 8 throughout.
