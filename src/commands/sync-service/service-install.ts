/** `cf sync install-service` / `uninstall-service` for systemd, launchd and Windows. */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, resolve } from 'node:path'
import { Command } from 'commander'
import chalk from 'chalk'
import { currentDeviceReport, reportDeviceSafely } from '@/lib/device-report'
import * as output from '@/lib/output'
import { launchdLogPath, launchdPlistPath, renderLaunchdPlist } from '@/lib/service/launchd'
import { systemdUnitPath, type ServiceSpec } from '@/lib/service/spec'
import {
  quoteWindowsArg,
  renderWindowsLauncher,
  WINDOWS_TASK_NAME,
  windowsCreateTaskArgs,
  windowsLauncherPath,
  windowsLogPath,
} from '@/lib/service/windows'
import { getRegistryPath } from '@/lib/sync-registry'
import {
  DEFAULT_INTERVAL_S,
  EXIT_NEEDS_LOGIN,
  MIN_INTERVAL_S,
  SERVICE_NAME,
} from '@/commands/sync-service/options'
import { BRAND } from '../../_vendored/brand'

/**
 * Renders a systemd **user** unit, not a system unit. The service needs the
 * caller's `~/.config/cryptflare` credentials and writes into the caller's
 * project directories, so running it as root would mean either copying the
 * token somewhere more privileged or writing files as the wrong owner.
 */
export function renderUnit(opts: {
  interval: number
  pullOnly: boolean
  project?: string
  execPath?: string
}): string {
  // systemd needs an absolute path with no PATH lookup, so bake in the entry
  // point this process was started from. `--exec-path` overrides it for the
  // cases where argv[1] is not the real CLI (a wrapper script, a test runner).
  const cliPath = resolve(opts.execPath ?? process.argv[1] ?? 'cf')
  const args = ['sync', 'watch', '--interval', String(opts.interval)]
  if (opts.pullOnly) args.push('--pull-only')
  if (opts.project) args.push('--project', opts.project)

  return `[Unit]
Description=CryptFlare secret sync
Documentation=${BRAND.urls.docs}/cli
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${cliPath} ${args.join(' ')}
Restart=always
RestartSec=15
# 78 is "login required": the saved token was refused. Restarting cannot fix
# that, so stay stopped until someone logs in again.
RestartPreventExitStatus=${EXIT_NEEDS_LOGIN}
# Optional 0600 file holding CF_TOKEN, so a dedicated scoped token for the
# service never has to live in this world-readable unit. The leading dash makes
# it optional - without it the service falls back to the CLI's saved login.
EnvironmentFile=-%h/.config/cryptflare/service.env
# Cap restart storms: if the loop cannot stay up, stop rather than hammer the
# API for a fortnight while nobody is watching.
StartLimitIntervalSec=300
StartLimitBurst=5
Environment=NODE_ENV=production

# Hardening. ProtectHome stays read-write because the whole job is writing
# .env files under $HOME; MemoryDenyWriteExecute stays off because V8 JITs.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-write
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes

[Install]
WantedBy=default.target
`
}

/** Runs a system tool, passing its output through. */
function runTool(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: 'inherit' })
}

function serviceSpecFrom(opts: {
  interval: string
  pullOnly?: boolean
  project?: string
  execPath?: string
}): ServiceSpec {
  const interval = Number(opts.interval)
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL_S) {
    throw new Error(`--interval must be a number >= ${MIN_INTERVAL_S}`)
  }

  const cliPath = resolve(opts.execPath ?? process.argv[1] ?? 'cf')
  if (!existsSync(cliPath)) {
    // A service whose entry point does not exist fails silently in the
    // background. Catch it here, while someone is still watching.
    throw new Error(`CLI entry point not found at ${cliPath}. Pass --exec-path <path to cf>.`)
  }

  return {
    nodePath: process.execPath,
    cliPath,
    interval,
    pullOnly: Boolean(opts.pullOnly),
    project: opts.project,
  }
}

/** Linux: systemd user unit. */
function installSystemd(spec: ServiceSpec, opts: { enable?: boolean; print?: boolean }): void {
  const unit = renderUnit({
    interval: spec.interval,
    pullOnly: spec.pullOnly,
    ...(spec.project ? { project: spec.project } : {}),
    execPath: spec.cliPath,
  })
  if (opts.print) {
    output.print(unit)
    return
  }

  // Under WSL the user manager only exists when systemd is switched on, and
  // without it the unit below would be written and never run.
  if (!existsSync('/run/systemd/system')) {
    throw new Error(
      'systemd is not running on this machine. Under WSL, add\n\n' +
        '    [boot]\n    systemd=true\n\n' +
        '  to /etc/wsl.conf and run `wsl --shutdown` from Windows, then try again.\n' +
        '  Or install the service on the Windows side instead, by running this command in PowerShell.',
    )
  }

  const unitPath = systemdUnitPath()
  const unitDir = dirname(unitPath)
  mkdirSync(unitDir, { recursive: true })
  writeFileSync(unitPath, unit, { encoding: 'utf-8', mode: 0o644 })
  output.success(`Wrote ${chalk.bold(unitPath)}`)

  if (opts.enable) {
    runTool('systemctl', ['--user', 'daemon-reload'])
    runTool('systemctl', ['--user', 'enable', '--now', SERVICE_NAME])
    try {
      // Without lingering, the user manager is torn down at logout and the
      // service dies with it - fatal for the "sync while I am away" case.
      runTool('loginctl', ['enable-linger', userInfo().username])
    } catch {
      output.warn('Could not enable linger automatically. Run: sudo loginctl enable-linger $USER')
    }
    output.success('Service enabled and started.')
  } else {
    output.print()
    output.print('  Next:')
    output.print(`    ${chalk.cyan('systemctl --user daemon-reload')}`)
    output.print(`    ${chalk.cyan(`systemctl --user enable --now ${SERVICE_NAME}`)}`)
    output.print(
      `    ${chalk.cyan('sudo loginctl enable-linger $USER')}   ${chalk.dim('# keeps it running while logged out')}`,
    )
  }

  output.print()
  output.print('  Logs:')
  output.print(`    ${chalk.cyan(`journalctl --user -u ${SERVICE_NAME} -f`)}`)
  output.print()
}

/** macOS: launchd user agent. */
function installLaunchd(spec: ServiceSpec, opts: { enable?: boolean; print?: boolean }): void {
  const plist = renderLaunchdPlist(spec)
  if (opts.print) {
    output.print(plist)
    return
  }

  const plistPath = launchdPlistPath()
  mkdirSync(dirname(plistPath), { recursive: true })
  mkdirSync(dirname(launchdLogPath()), { recursive: true })
  writeFileSync(plistPath, plist, { encoding: 'utf-8', mode: 0o644 })
  output.success(`Wrote ${chalk.bold(plistPath)}`)

  if (opts.enable) {
    // Unload first so re-installing replaces a running agent instead of
    // failing with "service already loaded". Not loaded is not an error.
    try {
      execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' })
    } catch {
      // Nothing was loaded.
    }
    runTool('launchctl', ['load', '-w', plistPath])
    output.success('Agent loaded. It starts at login.')
  } else {
    output.print()
    output.print('  Next:')
    output.print(`    ${chalk.cyan(`launchctl load -w ${plistPath}`)}`)
  }

  output.print()
  output.print('  Logs:')
  output.print(`    ${chalk.cyan(`tail -f ${launchdLogPath()}`)}`)
  output.print()
}

/** Windows: scheduled task at logon. */
function installWindowsTask(spec: ServiceSpec, opts: { enable?: boolean; print?: boolean }): void {
  const configDir = dirname(getRegistryPath())
  const launcher = renderWindowsLauncher(spec, configDir)
  if (opts.print) {
    output.print(launcher)
    return
  }

  const launcherPath = windowsLauncherPath(configDir)
  mkdirSync(configDir, { recursive: true })
  writeFileSync(launcherPath, launcher, { encoding: 'utf-8' })
  output.success(`Wrote ${chalk.bold(launcherPath)}`)

  const createArgs = windowsCreateTaskArgs(configDir)
  if (opts.enable) {
    runTool('schtasks.exe', createArgs)
    runTool('schtasks.exe', ['/Run', '/TN', WINDOWS_TASK_NAME])
    output.success(`Task "${WINDOWS_TASK_NAME}" created and started. It starts at logon.`)
  } else {
    output.print()
    output.print('  Next:')
    output.print(`    ${chalk.cyan(`schtasks ${createArgs.map(quoteWindowsArg).join(' ')}`)}`)
    output.print(`    ${chalk.cyan(`schtasks /Run /TN "${WINDOWS_TASK_NAME}"`)}`)
  }

  output.print()
  output.print('  Logs:')
  output.print(`    ${chalk.cyan(windowsLogPath(configDir))}`)
  output.print()
}

const SERVICE_KINDS: Partial<Record<NodeJS.Platform, string>> = {
  linux: 'systemd user unit',
  darwin: 'launchd agent',
  win32: 'scheduled task at logon',
}

function requireServicePlatform(): 'linux' | 'darwin' | 'win32' {
  const platform = process.platform
  if (platform === 'linux' || platform === 'darwin' || platform === 'win32') return platform
  throw new Error(
    `No background service is available for ${platform}. Run \`cf sync watch\` under whatever keeps processes alive there.`,
  )
}

export const installServiceCommand = new Command('install-service')
  .description(
    'Run `cf sync watch` in the background at login (systemd on Linux, launchd on macOS, a scheduled task on Windows)',
  )
  .option('--interval <seconds>', 'Base poll interval', String(DEFAULT_INTERVAL_S))
  .option('--pull-only', 'Service pulls only, never pushes local changes up')
  .option('-p, --project <id>', 'Limit the service to one project')
  .option('--exec-path <path>', 'Path to the cf entry point (defaults to the running one)')
  .option('--enable', 'Also register and start the service now')
  .option('--print', 'Print the service definition to stdout instead of writing it')
  .action(async (opts) => {
    try {
      const platform = requireServicePlatform()
      const spec = serviceSpecFrom(opts)

      if (!opts.print) output.print(chalk.dim(`  Installing as a ${SERVICE_KINDS[platform]}.`))
      if (platform === 'linux') installSystemd(spec, opts)
      else if (platform === 'darwin') installLaunchd(spec, opts)
      else installWindowsTask(spec, opts)
      // The devices page shows the new service at once, not at the first pass.
      if (!opts.print) await reportDeviceSafely(currentDeviceReport({}))
    } catch (err) {
      output.handleError(err)
    }
  })

/** Removes a file if it is there. Returns whether it was. */
function removeIfPresent(path: string): boolean {
  if (!existsSync(path)) return false
  rmSync(path)
  return true
}

/** Runs a tool whose failure only means "there was nothing to stop". */
function runQuietly(command: string, args: string[]): void {
  try {
    execFileSync(command, args, { stdio: 'ignore' })
  } catch {
    // Not installed, not running, or already gone.
  }
}

export const uninstallServiceCommand = new Command('uninstall-service')
  .description('Stop the background sync service and remove what `install-service` wrote')
  .action(async () => {
    try {
      const platform = requireServicePlatform()
      let removed: boolean

      if (platform === 'linux') {
        runQuietly('systemctl', ['--user', 'disable', '--now', SERVICE_NAME])
        removed = removeIfPresent(systemdUnitPath())
        runQuietly('systemctl', ['--user', 'daemon-reload'])
      } else if (platform === 'darwin') {
        runQuietly('launchctl', ['unload', '-w', launchdPlistPath()])
        removed = removeIfPresent(launchdPlistPath())
      } else {
        const configDir = dirname(getRegistryPath())
        runQuietly('schtasks.exe', ['/End', '/TN', WINDOWS_TASK_NAME])
        runQuietly('schtasks.exe', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F'])
        removed = removeIfPresent(windowsLauncherPath(configDir))
      }

      if (removed)
        output.success(
          'Background sync service removed. Registered projects and saved login are untouched.',
        )
      else output.info('No background sync service was installed.')
      await reportDeviceSafely(currentDeviceReport({}))
    } catch (err) {
      output.handleError(err)
    }
  })
