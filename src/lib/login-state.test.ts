import { describe, expect, it, vi } from 'vitest';

import { classifyCredentialCheck, decideLogin, LOGIN_COMMAND, needsLoginMessage } from './login-state.js';

describe('classifyCredentialCheck', () => {
  it('calls a key that answered valid', () => {
    expect(classifyCredentialCheck(undefined)).toBe('valid');
  });

  it('calls a key the API refuses invalid', () => {
    expect(classifyCredentialCheck({ status: 401 })).toBe('invalid');
  });

  it('keeps a key that works but is not allowed to do something', () => {
    expect(classifyCredentialCheck({ status: 403 })).toBe('valid');
    expect(classifyCredentialCheck({ status: 429 })).toBe('valid');
  });

  it('does not judge the key when the API gave no usable answer', () => {
    expect(classifyCredentialCheck(new Error('fetch failed'))).toBe('unreachable');
    expect(classifyCredentialCheck({ status: 503 })).toBe('unreachable');
  });
});

describe('decideLogin', () => {
  it('proceeds with no saved key, without asking the API', async () => {
    const check = vi.fn();
    expect(await decideLogin({ hasCredential: false, force: false, check })).toEqual({ action: 'proceed', reason: 'no-credential' });
    expect(check).not.toHaveBeenCalled();
  });

  it('proceeds when the saved key is no longer valid', async () => {
    const decision = await decideLogin({ hasCredential: true, force: false, check: async () => 'invalid' });
    expect(decision).toEqual({ action: 'proceed', reason: 'invalid' });
  });

  it('refuses while the saved key still works', async () => {
    const decision = await decideLogin({ hasCredential: true, force: false, check: async () => 'valid' });
    expect(decision).toEqual({ action: 'refuse', reason: 'valid' });
  });

  it('refuses when the API cannot be reached, rather than drop a key that may be fine', async () => {
    const decision = await decideLogin({ hasCredential: true, force: false, check: async () => 'unreachable' });
    expect(decision).toEqual({ action: 'refuse', reason: 'unreachable' });
  });

  it('replaces a valid key with --force, without asking the API', async () => {
    const check = vi.fn();
    expect(await decideLogin({ hasCredential: true, force: true, check })).toEqual({ action: 'proceed', reason: 'forced' });
    expect(check).not.toHaveBeenCalled();
  });
});

describe('needsLoginMessage', () => {
  it('names the exact command to run', () => {
    expect(needsLoginMessage(3)).toContain(`\`${LOGIN_COMMAND}\``);
    expect(needsLoginMessage(3)).toContain('3 passes');
  });
});
