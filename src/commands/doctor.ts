import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync } from 'node:fs';

import { BRAND } from '../_vendored/brand';

import { getClient } from '../lib/api.js';
import { getToken, getOrg, getDefault, getConfigPath } from '../lib/config.js';
import { VERSION } from '../version.js';

type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

type Check = {
  name: string;
  status: CheckStatus;
  detail?: string;
  hint?: string;
};

const NPM_PACKAGE = '@cryptflare/cli';

export const doctorCommand = new Command('doctor')
  .description('Diagnose auth, config, network, and version issues. Prints a checklist of pass / warn / fail.')
  .option('--json', 'Output the check results as JSON')
  .action(async (opts) => {
    const checks: Check[] = [];

    checks.push(checkNode());
    checks.push(checkConfig());
    checks.push(checkToken());
    checks.push(...(await checkApi()));
    checks.push(...checkContext());
    checks.push(await checkLatestVersion());

    if (opts.json) {
      console.log(JSON.stringify({ version: VERSION, checks }, null, 2));
      return;
    }

    print(checks);

    const failed = checks.some((c) => c.status === 'fail');
    process.exit(failed ? 1 : 0);
  });

function checkNode(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isNaN(major)) {
    return { name: 'Node.js version', status: 'warn', detail: process.versions.node };
  }
  if (major < 20) {
    return {
      name: 'Node.js version',
      status: 'fail',
      detail: `Node ${process.versions.node} is below the supported minimum (20).`,
      hint: 'Upgrade Node: https://nodejs.org or use nvm.',
    };
  }
  return { name: 'Node.js version', status: 'pass', detail: `v${process.versions.node}` };
}

function checkConfig(): Check {
  const path = getConfigPath();
  if (!existsSync(path)) {
    return {
      name: 'Config file',
      status: 'warn',
      detail: `${path} does not exist yet`,
      hint: 'Run `cf auth login` followed by `cf init` to populate it.',
    };
  }
  return { name: 'Config file', status: 'pass', detail: path };
}

function checkToken(): Check {
  if (!getToken()) {
    return {
      name: 'Auth credential',
      status: 'fail',
      detail: 'No CF_TOKEN env var, no token in config file',
      hint: 'Run `cf auth login` (browser device flow) or set CF_TOKEN.',
    };
  }
  const source = process.env.CF_TOKEN ? 'CF_TOKEN env' : 'config file';
  return { name: 'Auth credential', status: 'pass', detail: `present (${source})` };
}

async function checkApi(): Promise<Check[]> {
  if (!getToken()) {
    return [{ name: 'API reachable', status: 'skip', detail: 'no credential' }];
  }
  const spinner = ora({ text: `Calling ${BRAND.urls.api}/v1/auth/whoami...`, isSilent: true }).start();
  const checks: Check[] = [];
  try {
    const me = await getClient().me.get() as { email?: string; tokenKind?: string };
    spinner.stop();
    checks.push({
      name: 'API reachable',
      status: 'pass',
      detail: BRAND.urls.api,
    });
    checks.push({
      name: 'Token introspects',
      status: 'pass',
      detail: me.email
        ? `${me.tokenKind ?? 'token'} for ${me.email}`
        : `${me.tokenKind ?? 'token'} accepted`,
    });
  } catch (err) {
    spinner.stop();
    const message = err instanceof Error ? err.message : String(err);
    checks.push({
      name: 'API reachable',
      status: 'fail',
      detail: message,
      hint: 'Check network / proxy / CF_API_URL override.',
    });
    checks.push({ name: 'Token introspects', status: 'skip', detail: 'API unreachable' });
  }
  return checks;
}

function checkContext(): Check[] {
  const out: Check[] = [];
  const org = getOrg();
  out.push(org
    ? { name: 'Active organisation', status: 'pass', detail: org }
    : { name: 'Active organisation', status: 'warn', detail: 'no default org', hint: 'Run `cf init` or `cf org select <id>`.' },
  );
  const ws = getDefault('workspace');
  out.push(ws
    ? { name: 'Default workspace', status: 'pass', detail: ws }
    : { name: 'Default workspace', status: 'warn', detail: 'not set', hint: 'Run `cf config set defaults.workspace <slug>`.' },
  );
  const env = getDefault('environment');
  out.push(env
    ? { name: 'Default environment', status: 'pass', detail: env }
    : { name: 'Default environment', status: 'warn', detail: 'not set', hint: 'Run `cf config set defaults.environment <slug>`.' },
  );
  return out;
}

async function checkLatestVersion(): Promise<Check> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE)}/latest`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      return {
        name: 'CLI version',
        status: 'warn',
        detail: `npm registry responded ${res.status}`,
      };
    }
    const body = (await res.json()) as { version: string };
    if (body.version === VERSION) {
      return { name: 'CLI version', status: 'pass', detail: `${VERSION} (latest)` };
    }
    return {
      name: 'CLI version',
      status: 'warn',
      detail: `installed ${VERSION}, npm latest ${body.version}`,
      hint: 'Run `cf update` to upgrade.',
    };
  } catch (err) {
    return {
      name: 'CLI version',
      status: 'warn',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function print(checks: Check[]) {
  console.log();
  console.log(chalk.bold('  CryptFlare CLI doctor'));
  console.log(chalk.dim(`  v${VERSION}`));
  console.log();
  for (const c of checks) {
    const symbol = symbolFor(c.status);
    console.log(`  ${symbol} ${c.name.padEnd(24)} ${c.detail ?? ''}`);
    if (c.hint) {
      console.log(`     ${chalk.dim('-> ' + c.hint)}`);
    }
  }
  console.log();
  const fail = checks.filter((c) => c.status === 'fail').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  if (fail > 0) {
    console.log(chalk.red(`  ${fail} failed.`) + (warn ? chalk.yellow(` ${warn} warning${warn === 1 ? '' : 's'}.`) : ''));
  } else if (warn > 0) {
    console.log(chalk.yellow(`  ${warn} warning${warn === 1 ? '' : 's'}.`));
  } else {
    console.log(chalk.green('  All checks passed.'));
  }
  console.log();
}

function symbolFor(status: CheckStatus): string {
  switch (status) {
    case 'pass': return chalk.green('✓');
    case 'warn': return chalk.yellow('!');
    case 'fail': return chalk.red('✗');
    case 'skip': return chalk.dim('-');
  }
}
