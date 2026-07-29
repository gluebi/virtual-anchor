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
   * The published manifest, typed for the two fields this checks.
   *
   * `JSON.parse` is `any` by definition; naming the shape here is what lets the assertions
   * below be checked rather than merely written.
   *
   * @typedef {{ types?: string, default?: string }} ResolvedExport
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
  check(
    entries['.']?.default === './dist/index.js' &&
      entries['./react']?.default === './dist/react.js',
    'publishConfig rewrote both entries to dist',
  )
  check(
    entries['.']?.types === './dist/index.d.ts' &&
      entries['./react']?.types === './dist/react.d.ts',
    'both entries declare their types',
  )
  // ESM only, deliberately: no `require` condition means one module instance and no
  // dual-package hazard, which matters because the trace sink is module state.
  check(
    !JSON.stringify(entries).includes('require') && !files.some((f) => f.endsWith('.cjs')),
    'ships no CJS, as an ESM-only package should not',
  )
  for (const file of ['dist/index.js', 'dist/react.js', 'dist/index.d.ts', 'dist/react.d.ts']) {
    check(files.includes(file), `ships ${file}`)
  }

  // The React entry must *share* the core, not inline it: two copies would mean two module
  // scopes, so a trace sink installed through one would not see the other's events.
  const reactEntry = readFileSync(join(unpacked, 'dist/react.js'), 'utf8')
  check(
    /from ["']\.\/chunk-/.test(reactEntry),
    'the React entry shares the core through a chunk rather than inlining it',
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
     const missing = ['createEngine', 'SizeCache', 'setTraceSink'].filter((n) => !(n in core))
     const missingReact = ['VirtualList', 'useVirtualList'].filter((n) => !(n in react))
     if (missing.length || missingReact.length) {
       console.error('missing exports', missing, missingReact)
       process.exit(1)
     }
     console.log('imported both entries from an installed tarball')`,
  )
  const probe = execFileSync('node', ['probe.mjs'], { cwd: consumer, encoding: 'utf8' })
  check(probe.includes('imported both entries'), 'a consumer can import both entries')

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
