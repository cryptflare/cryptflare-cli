import { describe, it, expect } from 'vitest';

import { applyEnvChanges, MANAGED_BLOCK_HEADER, parseEnvContent, renderEnvFile, toValueMap } from './env-file.js';

describe('parseEnvContent', () => {
  it('reads plain, quoted, and exported assignments', () => {
    const parsed = parseEnvContent(['PLAIN=one', 'DOUBLE="two words"', "SINGLE='three'", 'export EXPORTED=four'].join('\n'));
    expect(toValueMap(parsed)).toEqual(
      new Map([
        ['PLAIN', 'one'],
        ['DOUBLE', 'two words'],
        ['SINGLE', 'three'],
        ['EXPORTED', 'four'],
      ]),
    );
    expect(parsed.entries.get('EXPORTED')?.exported).toBe(true);
  });

  it('keeps a hash that is part of an unquoted value', () => {
    // `PASSWORD=abc#123` is a real password, not a comment.
    expect(parseEnvContent('PASSWORD=abc#123').entries.get('PASSWORD')?.value).toBe('abc#123');
  });

  it('treats a space-preceded hash as a trailing comment', () => {
    const entry = parseEnvContent('PORT=3000 # dev only').entries.get('PORT');
    expect(entry?.value).toBe('3000');
    expect(entry?.trailingComment).toBe('# dev only');
  });

  it('unescapes inside double quotes but not single quotes', () => {
    expect(parseEnvContent('A="line\\nbreak"').entries.get('A')?.value).toBe('line\nbreak');
    expect(parseEnvContent("A='line\\nbreak'").entries.get('A')?.value).toBe('line\\nbreak');
  });

  it('flags an unterminated quote as multiline and excludes it from the value map', () => {
    const parsed = parseEnvContent('KEY="-----BEGIN KEY-----\nmore');
    expect(parsed.entries.get('KEY')?.multiline).toBe(true);
    expect(toValueMap(parsed).has('KEY')).toBe(false);
  });

  it('ignores comments and blank lines', () => {
    expect(parseEnvContent('# note\n\nA=1').entries.size).toBe(1);
  });

  it('lets the last assignment win', () => {
    expect(parseEnvContent('A=1\nA=2').entries.get('A')?.value).toBe('2');
  });
});

describe('applyEnvChanges', () => {
  const original = ['# Local dev config', '', 'DATABASE_URL=postgres://old', '', '# third party', 'STRIPE_KEY=sk_old', ''].join('\n');

  it('rewrites only the changed line and preserves everything else', () => {
    const { content } = applyEnvChanges(original, new Map([['DATABASE_URL', 'postgres://new']]));
    expect(content).toContain('# Local dev config');
    expect(content).toContain('# third party');
    expect(content).toContain('DATABASE_URL=postgres://new');
    expect(content).toContain('STRIPE_KEY=sk_old');
    expect(content.split('\n').length).toBe(original.split('\n').length);
  });

  it('is a no-op when the value already matches', () => {
    const { content } = applyEnvChanges(original, new Map([['DATABASE_URL', 'postgres://old']]));
    expect(content).toBe(original);
  });

  it('preserves the export prefix, indentation, and trailing comment', () => {
    const { content } = applyEnvChanges('  export PORT=3000 # dev only', new Map([['PORT', '4000']]));
    expect(content).toBe('  export PORT=4000 # dev only');
  });

  it('quotes values that need it', () => {
    const { content } = applyEnvChanges('A=1', new Map([['A', 'two words']]));
    expect(content).toBe('A="two words"');
  });

  it('appends unknown keys under a managed block', () => {
    const { content } = applyEnvChanges(original, new Map(), new Map([['NEW_KEY', 'v'], ['ANOTHER', 'w']]));
    expect(content).toContain(MANAGED_BLOCK_HEADER);
    // Sorted, and both under the one header.
    const lines = content.split('\n');
    const headerIdx = lines.indexOf(MANAGED_BLOCK_HEADER);
    expect(lines[headerIdx + 1]).toBe('ANOTHER=w');
    expect(lines[headerIdx + 2]).toBe('NEW_KEY=v');
  });

  it('reuses an existing managed block instead of stacking headers', () => {
    const once = applyEnvChanges(original, new Map(), new Map([['A_KEY', '1']])).content;
    const twice = applyEnvChanges(once, new Map(), new Map([['B_KEY', '2']])).content;
    expect(twice.split(MANAGED_BLOCK_HEADER).length - 1).toBe(1);
    expect(twice).toContain('A_KEY=1');
    expect(twice).toContain('B_KEY=2');
  });

  it('never removes a line', () => {
    const { content } = applyEnvChanges(original, new Map([['STRIPE_KEY', 'sk_new']]));
    expect(content).toContain('DATABASE_URL=postgres://old');
  });

  it('reports multi-line keys instead of corrupting them', () => {
    const src = 'PRIVATE_KEY="-----BEGIN\nrest of it\nOTHER=1';
    const { content, skippedMultiline } = applyEnvChanges(src, new Map([['PRIVATE_KEY', 'x'], ['OTHER', '2']]));
    expect(skippedMultiline).toEqual(['PRIVATE_KEY']);
    expect(content).toContain('PRIVATE_KEY="-----BEGIN');
    expect(content).toContain('OTHER=2');
  });

  it('round-trips a value through render and parse', () => {
    const tricky = new Map([['A', 'has "quotes" and spaces'], ['B', 'plain'], ['C', '']]);
    const rendered = renderEnvFile(tricky);
    expect(toValueMap(parseEnvContent(rendered))).toEqual(tricky);
  });

  it('manages a direnv .envrc without disturbing its directives', () => {
    // .envrc is a shell script, not a dotenv. Only assignment lines may be
    // rewritten; everything else - directives, comments, conditionals - has to
    // survive byte for byte or direnv breaks.
    const envrc = [
      '# Local-only direnv config. Gitignored.',
      'use flake',
      'dotenv_if_exists .env.local',
      '',
      'export CLOUDFLARE_API_TOKEN=old-token',
      'export CLOUDFLARE_ACCOUNT_ID=acct-123',
      '',
      'PATH_add ./bin',
      'if [ -f .env.extra ]; then',
      '  source_env .env.extra',
      'fi',
      '',
    ].join('\n');

    const { content } = applyEnvChanges(envrc, new Map([['CLOUDFLARE_API_TOKEN', 'new-token']]));

    expect(content).toContain('export CLOUDFLARE_API_TOKEN=new-token');
    expect(content).toContain('export CLOUDFLARE_ACCOUNT_ID=acct-123');
    // Every non-assignment line untouched.
    for (const line of ['use flake', 'dotenv_if_exists .env.local', 'PATH_add ./bin', 'source_env .env.extra', 'fi']) {
      expect(content).toContain(line);
    }
    expect(content.split('\n')).toHaveLength(envrc.split('\n').length);
  });

  it('reads assignments out of an .envrc regardless of the shell around them', () => {
    const parsed = parseEnvContent(['use flake', 'export A=1', 'PATH_add ./bin', 'export B=2'].join('\n'));
    expect(toValueMap(parsed)).toEqual(new Map([['A', '1'], ['B', '2']]));
  });

  it('does not treat a shell directive as an assignment', () => {
    // `source_env .env.extra` has no `=`; `PATH_add ./bin` neither. A parser
    // that split naively would invent keys from these.
    const parsed = parseEnvContent(['use flake', 'source_env .env.extra', 'PATH_add ./bin'].join('\n'));
    expect(parsed.entries.size).toBe(0);
  });

  it('handles Workers .vars files, which are plain KEY=value', () => {
    const vars = ['SESSION_SECRET=abc', 'STRIPE_SECRET_KEY=sk_test_123'].join('\n');
    const { content } = applyEnvChanges(vars, new Map([['STRIPE_SECRET_KEY', 'sk_live_456']]));
    expect(content).toContain('SESSION_SECRET=abc');
    expect(content).toContain('STRIPE_SECRET_KEY=sk_live_456');
  });

  it('preserves the absence of a trailing newline', () => {
    expect(applyEnvChanges('A=1', new Map([['A', '2']])).content).toBe('A=2');
    expect(applyEnvChanges('A=1\n', new Map([['A', '2']])).content).toBe('A=2\n');
  });
});
