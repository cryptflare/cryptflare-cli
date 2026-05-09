import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'es2022',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  treeshake: true,
  noExternal: ['@cryptflare/shared'],
  external: ['@cryptflare/sdk', 'chalk', 'commander', 'conf', 'open', 'ora', 'prompts'],
});
