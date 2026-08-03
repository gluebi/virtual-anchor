import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScrollWriteGate, type ScrollWriteGate } from './momentum.js'
import type { Viewport } from './viewport.js'

/**
 * The write gate in isolation.
 *
 * Kept apart from `scroller.ios.dom.test.ts` because the state machine has more
 * transitions than the scroller has ways to observe them — a tap that never scrolls
 * and a fling that never settles look identical from the outside until the timers
 * fire, and testing them through the scroller would mean asserting on writes that
 * happen not to occur.
 */
interface Harness {
  gate: ScrollWriteGate
  element: HTMLElement
  advance: (ms: number) => void
  scroll: () => void
  settle: () => void
  opens: () => number
  pendingTimers: () => number
}

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

const harness = (options: { isIOS?: boolean } = {}): Harness => {
  const element = document.createElement('div')
  document.body.appendChild(element)

  let clock = 0
  let opens = 0
  let nextTimer = 0
  const timers = new Map<number, { dueAt: number, callback: () => void }>()
  const listeners = new Map<string, Set<() => void>>()

  const viewport = {
    getScrollOffset: () => 0,
    getViewportSize: () => 600,
    getMaxScrollOffset: () => 10_000,
    setScrollOffset: () => {},
    addEventListener: (type: string, listener: () => void) => {
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
  } as unknown as Viewport

  const gate = createScrollWriteGate({
    viewport,
    setTimer: (callback, ms) => {
      const id = nextTimer++
      timers.set(id, { dueAt: clock + ms, callback })
      return id
    },
    clearTimer: (handle) => {
      timers.delete(handle as number)
    },
    ...(options.isIOS === undefined ? {} : { isIOS: options.isIOS }),
  })
  gate.attach()
  gate.onOpen(() => {
    opens++
  })

  const emit = (type: string): void => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener()
  }

  return {
    gate,
    element,
    advance: (ms) => {
      clock += ms
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
    },
    scroll: () => {
      emit('scroll')
    },
    settle: () => {
      emit('scrollend')
    },
    opens: () => opens,
    pendingTimers: () => timers.size,
  }
}

const touch = (element: HTMLElement, type: 'touchstart' | 'touchend' | 'touchcancel'): void => {
  element.dispatchEvent(new Event(type))
}

describe('the scroll write gate', () => {
  it('is open before anything has happened', () => {
    expect(harness().gate.canWrite()).toBe(true)
  })

  it('shuts while a finger is down', () => {
    const h = harness()
    touch(h.element, 'touchstart')
    expect(h.gate.canWrite()).toBe(false)
  })

  it('stays shut through the grace period after the finger lifts', () => {
    const h = harness()
    touch(h.element, 'touchstart')
    touch(h.element, 'touchend')

    h.advance(149)
    expect(h.gate.canWrite()).toBe(false)
  })

  it('reopens when the grace period expires with no scrolling — a tap', () => {
    const h = harness()
    touch(h.element, 'touchstart')
    touch(h.element, 'touchend')

    h.advance(150)
    expect(h.gate.canWrite()).toBe(true)
    expect(h.opens()).toBe(1)
  })

  it('treats a cancelled touch like a finished one', () => {
    const h = harness()
    touch(h.element, 'touchstart')
    touch(h.element, 'touchcancel')

    h.advance(150)
    expect(h.gate.canWrite()).toBe(true)
  })

  it('stays shut indefinitely while a fling keeps scrolling', () => {
    const h = harness()
    touch(h.element, 'touchstart')
    touch(h.element, 'touchend')
    h.advance(50)
    h.scroll()

    // Ten times the grace period. Nothing here reopens it but a settle or the cap.
    h.advance(1500)
    expect(h.gate.canWrite()).toBe(false)
    expect(h.opens()).toBe(0)
  })

  it('reopens when the platform reports the scrolling has ended', () => {
    const h = harness()
    touch(h.element, 'touchstart')
    touch(h.element, 'touchend')
    h.advance(50)
    h.scroll()
    h.advance(800)

    h.settle()
    expect(h.gate.canWrite()).toBe(true)
    expect(h.opens()).toBe(1)
  })

  it('reopens at the hard cap when no settle ever arrives', () => {
    const h = harness()
    touch(h.element, 'touchstart')
    touch(h.element, 'touchend')
    h.advance(50)
    h.scroll()

    h.advance(2999)
    expect(h.gate.canWrite()).toBe(false)

    h.advance(1)
    expect(h.gate.canWrite()).toBe(true)
    expect(h.opens()).toBe(1)
  })

  it('does not promote a scroll arriving after the grace period to momentum', () => {
    // By then the gate is already open and the event is either the reader starting
    // afresh or the echo of a write. Treating it as momentum onset would shut the
    // gate on a gesture that had finished.
    const h = harness()
    touch(h.element, 'touchstart')
    touch(h.element, 'touchend')
    h.advance(150)
    expect(h.gate.canWrite()).toBe(true)

    h.scroll()
    expect(h.gate.canWrite()).toBe(true)
  })

  it('re-shuts when a second fling begins before the first has settled', () => {
    const h = harness()
    touch(h.element, 'touchstart')
    touch(h.element, 'touchend')
    h.advance(50)
    h.scroll()

    touch(h.element, 'touchstart')
    // The first fling's cap timer must have been cancelled, or it reopens the gate
    // with a finger still on the glass.
    h.advance(5000)
    expect(h.gate.canWrite()).toBe(false)
    expect(h.opens()).toBe(0)
  })

  it('fires onOpen once per shut/open cycle, not once per transition', () => {
    const h = harness()
    for (let i = 0; i < 3; i++) {
      touch(h.element, 'touchstart')
      touch(h.element, 'touchend')
      h.advance(50)
      h.scroll()
      h.settle()
    }
    expect(h.opens()).toBe(3)
  })

  it('ignores a settle that arrives while nothing is in flight', () => {
    const h = harness()
    h.settle()
    expect(h.opens()).toBe(0)
    expect(h.gate.canWrite()).toBe(true)
  })

  it('ignores a touchend with no touchstart before it', () => {
    const h = harness()
    touch(h.element, 'touchend')
    expect(h.gate.canWrite()).toBe(true)
    expect(h.pendingTimers()).toBe(0)
  })

  it('stops an unsubscribed listener being called', () => {
    const h = harness()
    let extra = 0
    const off = h.gate.onOpen(() => {
      extra++
    })
    off()

    touch(h.element, 'touchstart')
    touch(h.element, 'touchend')
    h.advance(150)
    expect(extra).toBe(0)
    expect(h.opens()).toBe(1)
  })

  it('drops its listeners and its pending timer on disposal', () => {
    const h = harness()
    const remove = vi.spyOn(h.element, 'removeEventListener')
    touch(h.element, 'touchstart')
    touch(h.element, 'touchend')
    expect(h.pendingTimers()).toBe(1)

    h.gate.dispose()

    expect(h.pendingTimers()).toBe(0)
    expect(remove).toHaveBeenCalledWith('touchstart', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('touchend', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('touchcancel', expect.any(Function))
    // And it must not be left shut, refusing writes for a list that no longer has
    // a gesture — or indeed a gate.
    expect(h.gate.canWrite()).toBe(true)
  })

  it('refuses to re-attach after disposal', () => {
    const h = harness()
    h.gate.dispose()
    h.gate.attach()

    touch(h.element, 'touchstart')
    expect(h.gate.canWrite()).toBe(true)
  })

  it('is inert off iOS: no listeners, no timers, always open', () => {
    const h = harness({ isIOS: false })
    const add = vi.spyOn(h.element, 'addEventListener')

    touch(h.element, 'touchstart')
    touch(h.element, 'touchend')
    h.scroll()

    expect(h.gate.canWrite()).toBe(true)
    expect(h.pendingTimers()).toBe(0)
    expect(add).not.toHaveBeenCalled()
  })

  it('reports whether it is active, so callers can scope their own iOS guards', () => {
    // The scroller's rubber-band check hangs off this. Applying that test on every
    // platform was a regression the demo's e2e suite caught: Chromium reports an
    // out-of-range offset often enough — mid-clamp, while content grows — that
    // refusing those writes stalled an ordinary scroll outright.
    expect(harness().gate.isActive()).toBe(true)
    expect(harness({ isIOS: false }).gate.isActive()).toBe(false)
  })
})
