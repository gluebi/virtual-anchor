#!/usr/bin/env node
/**
 * Verify the tarball that would actually be published.
 *
 * Packaging is configuration, and configuration is exactly the kind of thing this project
 * has repeatedly found to be confidently wrong: `publishConfig` rewrites the entry points,
 * `files` decides what ships, and a subpath export that resolves in the workspace can still
 * fail for a consumer. So this packs the real thing, unpacks it, and imports both entries the
 * way a consumer would.
 *
 * It also hands that same tarball to `publint` and `are-the-types-wrong`, rather than letting
 * them pack it themselves: both shell out to `npm pack`, which does not apply pnpm's
 * `publishConfig` — so they would inspect a manifest whose entry points still refer to
 * TypeScript source and report every resolution as broken.
 *
 * Run with `pnpm check:package`.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = join(root, 'packages', 'virtual-anchor')
const failures = []
const check = (ok, description) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${description}`)
  if (!ok) failures.push(description)
}

// pnpm applies `publishConfig` when it packs, which is the whole point of packing rather
// than reading package.json.
const work = mkdtempSync(join(tmpdir(), 'virtual-anchor-pack-'))
try {
  execFileSync('pnpm', ['pack', '--pack-destination', work], { cwd: packageDir, stdio: 'pipe' })
  const tarball = execFileSync('ls', [work], { encoding: 'utf8' }).trim().split('\n')[0]
  execFileSync('tar', ['-xzf', join(work, tarball), '-C', work])
  const unpacked = join(work, 'package')

  /**
   * The published manifest, typed for the fields this checks.
   *
   * `JSON.parse` is `any` by definition; naming the shape here is what lets the assertions
   * below be checked rather than merely written.
   *
   * @typedef {{ types?: string, development?: string, default?: string }} ResolvedExport
   * @typedef {{ exports?: Record<string, ResolvedExport> }} PublishedManifest
   * @type {PublishedManifest}
   */
  const manifest = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8'))
  const files = execFileSync('find', [unpacked, '-type', 'f'], { encoding: 'utf8' })
    .split('\n')
    .map((path) => path.replace(`${unpacked}/`, ''))

  check(files.includes('README.md'), 'ships a README, which is what npm renders as the page')
  check(files.includes('LICENSE'), 'ships the LICENSE the manifest claims')
  check(!files.some((f) => f.startsWith('src/')), 'ships no source, only dist')

  const entries = manifest.exports ?? {}

  /**
   * The export map's rules, checked per subpath rather than by naming each one.
   *
   * This was three `&&` triples plus two more lists that each spelled out `.`, `./react` and
   * `./debug` — five places a fourth subpath would have to be remembered in. Expressed as a loop it
   * is shorter *and* it cannot be half-updated, which matters because "the map cannot be
   * half-switched into two module instances" is the stated reason this is a condition rather than an
   * alias.
   */
  const subpaths = Object.entries(entries)
  check(subpaths.length > 0, 'publishConfig produced an export map')
  for (const [subpath, entry] of subpaths) {
    const name = subpath === '.' ? 'index' : subpath.replace('./', '')
    check(entry.default === `./dist/${name}.js`, `${subpath} resolves to dist/${name}.js`)
    check(entry.types === `./dist/${name}.d.ts`, `${subpath} declares its types`)
    // Every subpath must offer the instrumented build, or a consumer who resolves the condition
    // gets a graph with some entries instrumented and some not — two module instances, and a
    // listener installed through one that never sees the other's events.
    check(
      entry.development === `./dist/dev/${name}.js`,
      `${subpath} offers the development condition`,
    )
    // `types` first. TypeScript takes the first match, and `dist/dev` ships no declarations.
    check(Object.keys(entry)[0] === 'types', `${subpath} lists types first`)
    for (const file of [`dist/${name}.js`, `dist/${name}.d.ts`, `dist/dev/${name}.js`]) {
      check(files.includes(file), `ships ${file}`)
    }
  }

  // ESM only, deliberately: no `require` condition means one module instance and no
  // dual-package hazard, which matters because the trace sink is module state.
  check(
    !JSON.stringify(entries).includes('require') && !files.some((f) => f.endsWith('.cjs')),
    'ships no CJS, as an ESM-only package should not',
  )
  /**
   * Every entry must reach the *same* trace sink, not its own copy.
   *
   * This is the invariant ESM-only exists to protect: the sink is module state, so two copies
   * mean two scopes and a listener installed through one silently never sees the other's
   * events. What it is *not* is "one chunk for everything" — esbuild splits the core in two,
   * and rightly: the debug entry needs the sink module and not the engine, which is why it is
   * 5 kB rather than 80. So the assertion is that the intersection is non-empty and that the
   * shared piece is the one holding the sink, identified by what it exports rather than by a
   * hash that changes every build.
   */
  /**
   * The chunk filenames one entry imports.
   *
   * @param {string} entry
   * @returns {Set<string>}
   */
  const chunksOf = (entry) => {
    const source = readFileSync(join(unpacked, entry), 'utf8')
    const found = [...source.matchAll(/from ["']\.\/(chunk-[^"']+)["']/g)]
    return new Set(found.map((match) => String(match[1])))
  }
  const coreChunks = chunksOf('dist/index.js')
  const reactChunks = chunksOf('dist/react.js')
  const debugChunks = chunksOf('dist/debug.js')
  const shared = [...coreChunks].filter((chunk) => reactChunks.has(chunk) && debugChunks.has(chunk))
  const sinkChunk = shared.find((chunk) =>
    readFileSync(join(unpacked, 'dist', chunk), 'utf8').includes('setTraceSink'),
  )
  check(
    sinkChunk !== undefined,
    `all three entries share the one module holding the trace sink (${String(sinkChunk)})`,
  )
  // And the two entries that do carry the engine must share that too, or a consumer importing
  // both ships it twice.
  const coreChunk = [...coreChunks].find(
    (chunk) => reactChunks.has(chunk) && chunk !== sinkChunk,
  )
  check(
    coreChunk !== undefined,
    `the core and React entries share the engine chunk (${String(coreChunk)})`,
  )

  /**
   * The zero-cost claim, enforced rather than asserted.
   *
   * Every trace topic is a quoted string literal, which makes them the ideal probe: unique,
   * human-readable, and impossible to keep if the guards around them are gone. This package
   * spent two releases claiming the instrumentation was inert while ~2 kB of it shipped, so the
   * claim is now a build failure rather than a sentence in a README.
   *
   * Scoped to what a consumer actually ships — the core, the React adapter and the shared chunk.
   * `dist/debug.js` is excluded deliberately: it is opt-in by import, so nobody who has not
   * asked for it pays for its strings.
   */
  /**
   * The topic prefixes, derived from the one place that declares them.
   *
   * A hand-maintained alternation here was a duplicate of `keyof TracePayloads`, which meant a topic
   * with a new prefix — `env.`, `input.` — would sit silently outside the check that is the *entire*
   * enforcement of the "genuinely absent" claim. Read from the source instead, so adding a topic
   * extends the check by itself.
   */
  const topicSource = readFileSync(join(root, 'packages/virtual-anchor/src/traceTopics.ts'), 'utf8')
  const declared = [...topicSource.matchAll(/^\s+'([a-z]+\.[a-zA-Z]+)':/gm)].map((m) => String(m[1]))
  check(declared.length > 15, `read ${String(declared.length)} topics from traceTopics.ts`)

  // Quoted, in any of the three styles. This package's own `dist` is unminified and uses double
  // quotes, but a consumer's minifier is free to re-quote — the demo's Rolldown build emits these
  // as template literals — and a probe that recognised only one form would pass by failing to look.
  // The quotes are required rather than optional, because several topics are also real member
  // expressions in this codebase (`gate.attach()`, `item.key`) and an unquoted match reports those.
  const TOPIC = new RegExp(`['"\`](?:${declared.join('|').replaceAll('.', '\\.')})['"\`]`, 'g')

  /**
   * Everything a consumer ships, rather than one chunk guessed by name.
   *
   * `coreChunk` above is "the first shared chunk that isn't the sink chunk"; if esbuild ever emits
   * two shared chunks, a leak into the unscanned one would pass. Derived from `files` instead, so
   * the scan covers whatever the build actually produced. `dist/debug.js` and its chunks are
   * excluded deliberately: the toolkit is opt-in by import, so nobody who has not asked for it pays
   * for its strings.
   */
  const debugOnly = new Set([...debugChunks].filter((chunk) => !coreChunks.has(chunk) && !reactChunks.has(chunk)))
  const shippedFiles = files.filter(
    (file) =>
      file.startsWith('dist/') &&
      file.endsWith('.js') &&
      !file.startsWith('dist/dev/') &&
      file !== 'dist/debug.js' &&
      !debugOnly.has(file.replace('dist/', '')),
  )
  const shipped = shippedFiles.map((file) => readFileSync(join(unpacked, file), 'utf8')).join('\n')
  const leaked = [...new Set(shipped.match(TOPIC) ?? [])]
  check(
    leaked.length === 0,
    `the default build ships no trace topics, across ${String(shippedFiles.length)} file(s)` +
      (leaked.length > 0 ? ` (found ${leaked.join(', ')})` : ''),
  )

  // And the instrumented build must still have them, or the condition resolves to something
  // that cannot diagnose anything and the whole second build is dead weight.
  const instrumented = files
    .filter((file) => file.startsWith('dist/dev/') && file.endsWith('.js'))
    .map((file) => readFileSync(join(unpacked, file), 'utf8'))
    .join('\n')
  check(
    (instrumented.match(TOPIC) ?? []).length > 0,
    'the development build does ship trace topics',
  )

  // The build-time flag must never reach a consumer as a free identifier: unresolved, it would
  // be a ReferenceError on the first scroll.
  check(
    !shipped.includes('__VIRTUAL_ANCHOR_DEBUG__') && !instrumented.includes('__VIRTUAL_ANCHOR_DEBUG__'),
    'neither build ships the unresolved debug identifier',
  )

  /**
   * The five real development warnings must survive.
   *
   * They are guarded by `process.env.NODE_ENV`, which the consumer's bundler substitutes — and
   * `minifySyntax` in `tsup.config.ts` is one option away from freezing it here instead, which
   * would silently delete all five for everyone. Four live in the core chunk (the size cache's
   * duplicate-key throw and estimate warning, the resizer's two margin warnings) and one in the
   * React entry (the render-storm error).
   */
  /** @param {string} source @returns {number} */
  const guards = (source) => (source.match(/process\.env\.NODE_ENV/g) ?? []).length
  // At least one in each, rather than "exactly four and exactly one". The invariant is that
  // NODE_ENV was *not* frozen at build time; the exact count and its distribution across chunks are
  // artefacts of how esbuild happened to split, and pinning them would fail a sixth dev warning
  // with a message about freezing that was not what happened.
  check(
    guards(shipped) > 0 && guards(readFileSync(join(unpacked, 'dist/react.js'), 'utf8')) > 0,
    'the development warnings are still keyed to NODE_ENV, not frozen at build time',
  )

  // And it resolves the way a consumer resolves it: a real install, real imports.
  const consumer = join(work, 'consumer')
  await mkdir(consumer, { recursive: true })
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
  )
  // React alongside it, because the adapter entry needs the peer a real consumer would have —
  // and because installing *without* it is the other thing worth knowing works.
  execFileSync(
    'npm',
    ['install', '--silent', '--no-audit', '--no-fund', join(work, tarball), 'react', 'react-dom'],
    { cwd: consumer, stdio: 'pipe' },
  )

  writeFileSync(
    join(consumer, 'probe.mjs'),
    `import * as core from 'virtual-anchor'
     import * as react from 'virtual-anchor/react'
     import * as debug from 'virtual-anchor/debug'
     const missing = ['createEngine', 'SizeCache', 'setTraceSink', 'addTraceListener'].filter((n) => !(n in core))
     const missingReact = ['VirtualList', 'useVirtualList'].filter((n) => !(n in react))
     const missingDebug = ['installDebug', 'analyzeGestures', 'createTraceRecorder'].filter((n) => !(n in debug))
     if (missing.length || missingReact.length || missingDebug.length) {
       console.error('missing exports', missing, missingReact, missingDebug)
       process.exit(1)
     }
     // Node resolves neither \`development\` nor \`production\` unless asked, so this is the
     // default path — the one a consumer who configures nothing gets, and it must be the
     // stripped build.
     if (core.TRACING !== false) {
       console.error('the default resolution is instrumented; it should be the stripped build')
       process.exit(1)
     }
     console.log('imported all three entries from an installed tarball')`,
  )
  const probe = execFileSync('node', ['probe.mjs'], { cwd: consumer, encoding: 'utf8' })
  check(probe.includes('imported all three entries'), 'a consumer can import all three entries')

  /**
   * And the `development` condition really does resolve the other build.
   *
   * Run with `--conditions=development`, which is how Node opts into a custom condition and
   * what a bundler's `resolve.conditions` does in spirit. Without this the second build could
   * be entirely unreachable and every other check here would still pass.
   */
  writeFileSync(
    join(consumer, 'probe-dev.mjs'),
    `import { TRACING, setTraceSink } from 'virtual-anchor'
     if (TRACING !== true) {
       console.error('the development condition did not resolve the instrumented build')
       process.exit(1)
     }
     if (setTraceSink(() => {}) !== true) {
       console.error('the instrumented build refused to install a sink')
       process.exit(1)
     }
     console.log('the development condition resolves the instrumented build')`,
  )
  const devProbe = execFileSync('node', ['--conditions=development', 'probe-dev.mjs'], {
    cwd: consumer,
    encoding: 'utf8',
  })
  check(
    devProbe.includes('resolves the instrumented build'),
    'the development condition reaches dist/dev and tracing works there',
  )

  // The core entry on its own must not reach for React: that is what makes the peer optional
  // rather than a lie, and it is the claim a non-React consumer relies on.
  const coreOnly = join(work, 'core-only')
  await mkdir(coreOnly, { recursive: true })
  writeFileSync(
    join(coreOnly, 'package.json'),
    JSON.stringify({ name: 'core-only', private: true, type: 'module' }),
  )
  execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', join(work, tarball)], {
    cwd: coreOnly,
    stdio: 'pipe',
  })
  writeFileSync(
    join(coreOnly, 'probe.mjs'),
    `import { createEngine } from 'virtual-anchor'
     if (typeof createEngine !== 'function') process.exit(1)
     console.log('core entry works with no framework installed')`,
  )
  const coreProbe = execFileSync('node', ['probe.mjs'], { cwd: coreOnly, encoding: 'utf8' })
  check(
    coreProbe.includes('no framework installed'),
    'the core entry works with React absent entirely',
  )

  // The two external validators, against the same tarball.
  /** @param {string} name */
  const bin = (name) => join(packageDir, 'node_modules', '.bin', name)

  /**
   * @param {string} command
   * @param {readonly string[]} args
   */
  const run = (command, args) => {
    try {
      return { ok: true, output: execFileSync(command, args, { encoding: 'utf8' }) }
    } catch (error) {
      const failure = /** @type {{ stdout?: string, stderr?: string }} */ (error)
      return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
    }
  }

  const publint = run(bin('publint'), [join(work, tarball), '--strict'])
  check(publint.ok, 'publint reports no problems')
  if (!publint.ok) console.error(publint.output)

  // `cjs-resolves-to-esm` is not a defect here: it is the definition of an ESM-only package,
  // and the README says so where a consumer will read it.
  const types = run(bin('attw'), [join(work, tarball), '--ignore-rules', 'cjs-resolves-to-esm'])
  check(types.ok, 'types resolve for node10, node16 and bundlers')
  if (!types.ok) console.error(types.output)
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} packaging problem(s)`)
  process.exit(1)
}
console.log('\npackage is publishable')
