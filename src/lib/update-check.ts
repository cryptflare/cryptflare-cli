import chalk from 'chalk';

const PACKAGE_NAME = '@cryptflare/cli';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const STORAGE_KEY = 'lastUpdateCheck';

type NpmRegistryResponse = {
  'dist-tags': { latest: string };
};

/** Checks npm for a newer version. Shows a message if one is available. Non-blocking. */
export async function checkForUpdate(currentVersion: string, config: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): Promise<void> {
  if (currentVersion === '0.0.0') return; // dev mode
  if (process.env.CF_NO_UPDATE_CHECK) return;

  try {
    const lastCheck = config.get(STORAGE_KEY) as number | undefined;
    if (lastCheck && Date.now() - lastCheck < CHECK_INTERVAL_MS) return;

    config.set(STORAGE_KEY, Date.now());

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}`, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
    });
    clearTimeout(timeout);

    if (!res.ok) return;

    const data = await res.json() as NpmRegistryResponse;
    const latest = data['dist-tags']?.latest;
    if (!latest || latest === currentVersion) return;

    console.log();
    console.log(
      chalk.yellow(`  Update available: ${chalk.dim(currentVersion)} → ${chalk.bold(latest)}`),
    );
    console.log(
      chalk.dim(`  Run ${chalk.bold(`npm i -g ${PACKAGE_NAME}`)} to update`),
    );
    console.log();
  } catch {
    // Silently ignore - network may be unavailable
  }
}
