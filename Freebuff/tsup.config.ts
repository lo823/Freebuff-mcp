import { defineConfig } from 'tsup';

/**
 * Bundles the TypeScript/Ink source into a single ESM file run by Node.
 *
 * - `platform: node` + `target: node20` keeps the output compatible with the
 *   Node.js LTS build shipped by Termux.
 * - Ink/React stay external so React has exactly one instance at runtime
 *   (a duplicated React copy is the classic cause of "invalid hook call").
 */
export default defineConfig({
  entry: { index: 'src/index.tsx' },
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  bundle: true,
  splitting: false,
  clean: true,
  sourcemap: true,
  minify: false,
  shims: false,
  treeshake: true,
  external: [
    'ink',
    'ink-gradient',
    'ink-select-input',
    'ink-spinner',
    'ink-text-input',
    'react',
    'chalk',
    'gradient-string',
    'zod',
  ],
  banner: {
    // Harmless when launched through `node dist/index.js`, useful if the file
    // is ever executed directly.
    js: '#!/usr/bin/env node',
  },
  esbuildOptions(options) {
    options.logLevel = 'warning';
    options.legalComments = 'none';
  },
});
