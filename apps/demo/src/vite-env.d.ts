/**
 * The library's build-time instrumentation flag, substituted by `vite.config.ts`.
 *
 * Declared here because the demo consumes `virtual-anchor` as source through the workspace
 * link, so TypeScript checks the library's own files as part of this project and needs to know
 * the identifier exists. The package's published `.d.ts` deliberately does not declare it —
 * see `packages/virtual-anchor/src/debugFlag.ts` for why leaking it into a consumer's type
 * space would be wrong.
 */
declare const __VIRTUAL_ANCHOR_DEBUG__: boolean
