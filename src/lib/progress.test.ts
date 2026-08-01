import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import { describeRequest } from './progress.js';

describe('describeRequest', () => {
  it('names the resource rather than the whole URL', () => {
    expect(describeRequest('GET', '/v1/organisations/org_1/workspaces/ws/environments/dev/secrets'))
      .toBe('Fetching secrets...');
    expect(describeRequest('POST', '/v1/organisations/org_1/workspaces')).toBe('Sending workspaces...');
    expect(describeRequest('DELETE', '/v1/organisations/org_1/workspaces/ws')).toBe('Deleting workspaces...');
  });

  it('never echoes a secret key back to the terminal', () => {
    // `.../secrets/DATABASE_URL` must read as "secrets". Key names are not
    // values, but they are still sensitive enough to keep off the screen and
    // out of anything scraping terminal output.
    const label = describeRequest('GET', '/v1/organisations/o/workspaces/w/environments/e/secrets/DATABASE_URL');
    expect(label).toBe('Fetching secrets...');
    expect(label).not.toContain('DATABASE_URL');
  });

  it('ignores query strings', () => {
    expect(describeRequest('GET', '/v1/organisations/o/audit?cursor=abc123')).toBe('Fetching audit...');
  });

  it('falls back to a bare verb for an unrecognised path', () => {
    expect(describeRequest('GET', '/v1/something/else')).toBe('Fetching...');
    expect(describeRequest('TRACE', '/v1/whatever')).toBe('Working...');
  });
});

describe('stream discipline', () => {
  // Behavioural proof lives in the live check (`cf env -f json | jq` stays
  // parseable). This guards the property that makes it true, because the
  // failure mode is silent: a spinner moved to stdout would corrupt every
  // piped command and no existing test would notice.
  const source = readFileSync(new URL('./progress.ts', import.meta.url), 'utf-8');

  it('renders to stderr, never stdout', () => {
    expect(source).toContain('stream: process.stderr');
    expect(source).not.toContain('process.stdout');
  });

  it('renders only on a TTY, so CI logs do not fill with escape codes', () => {
    expect(source).toContain('process.stderr.isTTY');
  });
});
