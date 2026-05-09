import { Command } from 'commander';
import chalk from 'chalk';

import type { CryptFlare } from '@cryptflare/sdk';

import { getClient } from '../lib/api.js';
import { resolveContext } from '../lib/resolve.js';
import * as output from '../lib/output.js';

type PodItem = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parentId: string | null;
  createdAt: string;
};

type PodDetail = PodItem & {
  ancestors: { id: string; name: string; slug: string }[];
};

type Scope = { organisation: string; workspace: string; environment: string };

export const podCommand = new Command('pod')
  .description('Manage pods (secret folders)');

podCommand
  .command('list')
  .description('List pods in an environment')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-p, --parent <id>', 'Parent pod ID (omit for root)')
  .option('--json', 'Output as JSON')
  .option('-q, --quiet', 'Minimal output')
  .action(async (opts) => {
    try {
      const ctx = resolveContext(opts);
      const scope = scopeOf(ctx);
      const data = opts.parent
        // SDK list does not currently expose parentId filter, so fall back
        // to runner.send for the query string.
        ? await getClient().runner.send<{ data: PodItem[] }>({
            method: 'GET',
            path: `/v1/organisations/${ctx.org}/workspaces/${ctx.workspace}/environments/${ctx.env}/pods?parentId=${encodeURIComponent(opts.parent)}`,
          }).then((r) => r.data)
        : (await getClient().pods.list(scope)) as PodItem[];

      if (opts.json) return output.json(data);

      output.table(
        data.map((p) => ({
          name: p.name,
          slug: p.slug,
          description: p.description ?? chalk.dim('-'),
          id: chalk.dim(p.id),
        })),
        { quiet: opts.quiet },
      );
    } catch (err) {
      output.handleError(err);
    }
  });

podCommand
  .command('get <pod>')
  .description('Get pod details with breadcrumb path')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (pod: string, opts) => {
    try {
      const ctx = resolveContext(opts);
      const data = await getClient().pods.get({
        ...scopeOf(ctx),
        id: pod,
      }) as PodDetail;

      if (opts.json) return output.json(data);

      const breadcrumb = data.ancestors.length > 0
        ? data.ancestors.map((a) => a.name).join(' / ') + ' / ' + data.name
        : data.name;

      console.log();
      console.log(`  ${chalk.bold(data.name)}`);
      console.log(`  ${chalk.dim('Path:')}  ${breadcrumb}`);
      console.log(`  ${chalk.dim('Slug:')}  ${data.slug}`);
      if (data.description) console.log(`  ${chalk.dim('Desc:')}  ${data.description}`);
      console.log(`  ${chalk.dim('ID:')}    ${data.id}`);
      console.log();
    } catch (err) {
      output.handleError(err);
    }
  });

podCommand
  .command('create')
  .description('Create a new pod')
  .requiredOption('-n, --name <name>', 'Pod name')
  .requiredOption('-s, --slug <slug>', 'URL-safe slug')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-p, --parent <id>', 'Parent pod ID for nesting')
  .option('-d, --description <text>', 'Pod description')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const ctx = resolveContext(opts);
      const data = await getClient().pods.create({
        ...scopeOf(ctx),
        name: opts.name,
        slug: opts.slug,
        ...(opts.parent ? { parentId: opts.parent } : {}),
        ...(opts.description ? { description: opts.description } : {}),
      } as never) as PodItem;

      if (opts.json) return output.json(data);
      output.success(`Created pod ${chalk.bold(data.name)} (${data.slug})`);
    } catch (err) {
      output.handleError(err);
    }
  });

podCommand
  .command('update <pod>')
  .description('Update a pod')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-n, --name <name>', 'New name')
  .option('-s, --slug <slug>', 'New slug')
  .option('-d, --description <text>', 'New description')
  .option('--json', 'Output as JSON')
  .action(async (pod: string, opts) => {
    try {
      const ctx = resolveContext(opts);
      const patch: Record<string, unknown> = {};
      if (opts.name) patch['name'] = opts.name;
      if (opts.slug) patch['slug'] = opts.slug;
      if (opts.description !== undefined) patch['description'] = opts.description;

      if (Object.keys(patch).length === 0) {
        console.error('Nothing to update. Pass --name, --slug, or --description.');
        process.exit(1);
      }

      const data = await getClient().pods.update({
        ...scopeOf(ctx),
        id: pod,
        ...patch,
      }) as PodItem;

      if (opts.json) return output.json(data);
      output.success(`Updated pod ${chalk.bold(data.name)}`);
    } catch (err) {
      output.handleError(err);
    }
  });

podCommand
  .command('delete <pod>')
  .description('Delete an empty pod')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (pod: string, opts) => {
    try {
      const ctx = resolveContext(opts);

      if (!opts.yes) {
        console.log(chalk.yellow('This will permanently delete this pod. It must be empty.'));
        console.log('Pass --yes to confirm.');
        process.exit(0);
      }

      await getClient().pods.delete({ ...scopeOf(ctx), id: pod });
      output.success('Pod deleted');
    } catch (err) {
      output.handleError(err);
    }
  });

podCommand
  .command('tree')
  .description('Show pod hierarchy as a tree')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const ctx = resolveContext(opts);
      const client = getClient();
      const scope = scopeOf(ctx);
      const basePath = `/v1/organisations/${ctx.org}/workspaces/${ctx.workspace}/environments/${ctx.env}`;

      const rootPods = await client.pods.list(scope) as PodItem[];
      // Secrets-by-pod requires a query the typed list does not expose, so
      // drop to the runner for these tree queries.
      const rootSecrets = await client.runner.send<{ data: { key: string; podId: string | null }[] }>({
        method: 'GET',
        path: `${basePath}/secrets?podId=root`,
      }).then((r) => r.data);

      if (opts.json) {
        return output.json({ pods: rootPods, secrets: rootSecrets });
      }

      console.log();
      console.log(`  ${chalk.bold(ctx.env)}/`);

      for (const secret of rootSecrets) {
        console.log(`  ${chalk.dim('├──')} ${chalk.cyan(secret.key)}`);
      }

      for (let i = 0; i < rootPods.length; i++) {
        const pod = rootPods[i];
        if (!pod) continue;
        const isLast = i === rootPods.length - 1;
        await printPodTree(client, basePath, pod, '  ', isLast);
      }

      console.log();
    } catch (err) {
      output.handleError(err);
    }
  });

async function printPodTree(client: CryptFlare, basePath: string, pod: PodItem, indent: string, isLast: boolean) {
  const connector = isLast ? '└── ' : '├── ';
  const childIndent = indent + (isLast ? '    ' : '│   ');

  console.log(`${indent}${chalk.dim(connector)}${chalk.bold.yellow(pod.name)}/`);

  const childPods = await client.runner.send<{ data: PodItem[] }>({
    method: 'GET',
    path: `${basePath}/pods?parentId=${encodeURIComponent(pod.id)}`,
  }).then((r) => r.data);
  const secrets = await client.runner.send<{ data: { key: string }[] }>({
    method: 'GET',
    path: `${basePath}/secrets?podId=${encodeURIComponent(pod.id)}`,
  }).then((r) => r.data);

  for (const secret of secrets) {
    const secretConnector = childPods.length > 0 || secrets.indexOf(secret) < secrets.length - 1 ? '├── ' : '└── ';
    console.log(`${childIndent}${chalk.dim(secretConnector)}${chalk.cyan(secret.key)}`);
  }

  for (let i = 0; i < childPods.length; i++) {
    const child = childPods[i];
    if (!child) continue;
    await printPodTree(client, basePath, child, childIndent, i === childPods.length - 1);
  }
}

function scopeOf(ctx: { org: string; workspace: string; environment?: string; env: string }): Scope {
  return {
    organisation: ctx.org,
    workspace: ctx.workspace,
    environment: ctx.env,
  };
}
