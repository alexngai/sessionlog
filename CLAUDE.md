# CLAUDE.md

Project context for AI coding agents working on this repository.

## What is sessionlog

An unofficial TypeScript reimplementation of the Entire CLI. It captures AI agent sessions (Claude Code, Cursor, Gemini CLI, OpenCode) as Git-native checkpoints — searchable, rewindable records stored on a separate `sessionlog/checkpoints/v1` branch so the user's working branch stays clean.

Zero production dependencies. Requires Node.js >= 18 and Git.

## Repository layout

```
src/
  agent/          Agent implementations (claude-code, cursor, gemini, opencode, codex)
  commands/       CLI command implementations (enable, disable, status, rewind, etc.)
  events/         JSONL event log (checkpoint events for external consumers)
  hooks/          Lifecycle handler + git hooks + skill version resolver
  security/       Secret redaction (entropy + pattern matching)
  session/        Session state machine (phase transitions)
  store/          SessionStore, CheckpointStore, NativeStore
  strategy/       Manual-commit strategy (checkpoint creation, condensation, attribution)
  summarize/      AI-powered session summarization
  telemetry/      OpenTelemetry integration (optional, see below)
  utils/          Shared utilities (paths, trailers, validation, etc.)
  cli.ts          CLI entry point
  config.ts       Settings loader (.sessionlog/settings.json)
  index.ts        Public API exports
  types.ts        Core type definitions
  wire-types.ts   Snake_case types for external consumers
```

## Build and test

```bash
npm install
npm run build          # tsc
npm test               # vitest run
npm run test:watch     # vitest
npm run lint           # eslint src/
npm run format         # prettier
```

Type-checking: `npx tsc --noEmit`. Pre-existing errors from missing `@types/node` in the container are expected — they resolve after `npm install`.

## Key architecture concepts

- **SessionState** — JSON record per session in `.git/sessionlog-sessions/{id}.json`
- **Shadow branches** — `sessionlog/<hash>` branches hold work-in-progress snapshots
- **Checkpoints branch** — `sessionlog/checkpoints/v1` stores permanent metadata (transcript, prompts, attribution)
- **Lifecycle handler** — `createLifecycleHandler()` dispatches `Event` objects through a state machine, updating `SessionState`
- **Strategy** — `createManualCommitStrategy()` orchestrates git hooks (`prepare-commit-msg`, `commit-msg`, `post-commit`, `pre-push`) to create checkpoints on user commits
- **Agent interface** — composable capabilities (`HookSupport`, `TranscriptAnalyzer`, `TokenCalculator`, etc.) registered via `registerAgent()`

## Event types

The lifecycle handler processes these events (defined in `EventType` enum in `types.ts`):

| Event | Trigger |
|-------|---------|
| `SessionStart` | Agent session begins |
| `TurnStart` | User submits a prompt |
| `TurnEnd` | Agent response completes |
| `SessionEnd` | Session closes |
| `Compaction` | Transcript truncation point |
| `SubagentStart` / `SubagentEnd` | Spawned subagent lifecycle |
| `TaskCreate` / `TaskUpdate` | Task tool tracking |
| `PlanModeEnter` / `PlanModeExit` | Plan mode lifecycle |
| `SkillUse` | Skill invocation |

## OpenTelemetry integration

The `src/telemetry/` module provides optional OTLP export of session lifecycle data. All `@opentelemetry/*` packages are optional peer dependencies — they load dynamically only when `otel.enabled` is true.

### Files

| File | Purpose |
|------|---------|
| `types.ts` | `OTelSettings`, `TelemetryExporter` interface, `SemanticAttributes`, `MetricNames` |
| `otel-exporter.ts` | Maps lifecycle events to OTel spans, metrics, and logs via OTLP |
| `lifecycle-hook.ts` | `wrapWithTelemetry()` — wraps a `LifecycleHandler` to emit telemetry transparently |
| `init.ts` | `initTelemetry()` entry point + `shouldSample()` |
| `index.ts` | Public exports via `sessionlog/telemetry` subpath |

### Signal mapping

- **Sessions** map to **traces** (root span per session)
- **Turns** map to **child spans** (one per agent turn)
- **Tasks/subagents** map to **child spans** (nested under turns)
- **Token usage** maps to **counters** (`sessionlog.tokens.input`, `.output`, `.cache_read`, `.cache_creation`) and a **per-turn histogram** (`sessionlog.turn.token_usage`)
- **Turn duration** maps to a **histogram** (`sessionlog.turn.duration_ms`)
- **Session duration** maps to a **histogram** (`sessionlog.session.duration_seconds`)
- **Skill use**, **user prompt**, **plan mode**, **compaction** map to **span events** and **log records**

### Privacy model

Dual-path, matching the OpenAI Codex CLI approach:
- **Traces** (spans + span events) — structural/aggregate data only. No prompt text, no tool arguments.
- **Logs** — may include sensitive text when `logSensitiveData: true` in settings.

### Integration pattern

```typescript
import { createLifecycleHandler, loadSettings } from 'sessionlog';
import { initTelemetry, wrapWithTelemetry } from 'sessionlog/telemetry';

const settings = await loadSettings();
const exporter = await initTelemetry(settings.otel ?? { enabled: false });

let lifecycle = createLifecycleHandler({ sessionStore, checkpointStore });
if (exporter) {
  lifecycle = wrapWithTelemetry({ inner: lifecycle, exporter, sessionStore });
}
```

### Configuration

Set in `.sessionlog/settings.json` under the `otel` key:

```jsonc
{
  "otel": {
    "enabled": true,
    "endpoint": "http://localhost:4318",
    "protocol": "http/protobuf",
    "logSensitiveData": false,
    "sampling": { "rate": 1.0 }
  }
}
```

## Settings

Two settings files, local overrides project:

| File | Purpose |
|------|---------|
| `.sessionlog/settings.json` | Team-shared, version-controlled |
| `.sessionlog/settings.local.json` | Personal overrides, gitignored |

Key fields: `enabled`, `strategy`, `logLevel`, `skipPushSessions`, `telemetryEnabled`, `summarizationEnabled`, `eventLogEnabled`, `eventLogMaxEvents`, `sessionRepo`, `otel`.

## Conventions

- ESM-only (`"type": "module"` in package.json)
- Imports use `.js` extension (TypeScript ESM convention)
- Git operations use child_process exec (no git library)
- All public API surfaces exported from `src/index.ts`
- Telemetry module exported via `sessionlog/telemetry` subpath
- Tests in `src/__tests__/` using vitest
