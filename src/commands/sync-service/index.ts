/**
 * `cf sync` - multi-project, bidirectional env-file sync plus the background
 * service that runs it unattended (systemd, launchd, or a Windows task).
 *
 * Distinct from the older top-level `cf pull` / `cf push` / `cf daemon`, which
 * operate on a single file passed by flag and hold no state between runs. This
 * group reads a registry of projects, keeps a merge base per bound file, and is
 * designed to be the thing systemd starts and forgets about.
 */

import { Command } from 'commander'
import { addCommand } from '@/commands/sync-service/add'
import { autoCommand } from '@/commands/sync-service/auto'
import { initCommand } from '@/commands/sync-service/init'
import {
  disableCommand,
  enableCommand,
  listCommand,
  removeCommand,
} from '@/commands/sync-service/registry-commands'
import { runCommand, statusCommand } from '@/commands/sync-service/run'
import {
  installServiceCommand,
  uninstallServiceCommand,
} from '@/commands/sync-service/service-install'
import { watchCommand } from '@/commands/sync-service/watch'

export const syncCommand = new Command('sync')
  .description('Keep local .env files in sync with CryptFlare environments')
  .addCommand(initCommand)
  .addCommand(autoCommand)
  .addCommand(addCommand)
  .addCommand(listCommand)
  .addCommand(removeCommand)
  .addCommand(enableCommand)
  .addCommand(disableCommand)
  .addCommand(statusCommand)
  .addCommand(runCommand)
  .addCommand(watchCommand)
  .addCommand(installServiceCommand)
  .addCommand(uninstallServiceCommand)

export { watchSignature } from './rediscover'
export { renderUnit } from './service-install'
