# sessionlog

Unofficial TypeScript reimplementation of the [Entire CLI](https://github.com/entireio/cli) — a Git-integrated tool that captures AI agent sessions as searchable records within your repository.

This package provides the core library used to build session tracking, checkpoint management, and agent integrations for AI coding tools.

## Features

- **Multi-agent support** — Claude Code, Cursor, Gemini CLI, and OpenCode
- **Session lifecycle tracking** — automatic capture of prompts, responses, files modified, and token usage
- **Git-native checkpoints** — temporary snapshots on shadow branches, permanent records on `sessionlog/checkpoints/v1`
- **Rewind** — restore code to any previous checkpoint
- **Resume** — pick up agent sessions from any branch
- **Secret redaction** — multi-layer detection (entropy analysis + 30+ patterns) before storing transcripts
- **AI summarization** — generate structured summaries of agent sessions
- **Zero production dependencies** — only Node.js and Git required

## Installation

**Global CLI (recommended for standalone use):**

```bash
npm install -g sessionlog
```

Then use the `sessionlog` command directly:

```bash
cd your-project
sessionlog enable
sessionlog status
```

**As a project dependency:**

```bash
npm install sessionlog
```

**As a dev dependency (for tools/plugins that integrate with Sessionlog):**

```bash
npm install --save-dev sessionlog
```

Requires Node.js >= 18 and Git.

## Quick Start

```typescript
import {
  enable,
  disable,
  status,
  listRewindPoints,
  rewindTo,
} from 'sessionlog';

// Enable Sessionlog in a repository
const result = await enable({ cwd: '/path/to/repo' });
console.log(result.enabled); // true

// Check status
const info = await status('/path/to/repo');
console.log(info.sessions); // active sessions
console.log(info.agents);   // installed agents

// List rewind points
const points = await listRewindPoints({ cwd: '/path/to/repo' });

// Rewind to a checkpoint
await rewindTo(points[0].id, { cwd: '/path/to/repo' });

// Disable
await disable({ cwd: '/path/to/repo' });
```

## Architecture

```
Your Branch                    sessionlog/checkpoints/v1
     │                                  │
     ▼                                  │
[Base Commit]                           │
     │                                  │
     │  ┌─── Agent works ───┐          │
     │  │  Step 1            │          │
     │  │  Step 2            │          │
     │  │  Step 3            │          │
     │  └───────────────────┘           │
     │                                  │
     ▼                                  ▼
[Your Commit] ─────────────────► [Session Metadata]
     │                           (transcript, prompts,
     │                            files touched)
     ▼
```

Your active branch stays clean — all metadata is stored on the separate `sessionlog/checkpoints/v1` branch.

## Key Concepts

**Sessions** represent complete AI agent interactions, capturing all prompts, responses, modified files, and timestamps. Session identifiers follow the format: `YYYY-MM-DD-<UUID>`.

**Checkpoints** are save points within sessions — snapshots you can rewind to when commits occur. Checkpoint identifiers are 12-character hexadecimal strings.

## Commands

All commands are exposed as async functions that return structured results:

| Function | Purpose |
|----------|---------|
| `enable(options)` | Activate Sessionlog in a repository |
| `disable(options)` | Deactivate Sessionlog hooks |
| `status(cwd)` | Get current session information |
| `listRewindPoints(options)` | List available checkpoints |
| `rewindTo(pointID, options)` | Restore to a previous checkpoint |
| `doctor(options)` | Diagnose and fix stuck sessions |
| `clean(options)` | Remove orphaned data artifacts |
| `reset(options)` | Clear shadow branch and session state |
| `explainCommit(ref, options)` | Get session details for a commit |
| `discoverResumeInfo(branch)` | Find resumable sessions on a branch |
| `setupCcweb(options)` | Configure for Claude Code Web sessions |

### Enable

```typescript
import { enable } from 'sessionlog';

const result = await enable({
  cwd: '/path/to/repo',
  agent: 'claude-code',  // or auto-detect
  force: true,           // reinstall hooks
  local: false,          // save to project settings
});
// result: { enabled, agent, agentHooksInstalled, gitHooksInstalled, errors }
```

### Status

```typescript
import { status, formatTokens } from 'sessionlog';

const info = await status('/path/to/repo');
console.log(`Strategy: ${info.strategy}`);
console.log(`Sessions: ${info.sessions.length}`);
for (const s of info.sessions) {
  console.log(`  ${s.sessionID} (${s.agentType}) - ${s.phase}`);
  if (s.tokenUsage) {
    console.log(`  Tokens: ${formatTokens(s.tokenUsage.input)} in / ${formatTokens(s.tokenUsage.output)} out`);
  }
}
```

### Rewind

```typescript
import { listRewindPoints, rewindTo } from 'sessionlog';

const points = await listRewindPoints({ cwd: '.', limit: 10 });
for (const p of points) {
  console.log(`${p.id} - ${p.message} (${p.date})`);
}

const result = await rewindTo(points[0].id);
// result: { success, message, rewindPoint }
```

### Explain

```typescript
import { explainCommit, getCheckpointDetail } from 'sessionlog';

// Explain a specific commit
const info = await explainCommit('HEAD');
if (info?.detail) {
  console.log(`Checkpoint: ${info.detail.checkpointID}`);
  console.log(`Agent: ${info.detail.agent}`);
  console.log(`Files: ${info.detail.filesTouched.join(', ')}`);
}

// Get checkpoint details by ID
const detail = await getCheckpointDetail('a3b2c4d5e6f7');
```

### Resume

```typescript
import { discoverResumeInfo, listResumableBranches } from 'sessionlog';

// List branches with resumable sessions
const branches = await listResumableBranches();
for (const b of branches) {
  console.log(`${b.branch}: session ${b.sessionID}`);
}

// Get resume info for a specific branch
const info = await discoverResumeInfo('feature/my-branch');
if (info.success && info.info) {
  console.log(`Resume command: ${info.info.resumeCommand}`);
}
```

### Claude Code Web

Configure a repository for automatic sessionlog setup in [Claude Code Web](https://claude.ai/code) sessions.

**The problem:** Claude Code Web (ccweb) sessions start with a fresh environment — sessionlog isn't installed, and the ccweb proxy restricts git pushes to only the current working branch, preventing sessionlog from pushing to its `sessionlog/checkpoints/v1` shadow branch.

**The solution:** `setup-ccweb` creates a `SessionStart` hook that automatically installs and configures sessionlog on every ccweb session.

**CLI usage:**

```bash
# Run locally in your repository
sessionlog setup-ccweb

# Commit and push the generated .claude/ directory
git add .claude/
git commit -m "Add sessionlog ccweb integration"
git push
```

This creates two files:

- `.claude/settings.json` — registers a `SessionStart` hook that runs on every ccweb session
- `.claude/scripts/setup-env.sh` — installs sessionlog, enables it, configures GitHub direct-push access, and installs a branch push filter

**Options:**

```bash
# Force overwrite existing setup
sessionlog setup-ccweb --force

# Customize allowed push branch prefixes
sessionlog setup-ccweb --push-prefixes "sessionlog/ my-prefix/"
```

**Programmatic usage:**

```typescript
import { setupCcweb } from 'sessionlog';

const result = await setupCcweb({
  cwd: '/path/to/repo',
  force: true,
  pushPrefixes: 'sessionlog/ claude/',
});
// result: { success, settingsCreated, scriptCreated, errors }
```

**Requirements:**

- Set `GITHUB_TOKEN` as an environment variable in your ccweb settings (needed for pushing session data to GitHub)
- Enable **Trusted** network access level in ccweb (needed to download the sessionlog npm package)

**What the SessionStart hook does on each ccweb session:**

1. Installs sessionlog via `npm install -g sessionlog`
2. Runs `sessionlog enable --agent claude-code --local`
3. Configures git to push directly to GitHub using `GITHUB_TOKEN` (bypassing the ccweb proxy)
4. Installs a `pre-push` filter that only allows pushes to `sessionlog/` and `claude/` prefixed branches (safety guardrail)

**Customizing push prefixes:**

The setup script restricts direct pushes to branches matching allowed prefixes. To modify which prefixes are allowed, either pass `--push-prefixes` during setup or edit `ALLOWED_PUSH_PREFIXES` in `.claude/scripts/setup-env.sh` directly.

## Agent System

Register and use AI agent integrations:

```typescript
import {
  registerAgent,
  getAgent,
  detectAgents,
  createClaudeCodeAgent,
} from 'sessionlog';

// Agents auto-register on import. Detect installed agents:
const agents = await detectAgents('/path/to/repo');

// Or get a specific agent:
const claude = getAgent('claude-code');
if (claude) {
  const present = await claude.detectPresence('/path/to/repo');
  const transcript = await claude.readTranscript(sessionRef);
}
```

### Supported Agents

| Agent | Name | Hook Location |
|-------|------|---------------|
| Claude Code | `claude-code` | `.claude/settings.json` |
| Cursor | `cursor` | `.cursor/hooks.json` |
| Gemini CLI | `gemini` | `.gemini/settings.json` |
| OpenCode | `opencode` | `.opencode/plugins/sessionlog.ts` |

## Strategy Engine

The manual-commit strategy orchestrates the full checkpoint lifecycle:

```typescript
import {
  createManualCommitStrategy,
  createSessionStore,
  createCheckpointStore,
} from 'sessionlog';

const strategy = createManualCommitStrategy({
  sessionStore: createSessionStore('/path/to/repo'),
  checkpointStore: createCheckpointStore('/path/to/repo'),
  cwd: '/path/to/repo',
});

// Git hook integration
await strategy.prepareCommitMsg(msgFile, source, sha);
await strategy.commitMsg(msgFile);
await strategy.postCommit();
await strategy.prePush('origin');

// Session management
await strategy.saveStep(stepContext);
await strategy.saveTaskStep(taskStepContext);
```

## Lifecycle Handler

Process agent events through the session state machine:

```typescript
import {
  createLifecycleHandler,
  createSessionStore,
  createCheckpointStore,
} from 'sessionlog';

const handler = createLifecycleHandler({
  sessionStore: createSessionStore(),
  checkpointStore: createCheckpointStore(),
});

// Dispatch events from agent hooks
await handler.dispatch(agent, event);
```

## Security

Redact secrets before storing transcripts:

```typescript
import { redactJSONL, detectSecrets, shannonEntropy } from 'sessionlog';

// Redact a JSONL transcript buffer
const safe = redactJSONL(transcriptBuffer);

// Detect secrets in text
const secrets = detectSecrets(content);

// Check entropy of a string
const entropy = shannonEntropy('AKIAIOSFODNN7EXAMPLE');
```

## Configuration

Settings stored in `.sessionlog/`:

| File | Purpose |
|------|---------|
| `.sessionlog/settings.json` | Team-shared, version-controlled |
| `.sessionlog/settings.local.json` | Personal overrides, gitignored |

```typescript
import { loadSettings, saveProjectSettings, isEnabled } from 'sessionlog';

const settings = await loadSettings('/path/to/repo');
// { enabled, strategy, logLevel, skipPushSessions, telemetryEnabled, summarizationEnabled }

await saveProjectSettings({ enabled: true, strategy: 'manual-commit' });

const enabled = await isEnabled('/path/to/repo');
```

### Configuration Options

| Option | Type | Default | Purpose |
|--------|------|---------|---------|
| `enabled` | boolean | `false` | Toggle Sessionlog functionality |
| `strategy` | string | `'manual-commit'` | Checkpoint strategy |
| `logLevel` | string | `'warn'` | Log verbosity (debug/info/warn/error) |
| `skipPushSessions` | boolean | `false` | Disable auto-push of checkpoints branch |
| `telemetryEnabled` | boolean | `false` | Anonymous usage analytics |
| `summarizationEnabled` | boolean | `false` | AI-generated summaries on commit |

## Summarization

Generate AI-powered session summaries:

```typescript
import {
  buildCondensedTranscript,
  buildSummarizationPrompt,
  createClaudeGenerator,
} from 'sessionlog';

// Build a condensed transcript from raw agent output
const condensed = buildCondensedTranscript(entries);

// Generate a summary using Claude
const generator = createClaudeGenerator({ model: 'claude-sonnet-4-6' });
const summary = await generator.generate({ condensed, prompt: 'Summarize this session' });
// { intent, outcome, learnings, friction, openItems }
```

## Git Worktrees

Sessionlog integrates with git worktrees, providing independent session tracking per worktree without conflicts.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Watch mode
npm run test:watch

# Lint
npm run lint

# Format
npm run format
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Not a git repository" | Navigate to a Git repository first |
| "Sessionlog is disabled" | Run `enable()` |
| "No rewind points found" | Work with your agent and commit changes |
| "shadow branch conflict" | Run `reset({ force: true })` |

## License

MIT
