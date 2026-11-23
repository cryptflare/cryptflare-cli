/**
 * Rails `config/master.key` and `config/credentials/<env>.key`: the whole
 * file is one secret. Rails reads `RAILS_MASTER_KEY` before the file, so
 * `cf run` injects it and the file can hold ciphertext.
 */

import type { FileFormat, ParsedFile } from '@/lib/local-env/formats/types'

const PATH = /(^|\/)config\/(master\.key|credentials\/[^/]+\.key)$/i

function parseWholeFile(content: string): ParsedFile {
  const value = content.trim()
  if (value === '') return { entries: [], unmanaged: [] }
  const start = content.indexOf(value)
  return {
    entries: [
      { name: 'RAILS_MASTER_KEY', value, start, end: start + value.length, quote: 'none', line: 1 },
    ],
    unmanaged: [],
  }
}

export const railsMasterKeyFormat: FileFormat = {
  id: 'rails-master-key',
  label: 'Rails master key',
  injection: 'env',
  style: 'whole-file',
  matches: (path) => PATH.test(path),
  parse: parseWholeFile,
  render: (value) => value,
  envName: () => 'RAILS_MASTER_KEY',
}
