import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScroller, type Scroller } from './scroller.js'
import { SizeCache } from './sizeCache.js'
import type { ItemKey } from './types.js'
import type { Viewport } from './viewport.js'

/**
 * iOS WebKit cancels an in-progress fling the instant `scrollTop` is written, so
 * corrections have to be banked until the gesture is demonstrably finished.
 * `react-window` v2 has none of this handling at all; both TanStack Virtual and
 * virtua carry roughly a hundred lines of it, independently arrived at.
 *
 * These tests impersonate an iPhone, so they need a DOM for the touch listeners.
 */
const keysFor = (n: number): ItemKey[] => Array.from({ length: n }, (_, i) => `c${String(i)}`)

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

const patched: string[] = []
const pretendIPhone = (): void => {
  const values: Record<string, unknown> = {
    userAgent: IPHONE_UA,
    platform: 'iPhone',
    maxTouchPoints: 5,
  }
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(navigator, name, { configurable: true, get: () => value })
    patched.push(name)
  }
  Object.defineProperty(window, 'ontouchend', { configurable: true, value: null })
}

beforeEach(() => {
  document.body.replaceChildren()
  pretendIPhone()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const name of patched) Reflect.deleteProperty(navigator, name)
  patched.length = 0
  Reflect.deleteProperty(window, 'ontouchend')
})

interface Harness {
  scroller: Scroller
  element: HTMLElement
  cache: SizeCache
  offset: () => number
  /**
   * Set the offset the way the *browser* would, bypassing the clamp.
   *
   * Needed to simulate rubber-band overscroll, where iOS genuinely reports an
   * offset outside [0, max] while the bounce is in progress. `notifyScroll` only
   * tells the scroller what happened; it does not move anything.
   */
  setRawOffset: (value: number) => void
  writes: number[]
  advance: (ms: number) => void
  frames: (n: number) => void
  /**
   * One frame of momentum: the platform moves the offset and fires `scroll`.
   *
   * The event is what the write gate watches — it is how a fling is told apart from
   * a tap, neither of which has any other signature.
   */
  scroll: (next: number) => void
  /** The platform reporting that the scrolling is over. */
  settle: () => void
  max: number
}

const harness = (options: { max?: number } = {}): Harness => {
  const element = document.createElement('div')
  document.body.appendChild(element)

  const cache = new SizeCache({ keys: keysFor(1000), defaultEstimate: 100 })
  const max = options.max ?? 99_400
  const writes: number[] = []
  let offset = 0
  let clock = 0
  let queue: (() => void)[] = []

  // A real registry, not the no-op stub this used to be. The gate and the settle
  // helper both subscribe through the viewport, so a stub meant neither could ever
  // be told a fling had started or finished — which is why none of this was tested.
  const listeners = new Map<string, Set<() => void>>()
  const emit = (type: string): void => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener()
  }

  // One clock for everything. Driving `now()` and the gate's timers from separate
  // sources lets them disagree about whether a fling is still running, which is a
  // state the real thing cannot be in.
  let nextTimer = 0
  const timers = new Map<number, { dueAt: number, callback: () => void }>()
  const runDueTimers = (): void => {
    // Bounded: a callback may arm another timer, and only a bug would do so with a
    // non-positive delay — but a test suite should fail rather than hang if it does.
    for (let guard = 0; guard < 100; guard++) {
      const due = [...timers]
        .filter(([, timer]) => timer.dueAt <= clock)
        .sort((a, b) => a[1].dueAt - b[1].dueAt)
      if (due.length === 0) return
      for (const [id, timer] of due) {
        timers.delete(id)
        timer.callback()
      }
    }
    throw new Error('timer callbacks kept re-arming')
  }
  const tick = (ms: number): void => {
    clock += ms
    runDueTimers()
  }

  const viewport: Viewport = {
    getScrollOffset: () => offset,
    getViewportSize: () => 600,
    getMaxScrollOffset: () => max,
    setScrollOffset: (next) => {
      writes.push(next)
      offset = Math.min(Math.max(next, 0), max)
    },
    addEventListener: (type, listener) => {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    },
    observeSize: () => () => {},
    getGateTarget: () => element,
    getElement: () => element,
    getScrollportElement: () => element,
    getWindow: () => window,
    getDevicePixelRatio: () => 2,
  }

  const scroller = createScroller({
    viewport,
    getCache: () => cache,
    getGeometry: () => ({}),
    applyCarry: () => {},
    now: () => clock,
    setTimer: (callback, ms) => {
      const id = nextTimer++
      timers.set(id, { dueAt: clock + ms, callback })
      return id
    },
    clearTimer: (handle) => {
      timers.delete(handle as number)
    },
    requestFrame: (callback) => {
      queue.push(callback)
      return queue.length
    },
    cancelFrame: () => {
      queue = []
    },
  })

  // Listeners are bound by `attach()`, not by construction — see the scroller's own
  // note on why building one is inert.
  scroller.attach()

  return {
    scroller,
    element,
    cache,
    max,
    writes,
    offset: () => offset,
    setRawOffset: (value) => {
      offset = value
    },
    advance: tick,
    scroll: (next) => {
      offset = next
      emit('scroll')
      scroller.notifyScroll(next)
    },
    settle: () => {
      emit('scrollend')
    },
    frames: (n) => {
      for (let i = 0; i < n; i++) {
        const pendingFrames = queue
        queue = []
        tick(16)
        for (const frame of pendingFrames) frame()
      }
    },
  }
}

const touch = (element: HTMLElement, type: 'touchstart' | 'touchend' | 'touchcancel'): void => {
  element.dispatchEvent(new Event(type))
}

describe('scroller on iOS WebKit', () => {
  it('refuses to write while a finger is down', () => {
    const h = harness()
    touch(h.element, 'touchstart')

    void h.scroller.scrollToIndex(500)
    expect(h.writes).toEqual([])
    expect(h.offset()).toBe(0)
  })

  it('still refuses immediately after the finger lifts', () => {
    // iOS fires touch events only at the start of momentum, so the end of the
    // gesture is not the end of the scrolling — hence a grace period rather than
    // trusting touchend.
    const h = harness()
    touch(h.element, 'touchstart')
    touch(h.element, 'touchend')

    void h.scroller.scrollToIndex(500)
    expect(h.writes).toEqual([])
  })

  it('writes once the grace period elapses with no scrolling at all', () => {
    // A tap, not a fling: nothing ever scrolled, so the grace timer is the only
    // thing that can reopen the gate. Without it a stationary press would shut the
    // list's corrections down for good.
    const h = harness()
    touch(h.element, 'touchstart')
    touch(h.element, 'touchend')
    h.advance(200)

    void h.scroller.scrollToIndex(500)
    expect(h.offset()).toBe(50_000)
  })

  it('treats a cancelled touch like a finished one', () => {
    const h = harness()
    touch(h.element, 'touchstart')
    touch(h.element, 'touchcancel')
    h.advance(200)

    void h.scroller.scrollToIndex(500)
    expect(h.offset()).toBe(50_000)
  })

  it('keeps refusing for as long as the fling keeps scrolling', () => {
    // The regression this whole gate exists for. The grace period is 150ms and a
    // real fling runs for one to three seconds, so a guard built only out of that
    // timer reopens mid-momentum and the next correction kills the scroll.
    const h = harness()
    touch(h.element, 'touchstart')
    touch(h.element, 'touchend')

    // Momentum carries the list along, well past the grace period.
    for (let i = 1; i <= 10; i++) {
      h.advance(100)
      h.scroll(i * 400)
    }

    void h.scroller.scrollToIndex(500)
    expect(h.writes).toEqual([])
  })

  it('flushes the banked correction when the fling settles, with no further scroll', () => {
    // The reopening is the *last* thing that happens, so a flush that waited for a
    // subsequent scroll event would wait forever.
    const h = harness()
    touch(h.element, 'touchstart')
    void h.scroller.scrollToIndex(500)
    expect(h.writes).toEqual([])

    touch(h.element, 'touchend')
    h.advance(50)
    h.scroll(1000)
    expect(h.writes).toEqual([])

    h.settle()

    // The banked delta is applied relative to where the fling actually left it.
    expect(h.offset()).toBe(51_000)
  })

  it('reopens at the hard cap when the platform never reports a settle', () => {
    const h = harness()
    touch(h.element, 'touchstart')
    touch(h.element, 'touchend')
    h.advance(50)
    h.scroll(1000)

    // No `scrollend` ever arrives. Without the cap the gate would stay shut for the
    // life of the list.
    h.advance(3100)

    void h.scroller.scrollToIndex(500)
    expect(h.offset()).toBe(50_000)
  })

  it('stays shut when a second fling starts before the first has settled', () => {
    const h = harness()
    touch(h.element, 'touchstart')
    touch(h.element, 'touchend')
    h.advance(50)
    h.scroll(1000)

    // A finger comes back down mid-momentum. The first fling's cap timer must not
    // reopen the gate underneath it.
    touch(h.element, 'touchstart')
    h.advance(3100)

    void h.scroller.scrollToIndex(500)
    expect(h.writes).toEqual([])
  })

  it('does not spend the scroll deadline while the gate is shut', () => {
    // A `scrollToIndex` issued during a fling is refused for as long as the fling
    // lasts. If its deadline clock ran through that, it would resolve `deadline`
    // with a large deviation for a scroll never given a chance to write.
    const h = harness()
    touch(h.element, 'touchstart')
    void h.scroller.scrollToIndex(500)

    // Well past SOFT_DEADLINE_MS of 2000, all of it blocked. `isScrolling` rather
    // than the promise: resolution is a microtask, so awaiting it would pass whether
    // or not the loop had already given up.
    h.frames(200)
    expect(h.scroller.isScrolling()).toBe(true)
    expect(h.writes).toEqual([])

    // And it still lands once the gesture is over, rather than having quietly
    // expired while it waited.
    touch(h.element, 'touchend')
    h.advance(200)
    h.frames(3)
    expect(h.offset()).toBe(50_000)
  })

  it('refuses to write during rubber-band overscroll past the top', () => {
    // Writing while the bounce is in progress snaps the page to the clamped value
    // the moment it ends.
    const h = harness()
    h.advance(500)
    h.setRawOffset(-40)

    void h.scroller.scrollToIndex(500)
    expect(h.writes).toEqual([])
  })

  it('refuses to write during rubber-band overscroll past the bottom', () => {
    const h = harness({ max: 1000 })
    h.advance(500)
    h.setRawOffset(1040)

    void h.scroller.scrollToIndex(0)
    expect(h.writes).toEqual([])
  })

  it('writes normally once the bounce has settled back in range', () => {
    const h = harness()
    h.advance(500)
    h.setRawOffset(-40)
    void h.scroller.scrollToIndex(500)
    expect(h.writes).toEqual([])

    h.setRawOffset(0)
    void h.scroller.scrollToIndex(500)
    expect(h.offset()).toBe(50_000)
  })

  it('drops a negative banked correction at the bottom clamp', () => {
    // The browser already absorbed the shrink by clamping; replaying it would
    // lift the list off the end of the scroller.
    const h = harness({ max: 1000 })
    touch(h.element, 'touchstart')
    void h.scroller.scrollToIndex(0)
    touch(h.element, 'touchend')
    h.advance(200)

    // Scrolling has settled hard against the bottom.
    h.scroller.notifyScroll(1000)
    expect(h.offset()).toBe(0)
  })

  it('discards a banked correction when a new absolute scroll is requested', () => {
    const h = harness()
    touch(h.element, 'touchstart')
    void h.scroller.scrollToIndex(500)

    touch(h.element, 'touchend')
    h.advance(200)
    // A fresh command supersedes whatever was banked.
    void h.scroller.scrollToIndex(10)

    expect(h.offset()).toBe(1000)
  })

  it('discards a banked correction on cancel', () => {
    const h = harness()
    touch(h.element, 'touchstart')
    void h.scroller.scrollToIndex(500)
    h.scroller.cancel()

    touch(h.element, 'touchend')
    h.advance(200)
    h.setRawOffset(1000)
    h.scroller.notifyScroll(1000)

    // Nothing is replayed: the cancelled scroll left nothing to flush.
    expect(h.writes).toEqual([])
    expect(h.offset()).toBe(1000)
  })

  it('removes its touch listeners on disposal', () => {
    const h = harness()
    const remove = vi.spyOn(h.element, 'removeEventListener')
    h.scroller.dispose()

    expect(remove).toHaveBeenCalledWith('touchstart', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('touchend', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('touchcancel', expect.any(Function))
  })
})
