import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  target: 'node16',
  splitting: true,
  sourcemap: true,
  minify: false,
  clean: true,
  skipNodeModulesBundle: true,
  dts: true,
  external: ['node_modules'],
}));
