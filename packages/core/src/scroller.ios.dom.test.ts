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

  const viewport: Viewport = {
    getScrollOffset: () => offset,
    getViewportSize: () => 600,
    getMaxScrollOffset: () => max,
    setScrollOffset: (next) => {
      writes.push(next)
      offset = Math.min(Math.max(next, 0), max)
    },
    getContentClientTop: () => 0,
    addEventListener: () => () => {},
    getElement: () => element,
    getWindow: () => window,
    getDevicePixelRatio: () => 2,
  }

  const scroller = createScroller({
    viewport,
    getCache: () => cache,
    getGeometry: () => ({}),
    applyCarry: () => {},
    now: () => clock,
    requestFrame: (callback) => {
      queue.push(callback)
      return queue.length
    },
    cancelFrame: () => {
      queue = []
    },
  })

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
    advance: (ms) => {
      clock += ms
    },
    frames: (n) => {
      for (let i = 0; i < n; i++) {
        const pendingFrames = queue
        queue = []
        clock += 16
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

  it('writes once the grace period has elapsed', () => {
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

  it('flushes the banked correction on a later scroll event', () => {
    const h = harness()
    touch(h.element, 'touchstart')
    void h.scroller.scrollToIndex(500)
    expect(h.writes).toEqual([])

    // The fling ends and scrolling settles somewhere.
    touch(h.element, 'touchend')
    h.advance(200)
    h.scroller.notifyScroll(1000)

    // The banked delta is applied relative to where the scroll actually is.
    expect(h.offset()).toBe(51_000)
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
