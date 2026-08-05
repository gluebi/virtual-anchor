import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pretendIPhone, touch, unpretendIPhone } from './iosPlatform.test.helpers.js'
import { createScrollWriteGate } from './momentum.js'
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


beforeEach(() => {
  document.body.replaceChildren()
  pretendIPhone()
})

afterEach(() => {
  vi.restoreAllMocks()
  unpretendIPhone()
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
  /**
   * Hold the content this far from where `scrollTop` says it is.
   *
   * What the engine does while a gesture refuses its writes: the correction goes onto the
   * item container as a paint offset, so the content sits at `scrollTop + shift` and every
   * item offset is a number in *that* space. The harness had no way to express this at
   * all, which is why eighteen iOS cases passed straight through issue #33.
   *
   * Folded into `scrollTop` when the gate reopens, by a listener registered ahead of the
   * scroller's — see the note at the registration for why the order is the engine's.
   */
  setShift: (value: number) => void
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
  /** Frames the convergence loop currently has queued: 0 means it has parked. */
  queued: () => number
  max: number
}

const harness = (options: { max?: number } = {}): Harness => {
  const element = document.createElement('div')
  document.body.appendChild(element)

  const cache = new SizeCache({ keys: keysFor(1000), defaultEstimate: 100 })
  const max = options.max ?? 99_400
  const writes: number[] = []
  let offset = 0
  let shift = 0
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

  // Built here rather than left to the scroller so its timers run off the same fake
  // clock as `now`. The scroller takes a gate instead of timer options because the
  // options were public API existing only for this line.
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
  })

  // The engine's fold, registered ahead of the scroller's own `gate.onOpen` flush — the
  // order `engine.mount()` establishes, and the invariant the scroller's writes rest on:
  // `scrollTop` owns the shift before any other reopen listener runs, so nothing is ever
  // held with the gate open and a content-space target is a scroll-space one. Flush the
  // other way round and the shift is added on top of a write that already accounted for it.
  gate.onOpen(() => {
    offset += shift
    shift = 0
  })

  const scroller = createScroller({
    viewport,
    writeGate: gate,
    getCache: () => cache,
    getGeometry: () => ({}),
    applyCarry: () => {},
    getContentOffset: () => offset + shift,
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
    cache,
    max,
    writes,
    offset: () => offset,
    setRawOffset: (value) => {
      offset = value
    },
    setShift: (value) => {
      shift = value
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
    queued: () => queue.length,
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

  it('parks the convergence loop while the gate is shut rather than spinning', () => {
    // The gate stays shut for the length of a fling, so re-requesting a frame each
    // time would schedule hundreds of guaranteed-useless main-thread wakeups during
    // momentum. It waits on `gate.onOpen` instead.
    const h = harness()
    touch(h.element, 'touchstart')
    void h.scroller.scrollToIndex(500)

    h.frames(1)
    expect(h.queued()).toBe(0)

    // Still pending, and still nothing scheduled however long the gesture lasts.
    h.frames(20)
    expect(h.queued()).toBe(0)
    expect(h.scroller.isScrolling()).toBe(true)

    // The reopening is what wakes it.
    touch(h.element, 'touchend')
    h.advance(200)
    expect(h.queued()).toBe(1)
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

  describe('with the engine holding a gesture shift', () => {
    // Issue #33: four reads that compared a destination built from item offsets against
    // the raw scroll offset. See `setShift` for the state they were wrong about.

    it('replays the banked correction from where the content is', () => {
      // Deliberately the same script as 'flushes the banked correction when the fling
      // settles' above, which lands at 51_000, with 400px of correction held on top. The
      // landing must not move: the shift is where the content already is, not another
      // 400px of destination.
      const h = harness()
      touch(h.element, 'touchstart')
      h.setShift(400)
      void h.scroller.scrollToIndex(500)
      expect(h.writes).toEqual([])

      touch(h.element, 'touchend')
      h.advance(50)
      h.scroll(1000)
      h.settle()

      // Banked as 49_600 — content at 400, item at 50_000 — and replayed from the content
      // at 1400 once the fold has moved `scrollTop` there. Measured against the raw offset
      // it banks 50_000 and lands 400px past the item.
      expect(h.writes).toEqual([51_000])
    })

    it('does not resolve settled for a target only the scrollbar has reached', async () => {
      // Fully measured, so `scrollToIndex` takes its fast path and reports a result
      // immediately — there is no convergence loop left to correct it afterwards.
      // `scrollTop` is at the item's offset and the content is 400px past it, so the
      // proximity test resolved `settled: true, deviation: 0` about a position the reader
      // is not at, and the correction banked on the way there stayed banked.
      const h = harness()
      for (let i = 0; i < h.cache.length; i++) h.cache.setSize(i, 100)
      touch(h.element, 'touchstart')
      h.setRawOffset(500)
      h.setShift(400)

      const promise = h.scroller.scrollToIndex(5)
      expect(h.scroller.isScrolling()).toBe(true)

      // The gesture ends: the shift folds into `scrollTop`, the banked −400 comes back out
      // of the content, and the loop confirms the landing.
      touch(h.element, 'touchend')
      h.advance(200)
      h.frames(3)

      const result = await promise
      expect(h.offset()).toBe(500)
      expect(result.settled).toBe(true)
      expect(result.deviation).toBe(0)
    })

    it("judges align: 'auto' by where the content is", async () => {
      // `scrollTop` 0 with 1000px held: the reader is looking at [1000, 1600) and item 5 —
      // [500, 600) — is off the top of the screen. Asked of the raw offset, item 5 is the
      // first thing on screen, so 'auto' takes its "already fully visible" branch and
      // returns the current offset as the target. Nothing moves and the promise says it
      // succeeded.
      const h = harness()
      for (let i = 0; i < h.cache.length; i++) h.cache.setSize(i, 100)
      touch(h.element, 'touchstart')
      h.setShift(1000)

      const promise = h.scroller.scrollToIndex(5, { align: 'auto' })
      touch(h.element, 'touchend')
      h.advance(200)
      h.frames(3)

      const result = await promise
      // Item 5's top edge at the top of the viewport, in the space item offsets live in.
      expect(h.offset()).toBe(500)
      expect(result.settled).toBe(true)
    })

    it('reports the distance the content has left to travel', async () => {
      // The number that lies. `deviation` is the caller's only account of where a scroll
      // that did not settle actually ended, and against the raw offset it is out by the
      // whole shift — reported as 50_000 while the content stood 49_600 away.
      const h = harness()
      touch(h.element, 'touchstart')
      h.setShift(400)

      const promise = h.scroller.scrollToIndex(500)
      h.scroller.cancel()

      const result = await promise
      expect(result.settled).toBe(false)
      expect(result.deviation).toBe(49_600)
    })
  })

  it('removes its own input listeners on disposal', () => {
    // The touch listeners moved to the gate, which disposes them itself — covered by
    // `momentum.dom.test.ts`. What is still the scroller's to release is the input set
    // that cancels an in-flight programmatic scroll.
    const h = harness()
    const remove = vi.spyOn(h.element, 'removeEventListener')
    h.scroller.dispose()

    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      expect(remove).toHaveBeenCalledWith(type, expect.any(Function))
    }
  })
})
