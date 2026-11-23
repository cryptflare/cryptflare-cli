/**
 * `cf env decrypt <file>` - print a file's plaintext, or its values for a
 * shell. Never writes plaintext to disk unless `--out` names a path.
 */

import { readFileSync, writeSync } from 'node:fs'

import { Command } from 'commander'

import { shellQuote } from '@/commands/run'
import { getClient } from '@/lib/api'
import { decryptContent, keyRefsIn } from '@/lib/local-env/codec'
import { resolveFileTarget } from '@/lib/local-env/file-target'
import { writeFileAtomic } from '@/lib/local-env/file-io'
import { Keyring } from '@/lib/local-env/keyring'
import { isEncryptedValue } from '@/lib/local-env/value-crypto'
import * as output from '@/lib/output'

export const DECRYPT_FORMATS = ['file', 'shell', 'json'] as const

/**
 * What `--format shell` prints when decryption fails: the encrypted names
 * unset, so an `eval` leaves neither plaintext nor ciphertext in the shell.
 */
export function unsetLines(content: string, target: ReturnType<typeof resolveFileTarget>): string {
  const names = target.format
    .parse(content)
    .entries.filter((entry) => isEncryptedValue(entry.value))
    .map((entry) => target.format.envName(entry))
  return names.length > 0 ? `unset ${[...new Set(names)].join(' ')}\n` : ''
}

export const decryptCommand = new Command('decrypt')
  .description('Decrypt a local env file to stdout (or to --out), never in place by default')
  .argument('<file>', 'Encrypted file')
  .option('-w, --workspace <slug>', 'Workspace, for a file not bound in .cryptflare.json')
  .option('-e, --env <slug>', 'Environment, for a file not bound in .cryptflare.json')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--format <format>', `Output: ${DECRYPT_FORMATS.join(', ')}`, 'file')
  .option('--file-format <id>', 'Format of the input, for a file whose name no format claims')
  .option('--stdout', 'Print to stdout (the default)')
  .option('--out <path>', 'Write the plaintext to this path (mode 0600) instead of stdout')
  .addHelpText(
    'after',
    `
Examples:
  cf env decrypt .env                          the whole file, decrypted
  eval "$(cf env decrypt .envrc --format shell)"   export the values into this shell
  cf env decrypt .dev.vars --out /tmp/vars     an explicit plaintext copy`,
  )
  .action(async (file: string, opts) => {
    let target: ReturnType<typeof resolveFileTarget> | null = null
    let content = ''
    try {
      target = resolveFileTarget(file, { ...opts, format: opts.fileFormat })
      content = readFileSync(target.path, 'utf-8')
      const keyring = new Keyring(getClient())
      const keys = await keyring.forRefs(target.scope, keyRefsIn(target.format.parse(content)))
      const result = decryptContent(content, target.format, keys)

      let body: string
      if (opts.format === 'shell') {
        body = [...result.values]
          .map(([name, value]) => `export ${name}=${shellQuote(value)}\n`)
          .join('')
      } else if (opts.format === 'json') {
        body = `${JSON.stringify(Object.fromEntries(result.values), null, 2)}\n`
      } else if (opts.format === 'file') {
        body = result.plaintext
      } else {
        output.usageError(
          `Unknown --format "${String(opts.format)}". Use ${DECRYPT_FORMATS.join(', ')}.`,
        )
      }

      if (opts.out) {
        writeFileAtomic(opts.out, body)
        output.printError(`cf env decrypt: wrote plaintext to ${opts.out}; delete it when done.`)
      } else {
        process.stdout.write(body)
      }
    } catch (err) {
      // Fails closed for `eval`: the encrypted names are unset, so the shell
      // holds neither the plaintext nor the ciphertext.
      // Written synchronously: handleError exits, and a piped stdout would
      // drop an asynchronous write.
      if (opts.format === 'shell' && target) writeSync(1, unsetLines(content, target))
      output.handleError(err)
    }
  })
