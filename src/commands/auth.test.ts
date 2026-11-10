import { describe, expect, it } from 'vitest';

import { authCommand, loginCommand, logoutCommand } from './auth.js';

function flags(command: { options: ReadonlyArray<{ long?: string | null }> }): string[] {
  return command.options.map((option) => option.long ?? '').sort();
}

describe('login and logout', () => {
  it('are available at the top level', () => {
    expect(loginCommand.name()).toBe('login');
    expect(logoutCommand.name()).toBe('logout');
  });

  it('are still available under `cf auth`', () => {
    expect(authCommand.commands.map((c) => c.name()).sort()).toEqual(['login', 'logout', 'status']);
  });

  it('are the same command in both places', () => {
    const nested = authCommand.commands.find((c) => c.name() === 'login')!;
    expect(nested).not.toBe(loginCommand);
    expect(flags(nested)).toEqual(flags(loginCommand));
    expect(nested.description()).toBe(loginCommand.description());

    const nestedLogout = authCommand.commands.find((c) => c.name() === 'logout')!;
    expect(nestedLogout.description()).toBe(logoutCommand.description());
  });

  it('can replace a valid key with --force', () => {
    expect(flags(loginCommand)).toContain('--force');
  });
});
