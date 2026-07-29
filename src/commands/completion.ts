/**
 * `cf completion <shell>` - emits a shell completion script.
 *
 * The command tree is walked at runtime rather than hard-coded, so a new
 * command or flag is completable the moment it exists. A hand-maintained list
 * would be wrong within a release.
 *
 * Deliberately prints to stdout and nothing else, so it can be sourced
 * directly:
 *
 *   source <(cf completion bash)
 *   cf completion zsh > "${fpath[1]}/_cf"
 */

import { Command } from 'commander';

import * as output from '../lib/output.js';

type CommandNode = { name: string; flags: string[]; subcommands: CommandNode[] };

/** Walks a commander tree into a plain structure the generators can render. */
function describe(cmd: Command): CommandNode {
  return {
    name: cmd.name(),
    flags: cmd.options.map((o) => o.long).filter((l): l is string => Boolean(l)),
    subcommands: cmd.commands.map((c) => describe(c as Command)),
  };
}

function bashScript(root: CommandNode): string {
  const topLevel = root.subcommands.map((c) => c.name).join(' ');

  // One case arm per command listing its subcommands and flags. Generated
  // rather than written so it cannot drift from the actual tree.
  const arms = root.subcommands
    .map((cmd) => {
      const subs = cmd.subcommands.map((s) => s.name).join(' ');
      const flags = [...new Set([...cmd.flags, ...cmd.subcommands.flatMap((s) => s.flags)])].join(' ');
      return `    ${cmd.name})\n      COMPREPLY=( $(compgen -W "${subs} ${flags}" -- "$cur") )\n      return 0\n      ;;`;
    })
    .join('\n');

  return `# CryptFlare CLI completion for bash
# Install:  source <(cf completion bash)
# Persist:  cf completion bash > /etc/bash_completion.d/cf

_cf_completion() {
  local cur prev words cword
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${topLevel} --help --version" -- "$cur") )
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
${arms}
  esac

  COMPREPLY=( $(compgen -W "--help" -- "$cur") )
  return 0
}

complete -F _cf_completion cf
`;
}

function zshScript(root: CommandNode): string {
  const descriptions = root.subcommands.map((c) => `    '${c.name}'`).join('\n');

  const arms = root.subcommands
    .map((cmd) => {
      const subs = cmd.subcommands.map((s) => `        '${s.name}'`).join('\n');
      const flags = [...new Set([...cmd.flags, ...cmd.subcommands.flatMap((s) => s.flags)])]
        .map((f) => `        '${f}'`)
        .join('\n');
      return `      ${cmd.name})\n        _values 'option' \\\n${[subs, flags].filter(Boolean).join(' \\\n')}\n        ;;`;
    })
    .join('\n');

  return `#compdef cf
# CryptFlare CLI completion for zsh
# Install:  cf completion zsh > "\${fpath[1]}/_cf" && exec zsh

_cf() {
  local -a commands
  commands=(
${descriptions}
  )

  if (( CURRENT == 2 )); then
    _values 'command' \${commands[@]}
    return
  fi

  case "\${words[2]}" in
${arms}
  esac
}

compdef _cf cf
`;
}

function fishScript(root: CommandNode): string {
  const lines: string[] = [
    '# CryptFlare CLI completion for fish',
    '# Install:  cf completion fish > ~/.config/fish/completions/cf.fish',
    '',
    // Stop fish offering files where a command belongs.
    'complete -c cf -f',
    '',
  ];

  for (const cmd of root.subcommands) {
    lines.push(`complete -c cf -n "__fish_use_subcommand" -a "${cmd.name}"`);
    for (const sub of cmd.subcommands) {
      lines.push(`complete -c cf -n "__fish_seen_subcommand_from ${cmd.name}" -a "${sub.name}"`);
    }
    for (const flag of new Set([...cmd.flags, ...cmd.subcommands.flatMap((s) => s.flags)])) {
      lines.push(`complete -c cf -n "__fish_seen_subcommand_from ${cmd.name}" -l "${flag.replace(/^--/, '')}"`);
    }
  }

  return `${lines.join('\n')}\n`;
}

const GENERATORS = { bash: bashScript, zsh: zshScript, fish: fishScript } as const;
type Shell = keyof typeof GENERATORS;

export function buildCompletionCommand(program: Command): Command {
  return new Command('completion')
    .description('Output a shell completion script (bash, zsh, fish)')
    .argument('<shell>', 'bash, zsh, or fish')
    .addHelpText(
      'after',
      `
Examples:
  source <(cf completion bash)                      try it in this shell
  cf completion bash > /etc/bash_completion.d/cf    persist for bash
  cf completion zsh > "\${fpath[1]}/_cf"             persist for zsh
  cf completion fish > ~/.config/fish/completions/cf.fish`,
    )
    .action((shell: string) => {
      try {
        if (!(shell in GENERATORS)) {
          throw new Error(`Unsupported shell "${shell}". Choose one of: ${Object.keys(GENERATORS).join(', ')}.`);
        }
        // The tree is read from the live program, so completions cannot drift
        // from the commands that actually exist.
        console.log(GENERATORS[shell as Shell](describe(program)));
      } catch (err) {
        output.handleError(err);
      }
    });
}
