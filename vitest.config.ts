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
          setupFiles: ['./vitest.setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**', 'packages/react/src/**'],
      exclude: ['**/*.test.*', '**/index.ts', '**/types.ts', '**/*.d.ts'],
      thresholds: {
        // Floors, not aspirations: each is at or just under what the suite reaches
        // today, so coverage cannot quietly fall away again. Three files were enforced
        // before this, which is how `engine.ts` and the whole React package sat at 0%
        // while the build stayed green — and that is exactly where the defects were.
        //
        // The modules where a wrong number is a silent visual bug stay at 100%.
        'packages/core/src/anchor.ts': { branches: 100, functions: 100, lines: 100 },
        'packages/core/src/sizeCache.ts': { branches: 100, functions: 100, lines: 100 },
        'packages/core/src/visibility.ts': { branches: 100, functions: 100, lines: 100 },
        'packages/core/src/listGeometry.ts': { branches: 100, functions: 100, lines: 100 },
        'packages/core/src/surface.ts': { branches: 100, functions: 100, lines: 100 },
        'packages/core/src/store.ts': { branches: 100, functions: 100, lines: 100 },
        'packages/core/src/env.ts': { branches: 100, functions: 100, lines: 100 },

        // The integration layer. Not 100%: what is left is mostly iOS momentum and
        // platform fallbacks that need a real device, and pretending otherwise would
        // mean writing tests that assert the mock rather than the behaviour.
        'packages/core/src/engine.ts': { branches: 80, functions: 91, lines: 90 },
        'packages/core/src/scroller.ts': { branches: 93, functions: 100, lines: 96 },
        'packages/core/src/viewport.ts': { branches: 85, functions: 91, lines: 100 },
        'packages/core/src/resizer.ts': { branches: 95, functions: 100, lines: 100 },
        'packages/core/src/gate.ts': { branches: 88, functions: 100, lines: 100 },
        // The uncovered branch is the production build, which by definition is not
        // this build.
        'packages/core/src/trace.ts': { branches: 70, functions: 100, lines: 100 },

        'packages/react/src/useItemVisibility.ts': {
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'packages/react/src/useVirtualList.ts': { branches: 73, functions: 50, lines: 88 },
        'packages/react/src/VirtualList.tsx': { branches: 85, functions: 80, lines: 98 },
      },
    },
  },
})
