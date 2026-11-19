/**
 * macOS: a launchd **user agent**, the per-user equivalent of the systemd
 * user unit. It runs as the logged-in user, so it reads that user's CLI
 * login and writes env files with the right owner.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { watchArgs, type ServiceSpec } from '@/lib/service/spec'

export const LAUNCHD_LABEL = 'com.cryptflare.sync'

export function launchdPlistPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
}

export function launchdLogPath(home: string = homedir()): string {
  return join(home, 'Library', 'Logs', 'cryptflare-sync.log')
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** A property-list value. Rendered by {@link renderPlistValue}. */
type PlistValue =
  | string
  | number
  | boolean
  | readonly PlistValue[]
  | { readonly [key: string]: PlistValue }

function renderPlistValue(value: PlistValue, indent: string): string {
  if (typeof value === 'string') return `${indent}<string>${xmlEscape(value)}</string>`
  if (typeof value === 'number') return `${indent}<integer>${value}</integer>`
  if (typeof value === 'boolean') return `${indent}<${value ? 'true' : 'false'}/>`
  const inner = `${indent}  `
  if (Array.isArray(value)) {
    return [
      `${indent}<array>`,
      ...value.map((item) => renderPlistValue(item, inner)),
      `${indent}</array>`,
    ].join('\n')
  }
  const entries = Object.entries(value).flatMap(([key, item]) => [
    `${inner}<key>${xmlEscape(key)}</key>`,
    renderPlistValue(item, inner),
  ])
  return [`${indent}<dict>`, ...entries, `${indent}</dict>`].join('\n')
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
  const log = launchdLogPath(home)
  const agent: PlistValue = {
    Label: LAUNCHD_LABEL,
    ProgramArguments: [spec.nodePath, spec.cliPath, ...watchArgs(spec)],
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 60,
    ProcessType: 'Background',
    EnvironmentVariables: { NODE_ENV: 'production' },
    StandardOutPath: log,
    StandardErrorPath: log,
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    renderPlistValue(agent, ''),
    '</plist>',
    '',
  ].join('\n')
}
