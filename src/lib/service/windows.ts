/**
 * Windows: a scheduled task that starts at logon and runs as the logged-in
 * user, with no elevation.
 *
 * A task whose action is `node.exe ...` opens a console window that stays on
 * screen for as long as the loop runs. The usual way round that is a
 * three-line Windows Script Host launcher that starts the process with a
 * hidden window, which also keeps the task's own command line far below the
 * 261 character limit `schtasks /TR` imposes.
 */

import { join } from 'node:path';

import { watchArgs, type ServiceSpec } from './spec.js';

export const WINDOWS_TASK_NAME = 'CryptFlare Sync';

export function windowsLauncherPath(configDir: string): string {
  return join(configDir, 'sync-service.vbs');
}

export function windowsLogPath(configDir: string): string {
  return join(configDir, 'sync-service.log');
}

/**
 * Quotes one argument for a Windows command line, following the rules the
 * Microsoft C runtime uses to split it back apart: backslashes are literal
 * unless they precede a quote, and a quote is escaped with a backslash.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  let quoted = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1);
    } else {
      quoted += '\\'.repeat(backslashes);
    }
    quoted += ch;
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

/** A VBScript string literal: quotes are doubled, nothing else is special. */
function vbsString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Renders the hidden-window launcher.
 *
 * It waits for the process and exits with its exit code, so Task Scheduler
 * shows the task as running while the loop runs, and records why it stopped.
 * Output is appended to a log file through `cmd`, the only part of Windows
 * that can redirect a console program's output without showing a window.
 */
export function renderWindowsLauncher(spec: ServiceSpec, configDir: string): string {
  const command = [spec.nodePath, spec.cliPath, ...watchArgs(spec)].map(quoteWindowsArg).join(' ');
  // `cmd /s /c "<command> >> "<log>" 2>&1"`: with /s, cmd strips exactly the
  // outer pair of quotes and runs the rest verbatim, so the quoting inside
  // survives.
  const shellLine = `cmd /d /s /c "${command} >> ${quoteWindowsArg(windowsLogPath(configDir))} 2>&1"`;

  return [
    "' Starts the CryptFlare sync loop with no console window.",
    "' Written by `cf sync install-service`. Remove with `cf sync uninstall-service`.",
    'Option Explicit',
    'Dim shell',
    'Set shell = CreateObject("WScript.Shell")',
    'shell.Environment("Process")("NODE_ENV") = "production"',
    `WScript.Quit shell.Run(${vbsString(shellLine)}, 0, True)`,
    '',
  ].join('\r\n');
}

/** Arguments for `schtasks.exe` that create (or replace) the logon task. */
export function windowsCreateTaskArgs(configDir: string): string[] {
  return [
    '/Create',
    '/TN', WINDOWS_TASK_NAME,
    '/SC', 'ONLOGON',
    // LIMITED: run with the user's normal rights, never elevated. The task
    // reads the user's own login and writes the user's own files.
    '/RL', 'LIMITED',
    '/TR', `wscript.exe ${quoteWindowsArg(windowsLauncherPath(configDir))}`,
    '/F',
  ];
}
