import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { composeInsets, ListGeometry, visibleSizeOf, type ListInsets } from './listGeometry.js'

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

  it('round-trips whatever the measured slots compose into', () => {
    // The slots reach the conversion as ordinary insets — a sticky header counted
    // into both `scrollMargin` and `scrollPaddingStart`, a footer into `spaceAfter`.
    // The invariant that has to survive that is the only one there is: the two
    // conversions remain exact inverses.
    fc.assert(
      fc.property(
        insetsArb(),
        fc.double({ min: 0, max: 2000, noNaN: true }),
        fc.double({ min: 0, max: 2000, noNaN: true }),
        fc.double({ min: 0, max: 2000, noNaN: true }),
        fc.double({ min: -1000, max: 500_000, noNaN: true }),
        (base, header, stickyStart, footer, scrollOffset) => {
          const g = geometry({
            scrollMargin: base.scrollMargin + header + stickyStart,
            scrollPaddingStart: base.scrollPaddingStart + stickyStart,
            scrollPaddingEnd: base.scrollPaddingEnd,
            spaceAfter: footer,
          })
          expect(g.toScroll(g.toList(scrollOffset))).toBeCloseTo(scrollOffset, 6)
        },
      ),
      { numRuns: 1000 },
    )
  })

  it('keeps space after the list out of the conversion entirely', () => {
    // `spaceAfter` exists for the scroller's end shortcut alone. If it ever started
    // shifting the probe point, every anchor in a list with a footer would be wrong.
    const withFooter = geometry({ spaceAfter: 400 })
    expect(withFooter.toList(1000)).toBe(geometry().toList(1000))
    expect(withFooter.toScroll(1000)).toBe(geometry().toScroll(1000))
    expect(withFooter.visibleSize()).toBe(geometry().visibleSize())
  })
})

describe('composeInsets', () => {
  it('returns the consumer’s own object when there is no chrome', () => {
    // Identity, not equality: a list with no slots must allocate nothing on a path
    // that runs once per publish.
    const base: ListInsets = { scrollMargin: 120 }
    expect(composeInsets(base, {})).toBe(base)
    expect(composeInsets(base, { header: 0, stickyHeader: 0, footer: 0, stickyFooter: 0 })).toBe(
      base,
    )
  })

  it('counts a scroll-away header only towards where the list begins', () => {
    expect(composeInsets({}, { header: 300 })).toEqual({
      scrollMargin: 300,
      scrollPaddingStart: 0,
      scrollPaddingEnd: 0,
      spaceAfter: 0,
    })
  })

  it('counts a sticky slot in both of its channels', () => {
    // The rule that is easy to get wrong, and the one react-virtuoso needed two
    // measured values for: in-flow space *and* overlapping chrome.
    expect(composeInsets({}, { stickyHeader: 80 })).toEqual({
      scrollMargin: 80,
      scrollPaddingStart: 80,
      scrollPaddingEnd: 0,
      spaceAfter: 0,
    })
    expect(composeInsets({}, { stickyFooter: 60 })).toEqual({
      scrollMargin: 0,
      scrollPaddingStart: 0,
      scrollPaddingEnd: 60,
      spaceAfter: 60,
    })
  })

  it('adds to the consumer’s own insets rather than replacing them', () => {
    // `scrollMargin` still means the list's offset within the document, which is
    // page chrome *outside* the component — a different quantity from a header
    // inside it, and they compose.
    expect(
      composeInsets(
        { scrollMargin: 200, scrollPaddingStart: 64, scrollPaddingEnd: 10 },
        { header: 300, stickyHeader: 80, footer: 40, stickyFooter: 60 },
      ),
    ).toEqual({
      scrollMargin: 580,
      scrollPaddingStart: 144,
      scrollPaddingEnd: 70,
      spaceAfter: 100,
    })
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

  it('grows it further ahead than behind when asked', () => {
    const g = geometry({}, 800)
    // The leading side is the one the compositor is scrolling toward, so it is the one that
    // takes the lookahead; behind the reader stays at the plain buffer.
    expect(g.bufferedBand(1000, 400, 2400)).toEqual({ start: 600, end: 4200 })
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

  it('never reports a negative usable height', () => {
    // Reachable now that sticky slots feed the padding: a composer and a filter bar
    // taller than the scrollport is a phone in landscape, not a misconfiguration. A
    // negative height would invert `visibleBand`, which does not report "nothing is
    // visible" — it silently stops every visibility event, which is the bug
    // `clampToOnScreen` was written to kill once already.
    const g = geometry({ scrollPaddingStart: 500, scrollPaddingEnd: 500 }, 600)
    expect(g.visibleSize()).toBe(0)

    const band = g.visibleBand(1000)
    expect(band.end).toBeGreaterThanOrEqual(band.start)
  })

  it('agrees with the free function the scroller uses', () => {
    // Two callers, one expression. The scroller holds raw insets and used to subtract
    // the padding itself, which is exactly the duplication this class exists to end.
    fc.assert(
      fc.property(insetsArb(), fc.double({ min: 0, max: 2000, noNaN: true }), (insets, size) => {
        expect(visibleSizeOf(insets, size)).toBe(new ListGeometry(insets, size).visibleSize())
      }),
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
