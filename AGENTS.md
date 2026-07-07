# Agent Instructions

Sessionlog is an unofficial TypeScript reimplementation of the [Entire CLI](https://github.com/entireio/cli): a Git-native session tracker and checkpoint manager for AI coding agents (Claude Code, Cursor, Gemini CLI, OpenCode, Codex, OpenSwarm). It records sessions as searchable checkpoints on a separate `sessionlog/checkpoints/v1` branch, keeping the user's working branch clean, and supports rewind/resume across agent sessions.

## Build and test

```bash
npm install
npm run build          # tsc
npm test               # vitest run
npm run lint           # eslint src/
npm run format          # prettier --write
```

## Top conventions

- ESM-only (`"type": "module"`); relative imports use the `.js` extension (TypeScript ESM convention).
- Zero production dependencies — git operations shell out via `child_process`, no git library.
- All public API surfaces are exported from `src/index.ts`; the optional OpenTelemetry integration is exported separately via the `sessionlog/telemetry` subpath.
- Tests live in `src/__tests__/` (vitest).
- A husky `pre-commit` hook runs `lint-staged`.

See `CLAUDE.md` for the full guide (architecture, event types, settings, OTel integration).
