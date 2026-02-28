/**
 * Setup ccweb Command
 *
 * Configures a repository for Sessionlog integration with Claude Code Web.
 * Creates .claude/settings.json SessionStart hook and .claude/scripts/setup-env.sh
 * so that sessionlog is automatically installed and enabled on every ccweb session.
 *
 * Inspired by the entire-setup-ccweb pattern:
 * https://github.com/aromarious/entire-setup-ccweb
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { isGitRepository, getWorktreeRoot } from '../git-operations.js';

// ============================================================================
// Constants
// ============================================================================

const CLAUDE_SCRIPTS_DIR = '.claude/scripts';
const CLAUDE_SETTINGS_FILE = '.claude/settings.json';
const SETUP_SCRIPT_FILE = '.claude/scripts/setup-env.sh';
const SETUP_HOOK_COMMAND = 'sh .claude/scripts/setup-env.sh';

// ============================================================================
// Types
// ============================================================================

export interface SetupCcwebOptions {
  /** Working directory */
  cwd?: string;

  /** Allowed push prefixes (space-separated, overrides template default) */
  pushPrefixes?: string;

  /** Force overwrite existing setup */
  force?: boolean;
}

export interface SetupCcwebResult {
  success: boolean;
  settingsCreated: boolean;
  scriptCreated: boolean;
  errors: string[];
}

// ============================================================================
// Claude Settings Types
// ============================================================================

interface ClaudeHookEntry {
  type: string;
  command: string;
}

interface ClaudeHookMatcher {
  matcher: string;
  hooks: ClaudeHookEntry[];
}

interface ClaudeSettings {
  hooks?: {
    SessionStart?: ClaudeHookMatcher[];
    [key: string]: ClaudeHookMatcher[] | undefined;
  };
  permissions?: {
    allow?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Set up a repository for Sessionlog on Claude Code Web.
 *
 * This creates:
 * 1. `.claude/settings.json` — adds a SessionStart hook that runs the setup script
 * 2. `.claude/scripts/setup-env.sh` — installs sessionlog, enables it, configures push access
 *
 * After running this command, commit the `.claude/` directory and push. When the
 * repository is opened in ccweb, sessionlog will be automatically installed and
 * configured on every session start.
 */
export async function setupCcweb(options: SetupCcwebOptions = {}): Promise<SetupCcwebResult> {
  const cwd = options.cwd ?? process.cwd();
  const errors: string[] = [];

  // Validate git repository
  if (!(await isGitRepository(cwd))) {
    return {
      success: false,
      settingsCreated: false,
      scriptCreated: false,
      errors: ['Not a git repository'],
    };
  }

  const root = await getWorktreeRoot(cwd);

  // Create directories
  const scriptsDir = path.join(root, CLAUDE_SCRIPTS_DIR);
  await fs.promises.mkdir(scriptsDir, { recursive: true });

  // Update .claude/settings.json
  let settingsCreated = false;
  try {
    settingsCreated = await updateClaudeSettings(root, options.force);
  } catch (e) {
    errors.push(`Failed to update settings: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Create/update setup script
  let scriptCreated = false;
  try {
    scriptCreated = await writeSetupScript(root, options);
  } catch (e) {
    errors.push(`Failed to write setup script: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    success: errors.length === 0,
    settingsCreated,
    scriptCreated,
    errors,
  };
}

// ============================================================================
// Settings Management
// ============================================================================

/**
 * Add the SessionStart hook to .claude/settings.json
 */
async function updateClaudeSettings(root: string, force = false): Promise<boolean> {
  const settingsPath = path.join(root, CLAUDE_SETTINGS_FILE);
  let settings: ClaudeSettings = {};

  // Read existing settings
  try {
    const content = await fs.promises.readFile(settingsPath, 'utf-8');
    settings = JSON.parse(content) as ClaudeSettings;
  } catch {
    // No existing settings — start fresh
  }

  if (!settings.hooks) settings.hooks = {};

  // Check if our hook is already installed
  const sessionStartHooks = settings.hooks.SessionStart ?? [];
  const hasOurHook = sessionStartHooks.some((m) =>
    m.hooks.some((h) => h.command.includes('setup-env.sh')),
  );

  if (hasOurHook && !force) {
    return false; // Already installed
  }

  if (hasOurHook && force) {
    // Remove existing hook for reinstall
    settings.hooks.SessionStart = sessionStartHooks.filter(
      (m) => !m.hooks.some((h) => h.command.includes('setup-env.sh')),
    );
  }

  // Add SessionStart hook
  const matchers = settings.hooks.SessionStart ?? [];
  matchers.push({
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: SETUP_HOOK_COMMAND,
      },
    ],
  });
  settings.hooks.SessionStart = matchers;

  // Add bash permission for the setup script
  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];
  const allowEntry = `Bash(sh .claude/scripts/setup-env.sh)`;
  if (!settings.permissions.allow.includes(allowEntry)) {
    settings.permissions.allow.push(allowEntry);
  }

  // Write settings
  const dir = path.dirname(settingsPath);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  return true;
}

// ============================================================================
// Setup Script
// ============================================================================

/**
 * Write the setup-env.sh script from the bundled template.
 * Preserves user-customized ALLOWED_PUSH_PREFIXES on update.
 */
async function writeSetupScript(root: string, options: SetupCcwebOptions): Promise<boolean> {
  const scriptPath = path.join(root, SETUP_SCRIPT_FILE);

  // Check if script already exists
  let existingContent = '';
  try {
    existingContent = await fs.promises.readFile(scriptPath, 'utf-8');
  } catch {
    // File doesn't exist
  }

  if (existingContent && !options.force) {
    // Preserve existing script unless --force
    return false;
  }

  // Preserve user-customized ALLOWED_PUSH_PREFIXES from existing script
  let pushPrefixes = options.pushPrefixes ?? 'sessionlog/ claude/';
  if (existingContent && !options.pushPrefixes) {
    const match = existingContent.match(/^ALLOWED_PUSH_PREFIXES="([^"]*)"$/m);
    if (match) {
      pushPrefixes = match[1];
    }
  }

  // Load the template
  const template = loadTemplate();

  // Apply push prefixes customization
  const content = template.replace(
    /^ALLOWED_PUSH_PREFIXES="[^"]*"$/m,
    `ALLOWED_PUSH_PREFIXES="${pushPrefixes}"`,
  );

  await fs.promises.writeFile(scriptPath, content, { mode: 0o755 });

  return true;
}

/**
 * Load the setup-env.sh template.
 * Tries the bundled template first (from package dist), then falls back to
 * the source template for development.
 */
function loadTemplate(): string {
  const require = createRequire(import.meta.url);

  // Try relative paths from the compiled output location (dist/commands/)
  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    // Installed via npm: template is in templates/ relative to package root
    path.resolve(path.dirname(require.resolve('../../package.json')), 'templates', 'setup-env.sh'),
    // Development: template is in templates/ at repo root (from dist/commands/ or src/commands/)
    path.resolve(thisDir, '..', '..', 'templates', 'setup-env.sh'),
  ];

  for (const candidate of candidates) {
    try {
      return fs.readFileSync(candidate, 'utf-8');
    } catch {
      // Try next candidate
    }
  }

  throw new Error(
    'Could not find setup-env.sh template. Ensure the templates/ directory is included in the package.',
  );
}
