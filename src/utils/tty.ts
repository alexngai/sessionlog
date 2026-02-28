/**
 * TTY Interaction Helpers
 *
 * Utilities for detecting and interacting with a controlling terminal.
 * Important for git hooks which need user confirmation even when stdin
 * is redirected.
 *
 * Ported from Go: strategy/manual_commit_hooks.go
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';

/**
 * Detect if a controlling terminal (TTY) is available.
 *
 * Respects environment variables:
 * - `RUNLOG_TEST_TTY=1` forces TTY detection to true (for testing)
 * - `GEMINI_CLI=1` forces TTY detection to false (Gemini runs non-interactively)
 */
export function hasTTY(): boolean {
  // Check environment overrides
  if (process.env.RUNLOG_TEST_TTY === '1') return true;
  if (process.env.GEMINI_CLI === '1') return false;

  // Try opening /dev/tty — this works even when stdin is redirected
  try {
    const fd = fs.openSync('/dev/tty', 'r');
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prompt the user for yes/no confirmation via /dev/tty.
 *
 * This works even when stdin is redirected (important for git hooks).
 * Returns false if no TTY is available or the user declines.
 */
export async function askConfirmTTY(prompt: string): Promise<boolean> {
  if (!hasTTY()) return false;

  let ttyIn: fs.ReadStream | undefined;
  let ttyOut: fs.WriteStream | undefined;

  try {
    ttyIn = fs.createReadStream('/dev/tty');
    ttyOut = fs.createWriteStream('/dev/tty');

    const rl = readline.createInterface({
      input: ttyIn,
      output: ttyOut,
    });

    const result = await new Promise<boolean>((resolve) => {
      rl.question(`${prompt} [y/N] `, (answer) => {
        rl.close();
        const normalized = answer.trim().toLowerCase();
        resolve(normalized === 'y' || normalized === 'yes');
      });
    });

    return result;
  } catch {
    return false;
  } finally {
    ttyIn?.destroy();
    ttyOut?.destroy();
  }
}
