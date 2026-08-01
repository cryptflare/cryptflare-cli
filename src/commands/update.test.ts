import { describe, it, expect } from 'vitest';

import { chooseInstaller } from './update.js';

describe('chooseInstaller', () => {
  it('uses npm for an npm global install', () => {
    // The exact path this bug was found on.
    expect(chooseInstaller('/home/sacha/.nvm/versions/node/v22.22.0/lib/node_modules/@cryptflare/cli').cmd)
      .toBe('npm');
  });

  it('does not pick pnpm just because the machine has pnpm', () => {
    // The whole defect: selection used to be "is pnpm on PATH", so every
    // machine with a pnpm monorepo ran `pnpm add -g` against an npm install.
    // pnpm wrote to its own tree, the copy on PATH never changed, and the
    // command still reported success.
    const npmPath = '/usr/local/lib/node_modules/@cryptflare/cli';
    expect(chooseInstaller(npmPath).cmd).toBe('npm');
  });

  it('uses pnpm when the install really is under pnpm', () => {
    expect(chooseInstaller('/home/sacha/.local/share/pnpm/global/5/node_modules/@cryptflare/cli').cmd)
      .toBe('pnpm');
  });

  it('uses bun when the install is under bun', () => {
    expect(chooseInstaller('/home/sacha/.bun/install/global/node_modules/@cryptflare/cli').cmd)
      .toBe('bun');
  });

  it('uses yarn when the install is under yarn global', () => {
    expect(chooseInstaller('/usr/local/share/.config/yarn/global/node_modules/@cryptflare/cli').cmd)
      .toBe('yarn');
  });

  it('falls back to npm when the root cannot be determined', () => {
    expect(chooseInstaller(null).cmd).toBe('npm');
  });
});
