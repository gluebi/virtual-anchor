import { defineConfig, type Options } from 'tsup'

/**
 * Three entries, one copy of the core, ESM only — built twice.
 *
 * `splitting` is what keeps the React entry from inlining its own copy of the core: without it
 * each entry is bundled standalone, and a consumer importing both would get two instances —
 * two module scopes, so `setTraceSink` called through one would not see the other's events.
 * esbuild only splits ESM, which is one more reason this package is ESM only: the guarantee
 * holds by construction rather than by inspection.
 *
 * ## Why two passes
 *
 * `src/debugFlag.ts` explains why the instrumentation can only be folded out here. The
 * consequence is that a single artifact cannot serve both cases: once the flag is folded to
 * `false` the call sites are gone, so no amount of consumer configuration can bring them
 * back. So the default build has none and `dist/dev` has all of it, and `publishConfig`'s
 * `development` condition chooses. A consumer who wants instrumentation in a *production*
 * build adds one line of resolver config; a consumer who does nothing gets an artifact
 * strictly smaller than the one this package shipped before.
 *
 * Pass order matters twice over: `clean` belongs to the first pass only, or the second
 * deletes the first's output, and `dts` likewise, because the two builds have identical
 * types and `types` sits above `development` in every condition object.
 */
const shared = {
  entry: { index: 'src/index.ts', react: 'src/react/index.ts', debug: 'src/debug/index.ts' },
  format: ['esm'],
  sourcemap: true,
  splitting: true,
  treeshake: true,
  target: 'es2022',
  external: ['react', 'react-dom', 'scrollyfills'],

  /**
   * Required, and measured: esbuild's constant inlining is part of `minifySyntax`.
   *
   * Without it `define` substitutes the flag and then stops — `if (false)` and all sixteen
   * topic strings stay in the artifact, which is the state this package shipped in while
   * claiming otherwise.
   *
   * It costs nothing in readability, also measured: `treeshake` above runs Rollup over each
   * emitted chunk, and Rollup re-prints, so esbuild's `!1` comes back out as `false` and a
   * folded `return !1, x * 2` comes back out as `return x * 2`. The published files stay as
   * legible as they were.
   *
   * Deliberately *not* accompanied by `platform` or `replaceNodeEnv`. tsup defaults
   * `platform` to `node` and gates NODE_ENV substitution on `replaceNodeEnv`, and that is
   * exactly what leaves `process.env.NODE_ENV` intact for the consumer to substitute. Set
   * either one and esbuild freezes it here, which would silently delete the five real
   * development warnings — `sizeCache`'s duplicate-key throw and estimate warning,
   * `resizer`'s two margin warnings, and `useVirtualList`'s render-storm error — for
   * everyone. `scripts/check-package.mjs` counts those five occurrences for that reason.
   */
  esbuildOptions(options) {
    options.minifySyntax = true
  },
} satisfies Options

export default defineConfig([
  {
    ...shared,
    outDir: 'dist',
    clean: true,
    dts: true,
    define: { __VIRTUAL_ANCHOR_DEBUG__: 'false' },
  },
  {
    ...shared,
    outDir: 'dist/dev',
    clean: false,
    dts: false,
    define: { __VIRTUAL_ANCHOR_DEBUG__: 'true' },
  },
])
