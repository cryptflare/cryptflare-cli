import { Command } from 'commander'
import chalk from 'chalk'

import type { CryptFlare } from '@cryptflare/sdk'

import { getClient } from '@/lib/api'
import { resolveContext } from '@/lib/resolve'
import * as output from '@/lib/output'
import { confirmDestructive } from '@/lib/confirm'
import { resolveSlug } from '@/lib/slug'
import { EXIT_CODES } from '@/lib/exit-codes'

type PodItem = {
  id: string
  name: string
  slug: string
  description: string | null
  parentId: string | null
  createdAt: string
}

type Scope = { organisation: string; workspace: string; environment: string }

export const podCommand = new Command('pod').description('Manage pods (secret folders)')

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
      const ctx = resolveContext(opts)
      const scope = scopeOf(ctx)
      const data = opts.parent
        ? // SDK list does not currently expose parentId filter, so fall back
          // to client.request for the query string.
          await getClient()
            .request<{ data: PodItem[] }>({
              method: 'GET',
              path: `/v1/organisations/${ctx.org}/workspaces/${ctx.workspace}/environments/${ctx.env}/pods?parentId=${encodeURIComponent(opts.parent)}`,
            })
            .then((r) => r.data)
        : await getClient().pods.list(scope)

      if (opts.json) return output.json(data)

      output.table(
        data.map((p) => ({
          name: p.name,
          slug: p.slug,
          description: p.description ?? chalk.dim('-'),
          id: chalk.dim(p.id),
        })),
        { quiet: opts.quiet },
      )
    } catch (err) {
      output.handleError(err)
    }
  })

podCommand
  .command('get <pod>')
  .description('Get pod details with breadcrumb path')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (pod: string, opts) => {
    try {
      const ctx = resolveContext(opts)
      const data = await getClient().pods.get({
        ...scopeOf(ctx),
        id: pod,
      })

      if (opts.json) return output.json(data)

      const breadcrumb =
        data.ancestors.length > 0
          ? data.ancestors.map((a) => a.name).join(' / ') + ' / ' + data.name
          : data.name

      output.print()
      output.print(`  ${chalk.bold(data.name)}`)
      output.print(`  ${chalk.dim('Path:')}  ${breadcrumb}`)
      output.print(`  ${chalk.dim('Slug:')}  ${data.slug}`)
      if (data.description) output.print(`  ${chalk.dim('Desc:')}  ${data.description}`)
      output.print(`  ${chalk.dim('ID:')}    ${data.id}`)
      output.print()
    } catch (err) {
      output.handleError(err)
    }
  })

podCommand
  .command('create')
  .description('Create a new pod')
  .requiredOption('-n, --name <name>', 'Pod name')
  .option('-s, --slug <slug>', 'URL-safe slug (derived from --name when omitted)')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-p, --parent <id>', 'Parent pod ID for nesting')
  .option('-d, --description <text>', 'Pod description')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const ctx = resolveContext(opts)
      const data = await getClient().pods.create({
        ...scopeOf(ctx),
        name: opts.name,
        slug: resolveSlug(opts.name, opts.slug),
        ...(opts.parent ? { parentId: opts.parent } : {}),
        ...(opts.description ? { description: opts.description } : {}),
      })

      if (opts.json) return output.json(data)
      output.success(`Created pod ${chalk.bold(data.name)} (${data.slug})`)
    } catch (err) {
      output.handleError(err)
    }
  })

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
      const ctx = resolveContext(opts)
      const patch: Record<string, unknown> = {}
      if (opts.name) patch['name'] = opts.name
      if (opts.slug) patch['slug'] = opts.slug
      if (opts.description !== undefined) patch['description'] = opts.description

      if (Object.keys(patch).length === 0) {
        output.printError('Nothing to update. Pass --name, --slug, or --description.')
        process.exit(EXIT_CODES.USAGE)
      }

      const data = await getClient().pods.update({
        ...scopeOf(ctx),
        id: pod,
        ...patch,
      })

      if (opts.json) return output.json(data)
      output.success(`Updated pod ${chalk.bold(data.name)}`)
    } catch (err) {
      output.handleError(err)
    }
  })

podCommand
  .command('delete <pod>')
  .description('Delete an empty pod')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (pod: string, opts) => {
    try {
      const ctx = resolveContext(opts)

      await confirmDestructive({
        message: 'This will permanently delete this pod. It must be empty.',
        assumeYes: opts.yes,
      })

      await getClient().pods.delete({ ...scopeOf(ctx), id: pod })
      output.success('Pod deleted')
    } catch (err) {
      output.handleError(err)
    }
  })

podCommand
  .command('tree')
  .description('Show pod hierarchy as a tree')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const ctx = resolveContext(opts)
      const client = getClient()
      const scope = scopeOf(ctx)
      const basePath = `/v1/organisations/${ctx.org}/workspaces/${ctx.workspace}/environments/${ctx.env}`

      const rootPods = await client.pods.list(scope)
      // Secrets-by-pod requires a query the typed list does not expose, so
      // drop to client.request for these tree queries.
      const rootSecrets = await client
        .request<{ data: { key: string; podId: string | null }[] }>({
          method: 'GET',
          path: `${basePath}/secrets?podId=root`,
        })
        .then((r) => r.data)

      if (opts.json) {
        return output.json({ pods: rootPods, secrets: rootSecrets })
      }

      output.print()
      output.print(`  ${chalk.bold(ctx.env)}/`)

      for (const secret of rootSecrets) {
        output.print(`  ${chalk.dim('├──')} ${chalk.cyan(secret.key)}`)
      }

      for (let i = 0; i < rootPods.length; i++) {
        const pod = rootPods[i]
        if (!pod) continue
        const isLast = i === rootPods.length - 1
        await printPodTree(client, basePath, pod, '  ', isLast)
      }

      output.print()
    } catch (err) {
      output.handleError(err)
    }
  })

async function printPodTree(
  client: CryptFlare,
  basePath: string,
  pod: PodItem,
  indent: string,
  isLast: boolean,
) {
  const connector = isLast ? '└── ' : '├── '
  const childIndent = indent + (isLast ? '    ' : '│   ')

  output.print(`${indent}${chalk.dim(connector)}${chalk.bold.yellow(pod.name)}/`)

  const childPods = await client
    .request<{ data: PodItem[] }>({
      method: 'GET',
      path: `${basePath}/pods?parentId=${encodeURIComponent(pod.id)}`,
    })
    .then((r) => r.data)
  const secrets = await client
    .request<{ data: { key: string }[] }>({
      method: 'GET',
      path: `${basePath}/secrets?podId=${encodeURIComponent(pod.id)}`,
    })
    .then((r) => r.data)

  for (const secret of secrets) {
    const secretConnector =
      childPods.length > 0 || secrets.indexOf(secret) < secrets.length - 1 ? '├── ' : '└── '
    output.print(`${childIndent}${chalk.dim(secretConnector)}${chalk.cyan(secret.key)}`)
  }

  for (let i = 0; i < childPods.length; i++) {
    const child = childPods[i]
    if (!child) continue
    await printPodTree(client, basePath, child, childIndent, i === childPods.length - 1)
  }
}

function scopeOf(ctx: {
  org: string
  workspace: string
  environment?: string
  env: string
}): Scope {
  return {
    organisation: ctx.org,
    workspace: ctx.workspace,
    environment: ctx.env,
  }
}
