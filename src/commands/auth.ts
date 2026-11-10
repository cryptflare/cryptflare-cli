import { Command } from 'commander';
import chalk from 'chalk';
import open from 'open';

import { BRAND } from '../_vendored/brand';

import { getAnonymousClient, getClient, resetClient, ApiError } from '../lib/api.js';
import { getToken, setToken, clearToken, setOrg, getConfigPath } from '../lib/config.js';
import { success, warn, handleError } from '../lib/output.js';
import * as progress from '../lib/progress.js';
import { classifyCredentialCheck, decideLogin, LOGIN_COMMAND, type CredentialState } from '../lib/login-state.js';

const DIVIDER = chalk.dim('─'.repeat(48));
const BASE_URL_LABEL = process.env.CF_API_URL ?? BRAND.urls.api;

type DeviceResponse = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
};

type TokenResponse = {
  apiKey: string;
  user: { id: string; email: string; name: string | null };
  org: string;
};

type AuthMeResponse = {
  user: { email: string; name: string | null };
  organisations: { id: string; name: string; plan: string; role: string }[];
};

export const authCommand = new Command('auth')
  .description('Manage authentication');

/** Asks the API whether the saved key still works. */
async function checkSavedCredential(): Promise<CredentialState> {
  progress.start('Checking the saved key...');
  try {
    await getClient().auth.whoami();
    return 'valid';
  } catch (err) {
    return classifyCredentialCheck(err);
  } finally {
    progress.stop();
  }
}

/**
 * Builds the login command. A factory rather than one instance because it is
 * registered twice (`cf login` and `cf auth login`) and a commander command
 * can only have one parent.
 */
function buildLoginCommand(): Command {
  return new Command('login')
    .description('Authenticate via browser')
    .option('-f, --force', 'Sign in again even though the saved key still works, replacing it')
    .action(async (opts: { force?: boolean }) => {
    console.log();
    console.log(`  ${chalk.bold(BRAND.name)} CLI`);
    console.log(DIVIDER);

    const existing = getToken();
    const decision = await decideLogin({
      hasCredential: Boolean(existing),
      force: Boolean(opts.force),
      check: checkSavedCredential,
    });

    if (decision.action === 'refuse' && existing) {
      const masked = existing.slice(0, 12) + '...' + existing.slice(-4);
      console.log();
      if (decision.reason === 'valid') {
        warn(`Already authenticated: ${chalk.dim(masked)}`);
        console.log();
        console.log(`  To sign in again and replace it, run ${chalk.cyan(`${LOGIN_COMMAND} --force`)}.`);
      } else {
        warn(`A key is saved (${chalk.dim(masked)}) but the API at ${BASE_URL_LABEL} could not be reached to check it.`);
        console.log();
        console.log('  Nothing was changed. Try again when you are online,');
        console.log(`  or run ${chalk.cyan(`${LOGIN_COMMAND} --force`)} to replace the key without checking it.`);
      }
      console.log(`  To use a different key, set ${chalk.cyan('CF_TOKEN')} env var.`);
      console.log();
      return;
    }

    if (decision.reason === 'invalid') {
      console.log();
      console.log(`  ${chalk.dim('The saved key is no longer valid. Signing in again.')}`);
    }
    if (existing && process.env.CF_TOKEN) {
      console.log();
      warn('CF_TOKEN is set in this shell and takes priority over the key this saves. Unset it to use the new one.');
    }

    // Anonymous on purpose. The device flow is how a token is obtained, so it
    // must not require one - `getClient()` throws when the config is empty,
    // which made `cf auth login` impossible right after `cf auth logout`.
    const client = getAnonymousClient();
    progress.start('Requesting device code...');

    try {
      const device = await client.cli.requestDeviceCode({}) as DeviceResponse;

      progress.stop();

      console.log();
      console.log(`  ${chalk.bold('Authorize this device')}`);
      console.log();
      const codeStr = `Code:  ${device.userCode}`;
      const boxWidth = codeStr.length + 8;
      const pad = ' '.repeat(boxWidth - codeStr.length - 2);
      console.log(`  ┌${'─'.repeat(boxWidth)}┐`);
      console.log(`  │${' '.repeat(boxWidth)}│`);
      console.log(`  │  Code:  ${chalk.bold.yellow(device.userCode)}${pad}│`);
      console.log(`  │${' '.repeat(boxWidth)}│`);
      console.log(`  └${'─'.repeat(boxWidth)}┘`);
      console.log();
      console.log(`  ${chalk.dim('URL:')}  ${chalk.cyan(device.verificationUrl)}`);
      console.log();

      try {
        await open(device.verificationUrl);
        console.log(`  ${chalk.green('✓')} Browser opened automatically`);
      } catch {
        console.log(`  ${chalk.dim('Open the URL above in your browser')}`);
      }

      console.log();
      progress.start('Waiting for browser approval...');

      const pollMs = Math.max((device.interval ?? 5) * 1000, 3000);
      const deadline = Date.now() + device.expiresIn * 1000;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));

        try {
          const result = await client.runner.send<TokenResponse>({
            method: 'POST',
            path: '/v1/cli/token',
            body: { deviceCode: device.deviceCode },
          });

          setToken(result.apiKey);
          setOrg(result.org);
          // Drop any cached client so a subsequent getClient() in this process
          // picks up the token that was just saved rather than a stale one.
          resetClient();

          progress.stop();

          const masked = result.apiKey.slice(0, 12) + '...' + result.apiKey.slice(-4);

          console.log();
          console.log(`  ${chalk.green('✓')} ${chalk.bold('Authenticated successfully')}`);
          console.log(DIVIDER);
          console.log(`  ${chalk.dim('Key:')}      ${masked}`);
          console.log(`  ${chalk.dim('User:')}     ${result.user.email}`);
          console.log(`  ${chalk.dim('Org:')}      ${result.org}`);
          console.log(`  ${chalk.dim('Saved to:')} ${getConfigPath()}`);
          console.log();
          return;
        } catch (err) {
          if (err instanceof ApiError && err.code === 'AUTH_PENDING') continue;
          if (err instanceof ApiError && err.code === 'RESOURCE_NOT_FOUND') {
            progress.fail('Device code expired. Run `cf login` again.');
            process.exit(1);
          }
          throw err;
        }
      }

      progress.fail('Timed out waiting for approval. Run `cf login` again.');
      process.exit(1);
    } catch (err) {
      progress.stop();
      handleError(err);
    }
    });
}

authCommand.addCommand(buildLoginCommand());

authCommand
  .command('status')
  .description('Show authentication status')
  .action(async () => {
    const token = getToken();

    console.log();
    console.log(`  ${chalk.bold(BRAND.name)} CLI`);
    console.log(DIVIDER);

    if (!token) {
      console.log();
      console.log(`  ${chalk.dim('Not authenticated')}`);
      console.log();
      console.log(`  Run ${chalk.cyan(LOGIN_COMMAND)} to get started.`);
      console.log();
      return;
    }

    const masked = token.slice(0, 12) + '...' + token.slice(-4);
    const source = process.env.CF_TOKEN ? 'CF_TOKEN env' : 'config file';

    try {
      const { user, organisations } = await getClient().auth.getMe() as unknown as AuthMeResponse;

      console.log();
      console.log(`  ${chalk.green('●')} ${chalk.bold('Authenticated')}`);
      console.log();
      console.log(`  ${chalk.dim('Key:')}    ${masked}`);
      console.log(`  ${chalk.dim('Source:')} ${source}`);
      console.log(`  ${chalk.dim('User:')}   ${user.email}`);
      console.log(`  ${chalk.dim('API:')}    ${BRAND.urls.api}`);

      if (organisations.length > 0) {
        console.log();
        console.log(`  ${chalk.bold('Organisations:')}`);
        organisations.forEach((org) => {
          console.log(`    ${chalk.cyan('●')} ${org.name} ${chalk.dim(`(${org.plan})`)} ${chalk.dim('-')} ${chalk.dim(org.role)}`);
        });
      }
      console.log();
    } catch {
      console.log();
      console.log(`  ${chalk.yellow('●')} ${chalk.bold('Key saved but cannot verify')}`);
      console.log();
      console.log(`  ${chalk.dim('Key:')}    ${masked}`);
      console.log(`  ${chalk.dim('Source:')} ${source}`);
      console.log(`  ${chalk.dim('API:')}    ${BRAND.urls.api}`);
      console.log();
      console.log(`  ${chalk.dim('The API may be unreachable or the key may be expired.')}`);
      console.log();
    }
  });

function buildLogoutCommand(): Command {
  return new Command('logout')
    .description('Remove saved API key')
    .action(() => {
      const token = getToken();
      if (!token) {
        console.log();
        console.log(chalk.dim('  No saved API key found.'));
        console.log();
        return;
      }
      clearToken();
      resetClient();
      console.log();
      success('API key removed');
      console.log();
    });
}

authCommand.addCommand(buildLogoutCommand());

/** `cf login`: the same command as `cf auth login`, at the top level. */
export const loginCommand = buildLoginCommand();

/** `cf logout`: the same command as `cf auth logout`, at the top level. */
export const logoutCommand = buildLogoutCommand();
