import { arch, hostname, platform } from 'node:os'

import { Command } from 'commander'
import chalk from 'chalk'
import open from 'open'

import { BRAND } from '../_vendored/brand'

import { getAnonymousClient, getClient, resetClient, ApiError } from '@/lib/api'
import { getToken, setToken, clearToken, setOrg, getConfigPath } from '@/lib/config'
import { success, warn, handleError, print, MARK } from '@/lib/output'
import * as progress from '@/lib/progress'
import {
  classifyCredentialCheck,
  decideLogin,
  LOGIN_COMMAND,
  type CredentialState,
} from '@/lib/login-state'
import { EXIT_CODES } from '@/lib/exit-codes'
import { pollForApproval } from '@/lib/device-poll'
import { VERSION } from '@/version'

const DIVIDER = chalk.dim('─'.repeat(48))
const BASE_URL_LABEL = process.env.CF_API_URL ?? BRAND.urls.api

type TokenResponse = {
  apiKey: string
  user: { id: string; email: string; name: string | null }
  org: string
}

export const authCommand = new Command('auth').description('Manage authentication')

/** Asks the API whether the saved key still works. */
async function checkSavedCredential(): Promise<CredentialState> {
  progress.start('Checking the saved key...')
  try {
    await getClient().auth.whoami()
    return 'valid'
  } catch (err) {
    return classifyCredentialCheck(err)
  } finally {
    progress.stop()
  }
}

/**
 * Builds the login command. A factory rather than one instance because it is
 * registered twice (`cf login` and `cf auth login`) and a commander command
 * can only have one parent.
 */
function buildLoginCommand(): Command {
  return new Command('login')
    .description('Authenticate via browser')
    .option('-f, --force', 'Sign in again even though the saved key still works, replacing it')
    .action(async (opts: { force?: boolean }) => {
      print()
      print(`  ${chalk.bold(BRAND.name)} CLI`)
      print(DIVIDER)

      const existing = getToken()
      const decision = await decideLogin({
        hasCredential: Boolean(existing),
        force: Boolean(opts.force),
        check: checkSavedCredential,
      })

      if (decision.action === 'refuse' && existing) {
        const masked = existing.slice(0, 12) + '...' + existing.slice(-4)
        print()
        if (decision.reason === 'valid') {
          warn(`Already authenticated: ${chalk.dim(masked)}`)
          print()
          print(`  To sign in again and replace it, run ${chalk.cyan(`${LOGIN_COMMAND} --force`)}.`)
        } else {
          warn(
            `A key is saved (${chalk.dim(masked)}) but the API at ${BASE_URL_LABEL} could not be reached to check it.`,
          )
          print()
          print('  Nothing was changed. Try again when you are online,')
          print(
            `  or run ${chalk.cyan(`${LOGIN_COMMAND} --force`)} to replace the key without checking it.`,
          )
        }
        print(`  To use a different key, set ${chalk.cyan('CF_TOKEN')} env var.`)
        print()
        return
      }

      if (decision.reason === 'invalid') {
        print()
        print(`  ${chalk.dim('The saved key is no longer valid. Signing in again.')}`)
      }
      if (existing && process.env.CF_TOKEN) {
        print()
        warn(
          'CF_TOKEN is set in this shell and takes priority over the key this saves. Unset it to use the new one.',
        )
      }

      // Anonymous on purpose. The device flow is how a token is obtained, so it
      // must not require one - `getClient()` throws when the config is empty,
      // which made `cf auth login` impossible right after `cf auth logout`.
      const client = getAnonymousClient()
      progress.start('Requesting device code...')

      try {
        // Who is asking, shown in the browser before the person approves.
        const device = await client.cli.requestDeviceCode({
          clientName: `${BRAND.name} CLI`,
          clientVersion: VERSION,
          hostname: hostname().slice(0, 120),
          platform: `${platform()} ${arch()}`,
        })

        progress.stop()

        const minutes = Math.round(device.expiresIn / 60)
        print()
        print(`  ${chalk.bold('Authorize this device')}`)
        print()
        const codeStr = `Code:  ${device.userCode}`
        const boxWidth = codeStr.length + 8
        const pad = ' '.repeat(boxWidth - codeStr.length - 2)
        print(`  ┌${'─'.repeat(boxWidth)}┐`)
        print(`  │${' '.repeat(boxWidth)}│`)
        print(`  │  Code:  ${chalk.bold.yellow(device.userCode)}${pad}│`)
        print(`  │${' '.repeat(boxWidth)}│`)
        print(`  └${'─'.repeat(boxWidth)}┘`)
        print()
        print(`  ${chalk.dim('URL:')}  ${chalk.cyan(device.verificationUrl)}`)
        print()
        print(
          `  Type the code above in the browser. It works once and expires in ${minutes} minutes.`,
        )
        print(
          `  ${chalk.dim(`${BRAND.name} never asks you to approve a sign-in from a link someone sent you.`)}`,
        )
        print()

        try {
          await open(device.verificationUrl)
          print(`  ${chalk.green(MARK.ok)} Browser opened automatically`)
        } catch {
          print(`  ${chalk.dim('Open the URL above in your browser')}`)
        }

        print()
        progress.start('Waiting for browser approval...')

        const outcome = await pollForApproval({
          poll: () =>
            client.request<TokenResponse>({
              method: 'POST',
              path: '/v1/cli/token',
              body: { deviceCode: device.deviceCode },
            }),
          codeOf: (err) => (err instanceof ApiError ? err.code : null),
          intervalSeconds: device.interval,
          expiresInSeconds: device.expiresIn,
        })

        if (outcome.kind === 'denied') {
          progress.fail('Sign-in denied in the browser. Nothing was signed in.')
          print(
            `  ${chalk.dim(`If you did not start it, review your sessions: ${BRAND.urls.app}/settings?tab=security`)}`,
          )
          process.exit(EXIT_CODES.AUTH)
        }
        if (outcome.kind === 'expired') {
          progress.fail('Device code expired. Run `cf login` again.')
          process.exit(EXIT_CODES.AUTH)
        }
        if (outcome.kind === 'timeout') {
          progress.fail('Timed out waiting for approval. Run `cf login` again.')
          process.exit(EXIT_CODES.AUTH)
        }

        const result = outcome.value
        setToken(result.apiKey)
        setOrg(result.org)
        // Drop any cached client so a subsequent getClient() in this process
        // picks up the token that was just saved rather than a stale one.
        resetClient()

        progress.stop()

        const masked = result.apiKey.slice(0, 12) + '...' + result.apiKey.slice(-4)

        print()
        print(`  ${chalk.green(MARK.ok)} ${chalk.bold('Authenticated successfully')}`)
        print(DIVIDER)
        print(`  ${chalk.dim('Key:')}      ${masked}`)
        print(`  ${chalk.dim('User:')}     ${result.user.email}`)
        print(`  ${chalk.dim('Org:')}      ${result.org}`)
        print(`  ${chalk.dim('Saved to:')} ${getConfigPath()}`)
        print()
      } catch (err) {
        progress.stop()
        handleError(err)
      }
    })
}

authCommand.addCommand(buildLoginCommand())

authCommand
  .command('status')
  .description('Show authentication status')
  .action(async () => {
    const token = getToken()

    print()
    print(`  ${chalk.bold(BRAND.name)} CLI`)
    print(DIVIDER)

    if (!token) {
      print()
      print(`  ${chalk.dim('Not authenticated')}`)
      print()
      print(`  Run ${chalk.cyan(LOGIN_COMMAND)} to get started.`)
      print()
      return
    }

    const masked = token.slice(0, 12) + '...' + token.slice(-4)
    const source = process.env.CF_TOKEN ? 'CF_TOKEN env' : 'config file'

    try {
      const { user, organisations } = await getClient().auth.getMe()

      print()
      print(`  ${chalk.green('●')} ${chalk.bold('Authenticated')}`)
      print()
      print(`  ${chalk.dim('Key:')}    ${masked}`)
      print(`  ${chalk.dim('Source:')} ${source}`)
      print(`  ${chalk.dim('User:')}   ${user.email}`)
      print(`  ${chalk.dim('API:')}    ${BRAND.urls.api}`)

      if (organisations.length > 0) {
        print()
        print(`  ${chalk.bold('Organisations:')}`)
        organisations.forEach((org) => {
          print(
            `    ${chalk.cyan('●')} ${org.name} ${chalk.dim(`(${org.plan})`)} ${chalk.dim('-')} ${chalk.dim(org.role)}`,
          )
        })
      }
      print()
    } catch {
      print()
      print(`  ${chalk.yellow('●')} ${chalk.bold('Key saved but cannot verify')}`)
      print()
      print(`  ${chalk.dim('Key:')}    ${masked}`)
      print(`  ${chalk.dim('Source:')} ${source}`)
      print(`  ${chalk.dim('API:')}    ${BRAND.urls.api}`)
      print()
      print(`  ${chalk.dim('The API may be unreachable or the key may be expired.')}`)
      print()
    }
  })

function buildLogoutCommand(): Command {
  return new Command('logout').description('Remove saved API key').action(() => {
    const token = getToken()
    if (!token) {
      print()
      print(chalk.dim('  No saved API key found.'))
      print()
      return
    }
    clearToken()
    resetClient()
    print()
    success('API key removed')
    print()
  })
}

authCommand.addCommand(buildLogoutCommand())

/** `cf login`: the same command as `cf auth login`, at the top level. */
export const loginCommand = buildLoginCommand()

/** `cf logout`: the same command as `cf auth logout`, at the top level. */
export const logoutCommand = buildLogoutCommand()
