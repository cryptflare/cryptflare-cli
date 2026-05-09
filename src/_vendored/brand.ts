const version = "0.1.0";
const DEV_URLS = {
  website: 'http://localhost:5490',
  app: 'http://localhost:5489',
  api: 'http://localhost:5488',
  docs: 'http://localhost:5491',
  status: 'http://localhost:5492',
  console: 'http://localhost:5496',
  assets: 'http://localhost:5495',
} as const;

const PROD_URLS = {
  website: 'https://cryptflare.com',
  app: 'https://vault.cryptflare.com',
  api: 'https://api.cryptflare.com',
  docs: 'https://docs.cryptflare.com',
  status: 'https://status.cryptflare.com',
  console: 'https://console.cryptflare.com',
  assets: 'https://assets.cryptflare.com',
} as const;

/**
 * Resolves URLs based on the current hostname.
 * Safe to call client-side only. For SSR/static builds, use BRAND.urls (production).
 *
 * Treats `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `.local` and private LAN
 * ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x) as development. Otherwise
 * falls back to production URLs.
 *
 * Uses `globalThis` for the window lookup so this file typechecks under
 * Worker tsconfigs (no DOM lib) without pulling DOM types and without
 * forcing every consumer to widen their libs.
 */
export function resolveUrls() {
  const win = (globalThis as { location?: { hostname?: string } }).location;
  if (!win?.hostname) {
    return PROD_URLS;
  }
  const host = win.hostname;
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.startsWith('192.168.') ||
    host.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    return DEV_URLS;
  }
  return PROD_URLS;
}

export const BRAND = {
  version,
  name: 'CryptFlare',
  tagline: 'Serverless secrets management, built for modern dev teams.',
  description: 'Secrets management platform built for the edge.',

  domain: 'cryptflare.com',
  urls: PROD_URLS,

  support: {
    email: 'support@cryptflare.com',
    security: 'security@cryptflare.com',
    noreply: 'noreply@cryptflare.com',
  },

  email: {
    /** Default `From:` header for transactional + non-support notifications. */
    from: 'CryptFlare <noreply@cryptflare.com>',
    /** `From:` header for replies on support tickets - surfaces the support inbox. */
    supportFrom: 'CryptFlare Support <support@cryptflare.com>',
  },

  socials: {
    github: 'https://github.com/BuunGroupCore/cryptflare-platform',
    x: 'https://x.com/cryptflare',
    discord: 'https://discord.gg/Gxfrv6EKGU',
  },

  legal: {
    company: 'Buun Group',
    privacyUrl: '/legal/privacy',
    termsUrl: '/legal/terms',
    securityUrl: '/legal/security',
    accessibilityUrl: '/legal/accessibility',
    cookiesUrl: '/legal/cookies',
    dpaUrl: '/legal/dpa',
    subprocessorsUrl: '/legal/sub-processors',
    websiteTermsUrl: '/legal/website-terms',
  },

  token: {
    prefix: 'cf_',
    livePrefix: 'cf_live_',
    testPrefix: 'cf_test_',
  },

  turnstile: {
    siteKey: '0x4AAAAAAC7leJ0z19A2rSMz',
  },
} as const;

export type Brand = typeof BRAND;
