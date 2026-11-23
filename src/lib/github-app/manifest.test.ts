import { describe, expect, it } from 'vitest'

import {
  buildAppManifest,
  defaultAppName,
  element,
  installUrl,
  manifestFormPage,
  newAppUrl,
  parsePermissionList,
  parseRepositoryList,
} from '@/lib/github-app/manifest'
import { missingInstallationPermissions } from '@/lib/github-app/permissions'

describe('parsePermissionList', () => {
  it('reads name:level pairs', () => {
    expect(parsePermissionList('contents:write, pull_requests:read')).toEqual({
      contents: 'write',
      pull_requests: 'read',
    })
  })

  it('defaults to read access to contents', () => {
    expect(parsePermissionList(undefined)).toEqual({ contents: 'read' })
    expect(parsePermissionList('  ')).toEqual({ contents: 'read' })
  })

  it('names the entry it cannot read', () => {
    expect(() => parsePermissionList('contents:everything')).toThrow(/"contents:everything"/)
    expect(() => parsePermissionList('Contents:read')).toThrow(/"Contents:read"/)
    expect(() => parsePermissionList('contents')).toThrow(/"contents"/)
  })
})

describe('parseRepositoryList', () => {
  it('keeps repository names and drops an owner prefix', () => {
    expect(parseRepositoryList('api, acme/web')).toEqual(['api', 'web'])
  })

  it('means every repository when nothing is named', () => {
    expect(parseRepositoryList(undefined)).toBeUndefined()
    expect(parseRepositoryList(' , ')).toBeUndefined()
  })
})

describe('buildAppManifest', () => {
  it('is a private App without a webhook that asks only for the lease permissions', () => {
    const manifest = buildAppManifest({
      name: 'A name that is far longer than GitHub allows for an App',
      permissions: { contents: 'read' },
      redirectUrl: 'http://127.0.0.1:1/callback',
      setupUrl: 'http://127.0.0.1:1/installed',
    })
    expect(manifest.public).toBe(false)
    expect(manifest.hook_attributes.active).toBe(false)
    expect(manifest.default_events).toEqual([])
    expect(manifest.default_permissions).toEqual({ metadata: 'read', contents: 'read' })
    expect(manifest.name.length).toBeLessThanOrEqual(34)
    expect(defaultAppName('a-very-long-organisation-name-indeed').length).toBeLessThanOrEqual(34)
  })
})

describe('GitHub URLs', () => {
  it('points at the organisation new-App page with the state', () => {
    expect(newAppUrl('acme', 'abc')).toBe(
      'https://github.com/organizations/acme/settings/apps/new?state=abc',
    )
    expect(installUrl('cryptflare-acme')).toBe(
      'https://github.com/apps/cryptflare-acme/installations/new',
    )
  })
})

describe('local pages', () => {
  it('escapes attribute values and text', () => {
    expect(element('p', { title: '"x"' }, '<b>')).toBe('<p title="&quot;x&quot;">&lt;b&gt;</p>')
  })

  it('carries the manifest JSON inside the field value without breaking out of it', () => {
    const page = manifestFormPage(newAppUrl('acme', 's'), { name: '"><script>' })
    expect(page).toContain(
      'action="https://github.com/organizations/acme/settings/apps/new?state=s"',
    )
    expect(page).not.toContain('"><script>')
    expect(page).toContain('&quot;&gt;&lt;script&gt;')
  })
})

describe('missingInstallationPermissions', () => {
  it('lists what the installation holds at a lower level or not at all', () => {
    expect(
      missingInstallationPermissions(
        { contents: 'write', issues: 'read', metadata: 'read' },
        { contents: 'read', metadata: 'read' },
      ),
    ).toEqual(['contents:write', 'issues:read'])
    expect(missingInstallationPermissions({ contents: 'read' }, { contents: 'admin' })).toEqual([])
  })
})
