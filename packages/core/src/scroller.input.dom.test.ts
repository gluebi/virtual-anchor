import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScroller, type Scroller } from './scroller.js'
import { SizeCache } from './sizeCache.js'
import type { ItemKey } from './types.js'
import type { Viewport } from './viewport.js'

/**
 * Cancellation on genuine user input.
 *
 * A programmatic scroll must get out of the way the moment the user takes over —
 * fighting someone's thumb or scroll wheel is never right. But the signal has to
 * be an actual input event, not an unrecognised scroll offset: the browser adjusts
 * `scrollTop` itself when content shrinks or a window of items is replaced, and
 * treating that as input cancels scrolls nobody asked to cancel.
 */
const keysFor = (n: number): ItemKey[] => Array.from({ length: n }, (_, i) => `c${String(i)}`)

interface Harness {
  scroller: Scroller
  element: HTMLElement
  frames: (n: number) => void
}

const harness = (): Harness => {
  const element = document.createElement('div')
  document.body.appendChild(element)

  const cache = new SizeCache({ keys: keysFor(1000), defaultEstimate: 100 })
  let offset = 0
  let clock = 0
  let queue: (() => void)[] = []

  const viewport: Viewport = {
    getScrollOffset: () => offset,
    getViewportSize: () => 600,
    getMaxScrollOffset: () => 99_400,
    setScrollOffset: (next) => {
      offset = Math.min(Math.max(next, 0), 99_400)
    },
    addEventListener: () => () => {},
    observeSize: () => () => {},
    getGateTarget: () => element,
    getElement: () => element,
    getWindow: () => window,
    getDevicePixelRatio: () => 1,
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

  // Listeners are bound by `attach()`, not by construction — see the scroller's own
  // note on why building one is inert.
  scroller.attach()

  return {
    scroller,
    element,
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

beforeEach(() => {
  document.body.replaceChildren()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('scroller cancellation on user input', () => {
  it.each(['wheel', 'touchstart', 'pointerdown', 'keydown'] as const)(
    'gives way to a %s',
    async (type) => {
      const h = harness()
      const promise = h.scroller.scrollToIndex(500)
      expect(h.scroller.isScrolling()).toBe(true)

      h.element.dispatchEvent(new Event(type))

      await expect(promise).resolves.toMatchObject({ settled: false })
      expect(h.scroller.isScrolling()).toBe(false)
    },
  )

  it('ignores input when nothing is in flight', () => {
    const h = harness()
    expect(() => {
      h.element.dispatchEvent(new Event('wheel'))
    }).not.toThrow()
    expect(h.scroller.isScrolling()).toBe(false)
  })

  it('stops listening for input after disposal', () => {
    const h = harness()
    const remove = vi.spyOn(h.element, 'removeEventListener')
    h.scroller.dispose()

    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      expect(remove).toHaveBeenCalledWith(type, expect.any(Function))
    }
  })

  it('binds no listeners until attached, then binds them passively', () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const add = vi.spyOn(element, 'addEventListener')

    const cache = new SizeCache({ keys: keysFor(10) })
    const scroller = createScroller({
      viewport: {
        getScrollOffset: () => 0,
        getViewportSize: () => 600,
        getMaxScrollOffset: () => 1000,
        setScrollOffset: () => {},
            addEventListener: () => () => {},
    observeSize: () => () => {},
    getGateTarget: () => element,
        getElement: () => element,
        getWindow: () => window,
        getDevicePixelRatio: () => 1,
      },
      getCache: () => cache,
      getGeometry: () => ({}),
      applyCarry: () => {},
    })

    // Construction is inert. It has to be: a scroller built speculatively — by a
    // React `useMemo`, or a `setState` updater React chose to run twice — would
    // otherwise bind listeners with nothing holding the handle that could remove them.
    expect(add).not.toHaveBeenCalled()

    scroller.attach()
    // A non-passive wheel listener on a scroller is a scroll-performance problem.
    expect(add).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: true })

    // Idempotent, so a double mount cannot double-bind.
    add.mockClear()
    scroller.attach()
    expect(add).not.toHaveBeenCalled()
  })
})

describe('settle detection', () => {
  const scrollerWith = (
    onEvents: 'scrollend' | 'scroll-only',
  ): { scroller: Scroller; fire: (type: string) => void; frames: (n: number) => void } => {
    const element = document.createElement('div')
    document.body.appendChild(element)

    if (onEvents === 'scrollend') {
      Object.defineProperty(window, 'onscrollend', { configurable: true, value: null })
    } else {
      Reflect.deleteProperty(window, 'onscrollend')
    }

    const listeners = new Map<string, (() => void)[]>()
    const cache = new SizeCache({ keys: keysFor(1000), defaultEstimate: 100 })
    let offset = 0
    let clock = 0
    let queue: (() => void)[] = []

    const scroller = createScroller({
      viewport: {
        getScrollOffset: () => offset,
        getViewportSize: () => 600,
        getMaxScrollOffset: () => 99_400,
        setScrollOffset: (next) => {
          offset = next
        },
        addEventListener: (type, listener) => {
          const existing = listeners.get(type) ?? []
          existing.push(listener)
          listeners.set(type, existing)
          return () => {
            listeners.set(
              type,
              (listeners.get(type) ?? []).filter((l) => l !== listener),
            )
          }
        },
        observeSize: () => () => {},
        getGateTarget: () => element,
        getElement: () => element,
        getWindow: () => window,
        getDevicePixelRatio: () => 1,
      },
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
    scroller.attach()

    return {
      scroller,
      fire: (type) => {
        for (const listener of [...(listeners.get(type) ?? [])]) listener()
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

  afterEach(() => {
    Reflect.deleteProperty(window, 'onscrollend')
  })

  it('settles as soon as the platform reports scrolling has ended', async () => {
    // The rAF loop is what establishes that the *target* has stopped moving; `scrollend`
    // adds only latency, by removing the need to wait out the measurement-quiet window
    // once the platform says the scrolling itself is over.
    const h = scrollerWith('scrollend')
    const promise = h.scroller.scrollToIndex(42)

    h.fire('scrollend')
    h.frames(3)
    await expect(promise).resolves.toMatchObject({ settled: true, reason: 'converged' })
  })

  it('falls back to a debounced scroll where scrollend is unavailable', async () => {
    // Older Safari. The loop's own deadline means neither path can hang; this asserts
    // the fallback produces the same outcome.
    vi.useFakeTimers()
    try {
      const h = scrollerWith('scroll-only')
      const promise = h.scroller.scrollToIndex(42)

      h.fire('scroll')
      vi.advanceTimersByTime(200)
      h.frames(3)
      await expect(promise).resolves.toMatchObject({ settled: true, reason: 'converged' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not treat scrolling as settled once a measurement moves the target', async () => {
    const h = scrollerWith('scrollend')
    const promise = h.scroller.scrollToIndex(500)

    h.fire('scrollend')
    // A measurement means the model just moved, so the earlier report says nothing about
    // the target being stable any more.
    h.scroller.notifyMeasured()
    h.frames(2)

    expect(h.scroller.isScrolling()).toBe(true)
    h.fire('scrollend')
    h.frames(3)
    await expect(promise).resolves.toMatchObject({ settled: true })
  })
})
