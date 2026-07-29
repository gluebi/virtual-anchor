import { defineConfig } from 'tsup'

/**
 * Two entries, one copy of the core, ESM only.
 *
 * `splitting` is what keeps the React entry from inlining its own copy of the core: without it
 * each entry is bundled standalone, and a consumer importing both would get two instances —
 * two module scopes, so `setTraceSink` called through one would not see the other's events.
 * esbuild only splits ESM, which is one more reason this package is ESM only: the guarantee
 * holds by construction rather than by inspection.
 */
export default defineConfig({
  entry: { index: 'src/index.ts', react: 'src/react/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  target: 'es2022',
  external: ['react', 'react-dom', 'scrollyfills'],
})
