/**
 * `cf mcp serve` - a local MCP server for AI coding agents.
 *
 * It runs on the developer's machine, speaks MCP over stdio, and uses the
 * login `cf auth login` already stored. So an agent gets working CryptFlare
 * tools with no token pasted into an editor config, and the token it uses is
 * the one the developer can see and revoke with `cf auth`.
 *
 * The tools are in `../lib/mcp/tools.ts`. None of them returns a secret value.
 */

import { Command } from 'commander';

import { getClient } from '../lib/api.js';
import { createMcpHandler, serveStdio } from '../lib/mcp/protocol.js';
import { buildTools, SERVER_INSTRUCTIONS } from '../lib/mcp/tools.js';
import * as output from '../lib/output.js';
import { loadRegistry } from '../lib/sync-registry.js';
import { loadState, saveState } from '../lib/sync-state.js';
import { VERSION } from '../version.js';

const serveCommand = new Command('serve')
  .description('Run a local MCP server over stdio, for AI agents working in this repository')
  .option('--cwd <path>', 'Project directory the tools act on (defaults to the current directory)')
  .addHelpText(
    'after',
    `
Add it to an MCP client. For Claude Code:

  claude mcp add cryptflare -- cf mcp serve

The server uses your \`cf auth login\` session. Its tools generate, capture
and sync secrets, and never return a secret value to the agent.`,
  )
  .action(async (opts) => {
    try {
      const handler = createMcpHandler({
        name: 'cryptflare-local',
        version: VERSION,
        instructions: SERVER_INSTRUCTIONS,
        tools: buildTools({
          // Resolved on first use, not at startup: the server must start (and
          // answer `initialize`) before login, so the agent is told to log in
          // by a tool error rather than by a server that never appears.
          get client() {
            return getClient();
          },
          cwd: opts.cwd ?? process.cwd(),
          loadRegistry,
          loadState,
          saveState,
        }),
      });
      await serveStdio(handler, process.stdin, process.stdout);
    } catch (err) {
      output.handleError(err);
    }
  });

export const mcpCommand = new Command('mcp')
  .description('Model Context Protocol server for AI coding agents')
  .addCommand(serveCommand);
