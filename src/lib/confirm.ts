/**
 * Confirmation for destructive commands.
 *
 * Five commands shared this shape:
 *
 *   if (!opts.yes) {
 *     console.log('This will permanently delete ...');
 *     console.log('Pass --yes to confirm.');
 *     process.exit(0);          // <- reports success for work not done
 *   }
 *
 * Two problems. Interactively it refuses to do the thing and makes you retype
 * the command with a flag, when it could simply ask. And it exits 0, so a
 * script sees success from a command that deleted nothing - `cf secret delete X
 * && echo done` prints "done" having done nothing.
 *
 * This helper prompts when there is a terminal, and when there is not - CI, a
 * pipeline - it fails with exit 1 and says which flag to pass. Refusing to act
 * is fine; claiming success while refusing is not.
 */

import chalk from 'chalk';
import prompts from 'prompts';

export type ConfirmOptions = {
  /** What is about to happen, in plain terms. */
  message: string;
  /** Set by `--yes`. Skips the prompt entirely. */
  assumeYes?: boolean | undefined;
  /**
   * Require the user to type this exact string. Reserved for the genuinely
   * unrecoverable - deleting a workspace and everything in it - where a reflexive
   * "y" is too easy.
   */
  requireTyped?: string | undefined;
};

/**
 * Returns only when the action is confirmed. Otherwise it exits: 0 when the
 * user declined at a prompt (they chose that, it is not a failure), 1 when
 * there was no way to ask.
 */
export async function confirmDestructive(options: ConfirmOptions): Promise<void> {
  const { message, assumeYes, requireTyped } = options;

  if (assumeYes) return;

  if (!process.stdin.isTTY) {
    console.error(chalk.yellow('!') + ` ${message}`);
    console.error(chalk.dim('  Not a terminal, so this cannot be confirmed interactively. Pass --yes to proceed.'));
    process.exit(1);
  }

  console.log(chalk.yellow('!') + ` ${message}`);

  if (requireTyped) {
    const { typed } = await prompts(
      {
        type: 'text',
        name: 'typed',
        message: `Type ${chalk.bold(requireTyped)} to confirm`,
      },
      { onCancel: () => ({ typed: '' }) },
    );
    if (typed !== requireTyped) {
      console.log(chalk.dim('  Cancelled.'));
      process.exit(0);
    }
    return;
  }

  const { ok } = await prompts(
    { type: 'confirm', name: 'ok', message: 'Continue?', initial: false },
    { onCancel: () => ({ ok: false }) },
  );
  if (!ok) {
    console.log(chalk.dim('  Cancelled.'));
    process.exit(0);
  }
}
