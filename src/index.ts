#!/usr/bin/env node

import { Command } from 'commander'
import { BRAND } from './_vendored/brand'
import { authCommand, loginCommand, logoutCommand } from '@/commands/auth'
import { secretCommand } from '@/commands/secret'
import { runCommand, envCommand } from '@/commands/run'
import { addEnvFileCommands } from '@/commands/env-files'
import { podCommand } from '@/commands/pod'
import { orgCommand } from '@/commands/org'
import { workspaceCommand } from '@/commands/workspace'
import { environmentCommand } from '@/commands/environment'
import { tokenCommand } from '@/commands/token'
import { serviceTokenCommand } from '@/commands/service-token'
import { auditCommand } from '@/commands/audit'
import { configCommand } from '@/commands/config'
import { whoamiCommand } from '@/commands/whoami'
import { statusCommand } from '@/commands/status'
import { pullCommand, pushCommand, diffCommand, daemonCommand } from '@/commands/sync'
import { syncCommand } from '@/commands/sync-service'
import { deviceCommand } from '@/commands/device'
import { telemetryCommand } from '@/commands/telemetry'
import { updateCommand } from '@/commands/update'
import { initCommand } from '@/commands/init'
import { doctorCommand } from '@/commands/doctor'
import { buildCompletionCommand } from '@/commands/completion'
import { importCommand } from '@/commands/import'
import { mcpCommand } from '@/commands/mcp'
import { dynamicCommand } from '@/commands/dynamic'
import { EXIT_CODES } from '@/lib/exit-codes'
import { VERSION } from '@/version'

const program = new Command()
  .name('cf')
  .description(`${BRAND.name} CLI - Manage secrets from your terminal`)
  .version(VERSION)
  // Required for `cf run`'s passThroughOptions, which lets flags meant for the
  // child process (-v, --watch) reach the child instead of being parsed here.
  .enablePositionalOptions()

// Auth & identity
program.addCommand(authCommand)
program.addCommand(loginCommand)
program.addCommand(logoutCommand)
program.addCommand(whoamiCommand)

// Secrets management
program.addCommand(secretCommand)
program.addCommand(podCommand)

// Sync (Terraform-like, one-shot single-file)
program.addCommand(pullCommand)
program.addCommand(pushCommand)
program.addCommand(diffCommand)
program.addCommand(daemonCommand)

// Sync service (multi-project, stateful, bidirectional)
program.addCommand(syncCommand)
program.addCommand(deviceCommand)

// Import from external sources
program.addCommand(importCommand)

// Inject & export
program.addCommand(runCommand)
program.addCommand(addEnvFileCommands(envCommand))

// Dynamic secrets
program.addCommand(dynamicCommand)

// AI agents
program.addCommand(mcpCommand)

// Organisation & resources
program.addCommand(orgCommand)
program.addCommand(workspaceCommand)
program.addCommand(environmentCommand)
program.addCommand(tokenCommand)
program.addCommand(serviceTokenCommand)
program.addCommand(auditCommand)

// Status & config
program.addCommand(statusCommand)
program.addCommand(configCommand)
program.addCommand(telemetryCommand)
program.addCommand(updateCommand)

// Setup helpers
program.addCommand(initCommand)
program.addCommand(doctorCommand)

// Built last so it can walk the fully-populated command tree.
program.addCommand(buildCompletionCommand(program))

// Commander exits 1 on a bad flag or argument. Report those as usage errors
// (exit 2) so scripts can tell them from a failed API call. `addCommand`
// does not copy exit settings to subcommands, so walk the whole tree.
function exitUsageOnParseErrors(cmd: Command): void {
  cmd.exitOverride((err) => {
    process.exit(err.exitCode === 0 ? EXIT_CODES.SUCCESS : EXIT_CODES.USAGE)
  })
  cmd.commands.forEach(exitUsageOnParseErrors)
}
exitUsageOnParseErrors(program)

program.parse()
