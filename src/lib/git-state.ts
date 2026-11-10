import { execFileSync } from 'node:child_process';

export type GitFileState = 'ignored' | 'tracked' | 'untracked' | 'unknown';

function git(root: string, args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { ok: true, output };
  } catch {
    return { ok: false, output: '' };
  }
}

/**
 * Says how git treats each file: ignored (what an env file should be),
 * tracked (its values are in the repository's history), or untracked but not
 * ignored (one `git add .` away from being committed).
 *
 * Returns `unknown` for every file when the directory is not a git
 * repository or git is not installed. Nothing here reads a file's contents.
 */
export function gitFileStates(root: string, files: readonly string[]): Map<string, GitFileState> {
  const states = new Map<string, GitFileState>();
  if (!git(root, ['rev-parse', '--is-inside-work-tree']).ok) {
    for (const file of files) states.set(file, 'unknown');
    return states;
  }

  for (const file of files) {
    if (git(root, ['ls-files', '--error-unmatch', '--', file]).ok) states.set(file, 'tracked');
    else if (git(root, ['check-ignore', '-q', '--', file]).ok) states.set(file, 'ignored');
    else states.set(file, 'untracked');
  }
  return states;
}
