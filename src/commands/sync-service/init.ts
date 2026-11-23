/** `cf sync init` - the fresh-clone path: create the remote structure and pull. */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { Command } from 'commander'
import chalk from 'chalk'
import { getClient } from '@/lib/api'
import { getOrg } from '@/lib/config'
import { requirePermission } from '@/lib/permissions'
import * as output from '@/lib/output'
import { collidingFiles, describeCollision, findBindingCollisions } from '@/lib/binding-collisions'
import { describePlanRefusal, provisionWithinPlan } from '@/lib/plan-allowance'
import { loadRegistry, saveRegistry, type SyncProject } from '@/lib/sync-registry'
import { revealSecrets } from '@/lib/reveal'
import { decryptValues, encryptValues, hasCiphertext } from '@/lib/local-env/sync-codec'
import { newScopeCache, seedFromValues } from '@/lib/provision'
import { applyEnvChanges, parseEnvContent, renderEnvFile, toValueMap } from '@/lib/env-file'
import { MANIFEST_FILENAME, hasManifest, loadManifest } from '@/lib/project-manifest'
import { proposeManifest, writeManifestFromRegistry } from '@/commands/sync-service/manifest-writer'
import { errorMessage } from '@/lib/guards'

export const initCommand = new Command('init')
  .description(
    'Set a project up for sync. Uses its committed .cryptflare.json, or proposes one from the env files it finds',
  )
  .argument('[path]', 'Project root (defaults to the current directory)', '.')
  .option(
    '--write',
    "Generate .cryptflare.json from this project's existing sync registration instead",
  )
  .option('--no-pull', 'Register for sync without pulling files first')
  .option('--no-register', 'Pull files without registering for ongoing sync')
  .option(
    '-p, --project <id>',
    'Which registered project to write from, when several share this directory',
  )
  .option(
    '--id <id>',
    "Register under this id instead of the manifest's, for a second checkout of the same repo",
  )
  .option(
    '--create',
    'Create any workspace or environment the manifest names but CryptFlare does not have, then push each local file up. For a project that has never been synced.',
  )
  .option('-y, --yes', 'Write a proposed .cryptflare.json without asking')
  .addHelpText(
    'after',
    `
In a repository with no ${MANIFEST_FILENAME}, this finds the env files, proposes
a manifest (one environment per file, named <app>-<stage>) and writes it once
you agree. New project, start to finish:

  cf sync init --create --yes`,
  )
  .action(async (pathArg: string, opts) => {
    try {
      const root = resolve(pathArg)
      if (!existsSync(root)) throw new Error(`Directory not found: ${root}`)

      if (opts.write) {
        writeManifestFromRegistry(root, opts.project)
        return
      }

      let wroteManifest = false
      if (!hasManifest(root)) {
        // A repository that has never been set up: work the manifest out
        // from the env files in it instead of asking for one to be written
        // by hand.
        const written = await proposeManifest(root, { assumeYes: Boolean(opts.yes) })
        if (!written) return
        wroteManifest = true
        if (!opts.create) {
          output.print(
            `  Next: ${chalk.cyan('cf sync init --create')}   ${chalk.dim('# creates the workspace and environments, uploads each file')}`,
          )
          output.print()
          return
        }
      }

      const manifest = loadManifest(root)
      const id = opts.id ?? manifest.id ?? basename(root)
      const org = manifest.org ?? getOrg()

      output.print()
      output.print(
        `  ${chalk.bold(id)} ${chalk.dim(`(${manifest.bindings.length} file(s) from ${MANIFEST_FILENAME})`)}`,
      )
      output.print()

      // Pull first, then register. Registering first would make the initial
      // sync pass see empty local files and treat every remote key as new -
      // correct, but it logs a pull of everything rather than a clean adopt.
      // Collected rather than thrown: a bootstrap that dies on the first
      // unreachable environment leaves a half-populated clone and no clue
      // which files are missing. Every binding is attempted, failures are
      // listed at the end, and the exit code still reports failure.
      const failures: Array<{ file: string; message: string }> = []

      // Two files bound to one environment are refused, and the rest of the
      // manifest is set up as usual.
      const collisions = findBindingCollisions(manifest.bindings, manifest.workspace)
      const collided = collidingFiles(collisions)
      for (const collision of collisions) {
        output.print(`  ${chalk.red(output.MARK.fail)} ${chalk.red(describeCollision(collision))}`)
        for (const file of collision.files)
          failures.push({
            file,
            message: `shares environment ${collision.target} with another file`,
          })
      }
      const bindings = manifest.bindings.filter((binding) => !collided.has(binding.file))
      /**
       * Files whose environment could not be created (no room in the plan, or
       * the request failed). Not registered, so no pass fails on an
       * environment that does not exist.
       */
      const unprovisioned = new Set<string>()
      let planLine = ''

      // First-time setup: build the remote structure from the manifest and
      // seed it from what is already on disk. Without this the only path was
      // `cf workspace create` plus one `cf environment create` per environment
      // by hand, and skipping it made the pull fail with "workspace not found".
      if (opts.create) {
        await requirePermission('secrets:write')
        const client = getClient()
        const scopeCache = newScopeCache()
        let madeWs = 0
        let madeEnv = 0
        let pushed = 0

        // What the manifest needs is compared with what the plan has left
        // before anything is created, so a plan limit leaves out whole files
        // in a known order instead of failing partway.
        const provisioned = await provisionWithinPlan(
          client,
          org,
          bindings.map((binding) => ({
            file: binding.file,
            workspace: binding.workspace,
            environment: binding.environment,
          })),
          scopeCache,
        )
        for (const item of provisioned.failed) {
          unprovisioned.add(item.file)
          failures.push({ file: item.file, message: item.message })
          output.print(
            `  ${chalk.red(output.MARK.fail)} ${item.file} ${chalk.red(item.message.slice(0, 90))}`,
          )
        }
        for (const item of provisioned.refused) {
          unprovisioned.add(item.file)
          output.print(
            `  ${chalk.yellow(output.MARK.fail)} ${item.file} ${chalk.yellow(`not taken over: plan limit on ${item.resource}`)}`,
          )
        }
        if (provisioned.refused.length > 0)
          planLine = describePlanRefusal(provisioned.refused, provisioned.allowance)

        for (const item of provisioned.ready) {
          const scope = {
            ...(org ? { organisation: org } : {}),
            workspace: item.workspace,
            environment: item.environment,
          }
          const { createdWorkspace, createdEnvironment } = item
          const binding = {
            file: item.file,
            workspace: item.workspace,
            environment: item.environment,
          }
          try {
            if (createdWorkspace) madeWs++
            if (createdEnvironment) madeEnv++

            const target = join(root, binding.file)
            // An encrypted file is decrypted in memory: ciphertext is never a value to push.
            const values = await decryptValues(
              client,
              scope,
              existsSync(target)
                ? toValueMap(parseEnvContent(readFileSync(target, 'utf-8')))
                : new Map<string, string>(),
            )
            const { created, updated } = await seedFromValues(client, scope, values)
            pushed += created + updated

            const marks = [
              createdWorkspace ? chalk.green('+workspace') : '',
              createdEnvironment ? chalk.green('+environment') : '',
              created > 0 ? chalk.green(`+${created} secret(s)`) : '',
              updated > 0 ? chalk.blue(`~${updated} secret(s)`) : '',
            ]
              .filter(Boolean)
              .join(' ')
            output.print(
              `  ${chalk.green(output.MARK.ok)} ${binding.file} ${chalk.dim(`-> ${binding.workspace}/${binding.environment}`)}` +
                (marks ? ` ${marks}` : chalk.dim(' (already set up)')),
            )
          } catch (err) {
            const message = errorMessage(err)
            failures.push({ file: binding.file, message })
            output.print(
              `  ${chalk.red(output.MARK.fail)} ${binding.file} ${chalk.red(message.slice(0, 90))}`,
            )
          }
        }

        output.print()
        output.success(
          `Created ${madeWs} workspace(s), ${madeEnv} environment(s), pushed ${pushed} secret(s).`,
        )
        // Local files are already the source here, so pulling them straight
        // back would be a no-op at best and a needless reveal at worst.
        opts.pull = false
      }

      if (opts.pull !== false) {
        await requirePermission('secrets:read')
        const client = getClient()

        for (const binding of bindings) {
          try {
            const target = join(root, binding.file)
            const scope = {
              ...(org ? { organisation: org } : {}),
              workspace: binding.workspace,
              environment: binding.environment,
              ...(binding.pod ? { podId: binding.pod } : {}),
            }

            const revealed = await revealSecrets(client, scope)
            const existing = existsSync(target)
              ? toValueMap(parseEnvContent(readFileSync(target, 'utf-8')))
              : new Map<string, string>()
            // An encrypted binding gets ciphertext, never plaintext, on disk.
            const secrets =
              binding.encrypted || hasCiphertext(existing)
                ? await encryptValues(client, scope, revealed, existing)
                : revealed

            mkdirSync(dirname(target), { recursive: true })
            if (existsSync(target)) {
              // Merge rather than clobber: a cloned repo may ship a template
              // file, and overwriting it would drop any comment or unmanaged
              // line the author put there.
              const original = readFileSync(target, 'utf-8')
              const parsed = parseEnvContent(original)
              const updates = new Map<string, string>()
              const additions = new Map<string, string>()
              for (const [k, v] of secrets) {
                if (parsed.entries.has(k)) updates.set(k, v)
                else additions.set(k, v)
              }
              const { content } = applyEnvChanges(original, updates, additions)
              if (content !== original)
                writeFileSync(target, content, { encoding: 'utf-8', mode: 0o600 })
            } else {
              writeFileSync(
                target,
                renderEnvFile(secrets, '# Pulled by CryptFlare (cf sync init)'),
                {
                  encoding: 'utf-8',
                  mode: 0o600,
                },
              )
            }

            output.print(
              `  ${chalk.green(output.MARK.ok)} ${binding.file} ${chalk.dim(`<- ${binding.workspace}/${binding.environment}`)} ` +
                `${chalk.dim(`(${secrets.size} secret(s))`)}`,
            )
          } catch (err) {
            const message = errorMessage(err)
            failures.push({ file: binding.file, message })
            output.print(
              `  ${chalk.red(output.MARK.fail)} ${binding.file} ${chalk.dim(`<- ${binding.workspace}/${binding.environment}`)} ` +
                `${chalk.red(message.slice(0, 80))}`,
            )
          }
        }
      }

      const registrable = bindings.filter((binding) => !unprovisioned.has(binding.file))
      if (opts.register !== false && registrable.length === 0) {
        output.print()
        output.warn('Nothing was registered for sync: no file of this project could be set up.')
        if (wroteManifest) {
          // Leaving the manifest behind would make the next attempt look like
          // a fresh clone, which is pulled, not created, and so could never
          // succeed. Without it the next attempt starts from the beginning.
          rmSync(join(root, MANIFEST_FILENAME), { force: true })
          output.print(
            chalk.dim(
              `  Removed the ${MANIFEST_FILENAME} written a moment ago, so the next attempt starts clean.`,
            ),
          )
        }
      }
      if (opts.register !== false && registrable.length > 0) {
        const registry = loadRegistry()
        const project: SyncProject = {
          id,
          path: root,
          ...(org ? { org } : {}),
          ...(manifest.workspace ? { workspace: manifest.workspace } : {}),
          enabled: true,
          bindings: registrable.map((b) => ({
            file: b.file,
            environment: b.environment,
            ...(b.pod ? { pod: b.pod } : {}),
            ...(b.workspace && b.workspace !== manifest.workspace
              ? { workspace: b.workspace }
              : {}),
          })),
        }
        const existing = registry.projects.findIndex((p) => p.id === id)
        const registeredAt = registry.projects[existing]?.path
        if (registeredAt !== undefined && registeredAt !== root) {
          // The manifest is committed, so every checkout of the repo carries
          // the same id. Silently rebinding it would point the sync service at
          // whichever copy ran `init` last - a second clone, a worktree, a
          // colleague's path in a shared home - and stop syncing the original
          // without saying so.
          throw new Error(
            `Project "${id}" is already registered at ${registeredAt}.\n` +
              `  This directory is ${root}.\n` +
              `  Re-running init here would repoint the sync service at this copy.\n` +
              `  Use --id <other-id> to register this checkout separately, ` +
              `or \`cf sync remove ${id}\` first if you meant to move it.`,
          )
        }
        if (existing >= 0) registry.projects[existing] = project
        else registry.projects.push(project)
        saveRegistry(registry)
        output.print()
        output.success(`Registered ${chalk.bold(id)} for ongoing sync.`)
      }

      if (failures.length > 0) {
        output.print()
        output.warn(
          `${failures.length} of ${manifest.bindings.length} file(s) could not be set up:`,
        )
        for (const f of failures)
          output.printError(`    ${f.file}  ${chalk.dim(f.message.slice(0, 100))}`)
        if (!planLine)
          output.printError(
            chalk.dim(`\n  Re-run ${chalk.cyan('cf sync init')} to retry only what is missing.`),
          )
      }
      if (planLine) {
        // Last and on one line: when the background service ran this, the
        // last line is the one it repeats in its own log.
        output.printError()
        output.printError(chalk.yellow(planLine))
      }
      if (failures.length > 0 || planLine) process.exit(1)

      output.print()
      output.print('  Next:')
      output.print(`    ${chalk.cyan(`cf sync status --project ${id}`)}`)
      output.print(
        `    ${chalk.cyan('cf sync install-service --enable')}   ${chalk.dim('# run it in the background')}`,
      )
      output.print()
    } catch (err) {
      output.handleError(err)
    }
  })

/** Generates `.cryptflare.json` from a project already registered locally. */
