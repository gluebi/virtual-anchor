/**
 * The build-time switch for everything in this package that exists to be measured.
 *
 * Substituted by this package's own build — `tsup.config.ts` runs twice, defining the
 * identifier below to `false` for `dist` and `true` for `dist/dev`, and the published
 * `exports` map selects between them with a `development` condition. Consumers who build
 * this package from source set the identifier themselves; consumers who set nothing get
 * the `NODE_ENV` fallback, which is what every build did before this existed.
 *
 * ## Why the fold has to happen here
 *
 * The previous spelling — `export const TRACING = process.env.NODE_ENV !== 'production'`
 * in `trace.ts` — did not eliminate anything, and the reason recorded in that file was the
 * wrong one. It blamed minifiers for not propagating a module-level constant across
 * modules. What actually happens is narrower and more fixable: **esbuild's bundler prints
 * every top-level `const` as `var`**, so the shipped artifact read
 *
 *     var TRACING = process.env.NODE_ENV !== "production";
 *
 * and a `var` is not a constant. esbuild's constant inlining applies to a source-level
 * `const` with a literal initialiser and is part of `minifySyntax`. So the const-ness was
 * being destroyed by *this* package's build, before any consumer's minifier ever saw the
 * file — and no consumer-side configuration could have recovered it. This build is the
 * last place the `const` still exists, which is why this is the only place the decision
 * can be made.
 *
 * Measured, against this repo's esbuild, with `--minify`:
 *
 * | build | guard | topic strings |
 * | --- | --- | --- |
 * | `--define:__VIRTUAL_ANCHOR_DEBUG__=false` | gone | **gone** |
 * | `--define:__VIRTUAL_ANCHOR_DEBUG__=true`  | gone (call inlined) | kept, as intended |
 * | no define at all | kept | kept |
 *
 * The residue this removes was ~2 kB minified, not the "few hundred bytes" the README
 * claimed.
 *
 * ## Why this file is so small
 *
 * It has to be. The value did not inline out of a large module that also holds mutable
 * top-level state — patching the shipped chunk's `var TRACING` to a `const` and
 * re-bundling left every reference and every topic string in place — while the same value
 * imported from a dedicated module folded completely. So the flag cannot live in
 * `trace.ts`, which owns the sink registry, and nothing else may be added here.
 *
 * ## Why an identifier rather than an environment variable
 *
 * A second `process.env.SOMETHING` would be a **runtime `ReferenceError`** in any browser
 * bundle that did not substitute it: Vite replaces only `process.env.NODE_ENV`, and
 * webpack 5 no longer shims `process` at all. An undefined *identifier* behind `typeof` is
 * merely un-folded, never fatal. `import.meta.env.__VIRTUAL_ANCHOR_DEBUG__` is worse than
 * both — Vite-specific, and a `TypeError` elsewhere, because `import.meta.env` is itself
 * `undefined` in a plain Rollup or webpack build.
 */

/**
 * Substituted by this package's build. Declared here rather than in an ambient global
 * `.d.ts` so the identifier is scoped to the one module allowed to read it — a
 * `declare global` would put it in every consumer's type space and collide with anyone who
 * defines a flag of the same name.
 */
declare const __VIRTUAL_ANCHOR_DEBUG__: boolean

/**
 * Whether the instrumentation exists in this build at all.
 *
 * The `: boolean` annotation is load-bearing rather than decorative: without it the
 * inferred type drags `__VIRTUAL_ANCHOR_DEBUG__` into the emitted `.d.ts`, which would
 * export an identifier no consumer can satisfy and fail their typecheck.
 *
 * The `typeof` fallback costs one branch that this suite can never cover — the arm not
 * taken is by definition not this build, the same exemption `trace.ts` has always carried
 * — and it is worth it because `package.json` points `main`, `types` and `exports` at
 * **source**. Every in-repo tool that evaluates this file is therefore a consumer of this
 * flag: both vitest projects, the demo's Vite config in serve *and* build, and both tsup
 * passes. A forgotten `define` on any of them degrades to the behaviour this package has
 * always had, instead of a blank page. It costs nothing in `dist`, because
 * `typeof false === 'undefined'` folds under `minifySyntax` along with everything else.
 */
export const DEBUG: boolean =
  typeof __VIRTUAL_ANCHOR_DEBUG__ === 'undefined'
    ? process.env.NODE_ENV !== 'production'
    : __VIRTUAL_ANCHOR_DEBUG__
