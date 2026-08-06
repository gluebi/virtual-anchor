import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { reconcileIndex, SizeCache, type SizeSnapshot } from './sizeCache.js'
import { setTraceSink, type TraceEvent } from './trace.js'
import type { ItemKey } from './types.js'

const keysFor = (n: number): ItemKey[] =>
  Array.from({ length: n }, (_, i) => `comment-${String(i)}`)

/** Realistic comment heights: mostly short, occasionally enormous. */
const size = () => fc.double({ min: 1, max: 4000, noNaN: true })
const gap = () => fc.double({ min: 0, max: 32, noNaN: true })

/** A cache with every item measured, so offsets are fully determined. */
const measuredCache = (sizes: readonly number[], gapPx: number): SizeCache => {
  const cache = new SizeCache({ keys: keysFor(sizes.length), gap: gapPx })
  sizes.forEach((s, i) => cache.setSize(i, s))
  return cache
}

const EPS = 1e-6

/**
 * The offset↔index inversion is the property everything else rests on, and it
 * is where float64 non-associativity actually bites, so it gets more runs than
 * fast-check's default 100.
 */
const INVERSION_RUNS = { numRuns: 1000 }

/** A 100-item cache with the given prefix measured, for the median estimator's gates. */
const cacheWith = (sizes: readonly number[]): SizeCache => {
  const cache = new SizeCache({ keys: keysFor(100), defaultEstimate: 100 })
  sizes.forEach((s, i) => cache.setSize(i, s))
  return cache
}

describe('SizeCache offsets', () => {
  it('starts the first item at zero', () => {
    fc.assert(
      fc.property(fc.array(size(), { minLength: 1, maxLength: 200 }), gap(), (sizes, g) => {
        expect(measuredCache(sizes, g).offsetOf(0)).toBe(0)
      }),
    )
  })

  it('advances each offset by exactly the item size plus the gap', () => {
    fc.assert(
      fc.property(fc.array(size(), { minLength: 1, maxLength: 200 }), gap(), (sizes, g) => {
        const cache = measuredCache(sizes, g)
        for (let i = 0; i < sizes.length; i++) {
          const delta = cache.offsetOf(i + 1) - cache.offsetOf(i)
          expect(delta).toBeCloseTo(sizes[i]! + g, 6)
        }
      }),
    )
  })

  it('totals every item plus interior gaps only, never a trailing one', () => {
    fc.assert(
      fc.property(fc.array(size(), { minLength: 1, maxLength: 200 }), gap(), (sizes, g) => {
        const expected = sizes.reduce((a, b) => a + b, 0) + (sizes.length - 1) * g
        expect(measuredCache(sizes, g).totalSize()).toBeCloseTo(expected, 6)
      }),
    )
  })

  it('reports zero total for an empty window', () => {
    const cache = new SizeCache({ keys: [], gap: 8 })
    expect(cache.totalSize()).toBe(0)
    expect(cache.indexAt(0)).toBe(-1)
    expect(cache.offsetOf(0)).toBe(0)
    expect(cache.length).toBe(0)
  })

  it('defaults to an empty window when no keys are given', () => {
    const cache = new SizeCache()
    expect(cache.length).toBe(0)
    expect(cache.gap).toBe(0)
    expect(cache.totalSize()).toBe(0)
  })

  it('exposes its own configuration', () => {
    const cache = new SizeCache({ keys: keysFor(4), gap: 12, defaultEstimate: 90 })
    expect(cache.length).toBe(4)
    expect(cache.gap).toBe(12)
    expect(cache.estimate).toBe(90)
  })

  it('clamps an out-of-range offsetOf to the ends of the window', () => {
    const cache = measuredCache([100, 200, 300], 0)
    expect(cache.offsetOf(-5)).toBe(0)
    // `length` is valid and yields the raw prefix sum (total plus trailing gap).
    expect(cache.offsetOf(3)).toBe(600)
    expect(cache.offsetOf(99)).toBe(600)
  })
})

describe('SizeCache indexAt inverts offsetOf', () => {
  it('round-trips every item top edge back to its own index', () => {
    fc.assert(
      fc.property(fc.array(size(), { minLength: 1, maxLength: 300 }), gap(), (sizes, g) => {
        const cache = measuredCache(sizes, g)
        for (let i = 0; i < sizes.length; i++) {
          expect(cache.indexAt(cache.offsetOf(i))).toBe(i)
        }
      }),
      INVERSION_RUNS,
    )
  })

  it('maps a point inside an item to that item', () => {
    fc.assert(
      fc.property(fc.array(size(), { minLength: 1, maxLength: 300 }), gap(), (sizes, g) => {
        const cache = measuredCache(sizes, g)
        for (let i = 0; i < sizes.length; i++) {
          const middle = cache.offsetOf(i) + sizes[i]! / 2
          expect(cache.indexAt(middle)).toBe(i)
        }
      }),
      INVERSION_RUNS,
    )
  })

  it('clamps below the start and past the end', () => {
    const cache = measuredCache([100, 200, 300], 0)
    expect(cache.indexAt(-9999)).toBe(0)
    expect(cache.indexAt(0)).toBe(0)
    expect(cache.indexAt(999_999)).toBe(2)
  })

  it('holds after an arbitrary sequence of re-measurements', () => {
    fc.assert(
      fc.property(
        fc.array(size(), { minLength: 5, maxLength: 60 }),
        fc.array(fc.tuple(fc.nat({ max: 59 }), size()), { maxLength: 120 }),
        gap(),
        (initial, writes, g) => {
          const cache = measuredCache(initial, g)
          const expected = [...initial]

          for (const [rawIndex, next] of writes) {
            const index = rawIndex % initial.length
            cache.setSize(index, next)
            expected[index] = next
          }

          // Offsets must still be an exact prefix sum, and still invertible.
          let running = 0
          for (let i = 0; i < expected.length; i++) {
            expect(cache.offsetOf(i)).toBeCloseTo(running, 6)
            expect(cache.indexAt(running + EPS)).toBe(i)
            running += expected[i]! + g
          }
        },
      ),
    )
  })
})

describe('SizeCache itemAt', () => {
  it('resolves an offset to index, key, start and size in one call', () => {
    const cache = measuredCache([100, 200, 300], 10)
    expect(cache.itemAt(0)).toEqual({ index: 0, key: 'comment-0', start: 0, size: 100 })
    expect(cache.itemAt(150)).toEqual({ index: 1, key: 'comment-1', start: 110, size: 200 })
    expect(cache.itemAt(400)).toEqual({ index: 2, key: 'comment-2', start: 320, size: 300 })
  })

  it('agrees with the individual accessors', () => {
    fc.assert(
      fc.property(
        fc.array(size(), { minLength: 1, maxLength: 100 }),
        gap(),
        fc.double({ min: -100, max: 200_000, noNaN: true }),
        (sizes, g, offset) => {
          const cache = measuredCache(sizes, g)
          const item = cache.itemAt(offset)!
          expect(item.index).toBe(cache.indexAt(offset))
          expect(item.key).toBe(cache.keyAt(item.index))
          expect(item.start).toBe(cache.offsetOf(item.index))
          expect(item.size).toBe(cache.sizeOf(item.index))
        },
      ),
    )
  })

  it('reports the estimate for an unmeasured item', () => {
    const cache = new SizeCache({ keys: keysFor(3), defaultEstimate: 140 })
    expect(cache.itemAt(200)).toEqual({ index: 1, key: 'comment-1', start: 140, size: 140 })
  })

  it('returns null for an empty window', () => {
    expect(new SizeCache({ keys: [] }).itemAt(0)).toBeNull()
  })

  it('clamps beyond either end', () => {
    const cache = measuredCache([100, 100], 0)
    expect(cache.itemAt(-999)?.index).toBe(0)
    expect(cache.itemAt(999_999)?.index).toBe(1)
  })
})

describe('reconcileIndex', () => {
  // Every item 100px wide, so prefixAt(i) === i * 100. Feeding this a
  // deliberately wrong candidate exercises both correction directions, which a
  // float64 pathology cannot be relied upon to produce on demand.
  const prefixAt = (i: number) => i * 100
  const COUNT = 10

  it('leaves an already-correct candidate alone', () => {
    expect(reconcileIndex(3, 300, COUNT, prefixAt)).toBe(3)
    expect(reconcileIndex(3, 350, COUNT, prefixAt)).toBe(3)
  })

  it('walks down when the candidate overshot', () => {
    expect(reconcileIndex(5, 300, COUNT, prefixAt)).toBe(3)
    expect(reconcileIndex(9, 0, COUNT, prefixAt)).toBe(0)
  })

  it('walks up when the candidate undershot', () => {
    expect(reconcileIndex(0, 300, COUNT, prefixAt)).toBe(3)
    expect(reconcileIndex(1, 999, COUNT, prefixAt)).toBe(9)
  })

  it('never walks past either end', () => {
    expect(reconcileIndex(0, -500, COUNT, prefixAt)).toBe(0)
    expect(reconcileIndex(9, 999_999, COUNT, prefixAt)).toBe(9)
  })

  it('resolves a boundary to the item that starts there, not the one before', () => {
    // The distinction that makes scrollToKey land on the requested comment.
    expect(reconcileIndex(2, 300, COUNT, prefixAt)).toBe(3)
    expect(reconcileIndex(3, 299.9999, COUNT, prefixAt)).toBe(2)
  })
})

describe('SizeCache measurement guards', () => {
  it('refuses zero, negative and non-finite sizes', () => {
    const cache = new SizeCache({ keys: keysFor(3), defaultEstimate: 100 })
    for (const bad of [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(cache.setSize(1, bad)).toBe(false)
    }
    // Still on the estimate, and no zero has poisoned the prefix sum.
    expect(cache.sizeOf(1)).toBe(100)
    expect(cache.totalSize()).toBe(300)
    expect(cache.isMeasured(1)).toBe(false)
  })

  it('reports whether a write actually changed anything', () => {
    const cache = new SizeCache({ keys: keysFor(2), defaultEstimate: 100 })
    expect(cache.setSize(0, 250)).toBe(true)
    expect(cache.setSize(0, 250)).toBe(false)
    expect(cache.setSize(0, 251)).toBe(true)
  })

  it('counts a first measurement as a change even when it equals the estimate', () => {
    // Load-bearing beyond this file. `observeItem` publishes only when `setSize` returns
    // true, and the visibility tracker defers a `once` report until a measurement arrives
    // *because* that publish is guaranteed. Comparing against the estimate rather than the
    // stored measurement would silence the publish for every row that guessed right, and
    // under `once` those rows would then never be reported at all.
    const cache = new SizeCache({ keys: keysFor(2), defaultEstimate: 100 })
    expect(cache.isMeasured(0)).toBe(false)
    expect(cache.setSize(0, 100)).toBe(true)
    expect(cache.isMeasured(0)).toBe(true)
    expect(cache.setSize(0, 100)).toBe(false)
  })

  it('ignores writes to indices outside the window', () => {
    const cache = new SizeCache({ keys: keysFor(2) })
    expect(cache.setSize(5, 100)).toBe(false)
    expect(cache.setSize(-1, 100)).toBe(false)
    expect(cache.sizeOf(5)).toBe(0)
  })

  it('reverts an item to the estimate when cleared', () => {
    const cache = new SizeCache({ keys: keysFor(3), defaultEstimate: 100 })
    cache.setSize(1, 500)
    expect(cache.totalSize()).toBe(700)

    expect(cache.clearSize(1)).toBe(true)
    expect(cache.totalSize()).toBe(300)
    expect(cache.clearSize(1)).toBe(false)
    // …and ignores indices outside the window.
    expect(cache.clearSize(99)).toBe(false)
  })

  it('drops every measurement on clearAll, for a reflow-everything resize', () => {
    const cache = new SizeCache({ keys: keysFor(3), defaultEstimate: 100 })
    cache.setSize(0, 500)
    cache.setSize(2, 900)
    cache.clearAll()

    expect(cache.measuredCount).toBe(0)
    expect(cache.totalSize()).toBe(300)
  })

  it('floors a non-positive estimate so offsets stay invertible', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cache = new SizeCache({ keys: keysFor(3), estimateSize: () => 0 })

    expect(cache.sizeOf(0)).toBe(1)
    expect(cache.indexAt(cache.offsetOf(2))).toBe(2)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('SizeCache window changes', () => {
  it('preserves measured sizes by key when items are prepended', () => {
    const original = keysFor(3)
    const cache = new SizeCache({ keys: original, defaultEstimate: 100 })
    cache.setSize(0, 500)
    cache.setSize(2, 700)

    const older: ItemKey[] = ['older-a', 'older-b']
    cache.setKeys([...older, ...original])

    // The same keys keep the same sizes, now at shifted indices.
    expect(cache.sizeOf(2)).toBe(500)
    expect(cache.sizeOf(4)).toBe(700)
    expect(cache.isMeasured(0)).toBe(false)
    expect(cache.totalSize()).toBe(100 + 100 + 500 + 100 + 700)
  })

  it('preserves measured sizes by key when items are appended', () => {
    const original = keysFor(3)
    const cache = new SizeCache({ keys: original, defaultEstimate: 100 })
    cache.setSize(1, 480)

    cache.setKeys([...original, 'newer-a'])
    expect(cache.sizeOf(1)).toBe(480)
    expect(cache.measuredCount).toBe(1)
    expect(cache.totalSize()).toBe(100 + 480 + 100 + 100)
  })

  it('keeps offsets exact and invertible across repeated prepends', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(size(), { minLength: 1, maxLength: 12 }), {
          minLength: 1,
          maxLength: 8,
        }),
        gap(),
        (pages, g) => {
          let keys: ItemKey[] = []
          const sizesByKey = new Map<ItemKey, number>()
          const cache = new SizeCache({ keys, gap: g, defaultEstimate: 100 })

          // Each page is prepended, as bidirectional pagination does.
          pages.forEach((page, p) => {
            const pageKeys = page.map((_, i) => `p${String(p)}-${String(i)}`)
            keys = [...pageKeys, ...keys]
            cache.setKeys(keys)

            page.forEach((s, i) => {
              cache.setSize(i, s)
              sizesByKey.set(pageKeys[i]!, s)
            })
          })

          let running = 0
          for (let i = 0; i < keys.length; i++) {
            expect(cache.offsetOf(i)).toBeCloseTo(running, 6)
            expect(cache.indexAt(running + EPS)).toBe(i)
            running += sizesByKey.get(keys[i]!)! + g
          }
        },
      ),
    )
  })

  it('treats the same array reference as a no-op', () => {
    const keys = keysFor(3)
    const cache = new SizeCache({ keys })
    expect(cache.setKeys(keys)).toBe(false)
    expect(cache.setKeys([...keys])).toBe(true)
  })

  it('resolves keys to indices and back', () => {
    const cache = new SizeCache({ keys: keysFor(3) })
    expect(cache.indexOf('comment-1')).toBe(1)
    expect(cache.indexOf('nope')).toBe(-1)
    expect(cache.keyAt(1)).toBe('comment-1')
    expect(cache.keyAt(99)).toBeUndefined()
  })

  it('rejects duplicate keys loudly in development', () => {
    expect(() => new SizeCache({ keys: ['a', 'b', 'a'] })).toThrow(/duplicate key/i)
  })

  it('rebuilds when the gap changes', () => {
    const cache = new SizeCache({ keys: keysFor(3), gap: 0, defaultEstimate: 100 })
    expect(cache.totalSize()).toBe(300)
    expect(cache.setGap(10)).toBe(true)
    expect(cache.totalSize()).toBe(320)
    expect(cache.setGap(10)).toBe(false)
  })
})

describe('SizeCache estimates set after construction', () => {
  it('rebuilds when the estimator changes', () => {
    // The whole of issue #8: the React adapter cannot supply this at construction, because the
    // engine is derived from a scroll element that does not exist on the first render.
    const cache = new SizeCache({ keys: keysFor(3), defaultEstimate: 100 })
    expect(cache.totalSize()).toBe(300)

    expect(cache.setEstimateSize(() => 250)).toBe(true)
    expect(cache.totalSize()).toBe(750)
    expect(cache.offsetOf(2)).toBe(500)
  })

  it('ignores an unchanged estimator reference', () => {
    // What makes this callable on every render: the adapter memoises the function, so the
    // common case must cost nothing rather than rebuilding 50,000 slots.
    const estimateSize = (): number => 250
    const cache = new SizeCache({ keys: keysFor(3), estimateSize })
    expect(cache.setEstimateSize(estimateSize)).toBe(false)
  })

  it('falls back to the default for an item the estimator declines', () => {
    // A key the caller cannot resolve to data. Returning `undefined` rather than a number
    // keeps the choice of fallback in one place.
    const cache = new SizeCache({
      keys: keysFor(3),
      defaultEstimate: 100,
      estimateSize: (index) => (index === 1 ? undefined : 300),
    })

    expect(cache.sizeOf(0)).toBe(300)
    expect(cache.sizeOf(1)).toBe(100)
    expect(cache.totalSize()).toBe(700)
  })

  it('keeps offsets exact when an item is measured after the estimator changed', () => {
    // The regression that makes the rebuild non-optional. `setSize` folds a first measurement
    // in incrementally, as `size - (previous ?? estimateFor(index, key))`. A slot built with
    // the old estimate and adjusted with the new one is wrong by the difference — permanently,
    // since nothing recomputes it.
    const cache = new SizeCache({ keys: keysFor(5), defaultEstimate: 100 })
    cache.setEstimateSize(() => 400)
    cache.setSize(2, 137)

    // 400 + 400 + 137 + 400 + 400
    expect(cache.totalSize()).toBe(1737)
    expect(cache.offsetOf(3)).toBe(937)
    // The invariant everything else rests on.
    for (let index = 0; index < 5; index++) {
      expect(cache.indexAt(cache.offsetOf(index))).toBe(index)
    }
  })

  it('changes the fallback estimate while nothing has been learned', () => {
    const cache = new SizeCache({ keys: keysFor(3), defaultEstimate: 100 })
    expect(cache.setDefaultEstimate(200)).toBe(true)
    expect(cache.estimate).toBe(200)
    expect(cache.totalSize()).toBe(600)
    expect(cache.setDefaultEstimate(200)).toBe(false)
  })

  it('does not clobber a learned median with the caller’s default', () => {
    // A median measured from real items beats an opening guess that arrives later, so this is
    // refused. A *different* value, so it is genuinely refused rather than merely unchanged.
    const cache = cacheWith([200, 200, 200, 200])
    expect(cache.refreshEstimate(0)).toBe(true)
    expect(cache.estimate).toBe(200)

    expect(cache.setDefaultEstimate(150)).toBe(false)
    expect(cache.estimate).toBe(200)
  })

  it('does not rebuild when the effective estimate would not move', () => {
    // `clearAll` forgets the measurements and re-arms the estimator, but keeps the median it
    // learned — a median from the old layout still beats the caller's opening guess. Setting a
    // default equal to it is then a no-op rather than a rebuild.
    const cache = cacheWith([200, 200, 200, 200])
    cache.refreshEstimate(0)
    cache.clearAll()
    expect(cache.estimate).toBe(200)

    expect(cache.setDefaultEstimate(200)).toBe(false)
    expect(cache.estimate).toBe(200)
  })
})

describe('SizeCache median estimator', () => {
  it('waits until measured content exceeds the viewport', () => {
    const cache = cacheWith([200, 200])
    // 400px measured against an 800px viewport: too early to trust.
    expect(cache.refreshEstimate(800)).toBe(false)
    expect(cache.estimate).toBe(100)

    expect(cache.refreshEstimate(300)).toBe(true)
    expect(cache.estimate).toBe(200)
  })

  it('uses the median so one enormous comment cannot skew it', () => {
    const cache = cacheWith([100, 110, 120, 130, 4000])
    cache.refreshEstimate(0)

    // Mean would be 892; median is 120.
    expect(cache.estimate).toBe(120)
  })

  it('averages the two middle values for an even count', () => {
    const cache = cacheWith([100, 200, 300, 400])
    cache.refreshEstimate(0)
    expect(cache.estimate).toBe(250)
  })

  it('does nothing when the caller supplies its own estimate', () => {
    const cache = new SizeCache({ keys: keysFor(10), estimateSize: () => 42 })
    cache.setSize(0, 900)
    expect(cache.refreshEstimate(0)).toBe(false)
    expect(cache.sizeOf(5)).toBe(42)
  })

  it('re-estimates only once the measured count doubles', () => {
    const cache = cacheWith([200, 200, 200, 200])
    expect(cache.refreshEstimate(0)).toBe(true)
    expect(cache.estimate).toBe(200)

    // 5, 6, 7 measured: not yet double of 4, so the median is not recomputed.
    cache.setSize(4, 900)
    cache.setSize(5, 900)
    cache.setSize(6, 900)
    expect(cache.refreshEstimate(0)).toBe(false)
    expect(cache.estimate).toBe(200)

    cache.setSize(7, 900)
    expect(cache.refreshEstimate(0)).toBe(true)
    expect(cache.estimate).toBe(550)
  })

  it('applies a new estimate to every unmeasured item', () => {
    const cache = new SizeCache({ keys: keysFor(10), defaultEstimate: 100 })
    cache.setSize(0, 300)
    cache.setSize(1, 300)
    cache.refreshEstimate(0)

    expect(cache.estimate).toBe(300)
    expect(cache.totalSize()).toBe(3000)
    expect(cache.indexAt(cache.offsetOf(7))).toBe(7)
  })

  it('reports no change when the median matches the current estimate', () => {
    const cache = cacheWith([100, 100])
    expect(cache.refreshEstimate(0)).toBe(false)
    expect(cache.estimate).toBe(100)
  })

  it('does nothing before anything has been measured', () => {
    const cache = new SizeCache({ keys: keysFor(10), defaultEstimate: 100 })
    expect(cache.refreshEstimate(0)).toBe(false)
    expect(cache.estimate).toBe(100)
  })
})

describe('SizeCache layout signature', () => {
  it('tracks the signature and reports whether it changed', () => {
    const cache = new SizeCache({ keys: keysFor(2), layoutSignature: 'w=800' })
    expect(cache.layoutSignature).toBe('w=800')

    expect(cache.setLayoutSignature('w=800')).toBe(false)
    expect(cache.setLayoutSignature('w=400')).toBe(true)
    expect(cache.layoutSignature).toBe('w=400')
  })

  it('defaults to an empty signature', () => {
    expect(new SizeCache().layoutSignature).toBe('')
  })

  it('accepts a snapshot again once the signature is set back to match', () => {
    const source = new SizeCache({ keys: keysFor(3), layoutSignature: 'w=800' })
    source.setSize(0, 350)

    const target = new SizeCache({ keys: keysFor(3), layoutSignature: 'w=400' })
    expect(target.restore(source.snapshot())).toBe(0)

    target.setLayoutSignature('w=800')
    expect(target.restore(source.snapshot())).toBeGreaterThan(0)
    expect(target.sizeOf(0)).toBe(350)
  })
})

describe('SizeCache snapshots', () => {
  it('round-trips measured sizes and the estimate', () => {
    const cache = new SizeCache({ keys: keysFor(5), layoutSignature: 'w=800|f=16|dpr=2' })
    cache.setSize(0, 310)
    cache.setSize(3, 480)
    const snapshot = cache.snapshot()

    const restored = new SizeCache({
      keys: keysFor(5),
      layoutSignature: 'w=800|f=16|dpr=2',
      snapshot,
    })

    expect(restored.sizeOf(0)).toBe(310)
    expect(restored.sizeOf(3)).toBe(480)
    expect(restored.measuredCount).toBe(2)
    expect(restored.totalSize()).toBe(cache.totalSize())
  })

  it('refuses a snapshot measured under a different layout', () => {
    const cache = new SizeCache({ keys: keysFor(3), layoutSignature: 'w=800|f=16|dpr=2' })
    cache.setSize(0, 310)

    const narrower = new SizeCache({ keys: keysFor(3), layoutSignature: 'w=400|f=16|dpr=2' })
    expect(narrower.restore(cache.snapshot())).toBe(0)
    expect(narrower.isMeasured(0)).toBe(false)
  })

  it('refuses a snapshot from a future format version', () => {
    const cache = new SizeCache({ keys: keysFor(3) })
    const alien = { ...cache.snapshot(), version: 2 } as unknown as SizeSnapshot
    expect(cache.restore(alien)).toBe(0)
  })

  it('restores sizes for keys that are not in the current window yet', () => {
    const cache = new SizeCache({ keys: keysFor(5) })
    cache.setSize(4, 700)
    const snapshot = cache.snapshot()

    // A later visit opens on a narrower window that excludes comment-4. The
    // measurement is retained regardless: it is keyed, not indexed.
    const reopened = new SizeCache({ keys: keysFor(2), snapshot })
    expect(reopened.measuredCount).toBe(1)

    // …and picks the size back up once the window grows to include it again.
    reopened.setKeys(keysFor(5))
    expect(reopened.sizeOf(4)).toBe(700)
  })
})

describe('SizeCache at thread scale', () => {
  // Browsers cap the maximum scrollable height (Chrome around 33.5M px). A
  // realistic worst case must stay well inside it, or the scroller silently
  // mispositions everything past the cap.
  const MAX_SCROLL_EXTENT = 33_000_000

  it('keeps a 50k-comment thread inside the browser scroll extent', () => {
    const count = 50_000
    const cache = new SizeCache({ keys: keysFor(count), gap: 16, defaultEstimate: 220 })

    // Every twentieth comment is a wall of text, to skew the total upwards.
    for (let i = 0; i < count; i += 20) cache.setSize(i, 2400)

    const total = cache.totalSize()
    expect(total).toBeLessThan(MAX_SCROLL_EXTENT)
    expect(cache.indexAt(total - 1)).toBe(count - 1)
    expect(cache.indexAt(cache.offsetOf(49_999))).toBe(49_999)
  })

  it('answers offset and index queries in logarithmic time, not linear', () => {
    const count = 100_000
    const cache = new SizeCache({ keys: keysFor(count), defaultEstimate: 200 })

    // Seeking backwards must cost the same as seeking forwards: there is no
    // resume-from-watermark, which is the point of the Fenwick tree.
    const start = performance.now()
    for (let i = count - 1; i >= 0; i -= 137) {
      cache.setSize(i, 300)
      cache.indexAt(cache.offsetOf(i))
    }
    const elapsed = performance.now() - start

    // ~730 iterations of (setSize + offsetOf + indexAt) over 100k items. A
    // linear-rebuild implementation would be orders of magnitude slower here.
    expect(elapsed).toBeLessThan(250)
  })
})

describe('restore into a partly measured cache', () => {
  const cache = (signature = 'sig') =>
    new SizeCache({ keys: ['a', 'b', 'c'], defaultEstimate: 100, layoutSignature: signature })

  const snapshot = (sizes: [string, number][], signature = 'sig') => ({
    version: 1 as const,
    layoutSignature: signature,
    estimate: 100,
    sizes,
  })

  it('fills in sizes for items that have not been measured', () => {
    // One method for both arrival times: at construction nothing is measured, so
    // fill-the-gaps and replace-everything are the same thing there.
    const c = cache()
    expect(c.restore(snapshot([['a', 250], ['c', 310]]))).toBe(2)
    expect(c.sizeOf(0)).toBe(250)
    expect(c.sizeOf(2)).toBe(310)
    expect(c.isMeasured(1)).toBe(false)
  })

  it('never overwrites a live measurement', () => {
    // A measured size is ground truth; a stored one is a recollection.
    const c = cache()
    c.setSize(0, 180)
    expect(c.restore(snapshot([['a', 9999], ['b', 220]]))).toBe(1)
    expect(c.sizeOf(0)).toBe(180)
    expect(c.sizeOf(1)).toBe(220)
  })

  it('refuses a snapshot from a different layout', () => {
    const c = cache('narrow')
    expect(c.restore(snapshot([['a', 250]], 'wide'))).toBe(0)
    expect(c.isMeasured(0)).toBe(false)
  })

  it('refuses a snapshot from a future version', () => {
    const c = cache()
    expect(c.restore({ ...snapshot([['a', 250]]), version: 2 })).toBe(0)
  })

  it('keeps the total consistent, so offsets stay right', () => {
    const c = cache()
    c.restore(snapshot([['a', 200], ['b', 300]]))
    expect(c.offsetOf(1)).toBe(200)
    expect(c.offsetOf(2)).toBe(500)
    expect(c.totalSize()).toBe(600)
  })
})

describe('restore tracing', () => {
  // The e2e suite asserts on these events to prove a snapshot reached the cache at all,
  // so the payloads are part of the contract rather than decoration.
  const events: TraceEvent[] = []

  beforeEach(() => {
    events.length = 0
    setTraceSink((event) => events.push(event))
  })

  afterEach(() => {
    setTraceSink(null)
  })

  it('reports an accepted restore with its size', () => {
    new SizeCache({
      keys: ['a', 'b'],
      layoutSignature: 'sig',
      snapshot: { version: 1, layoutSignature: 'sig', estimate: 100, sizes: [['a', 200]] },
    })

    expect(events.map((event) => event.topic)).toContain('snapshot.restore')
    expect(events[0]?.data).toMatchObject({ accepted: true, count: 1, version: 1 })
  })

  it('reports a refusal with both signatures, which is what explains it', () => {
    new SizeCache({
      keys: ['a'],
      layoutSignature: 'narrow',
      snapshot: { version: 1, layoutSignature: 'wide', estimate: 100, sizes: [['a', 200]] },
    })

    expect(events[0]?.data).toMatchObject({
      accepted: false,
      snapshotSignature: 'wide',
      cacheSignature: 'narrow',
    })
  })

  it('reports how much of a snapshot it took up', () => {
    const cache = new SizeCache({ keys: ['a', 'b'], layoutSignature: 'sig' })
    cache.setSize(0, 150)
    events.length = 0

    cache.restore({
      version: 1,
      layoutSignature: 'sig',
      estimate: 100,
      sizes: [
        ['a', 999],
        ['b', 220],
      ],
    })

    expect(events[0]?.topic).toBe('snapshot.restore')
    expect(events[0]?.data).toMatchObject({ accepted: true, applied: 1 })
  })
})
