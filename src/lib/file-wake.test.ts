import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { watchFiles, type FileWake } from './file-wake.js';

const DEBOUNCE_MS = 60;
/** Long enough for a filesystem event plus the debounce, short enough to keep the suite quick. */
const SETTLE_MS = 1500;

let dir: string;
let wake: FileWake | undefined;

/** Resolves `true` if the wake fires within the window, `false` if it stays quiet. */
function fires(target: FileWake, within = SETTLE_MS): Promise<boolean> {
  return Promise.race([
    target.next().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), within)),
  ]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-wake-'));
});

afterEach(() => {
  wake?.close();
  wake = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('watchFiles', () => {
  it('wakes when a watched file is written', async () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'A=1\n');
    wake = watchFiles([file], DEBOUNCE_MS);

    const fired = fires(wake);
    writeFileSync(file, 'A=2\n');

    expect(await fired).toBe(true);
  });

  it('wakes when a file is replaced by rename, the way editors save', async () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'A=1\n');
    wake = watchFiles([file], DEBOUNCE_MS);

    const fired = fires(wake);
    writeFileSync(join(dir, '.env.tmp'), 'A=2\n');
    renameSync(join(dir, '.env.tmp'), file);

    expect(await fired).toBe(true);
  });

  it('wakes when a watched file is created after watching began', async () => {
    const file = join(dir, '.env');
    wake = watchFiles([file], DEBOUNCE_MS);

    const fired = fires(wake);
    writeFileSync(file, 'A=1\n');

    expect(await fired).toBe(true);
  });

  it('stays quiet for other files in the same directory', async () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'A=1\n');
    wake = watchFiles([file], DEBOUNCE_MS);

    const fired = fires(wake, 500);
    writeFileSync(join(dir, 'README.md'), 'unrelated\n');

    expect(await fired).toBe(false);
  });

  it('collapses a burst of writes into one wake', async () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'A=1\n');
    wake = watchFiles([file], DEBOUNCE_MS);

    let count = 0;
    void wake.next().then(() => { count += 1; });
    for (let i = 0; i < 5; i += 1) writeFileSync(file, `A=${i}\n`);
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(count).toBe(1);
  });

  it('does not lose a change made while nobody was waiting', async () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'A=1\n');
    wake = watchFiles([file], DEBOUNCE_MS);

    // The loop is busy with a pass: the edit lands with no waiter registered.
    writeFileSync(file, 'A=2\n');
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(await fires(wake, 200)).toBe(true);
  });

  it('reports a missed change once, then waits for the next real one', async () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'A=1\n');
    wake = watchFiles([file], DEBOUNCE_MS);
    writeFileSync(file, 'A=2\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await wake.next();

    expect(await fires(wake, 400)).toBe(false);
  });

  it('watches one directory once, however many files in it are bound', () => {
    mkdirSync(join(dir, 'apps'));
    wake = watchFiles([join(dir, '.env'), join(dir, '.env.local'), join(dir, 'apps', '.env')], DEBOUNCE_MS);
    expect(wake.watching).toBe(2);
  });

  it('carries on, watching nothing, when a directory does not exist', () => {
    wake = watchFiles([join(dir, 'missing', '.env')], DEBOUNCE_MS);
    expect(wake.watching).toBe(0);
  });

  it('does not wake after it is closed', async () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'A=1\n');
    wake = watchFiles([file], DEBOUNCE_MS);
    const fired = fires(wake, 500);
    wake.close();
    writeFileSync(file, 'A=2\n');

    expect(await fired).toBe(false);
  });

  it('wakes for a new file in a watched directory when its name passes the test', async () => {
    writeFileSync(join(dir, '.env'), 'A=1\n');
    wake = watchFiles([join(dir, '.env')], DEBOUNCE_MS, [{ directory: dir, matches: (name) => name.startsWith('.env') }]);

    const fired = fires(wake);
    writeFileSync(join(dir, '.env.production'), 'B=2\n');

    expect(await fired).toBe(true);
  });

  it('still ignores other new files in that directory', async () => {
    wake = watchFiles([], DEBOUNCE_MS, [{ directory: dir, matches: (name) => name.startsWith('.env') }]);
    expect(wake.watching).toBe(1);

    const fired = fires(wake, 500);
    writeFileSync(join(dir, 'README.md'), 'unrelated\n');

    expect(await fired).toBe(false);
  });
});
