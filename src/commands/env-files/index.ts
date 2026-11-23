/**
 * `cf env encrypt | decrypt | status | migrate` - encrypted local env files.
 * Attached to the existing `cf env` command, whose own action (export the
 * vault's values) still runs when no subcommand is named.
 */

import type { Command } from 'commander'

import { decryptCommand } from './decrypt'
import { encryptCommand } from './encrypt'
import { migrateCommand } from './migrate'
import { statusCommand } from './status'

export function addEnvFileCommands(env: Command): Command {
  return (
    env
      // `cf env` has its own -w/-e/-o/-f; without this they would swallow the
      // subcommands' flags of the same name (`cf env decrypt --format shell`).
      .enablePositionalOptions()
      .addCommand(encryptCommand)
      .addCommand(decryptCommand)
      .addCommand(statusCommand)
      .addCommand(migrateCommand)
  )
}
