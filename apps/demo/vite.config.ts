import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Two pages, because they demonstrate different things: the thread page is about landing
 * accurately and holding position, and the pagination page is about what happens when the
 * collection is replaced or appended wholesale.
 */
export default defineConfig(({ command }) => {
  /**
   * Whether the library is built with its instrumentation.
   *
   * The demo consumes `virtual-anchor` as **TypeScript source** through the workspace link, so
   * it never sees the package's `exports` map and the `development` condition does not apply
   * here. The `define` is the mechanism instead, and it is the same identifier the package's own
   * build substitutes.
   *
   * On for `vite dev`, because that is what a dev server is for. On for a *build* only when
   * asked, and the asking is the point: `vite build` leaves `NODE_ENV` at `production`, so React
   * is the production build and `StrictMode`'s double invoke is gone — and that double invoke is
   * itself a source of jank, which makes it a confound when the thing being measured is scroll
   * smoothness. Being able to have a production app and an instrumented library at once is the
   * whole reason this flag is separate from `NODE_ENV`.
   *
   * `pnpm --filter demo build:trace` is the instrumented build; plain `build` is not, so the
   * default `preview` keeps serving a bundle with the tracing compiled out.
   */
  const instrumented = command === 'serve' || process.env.VA_TRACE === '1'

  return {
    plugins: [react()],
    define: { __VIRTUAL_ANCHOR_DEBUG__: JSON.stringify(instrumented) },
    server: { port: 5173 },
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: resolve(import.meta.dirname, 'index.html'),
          pagination: resolve(import.meta.dirname, 'pagination.html'),
        },
      },
    },
  }
})
