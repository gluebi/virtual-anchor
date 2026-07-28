import { describe, expect, it } from 'vitest'
import {
  type VisibilityCandidate,
  type VisibilityEvent,
  type VisibilityOptions,
  VisibilityTracker,
} from './visibility.js'
import type { ItemKey } from './types.js'

/** Uniform 100px items, so band arithmetic in the tests stays readable. */
const ITEM = 100
const items = (from: number, to: number, measured = true): VisibilityCandidate[] =>
  Array.from({ length: to - from + 1 }, (_, offset) => {
    const index = from + offset
    return {
      index,
      key: `c${String(index)}`,
      start: index * ITEM,
      size: ITEM,
      measured,
    }
  })

interface Harness {
  scroll: (top: number, options?: { size?: number; now?: number }) => VisibilityEvent[]
  at: (options: {
    top: number
    now?: number
    size?: number
    gated?: boolean
    suppressed?: boolean
    candidates?: VisibilityCandidate[]
  }) => VisibilityEvent[]
  tracker: VisibilityTracker
}

/** Drives the tracker with a viewport of `size` px parked at `top`. */
const harness = (options: VisibilityOptions = {}, defaultSize = 300): Harness => {
  const tracker = new VisibilityTracker(options)
  let clock = 0

  const at: Harness['at'] = ({ top, now, size = defaultSize, gated = true, suppressed, candidates }) => {
    clock = now ?? clock
    const viewportStart = top
    const viewportEnd = top + size
    // Everything within a generous overscan is a candidate, as the store's
    // rendered range would supply.
    const from = Math.max(0, Math.floor(top / ITEM) - 3)
    const to = Math.floor((top + size) / ITEM) + 3
    return tracker.sample({
      viewportStart,
      viewportEnd,
      items: candidates ?? items(from, to),
      now: clock,
      gated,
      ...(suppressed === undefined ? {} : { suppressed }),
    })
  }

  return {
    tracker,
    at,
    scroll: (top, opts) => at({ top, ...opts }),
  }
}

const keysOf = (events: readonly VisibilityEvent[], phase: 'enter' | 'leave'): ItemKey[] =>
  events.filter((e) => e.phase === phase).map((e) => e.key)

describe('VisibilityTracker rules', () => {
  it('reports any overlap by default', () => {
    const h = harness()
    const events = h.scroll(0)
    // A 300px viewport at offset 0 touches items 0, 1 and 2.
    expect(keysOf(events, 'enter')).toEqual(['c0', 'c1', 'c2'])
  })

  it('reports a single overlapping pixel', () => {
    const h = harness({}, 100)
    // Viewport [99, 199) clips 1px of item 0 and most of item 1.
    const events = h.at({ top: 99, size: 100 })
    expect(keysOf(events, 'enter')).toContain('c0')
  })

  it('honours a fraction of the item', () => {
    const h = harness({ rule: { mode: 'fraction', of: 'item', fraction: 0.5 } }, 300)
    // Viewport [50, 350): item 0 shows its lower 50%, items 1 and 2 are whole,
    // item 3 shows its upper 50%.
    const events = h.at({ top: 50, size: 300 })
    expect(keysOf(events, 'enter')).toEqual(['c0', 'c1', 'c2', 'c3'])

    // Nudge down 1px and item 0 drops below half, while item 3 gains.
    const next = h.at({ top: 51, size: 300 })
    expect(keysOf(next, 'leave')).toEqual(['c0'])
    expect(keysOf(next, 'enter')).toEqual([])
  })

  it('honours a fraction of the viewport, for items taller than it', () => {
    // A 2000px comment can never show 50% of *itself* in a 300px viewport, so an
    // item-fraction rule would never fire for it. This is the carve-out.
    const tracker = new VisibilityTracker({
      rule: { mode: 'fraction', of: 'viewport', fraction: 0.5 },
    })
    const giant: VisibilityCandidate = {
      index: 0,
      key: 'giant',
      start: 0,
      size: 2000,
      measured: true,
    }

    const events = tracker.sample({
      viewportStart: 500,
      viewportEnd: 800,
      items: [giant],
      now: 0,
      gated: true,
    })
    expect(keysOf(events, 'enter')).toEqual(['giant'])
    expect(events[0]?.itemFraction).toBeCloseTo(0.15, 6)
    expect(events[0]?.viewportFraction).toBe(1)
  })

  it('honours full visibility', () => {
    const h = harness({ rule: { mode: 'full' } }, 250)
    // Viewport [0, 250): items 0 and 1 are whole, item 2 is half.
    const events = h.at({ top: 0, size: 250 })
    expect(keysOf(events, 'enter')).toEqual(['c0', 'c1'])
  })

  it('treats a zero-height item as not visible', () => {
    // The IntersectionObserver spec reports intersectionRatio 1 for a
    // zero-area target, which makes empty rows look fully visible to any
    // threshold. Not a trap worth reproducing.
    const tracker = new VisibilityTracker({ rule: { mode: 'full' } })
    const events = tracker.sample({
      viewportStart: 0,
      viewportEnd: 300,
      items: [{ index: 0, key: 'empty', start: 100, size: 0, measured: true }],
      now: 0,
      gated: true,
    })
    expect(events).toEqual([])
  })

  it('expands the band with rootMargin', () => {
    const h = harness({ rootMargin: 150 }, 100)
    // Viewport [0, 100) plus 150px either side reaches item 2.
    expect(keysOf(h.at({ top: 0, size: 100 }), 'enter')).toContain('c2')
  })

  it('shrinks the band with a negative rootMargin', () => {
    const h = harness({ rootMargin: -60 }, 300)
    // [60, 240): item 0's last 40px are outside the shrunken band.
    const events = h.at({ top: 0, size: 300 })
    expect(keysOf(events, 'enter')).toEqual(['c0', 'c1', 'c2'])

    const strict = harness({ rootMargin: -60, rule: { mode: 'full' } }, 300)
    expect(keysOf(strict.at({ top: 0, size: 300 }), 'enter')).toEqual(['c1'])
  })
})

describe('VisibilityTracker measurement gating', () => {
  it('refuses a fraction rule for an unmeasured item', () => {
    // An unmeasured item sits at an estimated offset, so "half of it is showing"
    // is a guess dressed as a fact.
    const tracker = new VisibilityTracker({
      rule: { mode: 'fraction', of: 'item', fraction: 0.5 },
    })
    const events = tracker.sample({
      viewportStart: 0,
      viewportEnd: 300,
      items: items(0, 2, false),
      now: 0,
      gated: true,
    })
    expect(events).toEqual([])
  })

  it('refuses a full rule for an unmeasured item', () => {
    const tracker = new VisibilityTracker({ rule: { mode: 'full' } })
    const events = tracker.sample({
      viewportStart: 0,
      viewportEnd: 300,
      items: items(0, 1, false),
      now: 0,
      gated: true,
    })
    expect(events).toEqual([])
  })

  it('allows an any-overlap rule for an unmeasured item, and says so', () => {
    // "Some part of this overlaps" survives being approximate, and holding it
    // back would delay every event on a fast scroll into new territory.
    const tracker = new VisibilityTracker()
    const events = tracker.sample({
      viewportStart: 0,
      viewportEnd: 300,
      items: items(0, 2, false),
      now: 0,
      gated: true,
    })
    expect(keysOf(events, 'enter')).toEqual(['c0', 'c1', 'c2'])
    expect(events.every((e) => e.measured === false)).toBe(true)
  })
})

describe('VisibilityTracker dwell time', () => {
  it('reports nothing for comments crossed during a fling', () => {
    const h = harness({ dwellMs: 1000 })

    // A 200ms fling across ten screens: each row is present for one 20ms frame.
    let events: VisibilityEvent[] = []
    for (let frame = 0; frame < 10; frame++) {
      events = events.concat(h.at({ top: frame * 300, now: frame * 20 }))
    }
    expect(events).toEqual([])
  })

  it('reports once the item has been still for long enough', () => {
    const h = harness({ dwellMs: 1000 })

    expect(h.at({ top: 0, now: 0 })).toEqual([])
    expect(h.at({ top: 0, now: 999 })).toEqual([])
    expect(keysOf(h.at({ top: 0, now: 1000 }), 'enter')).toEqual(['c0', 'c1', 'c2'])
  })

  it('restarts a continuous clock when the item leaves the band', () => {
    const h = harness({ dwellMs: 1000, dwell: 'continuous' })

    h.at({ top: 0, now: 0 })
    h.at({ top: 0, now: 600 })
    // Scroll far away, then come back.
    h.at({ top: 5000, now: 700 })
    h.at({ top: 0, now: 800 })
    // 600ms banked + 600ms more would satisfy a cumulative rule; continuous
    // needs a fresh 1000ms.
    expect(h.at({ top: 0, now: 1400 })).toEqual([])
    expect(keysOf(h.at({ top: 0, now: 1800 }), 'enter')).toContain('c0')
  })

  it('stops the clock of an item that scrolls out before it was reported', () => {
    // The clock has to be stopped even though nothing was ever reported for this
    // item. Otherwise it keeps running while the row is unmounted, and the elapsed
    // time on return includes every millisecond in between — so a comment glanced
    // at for 600ms and revisited would count instantly.
    const h = harness({ dwellMs: 1000, dwell: 'continuous' })

    h.at({ top: 0, now: 0 })
    h.at({ top: 0, now: 600 })
    // Item 0 is no longer even a candidate.
    h.at({ top: 0, now: 700, candidates: items(20, 26) })
    // Twenty seconds later it comes back into view.
    h.at({ top: 0, now: 20_000 })

    expect(h.at({ top: 0, now: 20_500 })).toEqual([])
    expect(keysOf(h.at({ top: 0, now: 21_000 }), 'enter')).toContain('c0')
  })

  it('adds up separate viewings for a cumulative clock', () => {
    const h = harness({ dwellMs: 1000, dwell: 'cumulative' })

    h.at({ top: 0, now: 0 })
    h.at({ top: 0, now: 600 })
    h.at({ top: 5000, now: 700 })
    h.at({ top: 0, now: 800 })
    // 600ms banked plus 400ms more reaches the threshold.
    expect(keysOf(h.at({ top: 0, now: 1200 }), 'enter')).toContain('c0')
  })

  it('does not bank time spent in a hidden tab', () => {
    const h = harness({ dwellMs: 1000, dwell: 'cumulative' })

    h.at({ top: 0, now: 0 })
    h.at({ top: 0, now: 400 })
    h.tracker.pauseDwell(400)

    // The user was away for a minute; that is not reading time.
    expect(h.at({ top: 0, now: 60_400 })).toEqual([])
    expect(keysOf(h.at({ top: 0, now: 61_000 }), 'enter')).toContain('c0')
  })
})

describe('VisibilityTracker once semantics', () => {
  it('reports enter at most once per key', () => {
    const h = harness({ once: true })

    expect(keysOf(h.at({ top: 0, now: 0 }), 'enter')).toEqual(['c0', 'c1', 'c2'])
    h.at({ top: 5000, now: 100 })
    // Coming back must not re-report a comment already counted as read.
    expect(keysOf(h.at({ top: 0, now: 200 }), 'enter')).toEqual([])
  })

  it('still reports the departure of an item entered once', () => {
    const h = harness({ once: true })
    h.at({ top: 0, now: 0 })
    expect(keysOf(h.at({ top: 5000, now: 100 }), 'leave')).toEqual(['c0', 'c1', 'c2'])
  })

  it('remembers being seen even after the item unmounts and returns', () => {
    const h = harness({ once: true })
    h.at({ top: 0, now: 0 })
    h.at({ top: 100_000, now: 100 })
    h.at({ top: 0, now: 200 })

    expect(h.tracker.get('c0').hasBeenSeen).toBe(true)
    expect(h.tracker.get('c0').visible).toBe(false)
  })
})

describe('VisibilityTracker leave hysteresis', () => {
  // These pass an explicit candidate set covering item 0 throughout, so the
  // hysteresis path is exercised rather than the vanished-from-the-window path
  // (which reports immediately — see below).
  const wide = () => items(0, 8)

  it('waits out a brief departure', () => {
    const h = harness({ leaveDelayMs: 200 }, 300)
    h.at({ top: 0, now: 0, candidates: wide() })

    // Item 0 leaves the band, but not for long enough to report a departure.
    // Items 4-6 legitimately arrive; it is the absence of a *leave* that matters.
    expect(keysOf(h.at({ top: 400, now: 100, candidates: wide() }), 'leave')).toEqual([])
    // …and coming back cancels the pending departure entirely.
    expect(keysOf(h.at({ top: 0, now: 150, candidates: wide() }), 'leave')).toEqual([])
    expect(h.tracker.get('c0').visible).toBe(true)
  })

  it('reports the departure once the delay elapses', () => {
    const h = harness({ leaveDelayMs: 200 }, 300)
    h.at({ top: 0, now: 0, candidates: wide() })
    h.at({ top: 400, now: 100, candidates: wide() })

    expect(keysOf(h.at({ top: 400, now: 300, candidates: wide() }), 'leave')).toContain('c0')
  })

  it('reports an unmounted item immediately, without waiting out the delay', () => {
    // Hysteresis smooths a wobble at the viewport edge. An unmounted row is
    // definitively not on screen, and there is nothing to wobble back to.
    const h = harness({ leaveDelayMs: 5000 }, 300)
    h.at({ top: 0, now: 0, candidates: wide() })

    expect(keysOf(h.at({ top: 0, now: 10, candidates: items(5, 8) }), 'leave')).toEqual([
      'c0',
      'c1',
      'c2',
    ])
  })
})

describe('VisibilityTracker suppression', () => {
  it('reports nothing while a programmatic scroll is in flight', () => {
    const h = harness()
    h.at({ top: 0, now: 0 })

    // scrollToKey flies across 500 comments. None of them may count as read.
    const events: VisibilityEvent[] = []
    for (let i = 1; i <= 20; i++) {
      events.push(...h.at({ top: i * 2500, now: i * 16, suppressed: true }))
    }
    expect(events).toEqual([])
  })

  it('reports the new position, and the old departures, once it settles', () => {
    const h = harness()
    h.at({ top: 0, now: 0 })

    h.at({ top: 50_000, now: 100, suppressed: true })
    const settled = h.at({ top: 50_000, now: 200 })

    expect(keysOf(settled, 'leave')).toEqual(['c0', 'c1', 'c2'])
    expect(keysOf(settled, 'enter')).toEqual(['c500', 'c501', 'c502'])
  })

  it('restarts dwell clocks after suppression, so a fly-past banks nothing', () => {
    const h = harness({ dwellMs: 1000 })

    // Sitting still for 900ms, then a programmatic jump.
    h.at({ top: 0, now: 0 })
    h.at({ top: 0, now: 900 })
    h.at({ top: 30_000, now: 950, suppressed: true })

    // The 900ms banked before the jump must not carry into the new position.
    expect(h.at({ top: 30_000, now: 1000 })).toEqual([])
    expect(keysOf(h.at({ top: 30_000, now: 2000 }), 'enter')).toContain('c300')
  })

  it('does not re-report an item that was visible before and after a jump', () => {
    const h = harness()
    const entered = keysOf(h.at({ top: 0, now: 0 }), 'enter')
    expect(entered).toContain('c1')

    h.at({ top: 0, now: 100, suppressed: true })
    // Same position after the suppressed frames: nothing changed, nothing fires.
    expect(h.at({ top: 0, now: 200 })).toEqual([])
    expect(h.tracker.get('c1').visible).toBe(true)
  })
})

describe('VisibilityTracker scroller gate', () => {
  it('reports nothing while the scroller is off screen', () => {
    // Pure geometry cannot see that its scroller is in a collapsed accordion or
    // a background tab; this is that missing knowledge.
    const h = harness()
    expect(h.at({ top: 0, gated: false })).toEqual([])
  })

  it('reports departures when the scroller leaves the screen', () => {
    const h = harness()
    h.at({ top: 0, now: 0 })
    expect(keysOf(h.at({ top: 0, now: 100, gated: false }), 'leave')).toEqual([
      'c0',
      'c1',
      'c2',
    ])
  })

  it('flushes departures with no sample to derive them from', () => {
    const h = harness()
    h.at({ top: 0, now: 0 })

    const events = h.tracker.flushLeaves(500)
    expect(keysOf(events, 'leave')).toEqual(['c0', 'c1', 'c2'])
    expect(events.every((e) => e.at === 500)).toBe(true)
    expect(h.tracker.visibleKeys().size).toBe(0)

    // Idempotent: nothing left to flush.
    expect(h.tracker.flushLeaves(600)).toEqual([])
  })
})

describe('VisibilityTracker departures without a sample', () => {
  it('reports an item that vanished from the candidate set', () => {
    // IntersectionObserver delivers nothing on unobserve, so a recycled row
    // would otherwise stay "visible" forever.
    const h = harness()
    h.at({ top: 0, now: 0 })

    const events = h.at({ top: 0, now: 100, candidates: items(2, 4) })
    expect(keysOf(events, 'leave')).toEqual(['c0', 'c1'])
  })

  it('reports the last known index for a vanished item', () => {
    const h = harness()
    h.at({ top: 0, now: 0 })
    const events = h.at({ top: 0, now: 100, candidates: [] })

    expect(events.map((e) => e.index).sort((a, b) => a - b)).toEqual([0, 1, 2])
  })

  it('zeroes the fractions of a vanished item', () => {
    const h = harness()
    h.at({ top: 0, now: 0 })
    h.at({ top: 0, now: 100, candidates: [] })

    expect(h.tracker.get('c0')).toEqual({
      visible: false,
      itemFraction: 0,
      viewportFraction: 0,
      hasBeenSeen: true,
    })
  })
})

describe('VisibilityTracker quiet start', () => {
  it('adopts what is already on screen without reporting it', () => {
    // A deep link opens mid-thread; the comments already in view should not count
    // as freshly read.
    const h = harness({ quiet: true })
    expect(h.at({ top: 0, now: 0 })).toEqual([])
    expect(h.tracker.get('c0').visible).toBe(true)
    expect(h.tracker.get('c0').hasBeenSeen).toBe(true)
  })

  it('reports normally from the second sample onwards', () => {
    const h = harness({ quiet: true })
    h.at({ top: 0, now: 0 })

    const events = h.at({ top: 300, now: 100 })
    expect(keysOf(events, 'enter')).toEqual(['c3', 'c4', 'c5'])
    expect(keysOf(events, 'leave')).toEqual(['c0', 'c1', 'c2'])
  })
})

describe('VisibilityTracker state accessors', () => {
  it('reports nothing known about an untracked key', () => {
    const tracker = new VisibilityTracker()
    expect(tracker.get('never-seen')).toEqual({
      visible: false,
      itemFraction: 0,
      viewportFraction: 0,
      hasBeenSeen: false,
    })
  })

  it('exposes the visible key set', () => {
    const h = harness()
    h.at({ top: 0, now: 0 })
    expect([...h.tracker.visibleKeys()]).toEqual(['c0', 'c1', 'c2'])
  })

  it('reports the fractions it last computed', () => {
    const h = harness({}, 250)
    h.at({ top: 0, size: 250 })

    expect(h.tracker.get('c0').itemFraction).toBe(1)
    expect(h.tracker.get('c2').itemFraction).toBeCloseTo(0.5, 6)
    expect(h.tracker.get('c0').viewportFraction).toBeCloseTo(0.4, 6)
  })

  it('forgets everything on reset', () => {
    const h = harness({ once: true })
    h.at({ top: 0, now: 0 })
    h.tracker.reset()

    expect(h.tracker.get('c0').hasBeenSeen).toBe(false)
    expect(h.tracker.visibleKeys().size).toBe(0)
    // A reset clears `quiet`'s "already started" latch too.
    expect(keysOf(h.at({ top: 0, now: 100 }), 'enter')).toEqual(['c0', 'c1', 'c2'])
  })

  it('applies replaced options to the next sample', () => {
    const h = harness()
    h.at({ top: 0, now: 0 })

    h.tracker.setOptions({ rule: { mode: 'full' } })
    // c2 is only half visible in a 300px viewport… which is 3 whole items, so
    // widen to make the change observable.
    const events = h.at({ top: 50, size: 300, now: 100 })
    expect(keysOf(events, 'leave')).toContain('c0')
  })

  it('treats an empty viewport as covering nothing', () => {
    const tracker = new VisibilityTracker({
      rule: { mode: 'fraction', of: 'viewport', fraction: 0.1 },
    })
    const events = tracker.sample({
      viewportStart: 100,
      viewportEnd: 100,
      items: items(0, 3),
      now: 0,
      gated: true,
    })
    expect(events).toEqual([])
  })
})
