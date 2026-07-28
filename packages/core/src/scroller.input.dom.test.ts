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
    getContentClientTop: () => 0,
    addEventListener: () => () => {},
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

  it('attaches its input listeners passively', () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const add = vi.spyOn(element, 'addEventListener')

    const cache = new SizeCache({ keys: keysFor(10) })
    createScroller({
      viewport: {
        getScrollOffset: () => 0,
        getViewportSize: () => 600,
        getMaxScrollOffset: () => 1000,
        setScrollOffset: () => {},
        getContentClientTop: () => 0,
        addEventListener: () => () => {},
        getElement: () => element,
        getWindow: () => window,
        getDevicePixelRatio: () => 1,
      },
      getCache: () => cache,
      getGeometry: () => ({}),
      applyCarry: () => {},
    })

    // A non-passive wheel listener on a scroller is a scroll-performance problem.
    expect(add).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: true })
  })
})
