/** `cf sync list` / `remove` / `enable` / `disable`. */

import { Command } from 'commander'
import chalk from 'chalk'
import * as output from '@/lib/output'
import { loadManifestCapture, resolveCapture } from '@/lib/sync-capture'
import { loadRegistry, saveRegistry } from '@/lib/sync-registry'

export const listCommand = new Command('list')
  .description('List registered projects')
  .option('--json', 'Output as JSON')
  .action((opts) => {
    try {
      const registry = loadRegistry()
      if (opts.json) {
        output.json(registry)
        return
      }
      if (registry.projects.length === 0) {
        output.info(`No projects registered. Add one with ${chalk.cyan('cf sync add')}.`)
        return
      }
      output.table(
        registry.projects.flatMap((p) =>
          p.bindings.map((b) => ({
            project: p.id,
            file: b.file,
            // Per-binding workspace wins; the project value is only a default.
            workspace: b.workspace ?? p.workspace ?? '(unset)',
            environment: b.environment,
            pod: b.pod ?? 'root',
            capture: resolveCapture(b, loadManifestCapture(p)),
            enabled: p.enabled ? 'yes' : 'no',
            path: p.path,
          })),
        ),
      )
    } catch (err) {
      output.handleError(err)
    }
  })

export const removeCommand = new Command('remove')
  .description('Unregister a project (does not touch its files or remote secrets)')
  .argument('<id>', 'Project identifier')
  .action((id: string) => {
    try {
      const registry = loadRegistry()
      const next = registry.projects.filter((p) => p.id !== id)
      if (next.length === registry.projects.length) {
        throw new Error(`No project "${id}" registered.`)
      }
      registry.projects = next
      saveRegistry(registry)
      output.success(`Removed ${chalk.bold(id)}. Local files and remote secrets untouched.`)
    } catch (err) {
      output.handleError(err)
    }
  })

function setEnabled(id: string, enabled: boolean): void {
  const registry = loadRegistry()
  const project = registry.projects.find((p) => p.id === id)
  if (!project) throw new Error(`No project "${id}" registered.`)
  project.enabled = enabled
  saveRegistry(registry)
  output.success(`${enabled ? 'Enabled' : 'Disabled'} ${chalk.bold(id)}.`)
}

export const enableCommand = new Command('enable')
  .description('Re-enable a parked project')
  .argument('<id>', 'Project identifier')
  .action((id: string) => {
    try {
      setEnabled(id, true)
    } catch (err) {
      output.handleError(err)
    }
  })

export const disableCommand = new Command('disable')
  .description('Park a project without unregistering it')
  .argument('<id>', 'Project identifier')
  .action((id: string) => {
    try {
      setEnabled(id, false)
    } catch (err) {
      output.handleError(err)
    }
  })
