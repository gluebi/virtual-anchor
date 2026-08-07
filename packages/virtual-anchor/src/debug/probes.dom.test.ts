import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addTraceListener, type TraceEvent } from '../trace.js'
import { createFrameDriver } from './driver.js'
import { startFrameProbe } from './frameProbe.js'
import { startGestureProbe } from './gestureProbe.js'

/**
 * The two probes, and the shared frame loop underneath them.
 *
 * Both exist to measure the fling without changing it, so most of what is asserted here is what
 * they *do not* do: read layout, emit during a drag, or run more than one rAF loop.
 */

let frames: ((at: number) => void)[] = []
let now = 0
const stop: (() => void)[] = []

/** Advance one frame by `ms`, running whatever rAF callbacks are pending. */
const tick = (ms: number): void => {
  now += ms
  const due = frames
  frames = []
  for (const callback of due) callback(now)
}

beforeEach(() => {
  frames = []
  now = 0
  vi.stubGlobal('requestAnimationFrame', (callback: (at: number) => void) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})

afterEach(() => {
  for (const off of stop) off()
  stop.length = 0
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const collect = (): TraceEvent[] => {
  const events: TraceEvent[] = []
  stop.push(addTraceListener((event) => events.push(event)))
  return events
}

describe('the shared frame driver', () => {
  it('runs one loop however many subscribers there are', () => {
    const driver = createFrameDriver(globalThis.window)
    const a = vi.fn()
    const b = vi.fn()
    stop.push(driver.onFrame(a), driver.onFrame(b))

    tick(16)

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    // One pending callback, not two: two loops would be two main-thread wakeups per frame during
    // the fling being measured, which is the thing the probe reports on.
    expect(frames).toHaveLength(1)
  })

  it('stops when the last subscriber leaves, and starts again on the next', () => {
    const driver = createFrameDriver(globalThis.window)
    const off = driver.onFrame(() => {})
    expect(driver.running()).toBe(true)
    off()
    expect(driver.running()).toBe(false)
    stop.push(driver.onFrame(() => {}))
    expect(driver.running()).toBe(true)
  })

  it('reports the gap between frames, and nothing for the first', () => {
    const driver = createFrameDriver(globalThis.window)
    const gaps: number[] = []
    stop.push(driver.onFrame((_at, gap) => gaps.push(gap)))

    tick(16)
    tick(50)

    expect(gaps).toEqual([0, 50])
  })
})

describe('the frame probe', () => {
  it('reports only the long frames', () => {
    const events = collect()
    const driver = createFrameDriver(globalThis.window)
    const probe = startFrameProbe({ driver, longFrameMs: 32 })

    tick(16)
    tick(16)
    tick(120)

    // Emitting every frame would fill the ring with the ordinary 16ms case and push the gesture
    // that matters out of it.
    const long = events.filter((event) => event.topic === 'frame.long')
    expect(long).toHaveLength(1)
    expect(long[0]?.data.gap).toBe(120)
    expect(probe.longest()).toBe(120)
  })

  it('summarises on stop', () => {
    const events = collect()
    const driver = createFrameDriver(globalThis.window)
    const probe = startFrameProbe({ driver })

    tick(16)
    tick(120)
    probe.stop()

    const summary = events.find((event) => event.topic === 'frame.summary')
    expect(summary?.data).toMatchObject({ frames: 2, longest: 120, over: 1 })
  })

  it('never reads scrollTop, which would force a layout every frame', () => {
    // The default has to be free. Reading `scrollTop` in a rAF callback that runs after the
    // library has written styles forces a synchronous layout on every frame, which changes the
    // stall being hunted.
    const element = document.createElement('div')
    const read = vi.fn(() => 0)
    Object.defineProperty(element, 'scrollTop', { get: read, configurable: true })

    const driver = createFrameDriver(globalThis.window)
    startFrameProbe({ driver })
    tick(16)
    tick(120)

    expect(read).not.toHaveBeenCalled()
  })

  it('reads scrollTop only when explicitly asked', () => {
    const element = document.createElement('div')
    const read = vi.fn(() => 42)
    Object.defineProperty(element, 'scrollTop', { get: read, configurable: true })

    const events = collect()
    const driver = createFrameDriver(globalThis.window)
    startFrameProbe({ driver, sampleScrollTop: { element } })
    tick(16)
    tick(120)

    expect(events.find((event) => event.topic === 'frame.long')?.data.scrollTop).toBe(42)
  })
})

describe('the gesture probe', () => {
  const scroller = (): HTMLElement => {
    const element = document.createElement('div')
    element.className = 'scroller'
    document.body.appendChild(element)
    return element
  }

  afterEach(() => {
    document.body.innerHTML = ''
  })

  /**
   * A touch event, with a timestamp this test controls.
   *
   * `timeStamp` has to be defined rather than assigned: it is a prototype getter, so a plain
   * assignment silently does nothing and every synthetic event ends up sharing one instant —
   * which makes the velocity come out zero and the assertion meaningless.
   */
  let stamp = 0
  const touch = (element: Element, type: string, clientY?: number, advance = 16): void => {
    stamp += advance
    const event = new Event(type, { bubbles: true })
    Object.defineProperty(event, 'timeStamp', { value: stamp })
    if (clientY !== undefined) Object.assign(event, { touches: [{ clientY }] })
    element.dispatchEvent(event)
  }

  it('emits at the start and the lift, and nothing in between', () => {
    const element = scroller()
    const events = collect()
    const probe = startGestureProbe({ target: element })
    stop.push(() => { probe.stop(); })

    touch(element, 'touchstart', 700)
    touch(element, 'touchmove', 600)
    touch(element, 'touchmove', 500)
    touch(element, 'touchmove', 400)
    touch(element, 'touchend', 400)

    // A `touchmove` at 120Hz would fill the recorder with the least interesting part of the
    // gesture, and the drag is not the part that misbehaves.
    const phases = events.filter((e) => e.topic === 'gesture.touch').map((e) => e.data.phase)
    expect(phases).toEqual(['start', 'end'])
  })

  it('reports the direction of travel and how many moves it saw', () => {
    const element = scroller()
    const events = collect()
    const probe = startGestureProbe({ target: element })
    stop.push(() => { probe.stop(); })

    touch(element, 'touchstart', 700)
    touch(element, 'touchmove', 600)
    touch(element, 'touchmove', 500)
    touch(element, 'touchend', 500)

    const end = events.filter((e) => e.topic === 'gesture.touch').at(-1)
    expect(end?.data).toMatchObject({ phase: 'end', dy: 200, moves: 2 })
    // A finger moving up scrolls the content down, so the sign matches a scroll offset.
    expect(Number(end?.data.velocity)).toBeGreaterThan(0)
  })

  it('still opens a gesture for a synthesised event with no coordinates', () => {
    // Not hypothetical: `e2e/ios-momentum.spec.ts` dispatches a plain `new Event('touchstart')`
    // deliberately, because `page.touchscreen.tap` also lifts the finger. A probe that required
    // coordinates emitted nothing for those, and the analyzer then found no gesture at all.
    const element = scroller()
    const events = collect()
    const probe = startGestureProbe({ target: element })
    stop.push(() => { probe.stop(); })

    touch(element, 'touchstart')
    touch(element, 'touchend')

    expect(events.filter((e) => e.topic === 'gesture.touch').map((e) => e.data.phase)).toEqual([
      'start',
      'end',
    ])
  })

  it('ignores a move with no coordinates rather than reading it as a jump to zero', () => {
    const element = scroller()
    const events = collect()
    const probe = startGestureProbe({ target: element })
    stop.push(() => { probe.stop(); })

    touch(element, 'touchstart', 700)
    touch(element, 'touchmove')
    touch(element, 'touchend', 700)

    const end = events.filter((e) => e.topic === 'gesture.touch').at(-1)
    expect(end?.data).toMatchObject({ dy: 0, moves: 0 })
  })

  it('reports a cancel distinctly from a lift', () => {
    const element = scroller()
    const events = collect()
    const probe = startGestureProbe({ target: element })
    stop.push(() => { probe.stop(); })

    touch(element, 'touchstart', 700)
    touch(element, 'touchcancel', 700)

    expect(events.filter((e) => e.topic === 'gesture.touch').at(-1)?.data.phase).toBe('cancel')
  })

  it('waits for a target that does not exist yet', () => {
    // The scrollport is created during React's render, and the listener has to be installed
    // before that — so resolution is retried rather than assumed.
    const events = collect()
    const probe = startGestureProbe({ target: '.scroller' })
    stop.push(() => { probe.stop(); })
    expect(probe.attached()).toBe(false)

    const element = scroller()
    tick(16)
    expect(probe.attached()).toBe(true)

    touch(element, 'touchstart', 700)
    expect(events.some((e) => e.topic === 'gesture.touch')).toBe(true)
  })

  it('unbinds on stop', () => {
    const element = scroller()
    const probe = startGestureProbe({ target: element })
    probe.stop()

    const events = collect()
    touch(element, 'touchstart', 700)
    expect(events).toHaveLength(0)
  })
})
