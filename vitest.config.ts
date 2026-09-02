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
      // `traceTopics.ts` joins `types.ts` here for the same reason: it is declarations only
      // and emits no code, so a threshold on it would measure nothing and a missing
      // threshold would look like an oversight.
      exclude: [
        '**/*.test.*',
        '**/index.ts',
        '**/types.ts',
        '**/traceTopics.ts',
        '**/*.d.ts',
      ],
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
        'packages/virtual-anchor/src/surface.ts': { branches: 96, functions: 100, lines: 100 },

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
        // The branch floor went 85 → 84 when the inset composition moved to
        // `listGeometry.ts`. Nothing became less tested — the `?? 0` branches that
        // left were all covered, and they are covered there now (that file is held
        // at 100). Moving covered code out of a file lowers its ratio.
        //
        // Raised again with the momentum write gate (#26), which arrived with the first
        // engine-level iOS tests this suite has ever had — the absence of which is why
        // `publish` was able to write `scrollTop` past the guard for two releases.
        // Raised with the instrumentation work, which arrived with engine-level tests for every
        // value of `scroll.write`'s new `reason`, for the fold, and for the paint offset.
        // Lines 98 → 96, functions 93 → 91, branches 86 → 83, and the difference is
        // `hasPendingMeasurement` and the row bound on the default buffer. Both are exercised
        // end-to-end rather than by unit tests, and deliberately: the predicate's whole subject
        // is the moment a real surface has mounted a row and a real `ResizeObserver` has not yet
        // reported it, which a fake surface cannot stage without asserting the staging instead of
        // the behaviour. What proves it is `matrix.spec.ts` in the pinned Playwright image — three
        // failures before, five passes after, byte-identical across runs. Recorded here rather
        // than met with a test that would only restate the mock.
        //
        // Raised with `onLanded` (#115): branches 83 → 87, functions 91 → 93, lines 96 → 98. The
        // callback's own body is one line, and the rest of the gain is the three anchoring cases
        // it arrived with reaching code the suite had only ever entered from the scroll handler —
        // the restore branch after a programmatic landing, which is the window the defect lived
        // in. Banking that as slack is what this table exists to prevent.
        'packages/virtual-anchor/src/engine.ts': { branches: 87, functions: 93, lines: 98 },
        // Functions to 100 with the scroller's own writes finally being traced: `scroll.commit`,
        // `flush`, `park` and `wake` had no tests because they emitted nothing to test.
        //
        // Branches 91 → 90, and the difference is the four new `if (DEBUG)` guards. Their false
        // arm is "this is a build without instrumentation", which by definition is not this build
        // — the same exemption `trace.ts` has always carried, now for four more guards. Nothing
        // became less tested; the denominator grew.
        'packages/virtual-anchor/src/scroller.ts': { branches: 90, functions: 100, lines: 98 },
        // The gate, whole but for two production-build trace calls: the transition narration and
        // `gate.attach`. Both are covered when a listener is installed — `momentum.dom.test.ts`
        // asserts on both, including the off-iOS case — so what is uncovered is only the arm where
        // the guard is compiled out.
        'packages/virtual-anchor/src/momentum.ts': { branches: 93, functions: 100, lines: 100 },
        // Both settle paths, including the debounce fallback that bounds a fling on any
        // Safari without `scrollend`. Whole, so held at whole.
        'packages/virtual-anchor/src/settle.ts': { branches: 100, functions: 100, lines: 100 },
        // Both scroller kinds now answer for their scrollport as well as their measurement
        // scope, and the quirks-mode path is exercised — so this is no longer the file with the
        // thinnest coverage in the integration layer. Branches went 70 to 85 with #34: the
        // resize dedup is four branches on its own, and the `contentRect` fallback for an
        // absent `borderBoxSize` had none of them exercised before.
        'packages/virtual-anchor/src/viewport.ts': { branches: 85, functions: 96, lines: 100 },
        'packages/virtual-anchor/src/resizer.ts': { branches: 92, functions: 100, lines: 100 },
        'packages/virtual-anchor/src/gate.ts': { branches: 78, functions: 100, lines: 100 },
        // The uncovered branch is the production build, which by definition is not this build.
        //
        // Functions 100 → 83 for the same reason rather than a new one: `addTraceListener` returns
        // a no-op unsubscribe when there is no instrumentation, and a function that exists only to
        // be harmless in a build this suite is not cannot be called from a build this suite is.
        // Counting it as a gap would mean deleting the guard to satisfy the number.
        'packages/virtual-anchor/src/trace.ts': { branches: 80, functions: 83, lines: 100 },
        // One expression, one branch, and the branch is which build this is. The `define`d arm is
        // what `scripts/check-package.mjs` proves by grepping the shipped artifact for topic
        // strings; no unit test can reach it, and a threshold pretending otherwise would be a
        // fiction. See `debugFlag.ts` for the measurements.
        'packages/virtual-anchor/src/debugFlag.ts': { branches: 50, functions: 100, lines: 100 },

        // The debug toolkit. Pure by design where it can be, which is where the floors are highest:
        // the analyzer, the recorder and the formatter are functions of their arguments, so there is
        // no excuse for a gap in them beyond the ranking branches no fixture reaches yet.
        'packages/virtual-anchor/src/debug/analyzer.ts': { branches: 86, functions: 100, lines: 97 },
        'packages/virtual-anchor/src/debug/recorder.ts': { branches: 93, functions: 100, lines: 100 },
        'packages/virtual-anchor/src/debug/format.ts': { branches: 78, functions: 100, lines: 95 },
        'packages/virtual-anchor/src/debug/install.ts': { branches: 88, functions: 100, lines: 97 },
        'packages/virtual-anchor/src/debug/gestureProbe.ts': { branches: 86, functions: 100, lines: 100 },
        // Functions to 100 on both after the cleanup removed the two `frames()` accessors nothing
        // called. The branch ratios went *down* by a point or two in the same change, and for the
        // reason this table already records elsewhere: removing covered branches lowers the ratio
        // without anything becoming less tested. What is left is the `typeof performance` and
        // window-less fallbacks, which are the non-browser case.
        'packages/virtual-anchor/src/debug/driver.ts': { branches: 90, functions: 100, lines: 100 },
        'packages/virtual-anchor/src/debug/frameProbe.ts': { branches: 80, functions: 100, lines: 100 },
        // The lowest floor here, and the uncovered parts are named rather than rounded away: the
        // `save` button's `Blob` download and its deferred `revokeObjectURL`, which jsdom does not
        // implement. There is deliberately no feature detection to test — `navigator.clipboard` and
        // `navigator.share` are secure-context-gated and so unavailable on the LAN dev server this
        // exists for, which is why only the download and the textarea are offered at all.
        'packages/virtual-anchor/src/debug/overlay.ts': { branches: 86, functions: 78, lines: 88 },

        // The whole React adapter, with nothing left over.
        'packages/virtual-anchor/src/react/useItemVisibility.ts': { branches: 100, functions: 100, lines: 100 },
        'packages/virtual-anchor/src/react/useVirtualList.ts': { branches: 100, functions: 100, lines: 100 },
        'packages/virtual-anchor/src/react/VirtualList.tsx': { branches: 100, functions: 100, lines: 100 },
      },
    },
  },
})
