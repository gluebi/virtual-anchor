import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { trace } from '../trace.js'
import { installDebug, type DebugSession } from './install.js'

/**
 * The one-call entry point, which is what a consumer diagnosing a phone actually uses.
 *
 * Most of what is asserted here is composition — that the recorder, the probes, the overlay and
 * the console report are wired together and all come apart again — plus the two behaviours that
 * are only correct at this level: the conclusion is reported once per gesture, and it is reported
 * *after* the gesture has stopped moving rather than when the finger lifts.
 */

let frames: ((at: number) => void)[] = []
let session: DebugSession | null = null

const tick = (): void => {
  const due = frames
  frames = []
  for (const callback of due) callback(performance.now())
}

beforeEach(() => {
  vi.useFakeTimers()
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: (at: number) => void) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const scroller = document.createElement('div')
  scroller.className = 'scroller'
  document.body.appendChild(scroller)
})

afterEach(() => {
  session?.dispose()
  session = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** touchstart → a scroll → settle. */
const gesture = (): void => {
  trace('gesture.touch', () => ({ phase: 'start', y: 400, dy: 0, ms: 0, moves: 0, velocity: 0 }))
  trace('scroll.sample', () => ({ offset: 100, carry: 0, shift: 0 }))
  trace('gesture.touch', () => ({ phase: 'end', y: 300, dy: 100, ms: 60, moves: 3, velocity: -1 }))
  trace('scroll.gate', () => ({ state: 'idle', reason: 'settled' }))
}

describe('installing everything at once', () => {
  it('records, analyses and mounts a readout', () => {
    session = installDebug({ target: '.scroller' })
    gesture()

    expect(session.recorder.size()).toBeGreaterThan(0)
    expect(session.verdict()?.ended).toBe('settled')
    expect(session.gestures()).toHaveLength(1)
    expect(document.querySelector('[data-virtual-anchor-hud]')).not.toBeNull()
    expect(session.available).toBe(true)
  })

  it('can be installed without a readout, for a headless recording', () => {
    session = installDebug({ target: '.scroller', overlay: false })
    expect(session.hud).toBeNull()
    expect(document.querySelector('[data-virtual-anchor-hud]')).toBeNull()
    gesture()
    expect(session.verdict()).not.toBeNull()
  })

  it('runs one frame loop for the probe and the readout together', () => {
    session = installDebug({ target: '.scroller' })
    tick()
    // Two loops would be two main-thread wakeups per frame during the fling being measured.
    expect(frames).toHaveLength(1)
  })

  it('can leave the frame probe off, to confirm a timing finding without it', () => {
    session = installDebug({ target: '.scroller', frameProbe: false })
    gesture()
    expect(session.verdict()?.probeRunning).toBe(false)
  })

  it('honours a topic filter and a capacity', () => {
    session = installDebug({
      target: '.scroller',
      overlay: false,
      capacity: 2,
      topics: ['scroll.'],
    })
    trace('anchor.derive', () => ({ offset: 1, anchor: null, skipped: null }))
    trace('scroll.sample', () => ({ offset: 1, carry: 0, shift: 0 }))
    trace('scroll.sample', () => ({ offset: 2, carry: 0, shift: 0 }))
    trace('scroll.sample', () => ({ offset: 3, carry: 0, shift: 0 }))

    expect(session.recorder.size()).toBe(2)
    expect(session.recorder.dropped()).toBe(1)
    expect(session.recorder.select().every((event) => event.topic.startsWith('scroll.'))).toBe(true)
  })

  it('exports the record as JSON', () => {
    session = installDebug({ target: '.scroller', overlay: false })
    gesture()
    const parsed = JSON.parse(session.toJSON()) as { events: unknown[] }
    expect(parsed.events.length).toBeGreaterThan(0)
  })

  it('takes everything apart again', () => {
    session = installDebug({ target: '.scroller' })
    session.dispose()

    expect(document.querySelector('[data-virtual-anchor-hud]')).toBeNull()
    trace('scroll.sample', () => ({ offset: 1, carry: 0, shift: 0 }))
    expect(session.recorder.size()).toBe(0)
    session = null
  })
})

describe('reporting the conclusion to the console', () => {
  it('waits until the gesture has stopped moving', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    session = installDebug({ target: '.scroller', overlay: false })

    gesture()
    // `touchend` is not the end of the scrolling on iOS — momentum runs on for seconds — so a
    // conclusion drawn at the lift would describe a fling before the part that misbehaves.
    expect(log).not.toHaveBeenCalled()

    vi.advanceTimersByTime(400)
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]?.[0])).toContain('ended: settled')
  })

  it('reports each gesture exactly once', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    session = installDebug({ target: '.scroller', overlay: false })

    gesture()
    vi.advanceTimersByTime(400)
    // A later event must not re-fire the timer and print the same conclusion again, which on a
    // phone is indistinguishable from a second bad fling.
    trace('scroll.sample', () => ({ offset: 999, carry: 0, shift: 0 }))
    vi.advanceTimersByTime(400)

    expect(log).toHaveBeenCalledTimes(1)
  })

  it('warns rather than logs when a suspect is confirmed', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    session = installDebug({ target: '.scroller', overlay: false })

    trace('gate.attach', () => ({ ios: false, attached: false, disposed: false }))
    trace('gesture.touch', () => ({ phase: 'start', y: 400, dy: 0, ms: 0, moves: 0, velocity: 0 }))
    trace('scroll.sample', () => ({ offset: 100, carry: 0, shift: 0 }))
    trace('scroll.write', () => ({
      restore: 'measure',
      reason: 'gate-open',
      took: true,
      offset: 200,
      from: 100,
      delta: 100,
      deferred: false,
      pendingShift: 0,
      heldAfter: 0,
      room: 5000,
      max: 20_000,
    }))
    trace('gesture.touch', () => ({ phase: 'end', y: 300, dy: 100, ms: 60, moves: 3, velocity: -1 }))
    vi.advanceTimersByTime(400)

    // A finding should be hard to miss in a busy console; a clean gesture must not look like one.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toContain('not-ios')
  })

  it('routes the conclusion elsewhere when asked', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mine = vi.fn()
    session = installDebug({ target: '.scroller', overlay: false, log: mine })

    gesture()
    vi.advanceTimersByTime(400)

    expect(mine).toHaveBeenCalledTimes(1)
    expect(mine.mock.calls[0]?.[1]).toContain('ended: settled')
    expect(log).not.toHaveBeenCalled()
  })

  it('says nothing at all when reporting is off', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    session = installDebug({ target: '.scroller', overlay: false, log: false })

    gesture()
    vi.advanceTimersByTime(400)

    expect(log).not.toHaveBeenCalled()
  })
})
