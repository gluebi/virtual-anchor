import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Two pages, because they demonstrate different things: the thread page is about landing
 * accurately and holding position, and the pagination page is about what happens when the
 * collection is replaced or appended wholesale.
 */
export default defineConfig({
  plugins: [react()],
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
})
