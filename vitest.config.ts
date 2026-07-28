import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        // The offset/anchor/visibility maths is pure, so it runs without a DOM.
        test: {
          name: 'node',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts'],
          exclude: ['packages/*/src/**/*.dom.test.ts'],
        },
      },
      {
        // Modules that touch the DOM opt in by filename.
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['packages/*/src/**/*.dom.test.ts', 'packages/*/src/**/*.test.tsx'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**', 'packages/react/src/**'],
      exclude: ['**/*.test.*', '**/index.ts', '**/types.ts'],
      thresholds: {
        // The three modules where a wrong number is a silent visual bug.
        'packages/core/src/sizeCache.ts': { branches: 100, functions: 100, lines: 100 },
        'packages/core/src/anchor.ts': { branches: 100, functions: 100, lines: 100 },
        'packages/core/src/visibility.ts': { branches: 100, functions: 100, lines: 100 },
      },
    },
  },
})
