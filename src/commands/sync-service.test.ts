import { describe, it, expect } from 'vitest';

import { renderUnit, syncCommand } from './sync-service.js';

describe('cf sync command surface', () => {
  it('exposes the full lifecycle as subcommands', () => {
    expect(syncCommand.commands.map((c) => c.name()).sort()).toEqual([
      'add',
      'disable',
      'enable',
      'install-service',
      'list',
      'remove',
      'run',
      'status',
      'watch',
    ]);
  });
});

describe('renderUnit', () => {
  it('runs `sync watch` with the chosen interval under the calling user', () => {
    const unit = renderUnit({ interval: 90, pullOnly: false });
    expect(unit).toContain('sync watch --interval 90');
    // A user unit, never a system one - the service needs the caller's token
    // and writes into the caller's project directories.
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toContain('WantedBy=multi-user.target');
    expect(unit).not.toContain('User=');
  });

  it('threads --pull-only and --project through to ExecStart', () => {
    const unit = renderUnit({ interval: 60, pullOnly: true, project: 'app' });
    expect(unit).toContain('--pull-only');
    expect(unit).toContain('--project app');
  });

  it('restarts on failure but caps restart storms', () => {
    const unit = renderUnit({ interval: 60, pullOnly: false });
    expect(unit).toContain('Restart=always');
    expect(unit).toMatch(/StartLimitBurst=\d+/);
  });

  it('keeps $HOME writable, since writing .env files is the entire job', () => {
    const unit = renderUnit({ interval: 60, pullOnly: false });
    expect(unit).toContain('ProtectHome=read-write');
    expect(unit).toContain('NoNewPrivileges=yes');
    // V8 needs writable-executable pages; asserting it stays absent stops a
    // well-meaning hardening pass from adding it and breaking the service.
    expect(unit).not.toContain('MemoryDenyWriteExecute=yes');
  });

  it('waits for the network before starting', () => {
    expect(renderUnit({ interval: 60, pullOnly: false })).toContain('After=network-online.target');
  });

  it('sources an optional 0600 env file rather than inlining a token', () => {
    const unit = renderUnit({ interval: 60, pullOnly: false });
    expect(unit).toContain('EnvironmentFile=-%h/.config/cryptflare/service.env');
    expect(unit).not.toMatch(/Environment=CF_TOKEN/);
  });

  it('uses the given exec path verbatim', () => {
    expect(renderUnit({ interval: 60, pullOnly: false, execPath: '/opt/cf/bin/cf' })).toContain('/opt/cf/bin/cf sync watch');
  });
});
