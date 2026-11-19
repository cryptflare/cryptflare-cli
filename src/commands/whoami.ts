import { Command } from 'commander'
import chalk from 'chalk'
import { getClient } from '@/lib/api'
import { getOrg, getConfigPath, getDefault } from '@/lib/config'
import * as output from '@/lib/output'

export const whoamiCommand = new Command('whoami')
  .description('Show current authentication, organisation, and plan details')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      // We can introspect the bearer credential without an active-org
      // selection, so don't require CF_ORG / config-saved org just to
      // call this. When no org is set we render "(none selected)" in
      // the org block instead of erroring.
      const org = getOrg()

      const me = await getClient().auth.getMe()
      const { user, organisations } = me

      const activeOrg = organisations.find((o) => o.id === org) ?? organisations[0]

      if (opts.json) {
        return output.json({
          user,
          organisation: activeOrg ?? null,
          defaults: {
            workspace: getDefault('workspace') ?? null,
            environment: getDefault('environment') ?? null,
          },
          configPath: getConfigPath(),
        })
      }

      output.print()
      output.print(chalk.bold('  User'))
      output.print(`  ${chalk.dim('Name:')}     ${user.name ?? chalk.dim('(not set)')}`)
      output.print(`  ${chalk.dim('Email:')}    ${user.email}`)
      output.print(`  ${chalk.dim('ID:')}       ${chalk.dim(user.id)}`)
      output.print()

      if (activeOrg) {
        output.print(chalk.bold('  Organisation'))
        output.print(`  ${chalk.dim('Name:')}     ${activeOrg.name}`)
        output.print(`  ${chalk.dim('Plan:')}     ${planBadge(activeOrg.plan)}`)
        output.print(`  ${chalk.dim('Role:')}     ${activeOrg.role}`)
        // `dataRegion` is sent by the API but not yet declared in the shared
        // MeResponseSchema, so read it defensively instead of casting.
        const region =
          'dataRegion' in activeOrg && typeof activeOrg.dataRegion === 'string'
            ? activeOrg.dataRegion
            : chalk.dim('(unknown)')
        output.print(`  ${chalk.dim('Region:')}   ${region}`)
        output.print(`  ${chalk.dim('ID:')}       ${chalk.dim(activeOrg.id)}`)
        output.print()
      }

      const ws = getDefault('workspace')
      const env = getDefault('environment')
      if (ws || env) {
        output.print(chalk.bold('  Defaults'))
        if (ws) output.print(`  ${chalk.dim('Workspace:')}   ${ws}`)
        if (env) output.print(`  ${chalk.dim('Environment:')} ${env}`)
        output.print()
      }

      output.print(chalk.dim(`  Config: ${getConfigPath()}`))
      output.print()
    } catch (err) {
      output.handleError(err)
    }
  })

function planBadge(plan: string): string {
  switch (plan) {
    case 'team':
      return chalk.bgMagenta.white(` ${plan.toUpperCase()} `)
    case 'pro':
      return chalk.bgBlue.white(` ${plan.toUpperCase()} `)
    default:
      return chalk.bgGray.white(` ${plan.toUpperCase()} `)
  }
}
