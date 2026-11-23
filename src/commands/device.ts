/**
 * `cf device` - this machine as the dashboard's devices page sees it.
 * `status` prints exactly what `cf sync` reports, `rename` names it, and
 * `report on|off` turns the reports on or off.
 */

import { Command } from 'commander'
import chalk from 'chalk'

import { BRAND } from '../_vendored/brand'

import { api } from '@/lib/api'
import { setDeviceReport } from '@/lib/config'
import { DEVICE_NAME_MAX_LENGTH, DEVICE_REPORT_ENV } from '@/lib/device-contract'
import { currentDeviceReport, isDeviceReportEnabled } from '@/lib/device-report'
import * as output from '@/lib/output'

const PRIVACY_NOTE = `What \`cf sync\` reports to the devices page (${BRAND.urls.app}/devices):
  - This computer's name, operating system and CLI version
  - Which background service runs the sync, and whether it is running
  - How many projects and files are registered, and how the last pass ended

It never reports file paths, project, workspace or environment names, keys
or values. Turn it off with \`cf device report off\` or ${DEVICE_REPORT_ENV}=0.`

export const deviceCommand = new Command('device').description(
  'This machine on the devices page: what it reports, its name, and reporting on or off',
)

deviceCommand
  .command('status')
  .description('Print what `cf sync` reports about this machine')
  .option('--json', 'Output as JSON')
  .action((opts) => {
    try {
      const report = currentDeviceReport({})
      const enabled = isDeviceReportEnabled()
      if (opts.json) return output.json({ reporting: enabled, report })
      output.print()
      output.print(`  Reporting: ${enabled ? chalk.green('on') : chalk.dim('off')}`)
      output.print()
      output.print(JSON.stringify(report, null, 2))
      output.print()
      output.print(chalk.dim(PRIVACY_NOTE))
      output.print()
    } catch (err) {
      output.handleError(err)
    }
  })

deviceCommand
  .command('rename <name>')
  .description('Rename this machine on the devices page')
  .action(async (name: string) => {
    try {
      const trimmed = name.trim()
      if (!trimmed || trimmed.length > DEVICE_NAME_MAX_LENGTH) {
        output.usageError(`A device name is 1 to ${DEVICE_NAME_MAX_LENGTH} characters.`)
      }
      await api('/v1/devices/self', { method: 'PATCH', body: { name: trimmed } })
      output.success(`This machine is now "${trimmed}" on the devices page.`)
    } catch (err) {
      output.handleError(err)
    }
  })

const reportCommand = new Command('report').description(
  'Turn reporting to the devices page on or off',
)

reportCommand
  .command('on')
  .description('Report this machine to the devices page (the default)')
  .action(() => {
    setDeviceReport(true)
    output.success('Device reports on.')
    if (!isDeviceReportEnabled())
      output.warn(`${DEVICE_REPORT_ENV} is set in this shell and keeps them off here.`)
  })

reportCommand
  .command('off')
  .description('Stop reporting this machine to the devices page')
  .action(() => {
    setDeviceReport(false)
    output.success('Device reports off. The devices page shows this machine as offline.')
  })

deviceCommand.addCommand(reportCommand)
