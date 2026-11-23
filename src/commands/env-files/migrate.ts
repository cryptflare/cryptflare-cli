/**
 * `cf env migrate` - move a repository's local secrets files to encrypted
 * form. Prints the plan and changes nothing unless `--yes` is given.
 */

import { resolve } from 'node:path'

import chalk from 'chalk'
import { Command, InvalidArgumentError } from 'commander'

import { getClient } from '@/lib/api'
import { getOrg } from '@/lib/config'
import { errorMessage } from '@/lib/guards'
import { requirePermission } from '@/lib/permissions'
import { applyMigration, type MigrationOutcome } from '@/lib/local-env/migrate-apply'
import {
  describeConflict,
  GROUPINGS,
  isGrouping,
  type Grouping,
} from '@/lib/local-env/migrate-grouping'
import {
  blockers,
  missingIgnores,
  planMigration,
  type FilePlan,
  type MigrationPlan,
  type PlanOptions,
} from '@/lib/local-env/migrate-plan'
import { checkRemote, type RemoteCheck } from '@/lib/local-env/migrate-remote'
import { findManifestRoot } from '@/lib/project-context'
import { toSlug } from '@/lib/slug'
import * as output from '@/lib/output'

function names(list: readonly string[] | undefined, limit = 6): string {
  const items = list ?? []
  return items.length > limit
    ? `${items.slice(0, limit).join(', ')} +${items.length - limit}`
    : items.join(', ')
}

function printFile(file: FilePlan): void {
  const target = `${file.workspace}/${file.environment}${file.newBinding ? chalk.green(' (new binding)') : ''}`
  output.print(`  ${chalk.bold(file.rel)} ${chalk.dim(`${file.format.label} ->`)} ${target}`)
  if (file.blocked)
    output.print(chalk.red(`      ${output.MARK.fail} not migrated: ${file.blocked.message}`))
  for (const conflict of file.conflicts)
    output.print(chalk.red(`      ${output.MARK.fail} not migrated: ${describeConflict(conflict)}`))
  const encrypt = file.decisions.get('encrypt') ?? []
  const blocked = file.blocked !== undefined || file.conflicts.length > 0
  if (encrypt.length > 0)
    output.print(
      `      ${blocked ? 'would encrypt' : 'encrypt'} ${encrypt.length}: ${chalk.dim(names(encrypt))}`,
    )
  const already = file.decisions.get('encrypted') ?? []
  if (already.length > 0) output.print(chalk.dim(`      already encrypted: ${already.length}`))
  const pub = file.decisions.get('public') ?? []
  if (pub.length > 0)
    output.print(chalk.yellow(`      browser-public, left plaintext: ${names(pub)}`))
  const tokens = file.decisions.get('registry-token') ?? []
  if (tokens.length > 0) {
    output.print(
      chalk.yellow(
        `      registry token in plaintext: ${names(tokens)} (--move-registry-tokens moves it to CryptFlare)`,
      ),
    )
  }
  for (const problem of file.invalid) {
    output.print(
      chalk.yellow(
        `      ${problem.key}: not stored in CryptFlare (${problem.reason}); still encrypted locally`,
      ),
    )
  }
  if (file.duplicates.length > 0)
    output.print(
      chalk.yellow(`      defined twice: ${names(file.duplicates)} (the last one is pushed)`),
    )
  for (const item of file.unmanaged)
    output.print(chalk.dim(`      line ${item.line} ${item.name}: left alone (${item.reason})`))
  if (file.format.injection === 'materialize') {
    output.print(
      chalk.dim('      read by the tool itself: run it with `cf run --materialize -- <cmd>`'),
    )
  }
  if (file.inHistory) {
    output.print(
      chalk.red(
        `      ${output.MARK.fail} committed to git at some point: those values are in the history. Rotate these secrets.`,
      ),
    )
  } else if (file.git === 'untracked') {
    output.print(chalk.yellow('      not ignored by git: one `git add .` from being committed'))
  }
}

function printPlan(plan: MigrationPlan): void {
  output.print()
  output.print(`  ${chalk.bold(plan.root)} ${chalk.dim(`workspace ${plan.workspace}`)}`)
  for (const note of plan.notes) output.print(chalk.dim(`  ${note}`))
  output.print()
  for (const file of plan.files) printFile(file)
  if (plan.suggestions.length > 0) {
    output.print()
    output.print(chalk.yellow('  The plan does not fit. This would:'))
    for (const line of plan.suggestions) output.print(`    ${chalk.cyan(line)}`)
  }
  if (plan.files.length === 0) output.print(chalk.dim('  No local secrets files found.'))
  if (plan.scan.templates.length > 0) {
    output.print()
    output.print(chalk.dim(`  Templates, never touched: ${names(plan.scan.templates, 10)}`))
  }
  const review = [
    ...plan.scan.review.map((item) => `${item.rel}: ${item.reason}`),
    ...plan.scan.composeInline.map(
      (item) => `${item.rel}:${item.line} ${item.name} has a literal value in environment:`,
    ),
  ]
  if (review.length > 0) {
    output.print()
    output.print(chalk.yellow('  Review manually (not recognised, but may hold secrets):'))
    for (const line of review) output.print(chalk.yellow(`    ${line}`))
  }
  const ignores = missingIgnores(plan)
  if (ignores.length > 0) {
    output.print()
    output.print(chalk.dim(`  Will add to .gitignore: ${ignores.join(', ')}`))
  }
  output.print()
}

function printOutcome(outcome: MigrationOutcome): boolean {
  let failed = false
  for (const file of outcome.files) {
    if (file.status === 'encrypted') {
      output.print(
        `  ${chalk.green(output.MARK.ok)} ${file.rel} ${chalk.dim(`${file.result.encrypted.length} encrypted, ${file.pushed} pushed`)}`,
      )
    } else if (file.status === 'tokens-moved') {
      output.print(
        `  ${chalk.green(output.MARK.ok)} ${file.rel} ${chalk.dim(`now references ${file.names.join(', ')}`)}`,
      )
    } else if (file.status === 'skipped') {
      output.print(`  ${chalk.dim('-')} ${file.rel} ${chalk.dim(file.reason)}`)
    } else {
      failed = true
      output.print(
        `  ${chalk.red(output.MARK.fail)} ${file.rel} ${chalk.red(file.reason.slice(0, 120))} ${chalk.dim('(file left as it was)')}`,
      )
    }
  }
  if (outcome.manifest)
    output.print(chalk.dim(`\n  Bindings written to ${outcome.manifest} with "encrypted": true`))
  if (outcome.ignored.length > 0)
    output.print(chalk.dim(`  Added to .gitignore: ${outcome.ignored.join(', ')}`))
  return failed
}

function parseGroup(value: string): Grouping {
  if (!isGrouping(value)) throw new InvalidArgumentError(`expected one of ${GROUPINGS.join(', ')}`)
  return value
}

/** The remote half of the plan. A dry run without the API still prints the local plan. */
async function remoteCheck(
  plan: MigrationPlan,
  org: string | undefined,
  opts: { workspace?: string; createWorkspace?: boolean; group: Grouping },
  required: boolean,
): Promise<RemoteCheck | null> {
  if (!org) {
    if (required) throw new Error('No organisation selected. Run `cf org select` or pass --org.')
    plan.notes.push('No organisation selected: workspace and plan limits not checked.')
    return null
  }
  try {
    return await checkRemote(getClient(), org, plan, opts)
  } catch (err) {
    if (required || opts.workspace) throw err
    plan.notes.push(`Workspace and plan limits not checked: ${errorMessage(err)}`)
    return null
  }
}

export const migrateCommand = new Command('migrate')
  .description('Encrypt every local secrets file of a repository (plan first; --yes to apply)')
  .argument('[path]', 'Repository root (defaults to the project around the current directory)')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-y, --yes', 'Apply the plan')
  .option(
    '-w, --workspace <slug|id>',
    'Existing workspace for the files (default: the folder name)',
  )
  .option('--create-workspace', 'Create the -w workspace when it does not exist')
  .option('-e, --environment <slug>', 'Put every file into this one environment')
  .option(
    '--group <mode>',
    'Files to environments: per-file (default), per-app (<app>-<stage>), single',
    parseGroup,
  )
  .option('--include-public', 'Also encrypt browser-public names (NEXT_PUBLIC_, VITE_, ...)')
  .option('--all-values', 'Structured files: encrypt every string, not only secret-looking ones')
  .option(
    '--move-registry-tokens',
    'Move .npmrc / .yarnrc.yml tokens to CryptFlare and reference them as ${NPM_TOKEN}',
  )
  .addHelpText(
    'after',
    `
Finds .env*, .dev.vars, .envrc, .flaskenv, compose env_file targets, TOML and
JSON secrets files, *.tfvars, config/master.key and registry auth files in
every app of a monorepo. Each value is pushed to its environment first, then
the file is rewritten as ciphertext and bound in .cryptflare.json.

  cf env migrate                      show the plan
  cf env migrate --yes                apply it
  cf env migrate -w my-app -e dev     every file into one existing workspace and environment
  cf env migrate --group per-app      one environment per app and stage, not per file

Files sharing an environment share its variable names: a name two files
define with different values stops the plan (nothing is changed).`,
  )
  .action(async (pathArg: string | undefined, opts) => {
    try {
      const root = resolve(pathArg ?? findManifestRoot(process.cwd()) ?? process.cwd())
      const planOpts: PlanOptions = {
        includePublic: Boolean(opts.includePublic),
        allValues: Boolean(opts.allValues),
        moveRegistryTokens: Boolean(opts.moveRegistryTokens),
        ...(opts.workspace ? { workspace: String(opts.workspace) } : {}),
        ...(opts.environment ? { environment: toSlug(String(opts.environment)) } : {}),
        ...(opts.group ? { group: opts.group as Grouping } : {}),
      }
      const plan = planMigration(root, planOpts)
      const org: string | undefined = opts.org ?? plan.org ?? getOrg()
      const remote = await remoteCheck(
        plan,
        org,
        {
          ...(planOpts.workspace ? { workspace: planOpts.workspace } : {}),
          createWorkspace: Boolean(opts.createWorkspace),
          group: planOpts.environment ? 'single' : (planOpts.group ?? 'per-file'),
        },
        Boolean(opts.yes),
      )
      printPlan(plan)
      const problems = blockers(plan)
      if (!opts.yes || problems.length > 0) {
        output.print(
          problems.length > 0
            ? chalk.red(
                `  Nothing changed: ${problems.length} problem(s) above must be solved first.`,
              )
            : `  Nothing changed. Apply with ${chalk.cyan('cf env migrate --yes')} (same flags)`,
        )
        output.print()
        if (opts.yes) process.exit(1)
        return
      }
      if (!org || !remote)
        throw new Error('No organisation selected. Run `cf org select` or pass --org.')
      await requirePermission('secrets:write')
      const failed = printOutcome(
        await applyMigration(getClient(), plan, org, planOpts, remote.cache),
      )
      output.print()
      output.print(
        `  Next: ${chalk.cyan('cf env status')}, then ${chalk.cyan('cf run -- <your dev command>')}`,
      )
      output.print()
      if (failed) process.exit(1)
    } catch (err) {
      output.handleError(err)
    }
  })
