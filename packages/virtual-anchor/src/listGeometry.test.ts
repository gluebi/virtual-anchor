import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { ListGeometry, type ListInsets } from './listGeometry.js'

const geometry = (insets: ListInsets = {}, viewportSize = 800): ListGeometry =>
  new ListGeometry(insets, viewportSize)

const insetsArb = () =>
  fc.record({
    scrollPaddingStart: fc.double({ min: 0, max: 200, noNaN: true }),
    scrollPaddingEnd: fc.double({ min: 0, max: 200, noNaN: true }),
    scrollMargin: fc.double({ min: 0, max: 5000, noNaN: true }),
  })

describe('ListGeometry conversion', () => {
  it('round-trips scroller space to list space and back', () => {
    fc.assert(
      fc.property(
        insetsArb(),
        fc.double({ min: -1000, max: 500_000, noNaN: true }),
        (insets, scrollOffset) => {
          const g = geometry(insets)
          expect(g.toScroll(g.toList(scrollOffset))).toBeCloseTo(scrollOffset, 6)
        },
      ),
      { numRuns: 1000 },
    )
  })

  it('treats the top of the visible area as below the sticky header', () => {
    // A 60px header means the pixel at the top of the *visible* area is 60px
    // further into the list than the raw scroll offset suggests.
    const g = geometry({ scrollPaddingStart: 60 })
    expect(g.toList(0)).toBe(60)
    expect(g.toList(500)).toBe(560)
  })

  it('accounts for content above the list', () => {
    const g = geometry({ scrollMargin: 500 })
    expect(g.toList(500)).toBe(0)
    expect(g.toList(700)).toBe(200)
  })

  it('composes margin and padding', () => {
    const g = geometry({ scrollMargin: 500, scrollPaddingStart: 60 })
    expect(g.toList(500)).toBe(60)
    expect(g.toScroll(60)).toBe(500)
  })

  it('defaults every inset to zero', () => {
    const g = geometry()
    expect(g.toList(1234)).toBe(1234)
    expect(g.paddingStart).toBe(0)
    expect(g.paddingEnd).toBe(0)
    expect(g.margin).toBe(0)
  })
})

describe('ListGeometry visible area', () => {
  it('removes overlapping chrome from the usable height', () => {
    const g = geometry({ scrollPaddingStart: 60, scrollPaddingEnd: 40 }, 800)
    expect(g.visibleSize()).toBe(700)
  })

  it('reports the visible band in list coordinates', () => {
    const g = geometry({ scrollPaddingStart: 60, scrollMargin: 500 }, 800)
    // scrollOffset 1000 → list 560, and 740px of usable height.
    expect(g.visibleBand(1000)).toEqual({ start: 560, end: 1300 })
  })

  it('grows the band symmetrically for the mounted range', () => {
    const g = geometry({}, 800)
    expect(g.bufferedBand(1000, 400)).toEqual({ start: 600, end: 2200 })
  })

  it('keeps the buffered band a superset of the visible one', () => {
    fc.assert(
      fc.property(
        insetsArb(),
        fc.double({ min: 0, max: 100_000, noNaN: true }),
        fc.double({ min: 0, max: 2000, noNaN: true }),
        (insets, scrollOffset, buffer) => {
          const g = geometry(insets)
          const visible = g.visibleBand(scrollOffset)
          const buffered = g.bufferedBand(scrollOffset, buffer)
          expect(buffered.start).toBeLessThanOrEqual(visible.start)
          expect(buffered.end).toBeGreaterThanOrEqual(visible.end)
        },
      ),
    )
  })

  it('reflects an updated viewport size and insets', () => {
    const g = geometry({}, 800)
    expect(g.visibleSize()).toBe(800)

    g.update({ scrollPaddingStart: 100 }, 600)
    expect(g.visibleSize()).toBe(500)
    expect(g.toList(0)).toBe(100)
  })
})

describe('ListGeometry scrollport coordinates', () => {
  it('measures scrollport y from the top edge, above any header', () => {
    // The distinction that matters: toList answers for the top of the *visible*
    // area (y = paddingStart), listCoordAt answers for the scrollport edge.
    const g = geometry({ scrollPaddingStart: 60 }, 800)
    expect(g.listCoordAt(1000, 0)).toBe(1000)
    expect(g.listCoordAt(1000, 60)).toBe(g.toList(1000))
  })

  it('accounts for content above the list', () => {
    const g = geometry({ scrollMargin: 500 }, 800)
    expect(g.listCoordAt(1000, 0)).toBe(500)
  })
})

describe('ListGeometry on-screen clamping', () => {
  it('leaves a band alone when the whole scrollport is on screen', () => {
    const g = geometry({}, 800)
    const band = g.visibleBand(1000)
    expect(g.clampToOnScreen(1000, band, { start: 0, end: 800 })).toEqual(band)
  })

  it('narrows the band when the scrollport is half off the top', () => {
    // An 800px scrollport whose top 200px are above the fold: only list
    // coordinates from 1200 down are genuinely on screen.
    const g = geometry({}, 800)
    const band = g.visibleBand(1000)
    expect(g.clampToOnScreen(1000, band, { start: 200, end: 800 })).toEqual({
      start: 1200,
      end: 1800,
    })
  })

  it('narrows the band when the scrollport runs off the bottom', () => {
    const g = geometry({}, 800)
    const band = g.visibleBand(1000)
    expect(g.clampToOnScreen(1000, band, { start: 0, end: 300 })).toEqual({
      start: 1000,
      end: 1300,
    })
  })

  it('returns null when nothing is on screen', () => {
    const g = geometry({}, 800)
    expect(g.clampToOnScreen(1000, g.visibleBand(1000), null)).toBeNull()
  })

  it('returns null for an empty intersection rather than an inverted band', () => {
    const g = geometry({}, 800)
    const band = g.visibleBand(1000)
    expect(g.clampToOnScreen(1000, band, { start: 400, end: 400 })).toBeNull()
  })

  it('does not apply the scroll offset twice for a document scroller', () => {
    // The regression this class exists for. A gate observing `documentElement`
    // reports an intersection whose rect top already carries `-scrollY`; the old
    // code added the scroll offset again, so past one viewport the band inverted
    // and every visibility event stopped. Here the offset is applied exactly once,
    // so a fully-on-screen document scroller yields the untouched visible band at
    // any scroll position.
    const g = geometry({}, 800)

    for (const scrollOffset of [0, 500, 800, 1600, 50_000]) {
      const band = g.visibleBand(scrollOffset)
      const clamped = g.clampToOnScreen(scrollOffset, band, { start: 0, end: 800 })
      expect(clamped, `at scrollOffset ${String(scrollOffset)}`).toEqual(band)
    }
  })

  it('never widens a band', () => {
    fc.assert(
      fc.property(
        insetsArb(),
        fc.double({ min: 0, max: 100_000, noNaN: true }),
        fc.double({ min: 0, max: 800, noNaN: true }),
        fc.double({ min: 0, max: 800, noNaN: true }),
        (insets, scrollOffset, a, b) => {
          const g = geometry(insets)
          const band = g.visibleBand(scrollOffset)
          const onScreen = { start: Math.min(a, b), end: Math.max(a, b) }
          const clamped = g.clampToOnScreen(scrollOffset, band, onScreen)
          if (clamped === null) return

          expect(clamped.start).toBeGreaterThanOrEqual(band.start)
          expect(clamped.end).toBeLessThanOrEqual(band.end)
          expect(clamped.start).toBeLessThan(clamped.end)
        },
      ),
      { numRuns: 500 },
    )
  })
})
