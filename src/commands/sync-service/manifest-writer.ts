/** Writes a project manifest proposed from discovery or from the registry. */

import chalk from 'chalk'
import prompts from 'prompts'
import { getOrg } from '@/lib/config'
import * as output from '@/lib/output'
import { buildManifest, findEnvFiles, planBindings } from '@/lib/discover'
import { gitFileStates, type GitFileState } from '@/lib/git-state'
import { loadRegistry } from '@/lib/sync-registry'
import { MANIFEST_FILENAME, writeManifest } from '@/lib/project-manifest'

const GIT_STATE_NOTE: Record<GitFileState, string> = {
  ignored: '',
  unknown: '',
  untracked: 'not in .gitignore',
  tracked: 'TRACKED BY GIT',
}

/**
 * Proposes a manifest for a repository that has none, and writes it when the
 * person agrees. Reads file names only - never the contents of an env file.
 *
 * @returns whether a manifest was written.
 */
export async function proposeManifest(
  root: string,
  options: { assumeYes: boolean },
): Promise<boolean> {
  const files = findEnvFiles(root)
  if (files.length === 0) {
    throw new Error(
      `No ${MANIFEST_FILENAME} in ${root}, and no env files to build one from.\n` +
        '  Create the file your app reads (for example .env), then run this again.',
    )
  }

  const planned = planBindings(files)
  const manifest = buildManifest(root, planned, { org: getOrg() })
  const git = gitFileStates(root, files)

  output.print()
  output.print(
    `  No ${MANIFEST_FILENAME} here yet. Proposed from the ${files.length} env file(s) found:`,
  )
  output.print()
  output.print(`  ${chalk.dim('workspace')} ${chalk.bold(manifest.workspace)}`)
  output.print()
  output.table(
    planned.map((binding) => ({
      file: binding.file,
      environment: binding.environment,
      capture: binding.capture,
      note: GIT_STATE_NOTE[git.get(binding.file) ?? 'unknown'],
    })),
  )

  const tracked = files.filter((file) => git.get(file) === 'tracked')
  const exposed = files.filter((file) => git.get(file) === 'untracked')
  if (tracked.length > 0) {
    output.print()
    output.warn(`${tracked.length} of these are tracked by git: ${tracked.join(', ')}`)
    output.print(
      chalk.dim(
        '  Their values are in the repository history. Rotate them, and stop tracking the files',
      ),
    )
    output.print(chalk.dim('  (git rm --cached <file>, then add them to .gitignore).'))
  }
  if (exposed.length > 0) {
    output.print()
    output.warn(
      `${exposed.length} are not ignored by git and could be committed by accident: ${exposed.join(', ')}`,
    )
  }
  output.print()

  if (!options.assumeYes) {
    if (!process.stdin.isTTY) {
      output.print(
        chalk.dim(
          `  Not a terminal, so nothing was written. Pass --yes to write ${MANIFEST_FILENAME}.`,
        ),
      )
      output.print()
      return false
    }
    const { ok } = await prompts(
      { type: 'confirm', name: 'ok', message: `Write ${MANIFEST_FILENAME}?`, initial: true },
      { onCancel: () => ({ ok: false }) },
    )
    if (!ok) {
      output.print(chalk.dim('  Nothing written.'))
      return false
    }
  }

  const path = writeManifest(root, manifest)
  output.success(`Wrote ${chalk.bold(path)}`)
  output.print(
    chalk.dim(
      '  It holds file paths and names only, never a value. Edit it freely, then commit it.',
    ),
  )
  output.print()
  return true
}

export function writeManifestFromRegistry(root: string, projectId?: string): void {
  const registry = loadRegistry()
  const atRoot = registry.projects.filter((p) => p.path === root)
  const first = atRoot[0]

  if (first === undefined) {
    throw new Error(
      `No registered project at ${root}. Run \`cf sync add\` first, then \`cf sync init --write\`.`,
    )
  }

  // More than one project can point at the same directory - registering a
  // monorepo per-app produces exactly that. Picking the first silently writes
  // a manifest covering one app and looking complete, so require a choice.
  let project = first
  if (projectId) {
    const match = atRoot.find((p) => p.id === projectId)
    if (!match) {
      throw new Error(
        `No project "${projectId}" registered at ${root}. Candidates: ${atRoot.map((p) => p.id).join(', ')}`,
      )
    }
    project = match
  } else if (atRoot.length > 1) {
    throw new Error(
      `${atRoot.length} projects are registered at ${root}: ${atRoot.map((p) => p.id).join(', ')}. ` +
        `Choose one with --project <id>.`,
    )
  }

  const written = writeManifest(root, {
    version: 1,
    id: project.id,
    ...(project.org ? { org: project.org } : {}),
    ...(project.workspace ? { workspace: project.workspace } : {}),
    bindings: project.bindings.map((b) => ({
      file: b.file,
      ...(b.workspace ? { workspace: b.workspace } : {}),
      environment: b.environment,
      ...(b.pod ? { pod: b.pod } : {}),
      ...(b.capture ? { capture: b.capture } : {}),
    })),
  })

  output.success(`Wrote ${chalk.bold(written)}`)
  output.print()
  output.print(
    chalk.dim(
      '  Commit it. It holds no secrets - only file paths and workspace/environment names -',
    ),
  )
  output.print(
    chalk.dim('  so anyone cloning the repo can run `cf sync init` and be set up in one command.'),
  )
  output.print()
}
