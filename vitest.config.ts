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
      include: ['packages/virtual-anchor/src/**'],
      exclude: ['**/*.test.*', '**/index.ts', '**/types.ts', '**/*.d.ts'],
      thresholds: {
        // Floors, not aspirations: each is at or just under what the suite reaches today, so
        // coverage cannot quietly fall away again. Three files were enforced before this,
        // which is how the integration layer and the whole React adapter sat at 0% while the
        // build stayed green — and that is exactly where the defects were.
        //
        // Recalibrated for @vitest/coverage-v8 4.x, whose branch attribution is more accurate
        // than 3.x's. Not one line of library code changed in that upgrade and all 382 tests
        // still pass, so nothing was lost — but it does mean the 100% *branch* figures three
        // of these files used to report were optimistic. The uncovered branches are recorded
        // beside each one rather than rounded away.
        'packages/virtual-anchor/src/anchor.ts': { branches: 100, functions: 100, lines: 100 },
        'packages/virtual-anchor/src/listGeometry.ts': { branches: 100, functions: 100, lines: 100 },
        'packages/virtual-anchor/src/store.ts': { branches: 100, functions: 100, lines: 100 },
        'packages/virtual-anchor/src/env.ts': { branches: 100, functions: 100, lines: 100 },

        // Fully covered by line, with a handful of branch points left: the size cache's
        // clamping edges and the surface's null-container guard.
        'packages/virtual-anchor/src/sizeCache.ts': { branches: 96, functions: 100, lines: 100 },
        'packages/virtual-anchor/src/surface.ts': { branches: 95, functions: 100, lines: 100 },

        // The tracker is now whole. Its last two gaps were a `flushLeaves` corner reached only
        // after `pauseDwell` had banked the clock, which is a test, and an `adoptSilently` guard
        // on the leave path that nothing could take, which is now gone: a leave needs a prior
        // sample, and that guard is only ever true on the first one.
        'packages/virtual-anchor/src/visibility.ts': { branches: 100, functions: 100, lines: 100 },

        // The integration layer. What is left is mostly iOS momentum and platform fallbacks
        // that need a real device, and pretending otherwise would mean writing tests that
        // assert the mock rather than the behaviour.
        //
        // Raised with the measured slots, which arrived covered: leaving the floors where
        // they were would have banked the gain as slack a later change could spend without
        // anyone noticing, which is the exact failure this table exists to prevent.
        'packages/virtual-anchor/src/engine.ts': { branches: 81, functions: 83, lines: 95 },
        'packages/virtual-anchor/src/scroller.ts': { branches: 88, functions: 94, lines: 97 },
        // Both scroller kinds now answer for their scrollport as well as their measurement
        // scope, and the quirks-mode path is exercised — so this is no longer the file with the
        // thinnest coverage in the integration layer.
        'packages/virtual-anchor/src/viewport.ts': { branches: 70, functions: 96, lines: 100 },
        'packages/virtual-anchor/src/resizer.ts': { branches: 92, functions: 100, lines: 100 },
        'packages/virtual-anchor/src/gate.ts': { branches: 78, functions: 100, lines: 100 },
        // The uncovered branch is the production build, which by definition is not this build.
        'packages/virtual-anchor/src/trace.ts': { branches: 80, functions: 100, lines: 100 },

        // The whole React adapter, with nothing left over.
        'packages/virtual-anchor/src/react/useItemVisibility.ts': { branches: 100, functions: 100, lines: 100 },
        'packages/virtual-anchor/src/react/useVirtualList.ts': { branches: 100, functions: 100, lines: 100 },
        'packages/virtual-anchor/src/react/VirtualList.tsx': { branches: 100, functions: 100, lines: 100 },
      },
    },
  },
})
