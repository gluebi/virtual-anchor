import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type AnchorGeometry,
  carryFor,
  convergenceTolerance,
  deriveAnchor,
  isSelfWrite,
  MAX_CARRY,
  offsetForIndex,
  resolveAnchorOffset,
  SELF_WRITE_TOLERANCE,
  snapToDevicePixels,
} from './anchor.js'
import { SizeCache } from './sizeCache.js'
import type { ItemKey } from './types.js'

const keysFor = (n: number): ItemKey[] =>
  Array.from({ length: n }, (_, i) => `comment-${String(i)}`)

const cacheOf = (sizes: readonly number[], gap = 0): SizeCache => {
  const cache = new SizeCache({ keys: keysFor(sizes.length), gap })
  sizes.forEach((s, i) => cache.setSize(i, s))
  return cache
}

const size = () => fc.double({ min: 1, max: 4000, noNaN: true })

/**
 * Where an item's top edge sits relative to the top of the visible area.
 *
 * This is the quantity the user actually perceives, and the one the anchor
 * guarantees. It is a stronger and more honest invariant than "re-deriving names
 * the same key": if the anchored comment is re-measured *shorter* than the
 * anchor's own in-item offset, that pixel legitimately falls into the next
 * comment, so the key can change while the view has not moved at all.
 */
const screenTopOf = (
  index: number,
  cache: SizeCache,
  scrollTop: number,
  g?: AnchorGeometry,
): number => offsetForIndex(index, cache, g) - scrollTop
const geometry = () =>
  fc.record({
    scrollPaddingStart: fc.double({ min: 0, max: 200, noNaN: true }),
    scrollMargin: fc.double({ min: 0, max: 2000, noNaN: true }),
  })

describe('anchor round-trip', () => {
  it('restores the exact offset it was derived from', () => {
    fc.assert(
      fc.property(
        fc.array(size(), { minLength: 1, maxLength: 200 }),
        fc.double({ min: -500, max: 500_000, noNaN: true }),
        geometry(),
        (sizes, scrollTop, g) => {
          const cache = cacheOf(sizes)
          const anchor = deriveAnchor(scrollTop, cache, g)
          expect(anchor).not.toBeNull()

          const restored = resolveAnchorOffset(anchor!, cache, g)
          expect(restored).toBeCloseTo(scrollTop, 6)
        },
      ),
      { numRuns: 1000 },
    )
  })

  it('round-trips with no geometry at all', () => {
    const cache = cacheOf([100, 200, 300])
    const anchor = deriveAnchor(250, cache)
    expect(anchor).toEqual({ key: 'comment-1', offsetWithinItem: 150 })
    expect(resolveAnchorOffset(anchor!, cache)).toBe(250)
  })

  it('round-trips a position above the start of the list', () => {
    // Window scroller, page scrolled above the list: the probe is negative and
    // the anchor holds a negative offsetWithinItem. This has to survive, or
    // scrolling to the very top would lose the position.
    const cache = cacheOf([100, 200])
    const g: AnchorGeometry = { scrollMargin: 500 }

    const anchor = deriveAnchor(120, cache, g)
    expect(anchor).toEqual({ key: 'comment-0', offsetWithinItem: -380 })
    expect(resolveAnchorOffset(anchor!, cache, g)).toBe(120)
  })

  it('round-trips a position past the end of a short list', () => {
    const cache = cacheOf([100, 100])
    const anchor = deriveAnchor(5000, cache)
    expect(anchor?.key).toBe('comment-1')
    expect(anchor?.offsetWithinItem).toBe(4900)
    expect(resolveAnchorOffset(anchor!, cache)).toBe(5000)
  })

  it('anchors the item below a sticky header, not underneath it', () => {
    const cache = cacheOf([100, 100, 100])
    const g: AnchorGeometry = { scrollPaddingStart: 60 }

    // scrollTop 50 puts item 0 partly behind the header; the first item visible
    // below the header is item 1, at probe 110.
    const anchor = deriveAnchor(50, cache, g)
    expect(anchor).toEqual({ key: 'comment-1', offsetWithinItem: 10 })
    expect(resolveAnchorOffset(anchor!, cache, g)).toBe(50)
  })

  it('returns null for an empty window', () => {
    expect(deriveAnchor(0, new SizeCache({ keys: [] }))).toBeNull()
  })

  it('returns null rather than zero when the anchored key is gone', () => {
    const cache = cacheOf([100, 100])
    const anchor = deriveAnchor(150, cache)

    cache.setKeys(['different-a', 'different-b'])
    expect(resolveAnchorOffset(anchor!, cache)).toBeNull()
  })
})

describe('anchor stability under list mutation', () => {
  it('holds the view when items are prepended', () => {
    fc.assert(
      fc.property(
        fc.array(size(), { minLength: 3, maxLength: 40 }),
        fc.array(size(), { minLength: 1, maxLength: 20 }),
        fc.nat({ max: 39 }),
        geometry(),
        (existing, older, rawIndex, g) => {
          const existingKeys = existing.map((_, i) => `have-${String(i)}`)
          const cache = new SizeCache({ keys: existingKeys, defaultEstimate: 100 })
          existing.forEach((s, i) => cache.setSize(i, s))

          // Park the viewport partway down an arbitrary existing comment.
          const index = rawIndex % existing.length
          const scrollTop =
            offsetForIndex(index, cache, g) + Math.min(17, existing[index]! / 2)
          const anchor = deriveAnchor(scrollTop, cache, g)
          const anchoredKey = anchor!.key

          // A page of older comments arrives at the top, unmeasured.
          const olderKeys = older.map((_, i) => `older-${String(i)}`)
          cache.setKeys([...olderKeys, ...existingKeys])

          // The absolute offset moved; the anchor still points at the same pixel
          // of the same comment, which is the only thing the user perceives.
          const restored = resolveAnchorOffset(anchor!, cache, g)
          expect(restored).not.toBeNull()
          const reDerived = deriveAnchor(restored!, cache, g)
          expect(reDerived!.key).toBe(anchoredKey)
          expect(reDerived!.offsetWithinItem).toBeCloseTo(anchor!.offsetWithinItem, 6)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('shifts the restored offset by exactly the height of what was prepended', () => {
    const cache = new SizeCache({ keys: keysFor(3), defaultEstimate: 100 })
    const anchor = deriveAnchor(250, cache)
    expect(resolveAnchorOffset(anchor!, cache)).toBe(250)

    cache.setKeys(['older-a', 'older-b', ...keysFor(3)])
    // Two unmeasured items at 100px each.
    expect(resolveAnchorOffset(anchor!, cache)).toBe(450)
  })

  it('holds the view when items are appended below', () => {
    const cache = new SizeCache({ keys: keysFor(3), defaultEstimate: 100 })
    const anchor = deriveAnchor(150, cache)

    cache.setKeys([...keysFor(3), 'newer-a', 'newer-b'])
    // Nothing above the anchor changed, so the offset is untouched.
    expect(resolveAnchorOffset(anchor!, cache)).toBe(150)
  })

  it('holds the view when an item above is re-measured', () => {
    const cache = new SizeCache({ keys: keysFor(5), defaultEstimate: 100 })
    const anchor = deriveAnchor(320, cache)
    expect(anchor).toEqual({ key: 'comment-3', offsetWithinItem: 20 })

    // Comment 1 turns out to be 350px, not the estimated 100px.
    cache.setSize(1, 350)

    // The anchored comment is now 250px further down, and the restored offset
    // follows it — with no compensation heuristic deciding whether to.
    expect(resolveAnchorOffset(anchor!, cache)).toBe(570)
    const reDerived = deriveAnchor(570, cache)
    expect(reDerived).toEqual({ key: 'comment-3', offsetWithinItem: 20 })
  })

  it('holds the view when an item below is re-measured', () => {
    const cache = new SizeCache({ keys: keysFor(5), defaultEstimate: 100 })
    const anchor = deriveAnchor(120, cache)

    cache.setSize(4, 900)
    expect(resolveAnchorOffset(anchor!, cache)).toBe(120)
  })

  it('survives a burst of measurements arriving in any order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat({ max: 29 }), size()), { minLength: 1, maxLength: 60 }),
        fc.nat({ max: 29 }),
        geometry(),
        (writes, rawAnchorIndex, g) => {
          const cache = new SizeCache({ keys: keysFor(30), defaultEstimate: 100 })
          const anchorIndex = rawAnchorIndex % 30
          const scrollTop = offsetForIndex(anchorIndex, cache, g) + 5
          const anchor = deriveAnchor(scrollTop, cache, g)
          const anchoredIndex = cache.indexOf(anchor!.key)
          const screenBefore = screenTopOf(anchoredIndex, cache, scrollTop, g)

          for (const [rawIndex, next] of writes) cache.setSize(rawIndex % 30, next)

          // Whatever moved — items above, below, or the anchored one itself —
          // the anchored comment is still in the same place on screen.
          const restored = resolveAnchorOffset(anchor!, cache, g)
          expect(restored).not.toBeNull()
          expect(screenTopOf(anchoredIndex, cache, restored!, g)).toBeCloseTo(screenBefore, 6)
        },
      ),
      { numRuns: 1000 },
    )
  })

  it('keeps the view still even when the anchored comment shrinks past the anchor point', () => {
    const cache = new SizeCache({ keys: keysFor(5), defaultEstimate: 100 })
    const anchor = deriveAnchor(205, cache)
    expect(anchor).toEqual({ key: 'comment-2', offsetWithinItem: 5 })
    const screenBefore = screenTopOf(2, cache, 205)
    expect(screenBefore).toBe(-5)

    // comment-2 collapses to 1px, so "5px into comment-2" is now past its end.
    cache.setSize(2, 1)

    // The anchored comment's top edge has not moved on screen…
    const restored = resolveAnchorOffset(anchor!, cache)
    expect(restored).toBe(205)
    expect(screenTopOf(2, cache, restored!)).toBe(screenBefore)

    // …but the pixel at the top of the viewport is now in comment-3, and saying
    // so is correct rather than a rounding failure.
    expect(deriveAnchor(restored!, cache)?.key).toBe('comment-3')
  })

  it('holds the view when the estimate itself changes', () => {
    const cache = new SizeCache({ keys: keysFor(20), defaultEstimate: 100 })
    cache.setSize(0, 400)
    cache.setSize(1, 400)

    const anchor = deriveAnchor(offsetForIndex(10, cache) + 30, cache)

    // A better median estimate moves every unmeasured item, including the eight
    // above the anchor. In an offset-addressed list this is react-window's #863;
    // here it is a no-op for the viewport.
    expect(cache.refreshEstimate(0)).toBe(true)

    const restored = resolveAnchorOffset(anchor!, cache)
    const reDerived = deriveAnchor(restored!, cache)
    expect(reDerived!.key).toBe(anchor!.key)
    expect(reDerived!.offsetWithinItem).toBeCloseTo(anchor!.offsetWithinItem, 6)
  })
})

describe('offsetForIndex', () => {
  it('agrees with the anchor conversion for a zero in-item offset', () => {
    const cache = cacheOf([100, 200, 300])
    const g: AnchorGeometry = { scrollPaddingStart: 40, scrollMargin: 500 }

    const byIndex = offsetForIndex(2, cache, g)
    const byAnchor = resolveAnchorOffset({ key: 'comment-2', offsetWithinItem: 0 }, cache, g)
    expect(byIndex).toBe(byAnchor)
  })

  it('accounts for content above the list and chrome over it', () => {
    const cache = cacheOf([100, 100, 100])
    expect(offsetForIndex(1, cache)).toBe(100)
    expect(offsetForIndex(1, cache, { scrollMargin: 500 })).toBe(600)
    expect(offsetForIndex(1, cache, { scrollPaddingStart: 60 })).toBe(40)
    expect(offsetForIndex(1, cache, { scrollMargin: 500, scrollPaddingStart: 60 })).toBe(540)
  })
})

describe('isSelfWrite', () => {
  it('recognises the browser rounding our own write', () => {
    expect(isSelfWrite(1204, 1204.5)).toBe(true)
    expect(isSelfWrite(1205, 1204.5)).toBe(true)
    expect(isSelfWrite(1204.5, 1204.5)).toBe(true)
  })

  it('treats a real scroll as input', () => {
    expect(isSelfWrite(1210, 1204.5)).toBe(false)
    expect(isSelfWrite(1200, 1204.5)).toBe(false)
  })

  it('treats everything as input when nothing was written', () => {
    expect(isSelfWrite(1204, null)).toBe(false)
    expect(isSelfWrite(0, null)).toBe(false)
  })

  it('accepts exactly at the tolerance boundary', () => {
    expect(isSelfWrite(100 + SELF_WRITE_TOLERANCE, 100)).toBe(true)
    expect(isSelfWrite(100 + SELF_WRITE_TOLERANCE + 0.01, 100)).toBe(false)
  })
})

describe('carryFor', () => {
  it('recovers the fraction the browser refused to take', () => {
    expect(carryFor(1204.5, 1204)).toBeCloseTo(0.5, 10)
    expect(carryFor(1204.25, 1205)).toBeCloseTo(-0.75, 10)
  })

  it('is zero when the write landed exactly', () => {
    expect(carryFor(1204, 1204)).toBe(0)
  })

  it('refuses to carry more than a pixel', () => {
    // The browser clamped the write because the sizer had not grown yet.
    // Shoving content by the whole difference would be far worse than waiting
    // for the convergence loop to re-aim.
    expect(carryFor(50_000, 1200)).toBe(0)
    expect(carryFor(0, 1200)).toBe(0)
    expect(carryFor(100 + MAX_CARRY + 0.001, 100)).toBe(0)
    expect(carryFor(100 + MAX_CARRY, 100)).toBeCloseTo(MAX_CARRY, 10)
  })

  it('refuses non-finite input', () => {
    expect(carryFor(Number.NaN, 100)).toBe(0)
    expect(carryFor(Number.POSITIVE_INFINITY, 100)).toBe(0)
  })
})

describe('device pixel helpers', () => {
  it('snaps a visual offset to the device grid', () => {
    expect(snapToDevicePixels(10.4, 1)).toBe(10)
    expect(snapToDevicePixels(10.4, 2)).toBe(10.5)
    expect(snapToDevicePixels(10.3, 2)).toBe(10.5)
    expect(snapToDevicePixels(10.2, 2)).toBe(10)
    expect(snapToDevicePixels(10.1, 3)).toBeCloseTo(10.0, 6)
  })

  it('leaves values alone for a nonsensical ratio', () => {
    expect(snapToDevicePixels(10.4, 0)).toBe(10.4)
    expect(snapToDevicePixels(10.4, -1)).toBe(10.4)
    expect(snapToDevicePixels(10.4, Number.NaN)).toBe(10.4)
  })

  it('scales the convergence tolerance with the display', () => {
    expect(convergenceTolerance(1)).toBe(1)
    expect(convergenceTolerance(2)).toBe(0.5)
    expect(convergenceTolerance(2.625)).toBeCloseTo(0.38095, 4)
  })

  it('falls back to a whole pixel for a nonsensical ratio', () => {
    expect(convergenceTolerance(0)).toBe(1)
    expect(convergenceTolerance(Number.NaN)).toBe(1)
  })
})
