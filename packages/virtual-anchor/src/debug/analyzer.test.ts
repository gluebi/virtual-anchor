import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../trace.js'
import { analyzeGestures, lastGesture, type SuspectId } from './analyzer.js'

/**
 * The diagnosis itself, under test.
 *
 * `analyzeGestures` is a pure function of an event array precisely so this file can exist: every
 * row of the hypothesis table in `analyzer.ts` gets a fixture that must produce the suspect, and
 * — the half that matters more — a fixture that must *not*. A detector that fires on everything
 * is worth nothing, and the one false positive found while building this (`fold-anchor-loss` on
 * a clean fold) would have been shipped without the refuting cases.
 *
 * Fixtures are hand-written rather than recorded. A recording proves the analyzer agrees with
 * whatever the library did that day; a fixture states what the *signal* is, so if the library
 * stops emitting it the test fails rather than quietly agreeing.
 */

let clock = 0
/** One event, at a time this file controls, so gaps are deliberate rather than incidental. */
const at = (topic: string, data: Record<string, unknown> = {}, advance = 16): TraceEvent => {
  clock += advance
  return { at: clock, topic, data }
}
const reset = (): void => {
  clock = 0
}

/** A complete write payload, so a fixture only has to name what it is varying. */
const write = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  restore: 'measure',
  reason: 'held',
  took: false,
  offset: 5000,
  from: 5000,
  delta: 10,
  deferred: true,
  pendingShift: 0,
  heldAfter: 10,
  room: 4000,
  max: 20_000,
  ...over,
})

const fold = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  shift: 20,
  from: 5000,
  target: 5020,
  applied: 5020,
  max: 20_000,
  clamped: false,
  carryBefore: 0,
  carryAfter: 0,
  ...over,
})

/**
 * touchstart → an even drag → touchend → momentum → settle.
 *
 * Deliberately *evenly* spaced at 40px a sample: a smooth fling is what this has to represent, so
 * that any suspect a fixture produces comes from what the fixture adds rather than from the
 * baseline, rather than something a heuristic could mistake for an anomaly.
 */
const gesture = (middle: TraceEvent[] = [], options: { ios?: boolean } = {}): TraceEvent[] => {
  reset()
  return [
    at('gate.attach', { ios: options.ios ?? true, attached: false, disposed: false }, 0),
    at('gesture.touch', { phase: 'start', y: 400, dy: 0, ms: 0, moves: 0, velocity: 0 }),
    at('scroll.sample', { offset: 5000, carry: 0, shift: 0 }),
    at('scroll.sample', { offset: 5040, carry: 0, shift: 0 }),
    at('gesture.touch', { phase: 'end', y: 200, dy: 200, ms: 100, moves: 6, velocity: -2 }),
    at('scroll.gate', { state: 'grace', reason: 'touchend' }),
    at('scroll.gate', { state: 'momentum', reason: 'momentum-onset' }),
    ...middle,
    at('scroll.sample', { offset: 5080, carry: 0, shift: 0 }),
    at('scroll.sample', { offset: 5120, carry: 0, shift: 0 }),
    at('scroll.gate', { state: 'idle', reason: 'settled' }),
  ]
}

const suspects = (events: TraceEvent[], dropped = 0): SuspectId[] =>
  lastGesture(events, dropped)?.suspects.map((suspect) => suspect.id) ?? []

describe('segmenting the stream', () => {
  it('opens a gesture on a touch and closes it on settle', () => {
    const verdict = lastGesture(gesture())
    expect(verdict).not.toBeNull()
    expect(verdict?.ended).toBe('settled')
    expect(verdict?.gate).toBe('ios')
    expect(verdict?.scrolls).toBe(4)
  })

  it('finds each gesture separately', () => {
    const events = [...gesture(), ...gesture()]
    expect(analyzeGestures(events)).toHaveLength(2)
  })

  it('reports nothing when nothing has happened', () => {
    expect(lastGesture([])).toBeNull()
  })

  it('treats both openers for one touch as one gesture', () => {
    // What a device actually produces, and the case no fixture covered before: the gate's listener
    // is bound at mount and the probe's on a later frame, so a single touch announces itself twice.
    // Splitting on the second left a junk one-event group before every real gesture — invisible
    // through `lastGesture`, but it double-counted `gestures()` and made the `#index` printed to the
    // console skip numbers.
    reset()
    const events = [
      at('gate.attach', { ios: true, attached: false, disposed: false }, 0),
      at('scroll.gate', { state: 'touching', reason: 'touchstart' }),
      at('gesture.touch', { phase: 'start', y: 400, dy: 0, ms: 0, moves: 0, velocity: 0 }),
      at('scroll.sample', { offset: 5000, carry: 0, shift: 0 }),
      at('scroll.gate', { state: 'idle', reason: 'settled' }),
    ]

    const all = analyzeGestures(events)
    expect(all).toHaveLength(1)
    expect(all[0]?.scrolls).toBe(1)
  })

  it('still splits when the second opener follows real movement', () => {
    // The other half: two touches in quick succession are two gestures, and the thing that tells
    // them apart from one touch announced twice is whether anything scrolled in between.
    reset()
    const events = [
      at('gesture.touch', { phase: 'start', y: 400, dy: 0, ms: 0, moves: 0, velocity: 0 }),
      at('scroll.sample', { offset: 5000, carry: 0, shift: 0 }),
      at('gesture.touch', { phase: 'start', y: 300, dy: 0, ms: 0, moves: 0, velocity: 0 }),
      at('scroll.sample', { offset: 5100, carry: 0, shift: 0 }),
    ]
    expect(analyzeGestures(events)).toHaveLength(2)
  })

  it('opens on the gate when there is no touch probe', () => {
    // The iOS-only path: `scroll.gate` reason `touchstart` is the fallback boundary.
    reset()
    const verdict = lastGesture([
      at('scroll.gate', { state: 'touching', reason: 'touchstart' }),
      at('scroll.sample', { offset: 100, carry: 0, shift: 0 }),
      at('scroll.gate', { state: 'idle', reason: 'settled' }),
    ])
    expect(verdict?.scrolls).toBe(1)
  })

  it('opens on a scroll alone, for a platform with neither a touch nor a gate', () => {
    // A trackpad or a wheel: `gate.attach` says there is no gate, the probe binds only touch
    // listeners so it emits nothing, and neither opener above can ever fire. Before the sample
    // opener this returned no gestures at all — which reads as "nothing happened" from the one
    // tool whose job is to say what did, and made `not-ios` unreachable on the only platform it
    // describes.
    reset()
    const events = [
      at('gate.attach', { ios: false, attached: false, disposed: false }, 0),
      at('scroll.sample', { offset: 5000, carry: 0, shift: 0 }),
      at('scroll.write', write({ reason: 'gate-open', took: true })),
      at('scroll.sample', { offset: 5040, carry: 0, shift: 0 }),
      at('scroll.sample', { offset: 5080, carry: 0, shift: 0 }),
    ]

    const verdict = lastGesture(events)
    expect(verdict?.gate).toBe('inactive')
    expect(verdict?.scrolls).toBe(3)
    expect(suspects(events)).toContain('not-ios')
  })

  it('does not open one over the library scrolling itself', () => {
    // The other half, and the reason the opener consults `scroll.start`/`scroll.finish` rather
    // than opening on any scroll it sees. A `scrollToKey` converges by writing every frame, so a
    // group opened over one carries writes taken while samples arrive — `not-ios`'s exact
    // signature — for the convergence loop working correctly. Every thread open does this.
    reset()
    const events = [
      at('gate.attach', { ios: false, attached: false, disposed: false }, 0),
      at('scroll.start', { key: 'c1', index: 0, align: 'start', smooth: false, target: 5000, actual: 0 }),
      at('scroll.sample', { offset: 2000, carry: 0, shift: 0 }),
      at('scroll.write', write({ reason: 'gate-open', took: true })),
      at('scroll.sample', { offset: 5000, carry: 0, shift: 0 }),
      at('scroll.finish', {
        key: 'c1', index: 0, settled: true, reason: 'converged',
        deviation: 0, finalTarget: 5000, actual: 5000, iterations: 2,
      }),
    ]
    expect(analyzeGestures(events)).toEqual([])
  })

  it('opens one for the scroll that follows a programmatic scroll', () => {
    // And the latch releases: a reader flinging the list right after it landed is a real gesture,
    // and `finish()` is a single exit in `scroller.ts` — including on dispose — so there is no
    // path on which this stays shut.
    reset()
    const events = [
      at('gate.attach', { ios: false, attached: false, disposed: false }, 0),
      at('scroll.start', { key: 'c1', index: 0, align: 'start', smooth: false, target: 5000, actual: 0 }),
      at('scroll.sample', { offset: 5000, carry: 0, shift: 0 }),
      at('scroll.finish', {
        key: 'c1', index: 0, settled: true, reason: 'converged',
        deviation: 0, finalTarget: 5000, actual: 5000, iterations: 1,
      }),
      at('scroll.sample', { offset: 5100, carry: 0, shift: 0 }),
      at('scroll.sample', { offset: 5200, carry: 0, shift: 0 }),
    ]

    const all = analyzeGestures(events)
    expect(all).toHaveLength(1)
    expect(all[0]?.scrolls).toBe(2)
  })
})

describe('a truncated record', () => {
  it('is named, and suppresses every suspect', () => {
    // The evidence for an escape is present, and must still not be ranked: a partial record
    // refutes everything it does not contain, so a verdict from one reads as a false all-clear.
    const events = gesture([
      at('scroll.write', write({ reason: 'no-room', took: true, from: 19_950, room: 50 })),
    ])
    const verdict = analyzeGestures(events, 12)[0]
    expect(verdict?.truncated).toBe(true)
    expect(verdict?.suspects).toEqual([])
    // And the counts are still reported, so the reader can see what was there.
    expect(verdict?.writes.taken).toBe(1)
  })
})

describe('overscroll-write', () => {
  it('is confirmed when a write landed past the end of the scroll range', () => {
    const events = gesture([
      at('scroll.write', write({ reason: 'no-room', took: true, from: 20_050, room: 0 })),
    ])
    expect(suspects(events)).toContain('overscroll-write')
  })

  it('is confirmed below zero too — the top bounce', () => {
    const events = gesture([
      at('scroll.write', write({ reason: 'no-room', took: true, from: -30, room: 0 })),
    ])
    expect(suspects(events)).toContain('overscroll-write')
  })

  it('is absent when the offset stayed inside the range', () => {
    const events = gesture([
      at('scroll.write', write({ reason: 'no-room', took: true, from: 9000, room: 9000 })),
    ])
    expect(suspects(events)).not.toContain('overscroll-write')
  })

  it('takes precedence over the general no-room reading', () => {
    // They share a signal and the sharper one is the actionable finding, so reporting both
    // would just be two names for one defect.
    const events = gesture([
      at('scroll.write', write({ reason: 'no-room', took: true, from: 20_050, room: 0 })),
    ])
    expect(suspects(events)).not.toContain('no-room-at-end')
  })
})

describe('no-room-at-end', () => {
  it('is confirmed near the bottom', () => {
    const events = gesture([
      at('scroll.write', write({ reason: 'no-room', took: true, from: 19_900, room: 100 })),
    ])
    expect(suspects(events)).toContain('no-room-at-end')
  })

  it('is only suspected in the middle of a list, where the bound is generous', () => {
    const events = gesture([
      at('scroll.write', write({ reason: 'no-room', took: true, from: 9000, room: 9000 })),
    ])
    const verdict = lastGesture(events)
    const found = verdict?.suspects.find((suspect) => suspect.id === 'no-room-at-end')
    expect(found?.confidence).toBe('suspected')
  })

  it('is absent when every correction was banked', () => {
    const events = gesture([at('scroll.write', write({ reason: 'held', took: false }))])
    expect(suspects(events)).not.toContain('no-room-at-end')
  })
})

describe('fold-jump and fold-anchor-loss', () => {
  it('confirms fold-jump when the browser clamped the fold', () => {
    const events = gesture([
      at('scroll.write', write()),
      at('gesture.fold', fold({ shift: 400, target: 20_400, applied: 20_000, clamped: true })),
    ])
    expect(suspects(events)).toContain('fold-jump')
  })

  it('leaves a clean fold alone', () => {
    const events = gesture([at('scroll.write', write()), at('gesture.fold', fold())])
    expect(suspects(events)).not.toContain('fold-jump')
  })

  it('confirms fold-anchor-loss when the anchor was re-derived after a clamped fold', () => {
    const events = gesture([
      at('gesture.fold', fold({ clamped: true, applied: 19_000, target: 20_400 })),
      at('anchor.derive', { offset: 19_000, anchor: null, skipped: null }, 8),
    ])
    expect(suspects(events)).toContain('fold-anchor-loss')
  })

  it('does not report anchor loss after a fold that landed exactly', () => {
    // The false positive this file exists for. An `anchor.derive` after a clean fold is the next
    // scroll event of a fling still running, and calling that a permanent displacement is a
    // confident lie — measured at 0.25px on a real gesture.
    const events = gesture([
      at('gesture.fold', fold()),
      at('anchor.derive', { offset: 5020, anchor: null, skipped: null }, 8),
    ])
    expect(suspects(events)).not.toContain('fold-anchor-loss')
  })

  it('does not report anchor loss when the write was recognised as ours', () => {
    const events = gesture([
      at('gesture.fold', fold({ clamped: true })),
      at('anchor.derive', { offset: 5020, anchor: null, skipped: 'self-write' }, 8),
    ])
    expect(suspects(events)).not.toContain('fold-anchor-loss')
  })
})

describe('scroller-wake', () => {
  it('is suspected when the parked loop woke and wrote', () => {
    const events = gesture([
      at('scroll.park', { elapsed: 100, suspended: 16 }),
      at('scroll.wake', { pending: true, banked: 40 }),
      at('scroll.commit', { offset: 5100, from: 5060, refused: false, banked: 0, carry: 0 }),
    ])
    expect(suspects(events)).toContain('scroller-wake')
  })

  it('is absent when the loop parked and never wrote', () => {
    const events = gesture([
      at('scroll.park', { elapsed: 100, suspended: 16 }),
      at('scroll.wake', { pending: false, banked: 0 }),
    ])
    expect(suspects(events)).not.toContain('scroller-wake')
  })

  it('does not count a refused commit as a write', () => {
    const events = gesture([
      at('scroll.park', { elapsed: 100, suspended: 16 }),
      at('scroll.wake', { pending: true, banked: 40 }),
      at('scroll.commit', { offset: 5100, from: 5060, refused: true, banked: 40, carry: 0 }),
    ])
    expect(suspects(events)).not.toContain('scroller-wake')
  })
})

describe('grace-misfire', () => {
  it('is confirmed when the gate reopened on grace and scrolling continued', () => {
    reset()
    const events = [
      at('gate.attach', { ios: true, attached: false, disposed: false }, 0),
      at('gesture.touch', { phase: 'start', y: 400, dy: 0, ms: 0, moves: 0, velocity: 0 }),
      at('gesture.touch', { phase: 'end', y: 300, dy: 100, ms: 60, moves: 4, velocity: -1.6 }),
      at('scroll.gate', { state: 'grace', reason: 'touchend' }),
      // The window expires because the first momentum scroll was late.
      at('scroll.gate', { state: 'idle', reason: 'grace-expired' }, 160),
      at('scroll.sample', { offset: 5100, carry: 0, shift: 0 }),
      at('scroll.sample', { offset: 5140, carry: 0, shift: 0 }),
      at('scroll.sample', { offset: 5170, carry: 0, shift: 0 }),
      at('scroll.sample', { offset: 5190, carry: 0, shift: 0 }),
    ]
    expect(suspects(events)).toContain('grace-misfire')
  })

  it('is absent for a genuine tap, where nothing scrolls afterwards', () => {
    reset()
    const events = [
      at('gate.attach', { ios: true, attached: false, disposed: false }, 0),
      at('gesture.touch', { phase: 'start', y: 400, dy: 0, ms: 0, moves: 0, velocity: 0 }),
      at('gesture.touch', { phase: 'end', y: 400, dy: 0, ms: 40, moves: 0, velocity: 0 }),
      at('scroll.gate', { state: 'grace', reason: 'touchend' }),
      at('scroll.gate', { state: 'idle', reason: 'grace-expired' }, 160),
    ]
    expect(suspects(events)).not.toContain('grace-misfire')
  })
})

describe('cap', () => {
  it('is confirmed when the momentum watchdog ended the gesture', () => {
    reset()
    const events = [
      at('gate.attach', { ios: true, attached: false, disposed: false }, 0),
      at('gesture.touch', { phase: 'start', y: 700, dy: 0, ms: 0, moves: 0, velocity: 0 }),
      at('gesture.touch', { phase: 'end', y: 100, dy: 600, ms: 120, moves: 8, velocity: -5 }),
      at('scroll.gate', { state: 'grace', reason: 'touchend' }),
      at('scroll.gate', { state: 'momentum', reason: 'momentum-onset' }),
      // A long fling really does keep delivering scroll events for the whole three seconds,
      // so the fixture does too — the watchdog firing is the anomaly, not a gap in the record.
      ...Array.from({ length: 60 }, (_, i) =>
        at('scroll.sample', { offset: 6000 + i * 30, carry: 0, shift: 0 }, 50),
      ),
      at('scroll.gate', { state: 'idle', reason: 'cap' }, 40),
    ]
    expect(suspects(events)).toContain('cap')
  })

  it('is absent when the gesture settled normally', () => {
    expect(suspects(gesture())).not.toContain('cap')
  })
})

describe('model-write', () => {
  it('is suspected when a model change wrote through the gate', () => {
    const events = gesture([
      at('scroll.write', write({ restore: 'model', reason: 'model', took: true, deferred: false })),
    ])
    expect(suspects(events)).toContain('model-write')
  })

  it('is absent when no model change occurred', () => {
    expect(suspects(gesture([at('scroll.write', write())]))).not.toContain('model-write')
  })
})

describe('starvation', () => {
  it('is confirmed when scroll events stopped with a long frame and no write', () => {
    reset()
    const events = [
      at('gate.attach', { ios: true, attached: false, disposed: false }, 0),
      at('gesture.touch', { phase: 'start', y: 700, dy: 0, ms: 0, moves: 0, velocity: 0 }),
      at('scroll.sample', { offset: 5000, carry: 0, shift: 0 }),
      at('gesture.touch', { phase: 'end', y: 400, dy: 300, ms: 80, moves: 5, velocity: -3 }),
      at('scroll.gate', { state: 'momentum', reason: 'momentum-onset' }),
      at('frame.long', { gap: 210, frames: 40 }, 100),
      // The scrollport kept moving; nothing repositioned the rows for 220ms.
      at('scroll.sample', { offset: 5600, carry: 0, shift: 0 }, 120),
      at('scroll.gate', { state: 'idle', reason: 'settled' }),
    ]
    const found = lastGesture(events)?.suspects.find((suspect) => suspect.id === 'starvation')
    expect(found?.confidence).toBe('confirmed')
  })

  it('is absent when a write explains the stop', () => {
    reset()
    const events = [
      at('gate.attach', { ios: true, attached: false, disposed: false }, 0),
      at('gesture.touch', { phase: 'start', y: 700, dy: 0, ms: 0, moves: 0, velocity: 0 }),
      at('scroll.sample', { offset: 5000, carry: 0, shift: 0 }),
      at('gesture.touch', { phase: 'end', y: 400, dy: 300, ms: 80, moves: 5, velocity: -3 }),
      at('scroll.write', write({ reason: 'no-room', took: true, from: 9000, room: 9000 })),
      at('scroll.sample', { offset: 5600, carry: 0, shift: 0 }, 200),
      at('scroll.gate', { state: 'idle', reason: 'settled' }),
    ]
    expect(suspects(events)).not.toContain('starvation')
  })

  it('is absent when events kept arriving at cadence', () => {
    expect(suspects(gesture())).not.toContain('starvation')
  })
})

describe('not-ios', () => {
  it('is confirmed when there is no gate and writes went through', () => {
    const events = gesture(
      [at('scroll.write', write({ reason: 'gate-open', took: true, deferred: false }))],
      { ios: false },
    )
    expect(lastGesture(events)?.gate).toBe('inactive')
    expect(suspects(events)).toContain('not-ios')
  })

  it('is absent where the gate is live', () => {
    const events = gesture([
      at('scroll.write', write({ reason: 'gate-open', took: true, deferred: false })),
    ])
    expect(suspects(events)).not.toContain('not-ios')
  })

  it('reports an unknown platform when nothing said', () => {
    reset()
    const verdict = lastGesture([
      at('gesture.touch', { phase: 'start', y: 400, dy: 0, ms: 0, moves: 0, velocity: 0 }),
      at('scroll.sample', { offset: 100, carry: 0, shift: 0 }),
    ])
    expect(verdict?.gate).toBe('unknown')
  })
})

describe('the numbers a reader reads', () => {
  it('reports the peak held correction from either source', () => {
    const events = gesture([
      at('scroll.write', write({ heldAfter: 120 })),
      at('paint.offset', { px: 300, carry: 0.25, shift: 300 }),
    ])
    expect(lastGesture(events)?.heldPeak).toBe(300)
  })

  it('measures travel from the first and last sample', () => {
    expect(lastGesture(gesture())?.travelPx).toBe(120)
  })

  it('counts the writes by reason', () => {
    const events = gesture([
      at('scroll.write', write({ reason: 'held', took: false })),
      at('scroll.write', write({ reason: 'no-room', took: true, from: 9000, room: 9000 })),
      at('scroll.write', write({ reason: 'gate-open', took: true, deferred: false })),
    ])
    const verdict = lastGesture(events)
    expect(verdict?.writes).toMatchObject({
      taken: 2,
      held: 1,
      byReason: { held: 1, 'no-room': 1, 'gate-open': 1, model: 0 },
    })
  })

  it('records each escape with the room it had and the time since the lift', () => {
    const events = gesture([
      at('scroll.write', write({ reason: 'no-room', took: true, from: 19_950, room: 50 })),
    ])
    const escape = lastGesture(events)?.escapes[0]
    expect(escape).toMatchObject({ reason: 'no-room', room: 50, from: 19_950 })
    expect(escape?.sinceLift).toBeGreaterThan(0)
  })

  it('sums the measurement cost', () => {
    const events = gesture([
      at('measure.done', { count: 8, invalidated: false, ms: 12 }),
      at('measure.done', { count: 3, invalidated: true, ms: 40 }),
    ])
    expect(lastGesture(events)?.measure).toEqual({
      batches: 2,
      totalMs: 52,
      worstMs: 40,
      invalidations: 1,
    })
  })

  it('says when the frame probe was running, since it perturbs what it measures', () => {
    expect(lastGesture(gesture())?.probeRunning).toBe(false)
    const events = gesture([at('frame.long', { gap: 40, frames: 10 })])
    expect(lastGesture(events)?.probeRunning).toBe(true)
  })
})
