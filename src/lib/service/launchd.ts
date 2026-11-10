/**
 * macOS: a launchd **user agent**, the per-user equivalent of the systemd
 * user unit. It runs as the logged-in user, so it reads that user's CLI
 * login and writes env files with the right owner.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { watchArgs, type ServiceSpec } from './spec.js';

export const LAUNCHD_LABEL = 'com.cryptflare.sync';

export function launchdPlistPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export function launchdLogPath(home: string = homedir()): string {
  return join(home, 'Library', 'Logs', 'cryptflare-sync.log');
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Renders the agent's property list.
 *
 * `KeepAlive` restarts the loop only after a failed exit, and
 * `ThrottleInterval` spaces those restarts a minute apart. launchd cannot be
 * told to ignore one particular exit code, so unlike systemd it will retry a
 * logged-out service - once a minute, not once a second.
 */
export function renderLaunchdPlist(spec: ServiceSpec, home: string = homedir()): string {
  const args = [spec.nodePath, spec.cliPath, ...watchArgs(spec)]
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join('\n');
  const log = xmlEscape(launchdLogPath(home));

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}
