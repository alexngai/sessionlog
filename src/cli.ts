#!/usr/bin/env node
/**
 * Sessionlog CLI Entry Point
 *
 * Minimal CLI wrapper over the library functions.
 * Parses arguments and dispatches to the appropriate command.
 */

import * as process from 'node:process';

// Ensure agent implementations are registered
import './agent/agents/claude-code.js';
import './agent/agents/cursor.js';
import './agent/agents/gemini-cli.js';
import './agent/agents/opencode.js';

import { enable } from './commands/enable.js';
import { disable } from './commands/disable.js';
import { setupCcweb } from './commands/setup-ccweb.js';
import { status, formatStatusJSON, formatTokens } from './commands/status.js';
import { listRewindPoints, rewindTo, listRewindPointsJSON } from './commands/rewind.js';
import { doctor, diagnose } from './commands/doctor.js';
import { clean } from './commands/clean.js';
import { reset } from './commands/reset.js';
import { explainCommit, getCheckpointDetail } from './commands/explain.js';
import { discoverResumeInfo, listResumableBranches } from './commands/resume.js';
import { isEnabled, loadSettings } from './config.js';
import { createSessionStore } from './store/session-store.js';
import { createCheckpointStore } from './store/checkpoint-store.js';
import { createManualCommitStrategy } from './strategy/manual-commit.js';
import { getVersion } from './index.js';
import {
  getWorktreeRoot,
  initSessionRepo,
  resolveSessionRepoPath,
  getProjectID,
} from './git-operations.js';
import { CHECKPOINTS_BRANCH, SESSION_DIR_NAME } from './types.js';

// ============================================================================
// Argument Parsing Helpers
// ============================================================================

function hasFlag(args: string[], ...flags: string[]): boolean {
  return flags.some((f) => args.includes(f));
}

function getFlagValue(args: string[], ...flags: string[]): string | undefined {
  for (const flag of flags) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) {
      return args[idx + 1];
    }
    // Handle --flag=value
    const prefix = flag + '=';
    const match = args.find((a) => a.startsWith(prefix));
    if (match) return match.slice(prefix.length);
  }
  return undefined;
}

function getPositionalArg(args: string[], flagPrefixes: string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    if (flagPrefixes.some((p) => args.includes(p) && args[args.indexOf(p) + 1] === arg)) continue;
    return arg;
  }
  return undefined;
}

// ============================================================================
// Command Handlers
// ============================================================================

async function cmdEnable(args: string[]): Promise<void> {
  const result = await enable({
    agent: getFlagValue(args, '--agent'),
    force: hasFlag(args, '--force', '-f'),
    local: hasFlag(args, '--local'),
    project: hasFlag(args, '--project'),
    skipPushSessions: hasFlag(args, '--skip-push-sessions') ? true : undefined,
    telemetry: getFlagValue(args, '--telemetry') === 'false' ? false : undefined,
    sessionRepoPath: getFlagValue(args, '--session-repo'),
  });

  if (!result.enabled) {
    console.error('Failed to enable Sessionlog:');
    for (const err of result.errors) console.error(`  ${err}`);
    process.exit(1);
  }

  console.log('Sessionlog enabled.');
  if (result.agent) console.log(`  Agent: ${result.agent}`);
  console.log(`  Git hooks installed: ${result.gitHooksInstalled}`);
  console.log(`  Agent hooks installed: ${result.agentHooksInstalled}`);
  if (result.errors.length > 0) {
    console.warn('Warnings:');
    for (const err of result.errors) console.warn(`  ${err}`);
  }
}

async function cmdDisable(args: string[]): Promise<void> {
  const result = await disable({
    uninstall: hasFlag(args, '--uninstall'),
    local: hasFlag(args, '--local'),
  });

  if (!result.disabled) {
    console.error('Failed to disable Sessionlog:');
    for (const err of result.errors) console.error(`  ${err}`);
    process.exit(1);
  }

  console.log('Sessionlog disabled.');
  if (result.uninstalled) console.log('  Hooks uninstalled.');
}

async function cmdStatus(args: string[]): Promise<void> {
  const result = await status();

  if (hasFlag(args, '--json')) {
    console.log(formatStatusJSON(result));
    return;
  }

  console.log(`Enabled: ${result.enabled}`);
  console.log(`Strategy: ${result.strategy}`);
  console.log(`Branch: ${result.branch ?? '(detached)'}`);
  console.log(`Checkpoints branch: ${result.hasCheckpointsBranch ? 'exists' : 'not created'}`);
  console.log(`Git hooks: ${result.gitHooksInstalled ? 'installed' : 'not installed'}`);
  console.log(`Agents: ${result.agents.length > 0 ? result.agents.join(', ') : 'none'}`);
  if (result.settings.sessionRepoPath) {
    console.log(`Session repo: ${result.settings.sessionRepoPath}`);
  }

  if (result.sessions.length > 0) {
    console.log(`\nActive sessions (${result.sessions.length}):`);
    for (const s of result.sessions) {
      console.log(`  ${s.sessionID} (${s.agentType}) - ${s.phase}`);
      if (s.firstPrompt) console.log(`    Prompt: ${s.firstPrompt.slice(0, 80)}...`);
      if (s.filesTouched.length > 0) console.log(`    Files: ${s.filesTouched.length}`);
      if (s.tokenUsage) {
        console.log(
          `    Tokens: ${formatTokens(s.tokenUsage.input)} in / ${formatTokens(s.tokenUsage.output)} out`,
        );
      }
    }
  }
}

async function cmdRewind(args: string[]): Promise<void> {
  const toID = getFlagValue(args, '--to');

  if (hasFlag(args, '--list')) {
    console.log(await listRewindPointsJSON());
    return;
  }

  if (toID) {
    const result = await rewindTo(toID, {
      logsOnly: hasFlag(args, '--logs-only'),
      reset: hasFlag(args, '--reset'),
    });
    if (!result.success) {
      console.error(result.message);
      process.exit(1);
    }
    console.log(result.message);
    return;
  }

  // Default: list rewind points
  const points = await listRewindPoints({ limit: 20 });
  if (points.length === 0) {
    console.log('No rewind points found. Work with your agent and commit changes.');
    return;
  }

  for (const p of points) {
    const prefix = p.isLogsOnly ? '[logs]' : '[code]';
    const agent = p.agent ? ` (${p.agent})` : '';
    console.log(`  ${prefix} ${p.id.slice(0, 8)} - ${p.message}${agent} - ${p.date}`);
  }
  console.log(`\nUse --to <id> to rewind to a specific point.`);
}

async function cmdDoctor(args: string[]): Promise<void> {
  if (hasFlag(args, '--force')) {
    const result = await doctor({ force: true });
    console.log(`Fixed: ${result.fixedCount}, Discarded: ${result.discardedCount}`);
    for (const err of result.errors) console.error(`  Error: ${err}`);
    return;
  }

  const stuck = await diagnose();
  if (stuck.length === 0) {
    console.log('No stuck sessions found.');
    return;
  }

  console.log(`Found ${stuck.length} stuck session(s):`);
  for (const s of stuck) {
    console.log(`  ${s.sessionID} - ${s.reason}`);
  }
  console.log('\nUse --force to auto-fix.');
}

async function cmdClean(args: string[]): Promise<void> {
  const result = await clean({ force: hasFlag(args, '--force') });

  if (result.items.length === 0) {
    console.log('Nothing to clean.');
    return;
  }

  for (const item of result.items) {
    const status = result.deletedCount > 0 ? 'deleted' : 'would delete';
    console.log(`  [${item.type}] ${item.path} - ${item.reason} (${status})`);
  }

  if (!hasFlag(args, '--force')) {
    console.log(`\nFound ${result.items.length} item(s). Use --force to delete.`);
  } else {
    console.log(`\nDeleted ${result.deletedCount} item(s).`);
  }
}

async function cmdReset(args: string[]): Promise<void> {
  const result = await reset({
    sessionID: getFlagValue(args, '--session'),
    force: hasFlag(args, '--force'),
  });

  if (result.errors.length > 0) {
    for (const err of result.errors) console.error(`  ${err}`);
    if (result.sessionsReset.length === 0) process.exit(1);
  }

  console.log(`Sessions reset: ${result.sessionsReset.length}`);
  console.log(`Branches deleted: ${result.branchesDeleted.length}`);
}

async function cmdExplain(args: string[]): Promise<void> {
  const commitRef =
    getFlagValue(args, '--commit') ?? getPositionalArg(args, ['--commit', '--checkpoint']);
  const checkpointID = getFlagValue(args, '--checkpoint', '-c');

  if (checkpointID) {
    const detail = await getCheckpointDetail(checkpointID);
    if (!detail) {
      console.error(`Checkpoint not found: ${checkpointID}`);
      process.exit(1);
    }
    console.log(JSON.stringify(detail, null, 2));
    return;
  }

  const ref = commitRef ?? 'HEAD';
  const result = await explainCommit(ref);
  if (!result) {
    console.error(`Could not explain commit: ${ref}`);
    process.exit(1);
  }

  console.log(`Commit: ${result.commitSHA.slice(0, 8)}`);
  console.log(`Message: ${result.commitMessage}`);
  if (result.checkpointID) {
    console.log(`Checkpoint: ${result.checkpointID}`);
  }
  if (result.detail) {
    console.log(`Agent: ${result.detail.agent}`);
    console.log(`Files: ${result.detail.filesTouched.join(', ')}`);
    if (result.detail.summary) {
      console.log(`\nIntent: ${result.detail.summary.intent}`);
      console.log(`Outcome: ${result.detail.summary.outcome}`);
    }
  }
}

async function cmdResume(args: string[]): Promise<void> {
  const branch = getPositionalArg(args, []);

  if (!branch) {
    // List resumable branches
    const branches = await listResumableBranches();
    if (branches.length === 0) {
      console.log('No resumable branches found.');
      return;
    }

    console.log('Resumable branches:');
    for (const b of branches) {
      console.log(`  ${b.branch} - session ${b.sessionID} (${b.lastCommit})`);
    }
    return;
  }

  const result = await discoverResumeInfo(branch);
  if (!result.success || !result.info) {
    console.error(result.error ?? 'Failed to discover resume info');
    process.exit(1);
  }

  console.log(`Branch: ${result.info.branchName}`);
  console.log(`Session: ${result.info.sessionID}`);
  console.log(`Checkpoint: ${result.info.checkpointID}`);
  console.log(`Commit: ${result.info.commitSHA.slice(0, 8)} - ${result.info.commitMessage}`);
  if (result.info.needsReset) {
    console.log(
      `\nNote: branch has advanced past checkpoint. Reset target: ${result.info.resetTargetSHA?.slice(0, 8)}`,
    );
  }
}

async function cmdSetupCcweb(args: string[]): Promise<void> {
  const result = await setupCcweb({
    force: hasFlag(args, '--force', '-f'),
    pushPrefixes: getFlagValue(args, '--push-prefixes'),
  });

  if (!result.success) {
    console.error('Failed to set up ccweb integration:');
    for (const err of result.errors) console.error(`  ${err}`);
    process.exit(1);
  }

  console.log('Claude Code Web integration configured.');
  console.log(`  Settings: ${result.settingsCreated ? 'created' : 'already exists'}`);
  console.log(`  Script: ${result.scriptCreated ? 'created' : 'already exists'}`);
  console.log('\nNext steps:');
  console.log('  1. Commit the .claude/ directory');
  console.log('  2. Push to your repository');
  console.log('  3. Open the repo in Claude Code Web');
  console.log('\nRequirements:');
  console.log('  - Set GITHUB_TOKEN in your ccweb environment variables');
  console.log('  - Enable "Trusted" network access level in ccweb settings');
}

// ============================================================================
// Git Hook Dispatch
// ============================================================================

/**
 * Handle `sessionlog hooks git <hook-name> [args...]`
 *
 * This is invoked by the git hooks installed via `sessionlog enable`.
 * Each hook delegates to the corresponding strategy method.
 * All hooks are designed to fail silently (the shell scripts use `|| true`
 * except commit-msg which uses `|| exit 1`).
 */
async function cmdHooksGit(args: string[]): Promise<void> {
  const hookName = args[0];
  const hookArgs = args.slice(1);

  // Bail silently if Sessionlog is not enabled
  if (!(await isEnabled())) return;

  // Resolve session repo if configured
  const settings = await loadSettings();
  let sessionRepoCwd: string | undefined;
  let sessionsDir: string | undefined;
  let checkpointsBranch: string | undefined;

  if (settings.sessionRepoPath) {
    const root = await getWorktreeRoot();
    const projectID = getProjectID(root);
    const resolved = resolveSessionRepoPath(settings.sessionRepoPath, root);
    sessionRepoCwd = await initSessionRepo(resolved);
    // Namespace by project so multiple repos can share one session repo
    sessionsDir = `${sessionRepoCwd}/${SESSION_DIR_NAME}/${projectID}`;
    checkpointsBranch = `${CHECKPOINTS_BRANCH}/${projectID}`;
  }

  const strategy = createManualCommitStrategy({
    sessionStore: createSessionStore(undefined, sessionsDir),
    checkpointStore: createCheckpointStore(undefined, sessionRepoCwd, checkpointsBranch),
    sessionRepoCwd,
    checkpointsBranch,
  });

  switch (hookName) {
    case 'prepare-commit-msg': {
      // Args: <commit-msg-file> [<source>] [<sha>]
      const commitMsgFile = hookArgs[0];
      const source = hookArgs[1] ?? '';
      const sha = hookArgs[2] ?? '';
      if (!commitMsgFile) return;
      await strategy.prepareCommitMsg(commitMsgFile, source, sha);
      break;
    }
    case 'commit-msg': {
      // Args: <commit-msg-file>
      const commitMsgFile = hookArgs[0];
      if (!commitMsgFile) return;
      await strategy.commitMsg(commitMsgFile);
      break;
    }
    case 'post-commit': {
      await strategy.postCommit();
      break;
    }
    case 'pre-push': {
      // Args: <remote> <url>
      const remote = hookArgs[0] ?? 'origin';
      await strategy.prePush(remote);
      break;
    }
    default:
      // Unknown hook — ignore silently (hooks must not break git)
      break;
  }
}

async function cmdVersion(): Promise<void> {
  console.log(`sessionlog ${getVersion()}`);
}

function printHelp(): void {
  console.log(`sessionlog ${getVersion()}

Usage: sessionlog <command> [options]

Commands:
  enable        Activate Sessionlog in a repository
  disable       Deactivate Sessionlog hooks
  status        Show current session information
  rewind        Browse and restore checkpoints
  doctor        Diagnose and fix stuck sessions
  clean         Remove orphaned data artifacts
  reset         Clear shadow branch and session state
  explain       Show session or commit details
  resume        Switch branches and restore sessions
  setup-ccweb   Configure for Claude Code Web sessions
  version       Show version

Options:
  enable --session-repo <path>   Store sessions in a separate repository

Run 'sessionlog <command> --help' for more information on a command.`);
}

// ============================================================================
// Main Dispatch
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const commandArgs = args.slice(1);

  if (!command || hasFlag(args, '--help', '-h')) {
    printHelp();
    return;
  }

  switch (command) {
    case 'enable':
      return cmdEnable(commandArgs);
    case 'disable':
      return cmdDisable(commandArgs);
    case 'status':
      return cmdStatus(commandArgs);
    case 'rewind':
      return cmdRewind(commandArgs);
    case 'doctor':
      return cmdDoctor(commandArgs);
    case 'clean':
      return cmdClean(commandArgs);
    case 'reset':
      return cmdReset(commandArgs);
    case 'explain':
      return cmdExplain(commandArgs);
    case 'resume':
      return cmdResume(commandArgs);
    case 'setup-ccweb':
      return cmdSetupCcweb(commandArgs);
    case 'hooks': {
      // `sessionlog hooks git <hook-name> [args...]`
      const subcommand = commandArgs[0];
      if (subcommand === 'git') {
        return cmdHooksGit(commandArgs.slice(1));
      }
      console.error(`Unknown hooks subcommand: ${subcommand}`);
      process.exit(1);
      break;
    }
    case 'version':
    case '--version':
    case '-v':
      return cmdVersion();
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
