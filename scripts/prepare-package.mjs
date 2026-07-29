#!/usr/bin/env node
/**
 * Put the README and LICENSE inside the package before it is packed.
 *
 * npm renders the *package's* readme, not the repository's, so without this both the npm
 * page and the licence file would be missing from a published tarball — while the manifest
 * claimed MIT. Copied from the repository root rather than duplicated by hand, so there is
 * one source of truth and it cannot drift.
 */
import { copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'packages', 'virtual-anchor')

for (const file of ['README.md', 'LICENSE']) {
  await copyFile(join(root, file), join(target, file))
  console.log(`copied ${file} -> packages/virtual-anchor/${file}`)
}
