/**
 * The CryptFlare GitHub App on the repository's owner.
 *
 * Pushes run through the CryptFlare GitHub App installed on the owner (an
 * organisation or a personal account), which mints a short-lived token for
 * each push. No one's personal token is stored. The install itself is done
 * in the browser; the dashboard page GitHub returns to records it, and this
 * side waits until it shows up in the organisation's integrations.
 */

export type GitHubIntegration = {
  id: string
  provider: string
  externalOrgLogin: string | null
  installationId: number | null
  accountType: 'Organization' | 'User' | null
  repositorySelection: 'all' | 'selected' | null
  status: string
}

/** The active CryptFlare GitHub App installation on `owner`, if there is one. */
export function findOwnerIntegration(
  integrations: GitHubIntegration[],
  owner: string,
): GitHubIntegration | undefined {
  return integrations.find(
    (integration) =>
      integration.provider === 'github' &&
      integration.status === 'active' &&
      integration.externalOrgLogin?.toLowerCase() === owner.toLowerCase(),
  )
}

/** Where the owner changes which repositories the installation reaches. */
export function installationSettingsUrl(integration: GitHubIntegration): string {
  const id = String(integration.installationId ?? '')
  return integration.accountType === 'User'
    ? `https://github.com/settings/installations/${id}`
    : `https://github.com/organizations/${integration.externalOrgLogin ?? ''}/settings/installations/${id}`
}
