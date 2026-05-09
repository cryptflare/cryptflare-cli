#!/usr/bin/env node

import { Command } from 'commander';
import { BRAND } from './_vendored/brand';
import { authCommand } from './commands/auth.js';
import { secretCommand } from './commands/secret.js';
import { runCommand, envCommand } from './commands/run.js';
import { podCommand } from './commands/pod.js';
import { orgCommand } from './commands/org.js';
import { workspaceCommand } from './commands/workspace.js';
import { environmentCommand } from './commands/environment.js';
import { tokenCommand } from './commands/token.js';
import { configCommand } from './commands/config.js';
import { whoamiCommand } from './commands/whoami.js';
import { statusCommand } from './commands/status.js';
import { pullCommand, pushCommand, diffCommand } from './commands/sync.js';
import { telemetryCommand } from './commands/telemetry.js';
import { updateCommand } from './commands/update.js';
import { initCommand } from './commands/init.js';
import { doctorCommand } from './commands/doctor.js';
import { importCommand } from './commands/import.js';
import { VERSION } from './version.js';

const program = new Command()
  .name('cf')
  .description(`${BRAND.name} CLI - Manage secrets from your terminal`)
  .version(VERSION);

// Auth & identity
program.addCommand(authCommand);
program.addCommand(whoamiCommand);

// Secrets management
program.addCommand(secretCommand);
program.addCommand(podCommand);

// Sync (Terraform-like)
program.addCommand(pullCommand);
program.addCommand(pushCommand);
program.addCommand(diffCommand);

// Import from external sources
program.addCommand(importCommand);

// Inject & export
program.addCommand(runCommand);
program.addCommand(envCommand);

// Organisation & resources
program.addCommand(orgCommand);
program.addCommand(workspaceCommand);
program.addCommand(environmentCommand);
program.addCommand(tokenCommand);

// Status & config
program.addCommand(statusCommand);
program.addCommand(configCommand);
program.addCommand(telemetryCommand);
program.addCommand(updateCommand);

// Setup helpers
program.addCommand(initCommand);
program.addCommand(doctorCommand);

program.parse();
