/**
 * Turns the decrypted local files into what the child gets: extra argv for
 * `wrangler dev`, extra environment, and any plaintext that has to exist on
 * disk while it runs (only with `--materialize`).
 */

import { materializeInPlace, materializeTemp } from '@/lib/local-env/materialize'
import { toUpperSnake } from '@/lib/local-env/names'
import type { LocalFilesPlan } from '@/lib/local-env/run-files'
import { adaptWrangler } from '@/lib/local-env/wrangler'

export type MaterializeMode = 'in-place' | 'temp'

export type PreparedRun = {
  args: string[]
  env: Record<string, string>
  /** Puts ciphertext back / removes temp copies. `null` when nothing was written. */
  cleanup: (() => void) | null
  /** One line each, for stderr. */
  notes: string[]
}

/** Reads `--materialize [mode]` from commander's value. */
export function materializeMode(value: unknown): MaterializeMode | null {
  if (value === undefined || value === false) return null
  if (value === true || value === 'in-place') return 'in-place'
  if (value === 'temp') return 'temp'
  throw new Error(`--materialize takes "in-place" or "temp" (got "${String(value)}")`)
}

export function prepareRun(
  argv: readonly string[],
  local: LocalFilesPlan,
  mode: MaterializeMode | null,
): PreparedRun {
  const wrangler = adaptWrangler(
    argv,
    local.devVars.map((file) => file.path),
  )
  const notes: string[] = local.restored.map(
    (path) => `restored ${path} from a .cf-restore sidecar left by an earlier run`,
  )
  if (wrangler.adapted) {
    notes.push(
      'wrangler dev: passing the encrypted .dev.vars as --env-file; decrypted values come from the environment',
    )
  }

  const files = [...local.materialize, ...(wrangler.adapted || !mode ? [] : local.devVars)]
  if (!mode) {
    for (const file of local.materialize) {
      notes.push(`${file.rel} is read by the tool itself and holds ciphertext: pass --materialize`)
    }
    if (!wrangler.adapted && local.devVars.length > 0) {
      notes.push(
        'a bound .dev.vars holds ciphertext; if this starts wrangler dev indirectly, run `cf run -- wrangler dev` or pass --materialize',
      )
    }
  }

  const env = { ...wrangler.env }
  let cleanup: (() => void) | null = null
  if (mode && files.length > 0) {
    if (mode === 'in-place') {
      cleanup = materializeInPlace(files)
      notes.push(`materialized ${files.length} file(s) in place until the command exits`)
    } else {
      const temp = materializeTemp(files)
      for (const file of files) {
        const copy = temp.copies.get(file.path)
        if (copy) env[`CF_MATERIALIZED_${toUpperSnake(file.rel)}`] = copy
      }
      cleanup = temp.cleanup
      notes.push(
        `materialized ${files.length} file(s) to a private temp directory (CF_MATERIALIZED_*)`,
      )
    }
  }
  return { args: wrangler.args, env, cleanup, notes }
}
