import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCaptureMode, readCaptureMode } from './capture.js';
import { MANIFEST_FILENAME, parseManifest, renderManifest } from './project-manifest.js';
import { loadManifestCapture, resolveCapture } from './sync-capture.js';
import { parseRegistry } from './sync-registry.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-capture-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeManifestFile(body: unknown): void {
  writeFileSync(join(dir, MANIFEST_FILENAME), typeof body === 'string' ? body : JSON.stringify(body));
}

describe('readCaptureMode', () => {
  it('accepts every known mode', () => {
    expect(['off', 'prompt', 'auto'].every(isCaptureMode)).toBe(true);
  });

  it('returns undefined when the field is absent', () => {
    expect(readCaptureMode(undefined, 'capture')).toBeUndefined();
  });

  it('rejects an unknown mode and names the field', () => {
    expect(() => readCaptureMode('always', 'bindings[0].capture')).toThrow(/bindings\[0\]\.capture/);
  });
});

describe('manifest capture', () => {
  it('applies the manifest default to bindings without their own', () => {
    const manifest = parseManifest({
      version: 1,
      workspace: 'api',
      capture: 'auto',
      bindings: [
        { file: '.env', environment: 'dev' },
        { file: '.env.production', environment: 'production', capture: 'off' },
      ],
    });

    expect(manifest.bindings.map((b) => b.capture)).toEqual(['auto', 'off']);
  });

  it('leaves capture unset when nothing declares it', () => {
    const manifest = parseManifest({
      version: 1,
      workspace: 'api',
      bindings: [{ file: '.env', environment: 'dev' }],
    });

    expect(manifest.bindings[0]?.capture).toBeUndefined();
  });

  it('rejects an unknown mode', () => {
    expect(() => parseManifest({
      version: 1,
      workspace: 'api',
      bindings: [{ file: '.env', environment: 'dev', capture: 'yes' }],
    })).toThrow(/capture/);
  });

  it('round-trips through render, writing only what differs from the default', () => {
    const manifest = parseManifest({
      version: 1,
      workspace: 'api',
      capture: 'auto',
      bindings: [
        { file: '.env', environment: 'dev' },
        { file: '.env.production', environment: 'production', capture: 'prompt' },
      ],
    });
    const rendered = JSON.parse(renderManifest(manifest)) as { capture: string; bindings: Array<{ capture?: string }> };

    expect(rendered.capture).toBe('auto');
    expect(rendered.bindings.map((b) => b.capture)).toEqual([undefined, 'prompt']);
    expect(parseManifest(rendered).bindings.map((b) => b.capture)).toEqual(['auto', 'prompt']);
  });
});

describe('registry capture', () => {
  it('keeps a per-binding override', () => {
    const registry = parseRegistry({
      version: 1,
      projects: [{
        id: 'proj',
        path: dir,
        workspace: 'api',
        bindings: [{ file: '.env', environment: 'dev', capture: 'auto' }],
      }],
    });

    expect(registry.projects[0]?.bindings[0]?.capture).toBe('auto');
  });

  it('rejects an unknown mode on load', () => {
    expect(() => parseRegistry({
      version: 1,
      projects: [{
        id: 'proj',
        path: dir,
        workspace: 'api',
        bindings: [{ file: '.env', environment: 'dev', capture: 'sometimes' }],
      }],
    })).toThrow(/capture/);
  });
});

describe('resolveCapture', () => {
  const binding = { file: '.env', environment: 'dev' };

  it('is off when neither the registry nor the manifest says otherwise', () => {
    expect(resolveCapture(binding, loadManifestCapture({ path: dir }))).toBe('off');
  });

  it('follows the committed manifest without re-running init', () => {
    writeManifestFile({ version: 1, workspace: 'api', bindings: [{ ...binding, capture: 'auto' }] });
    expect(resolveCapture(binding, loadManifestCapture({ path: dir }))).toBe('auto');
  });

  it('lets a machine-local registry value override the manifest', () => {
    writeManifestFile({ version: 1, workspace: 'api', bindings: [{ ...binding, capture: 'auto' }] });
    expect(resolveCapture({ ...binding, capture: 'off' }, loadManifestCapture({ path: dir }))).toBe('off');
  });

  it('falls back to off when the manifest cannot be read', () => {
    writeManifestFile('{ not json');
    expect(resolveCapture(binding, loadManifestCapture({ path: dir }))).toBe('off');
  });
});
