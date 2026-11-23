/**
 * Runs a child process asynchronously so cf can clean up after it.
 *
 * `cf run` normally uses `spawn.sync`, which leaves cf unable to act on a
 * Ctrl-C: the terminal signals both processes and Node's default handler
 * kills cf at once. When plaintext has been materialised, cf must outlive the
 * child to put the ciphertext back, so it forwards the signal and waits.
 */

import spawn from 'cross-spawn'

import { EXIT_CODES } from '@/lib/exit-codes'
import { errorCode } from '@/lib/guards'

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
}

/**
 * Starts the child, forwards SIGINT/SIGTERM/SIGHUP to it, and runs `cleanup`
 * exactly once when it exits, when it cannot start, or when cf itself exits.
 *
 * @returns The exit status to report: the child's own, 127 when the command
 *   is not found, 128 + n when it died on signal n.
 */
export function runChildWithCleanup(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cleanup: () => void,
): Promise<number> {
  let cleaned = false
  const once = () => {
    if (cleaned) return
    cleaned = true
    cleanup()
  }
  process.once('exit', once)

  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: 'inherit', env })
    const forward = (signal: NodeJS.Signals) => child.kill(signal)
    for (const signal of SIGNALS) process.on(signal, forward)
    const finish = (status: number) => {
      for (const signal of SIGNALS) process.off(signal, forward)
      once()
      resolve(status)
    }
    child.on('error', (err) => {
      finish(errorCode(err) === 'ENOENT' ? EXIT_CODES.COMMAND_NOT_FOUND : EXIT_CODES.ERROR)
    })
    child.on('exit', (code, signal) => {
      finish(signal ? EXIT_CODES.SIGNAL_BASE + (SIGNAL_NUMBERS[signal] ?? 0) : (code ?? 0))
    })
  })
}
