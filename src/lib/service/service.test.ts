import { describe, expect, it } from 'vitest';

import { LAUNCHD_LABEL, launchdPlistPath, renderLaunchdPlist } from './launchd.js';
import { watchArgs, type ServiceSpec } from './spec.js';
import {
  quoteWindowsArg,
  renderWindowsLauncher,
  WINDOWS_TASK_NAME,
  windowsCreateTaskArgs,
  windowsLauncherPath,
} from './windows.js';

function buildSpec(overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    nodePath: '/usr/local/bin/node',
    cliPath: '/usr/local/lib/node_modules/@cryptflare/cli/dist/index.js',
    interval: 60,
    pullOnly: false,
    ...overrides,
  };
}

describe('watchArgs', () => {
  it('runs the watch loop at the given interval', () => {
    expect(watchArgs(buildSpec())).toEqual(['sync', 'watch', '--interval', '60']);
  });

  it('adds pull-only and the project filter when set', () => {
    expect(watchArgs(buildSpec({ pullOnly: true, project: 'api' }))).toEqual([
      'sync', 'watch', '--interval', '60', '--pull-only', '--project', 'api',
    ]);
  });
});

describe('launchd agent', () => {
  it('lives in the user LaunchAgents directory, named after its label', () => {
    expect(launchdPlistPath('/Users/dev')).toBe(`/Users/dev/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
  });

  it('passes each argument as its own string, so a path with spaces stays whole', () => {
    const plist = renderLaunchdPlist(buildSpec({ cliPath: '/Users/dev/My Tools/cf.js' }), '/Users/dev');

    expect(plist).toContain('<string>/Users/dev/My Tools/cf.js</string>');
    expect(plist).toContain('<string>--interval</string>\n    <string>60</string>');
  });

  it('escapes XML metacharacters in paths', () => {
    const plist = renderLaunchdPlist(buildSpec({ project: 'a&b<c>' }), '/Users/dev');
    expect(plist).toContain('<string>a&amp;b&lt;c&gt;</string>');
  });

  it('starts at login and restarts only after a failure, no faster than once a minute', () => {
    const plist = renderLaunchdPlist(buildSpec(), '/Users/dev');

    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>60<\/integer>/);
  });

  it('logs under the user Library', () => {
    expect(renderLaunchdPlist(buildSpec(), '/Users/dev')).toContain('/Users/dev/Library/Logs/cryptflare-sync.log');
  });
});

describe('quoteWindowsArg', () => {
  it('leaves a plain argument alone', () => {
    expect(quoteWindowsArg('--interval')).toBe('--interval');
  });

  it('quotes an argument containing a space', () => {
    expect(quoteWindowsArg('C:\\Program Files\\nodejs\\node.exe')).toBe('"C:\\Program Files\\nodejs\\node.exe"');
  });

  it('doubles a trailing backslash so it cannot escape the closing quote', () => {
    expect(quoteWindowsArg('C:\\My Dir\\')).toBe('"C:\\My Dir\\\\"');
  });

  it('escapes an embedded quote', () => {
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('quotes the empty string', () => {
    expect(quoteWindowsArg('')).toBe('""');
  });
});

describe('Windows scheduled task', () => {
  const configDir = 'C:\\Users\\dev\\AppData\\Roaming\\cryptflare-nodejs\\Config';
  const spec = buildSpec({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    cliPath: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@cryptflare\\cli\\dist\\index.js',
  });

  it('runs the loop hidden and waits for it, so the task reflects its exit code', () => {
    const launcher = renderWindowsLauncher(spec, configDir);

    expect(launcher).toContain('WScript.Quit shell.Run(');
    expect(launcher).toMatch(/, 0, True\)\r\n$/);
  });

  it('quotes the node path for cmd and doubles quotes for VBScript', () => {
    const launcher = renderWindowsLauncher(spec, configDir);
    expect(launcher).toContain('""C:\\Program Files\\nodejs\\node.exe""');
  });

  it('appends output to a log file in the config directory', () => {
    const launcher = renderWindowsLauncher(spec, configDir);
    expect(launcher).toContain('sync-service.log');
    expect(launcher).toContain('2>&1');
  });

  it('uses CRLF line endings, as Windows Script Host expects', () => {
    expect(renderWindowsLauncher(spec, configDir).split('\r\n').length).toBeGreaterThan(5);
  });

  it('creates a logon task that is never elevated', () => {
    const args = windowsCreateTaskArgs(configDir);

    expect(args).toEqual(expect.arrayContaining(['/TN', WINDOWS_TASK_NAME, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F']));
  });

  it('keeps the task command line under the schtasks limit by pointing at the launcher', () => {
    const args = windowsCreateTaskArgs(configDir);
    const command = args[args.indexOf('/TR') + 1] ?? '';

    expect(command.startsWith('wscript.exe ')).toBe(true);
    expect(command).toContain(windowsLauncherPath(configDir));
    expect(command.length).toBeLessThan(261);
  });
});
