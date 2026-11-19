import { Command } from 'commander'
import chalk from 'chalk'

import { getClient } from '@/lib/api'
import { getOrg, setOrg } from '@/lib/config'
import * as output from '@/lib/output'

export const orgCommand = new Command('org').description('Manage organisations')

orgCommand
  .command('list')
  .description('List your organisations')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const data = await getClient().organisations.list()

      if (opts.json) return output.json(data)

      const currentOrg = getOrg()
      output.table(
        data.map((o) => ({
          name: o.id === currentOrg ? chalk.cyan('● ' + o.name) : '  ' + o.name,
          plan: o.plan,
          role: o.role,
          id: chalk.dim(o.id),
        })),
      )
    } catch (err) {
      output.handleError(err)
    }
  })

orgCommand
  .command('select')
  .description('Select the active organisation')
  .argument('[id]', 'Organisation ID (interactive if omitted)')
  .action(async (id?: string) => {
    try {
      if (id) {
        setOrg(id)
        output.success(`Active organisation: ${chalk.bold(id)}`)
        return
      }

      const data = await getClient().organisations.list()

      if (data.length === 0) {
        output.print(chalk.dim('No organisations found.'))
        return
      }

      const [only] = data
      if (data.length === 1 && only) {
        setOrg(only.id)
        output.success(`Active organisation: ${chalk.bold(only.name)}`)
        return
      }

      output.print(chalk.bold('Pick an organisation:'))
      data.forEach((o, i) => {
        output.print(
          `  ${chalk.dim(`${i + 1}.`)} ${o.name} ${chalk.dim(`(${o.plan})`)} - ${chalk.dim(o.id)}`,
        )
      })
      output.print()
      output.print(`Run: ${chalk.bold('cf org select <id>')}`)
    } catch (err) {
      output.handleError(err)
    }
  })

orgCommand
  .command('current')
  .description('Show the active organisation')
  .action(() => {
    const org = getOrg()
    if (!org) {
      output.print(chalk.dim('No organisation selected. Run `cf org select`.'))
      return
    }
    output.print(org)
  })
