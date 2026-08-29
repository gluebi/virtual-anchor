import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pretendIPhone, touch, unpretendIPhone } from './iosPlatform.test.helpers.js'
import { createEngine, layoutSignatureFor, type Engine } from './engine.js'
import {
  acceptedScrollOffset,
  FakeResizeObserver,
  harnessState,
  installObservers,
  maxOffsetFor,
  recordingSurface,
} from './engineHarness.test.helpers.js'
import { collectTrace } from './trace.test.helpers.js'
import { setTraceSink, type TraceEvent } from './trace.js'
import type { ItemKey, SlotName } from './types.js'
import type { Viewport } from './viewport.js'

/**
 * The engine's own scroll writes, on iOS.
 *
 * There were no engine-level iOS tests at all, which is exactly why issue #26
 * survived: the guard against writing `scrollTop` during a fling lived inside the
 * scroller and was tested there, while `engine.publish()` wrote straight past it
 * from six different triggers. Every one of those is a row in this file.
 *
 * The distinction under test is not "does it write" but *why* it was going to. A
 * measurement landing is postponable, because the fling is already moving the view by
 * more than the correction would; a prepend is not, because skipping it moves the
 * reader by the whole inserted height.
 */

const KEYS = (count: number, prefix = 'c'): ItemKey[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i)}`)

/**
 * Collect trace events for one test.
 *
 * At module scope because two adjacent `describe`s each had a byte-identical copy of it, along with
 * a byte-identical `afterEach`. The shared helper is in `trace.test.helpers.ts`.
 */
const collected: (() => void)[] = []
/**
 * How far the content moved across the fold, per the `gesture.fold` payload.
 *
 * The fold's own arithmetic is the only witness to this. Asserting the content position
 * afterwards does not work: a later anchor restore corrects it, so the end state is right
 * either way and the discontinuity lives entirely in the frame between them — which is the
 * frame the reader sees. `reconcileGestureShift` says as much where it emits this.
 */
const foldDelta = (events: TraceEvent[]): number => {
  const fold = events.find((event) => event.topic === 'gesture.fold')
  if (!fold) return Number.NaN
  const data = fold.data as Record<string, number | undefined>
  const before = Number(data.from) + Number(data.shift) + Number(data.carryBefore)
  return Math.abs(before - (Number(data.applied) + Number(data.carryAfter)))
}

const traced = (): TraceEvent[] => {
  const { events, stop } = collectTrace()
  collected.push(stop)
  return events
}
afterEach(() => {
  for (const stop of collected) stop()
  collected.length = 0
})


interface Harness {
  engine: Engine
  scroller: HTMLElement
  /** Just the scroll writes, which is what this file is about. */
  scrollWrites: () => number[]
  /**
   * Every paint offset handed to the surface, in order.
   *
   * Carry and gesture shift arrive summed, since they share one `top`. They are told
   * apart by magnitude: the carry cannot exceed `MAX_CARRY` of 1px, and a shift worth
   * testing is hundreds.
   */
  paintOffsets: () => number[]
  /** The paint offset currently applied. */
  paintOffset: () => number
  /**
   * The paint offset in effect at each `scrollTop` write, in order.
   *
   * Scroll writes and paint offsets land in one ordered log, so a write made while the
   * content was still held away from `scrollTop` is distinguishable from one made after
   * the shift was folded in — the interleaving `scrollWrites` and `paintOffsets` discard.
   */
  heldAtWrites: () => number[]
  /** The scroller's own maximum, for assertions about the end of the list. */
  maxOffset: () => number
  /**
   * How many times the engine has read the scroll offset.
   *
   * Exists for one assertion: that building a trace payload costs no layout reads. The
   * `scroll.write` thunk used to take three, after `publish` had written styles, on the hottest
   * path in the library — so tracing a gesture made the gesture worse.
   */
  offsetReads: () => number
  offset: () => number
  /**
   * Move the offset the way momentum does *between* scroll events: silently.
   *
   * The platform advances the scroller continuously and reports it at ~60Hz, so at any instant the
   * last delivered offset is behind the real one. Nothing else in this harness can express that,
   * and it is the entire condition of issue #54.
   */
  advanceOffset: (by: number) => void
  scroll: (value: number) => void
  scrollSettled: () => void
  resize: (size: number) => void
  measure: (key: ItemKey, size: number) => void
  mountItem: (key: ItemKey, height: number) => void
  contentWidth: (value: number) => void
}

const setup = (
  options: Partial<Parameters<typeof createEngine>[0]> & {
    count?: number
    /**
     * Derive the maximum from the content, as a browser does.
     *
     * Needed by anything about the *end* of the list: following writes
     * `getMaxScrollOffset()`, and a constant makes "at the bottom" unreachable, so
     * the first scroll event unpins and the follow branch is never exercised at all.
     */
    trackContent?: boolean
    /** Truncate written offsets to integers, as WebKit does. */
    truncateWrites?: boolean
  } = {},
): Harness => {
  const { count = 200, trackContent = false, truncateWrites = false, ...engineOptions } = options

  const scroller = document.createElement('div')
  document.body.appendChild(scroller)

  const state = harnessState()
  let offsetReads = 0
  const writes: string[] = []
  const elements = new Map<ItemKey, HTMLElement>()
  const scrollListeners: (() => void)[] = []
  const scrollEndListeners: (() => void)[] = []
  const sizeListeners: ((size: number) => void)[] = []

  Object.defineProperty(scroller, 'clientWidth', {
    configurable: true,
    get: () => state.contentWidth,
  })

  const surface = recordingSurface(state, writes, elements)

  const viewport: Viewport = {
    getScrollOffset: () => {
      offsetReads++
      return state.offset
    },
    getViewportSize: () => state.viewportSize,
    getMaxScrollOffset: () => (trackContent ? maxOffsetFor(state) : 1_000_000),
    setScrollOffset: (next) => {
      state.offset = acceptedScrollOffset(state, next, { trackContent, truncateWrites })
      writes.push(`scroll:${String(next)}`)
    },
    addEventListener: (type, listener) => {
      const list = type === 'scrollend' ? scrollEndListeners : scrollListeners
      list.push(listener)
      return () => {
        const i = list.indexOf(listener)
        if (i >= 0) list.splice(i, 1)
      }
    },
    observeSize: (onResize) => {
      sizeListeners.push(onResize)
      return () => {
        const i = sizeListeners.indexOf(onResize)
        if (i >= 0) sizeListeners.splice(i, 1)
      }
    },
    getGateTarget: () => scroller,
    getElement: () => scroller,
    getScrollportElement: () => scroller,
    getWindow: () => window,
    getDevicePixelRatio: () => 1,
  }

  const engine = createEngine({
    viewport,
    surface,
    keys: KEYS(count),
    defaultEstimate: 100,
    layoutSignature: layoutSignatureFor(scroller),
    ...engineOptions,
  })
  engine.mount()

  const numbersFor = (prefix: string): number[] =>
    writes.filter((w) => w.startsWith(prefix)).map((w) => Number(w.slice(prefix.length)))

  return {
    engine,
    scroller,
    scrollWrites: () => numbersFor('scroll:'),
    paintOffsets: () => numbersFor('paint:'),
    paintOffset: () => numbersFor('paint:').at(-1) ?? 0,
    heldAtWrites: () => {
      let held = 0
      const atWrites: number[] = []
      for (const write of writes) {
        if (write.startsWith('paint:')) held = Number(write.slice('paint:'.length))
        else if (write.startsWith('scroll:')) atWrites.push(held)
      }
      return atWrites
    },
    maxOffset: () => viewport.getMaxScrollOffset(),
    offsetReads: () => offsetReads,
    offset: () => state.offset,
    advanceOffset: (by) => {
      state.offset += by
    },
    scroll: (value) => {
      state.offset = value
      for (const listener of [...scrollListeners]) listener()
    },
    scrollSettled: () => {
      for (const listener of [...scrollEndListeners]) listener()
    },
    resize: (size) => {
      state.viewportSize = size
      for (const listener of [...sizeListeners]) listener(size)
    },
    measure: (key, size) => {
      const element = elements.get(key)
      if (element) FakeResizeObserver.deliverTo(element, size)
    },
    mountItem: (key, height) => {
      const element = document.createElement('div')
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, height))
      document.body.appendChild(element)
      engine.observeItem(element, key)
    },
    contentWidth: (value) => {
      state.contentWidth = value
    },
  }
}

/**
 * Put the list into live momentum: finger down, finger up, one frame of fling.
 *
 * The scroll event is what tells the gate this is a fling rather than a tap, and it
 * is the state every assertion below is made in.
 */
const fling = (h: Harness, to = 5000): void => {
  h.scroll(2000)
  touch(h.scroller, 'touchstart')
  touch(h.scroller, 'touchend')
  vi.advanceTimersByTime(50)
  h.scroll(to)
}

beforeEach(() => {
  vi.useFakeTimers()
  installObservers()
  document.body.replaceChildren()
  pretendIPhone()
})

afterEach(() => {
  unpretendIPhone()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the engine on iOS WebKit', () => {
  it('does not write scrollTop when a row is measured on mount mid-fling', () => {
    // The hottest path of the bug. During a fling every row that scrolls into view
    // is measured on mount, and in a list of variable-height text almost none of
    // them match their estimate — so this ran, and wrote, on very nearly every frame.
    const h = setup()
    fling(h)
    const before = h.scrollWrites().length

    h.mountItem('c30', 450)

    expect(h.scrollWrites().slice(before)).toEqual([])
  })

  it('does not write scrollTop when a ResizeObserver batch lands mid-fling', () => {
    const h = setup()
    h.mountItem('c30', 100)
    fling(h)
    const before = h.scrollWrites().length

    h.measure('c30', 700)

    expect(h.scrollWrites().slice(before)).toEqual([])
  })

  it('does not write scrollTop when the scrollport changes height mid-fling', () => {
    // On iOS this case *is* the URL bar collapsing as the reader flings, which is
    // about the most common way to lose a fling there.
    const h = setup()
    fling(h)
    const before = h.scrollWrites().length

    h.resize(600)

    expect(h.scrollWrites().slice(before)).toEqual([])
  })

  it('applies the deferred correction once the fling settles', () => {
    const h = setup()
    h.mountItem('c30', 100)
    fling(h)
    h.measure('c30', 700)
    const before = h.scrollWrites().length

    h.scrollSettled()

    // Exactly one write, not one per skipped correction: they all resolve to the
    // same anchor, so replaying them individually would write the same offset over.
    expect(h.scrollWrites().slice(before)).toHaveLength(1)
  })

  it('does not write for an append that displaced nothing, mid-fling', () => {
    // Issue #54, found on a device by `virtual-anchor/debug`.
    //
    // The anchor is re-derived on each scroll event, so `resolveAnchorOffset` answers "where the
    // content was when the last one arrived" while `writeScroll` compares it against where the
    // content is *now*. During momentum those differ by the fling's travel — and a `'model'`
    // restore overrides the gate, so that difference gets written as though it were a correction.
    // Measured on an iPhone: a 500-item append below the reader wrote `delta: -7`, nudging them
    // backwards to a stale offset and cancelling a fling with a second still to run.
    //
    // The append is the case that must write *nothing*: it changed no offset above the anchor.
    const h = setup()
    h.mountItem('c10', 100)
    fling(h, 5000)

    // Momentum carries on between scroll events. This is the whole condition.
    h.advanceOffset(7)
    const before = h.scrollWrites().length

    h.engine.setOptions({ keys: [...KEYS(200), ...KEYS(500, 'newer')] })

    expect(h.scrollWrites().slice(before)).toEqual([])
  })

  it('is unaffected by a correction already banked as a paint offset', () => {
    // Edge case flagged with #54's report: with `pendingShift ≠ 0`, `contentOffset()` includes the
    // paint offset while the anchor's offsets come from the cache. They are the same space —
    // `anchor` was derived from `contentOffset()` in the first place — so the shift cancels out of
    // the subtraction rather than being double-counted. Asserted rather than argued.
    const h = setup()
    h.mountItem('c10', 100)
    fling(h, 5000)

    // Bank a correction: the gate is shut, so this is held rather than written.
    h.measure('c10', 700)
    expect(h.paintOffset()).not.toBe(0)

    h.advanceOffset(7)
    const before = h.scrollWrites().length

    h.engine.setOptions({ keys: [...KEYS(200), ...KEYS(500, 'newer')] })

    expect(h.scrollWrites().slice(before)).toEqual([])
  })

  it('holds position when the model change takes the anchored key away', () => {
    // The other end of the same guard. `resolveAnchorOffset` returns null for a key that has left
    // the collection, and holding beats jumping — so nothing is written, with or without lag.
    const h = setup()
    h.mountItem('c10', 100)
    fling(h, 5000)
    h.advanceOffset(7)
    const before = h.scrollWrites().length

    h.engine.setOptions({ keys: KEYS(200, 'replaced') })

    expect(h.scrollWrites().slice(before)).toEqual([])
  })

  it('writes a prepend’s real height, uncontaminated by the fling’s lag', () => {
    // The mirror of the test above, and the one that shows #54's fix writes the *right* number
    // rather than merely a smaller one. The same prepend is run twice — once with the platform's
    // offset where the last scroll event left it, once with it advanced 7px as momentum would —
    // and the correction has to be identical. Before the fix the second was 7px short, because
    // the travel was being subtracted from the inserted height.
    const deltaFor = (lag: number): number => {
      const events = traced()
      const h = setup()
      h.mountItem('c10', 100)
      fling(h, 5000)
      h.advanceOffset(lag)

      h.engine.setOptions({ keys: [...KEYS(10, 'older'), ...KEYS(200)] })

      const write = events.find(
        (event) => event.topic === 'scroll.write' && event.data.reason === 'model',
      )
      expect(write).toBeDefined()
      return Number(write?.data.delta)
    }

    const still = deltaFor(0)
    expect(still).toBeGreaterThan(0)
    expect(deltaFor(7)).toBe(still)
  })

  it('writes for a prepend even mid-fling', () => {
    // The deliberate exception. Deferring a model change would move the reader by the
    // whole inserted height — the one thing an anchored list promises cannot happen —
    // so a cancelled fling is accepted as the lesser harm.
    const h = setup()
    fling(h)
    const before = h.scrollWrites().length

    h.engine.setOptions({ keys: [...KEYS(10, 'older'), ...KEYS(200)] })

    expect(h.scrollWrites().slice(before)).not.toEqual([])
  })

  it('writes for a reflow that discarded every measurement, even mid-fling', () => {
    const h = setup()
    h.mountItem('c30', 100)
    h.measure('c30', 700)
    fling(h)
    const before = h.scrollWrites().length

    // A width change is a real reflow: every measurement is invalidated, so every
    // offset in the list moved and the restore is not a wobble.
    h.contentWidth(320)
    h.resize(800)

    expect(h.scrollWrites().slice(before)).not.toEqual([])
  })

  it('writes for an explicit setAnchor even mid-fling', () => {
    const h = setup()
    fling(h)
    const before = h.scrollWrites().length

    h.engine.setAnchor({ key: 'c40', offsetWithinItem: 0 })

    expect(h.scrollWrites().slice(before)).not.toEqual([])
  })

  it('does not record a restore intent for a write it refused', () => {
    // A phantom intent is consumed by the next momentum scroll event, which then skips
    // re-deriving the anchor for a scroll that really was the reader's — leaving the
    // anchor stale for the rest of the fling.
    //
    // The offset the refused write aimed at is taken from the trace rather than
    // hard-coded: it depends on the median estimator, so a literal would quietly stop
    // being the offset under test. Landing the next momentum frame exactly there is
    // what makes a phantom intent match, within `isSelfWrite`'s 1.5px tolerance.
    const seen: TraceEvent[] = []
    expect(setTraceSink((event) => seen.push(event))).toBe(true)

    try {
      const h = setup()
      h.mountItem('c10', 100)
      fling(h, 5000)
      h.measure('c10', 700)

      const refused = seen.find(
        (event) => event.topic === 'scroll.write' && event.data.deferred === true,
      )
      expect(refused).toBeDefined()

      const before = h.engine.getAnchor()
      h.scroll(Number(refused?.data.offset))

      expect(h.engine.getAnchor()).not.toEqual(before)
    } finally {
      setTraceSink(null)
    }
  })

  it('holds the follow pin rather than writing it mid-fling', () => {
    // Following writes on every publish, so a fling launched from the bottom hits it
    // at momentum onset — the worst possible moment to cancel one. `trackContent` is
    // what makes "at the bottom" reachable, and so what keeps `following` armed
    // through the scroll event instead of unpinning on it.
    const h = setup({ followOutput: true, trackContent: true })
    touch(h.scroller, 'touchstart')
    touch(h.scroller, 'touchend')
    vi.advanceTimersByTime(50)
    // A momentum frame that stays pinned to the end.
    h.scroll(h.offset())
    const before = h.scrollWrites().length

    h.mountItem('c30', 450)

    expect(h.scrollWrites().slice(before)).toEqual([])
  })

  it('reopens at the hard cap if the platform never reports a settle', () => {
    const h = setup()
    h.mountItem('c30', 100)
    fling(h)
    h.measure('c30', 700)
    const before = h.scrollWrites().length

    vi.advanceTimersByTime(3100)

    expect(h.scrollWrites().slice(before)).toHaveLength(1)
  })

  it('holds the view with a paint offset instead of the refused scroll write', () => {
    // The whole point of #28: deferring alone cancelled nothing, so the content lurched
    // by the full correction. The shift is that cancellation, applied where the platform
    // cannot refuse it.
    const h = setup()
    h.mountItem('c10', 100)
    fling(h, 5000)
    const scrollsBefore = h.scrollWrites().length

    h.measure('c10', 700)

    expect(h.scrollWrites().slice(scrollsBefore)).toEqual([])
    expect(Math.abs(h.paintOffset())).toBeGreaterThan(1)
  })

  it('accumulates successive refused corrections into one shift', () => {
    // `estimateSize` disables the median estimator, whose rebuild on the second
    // measurement would swamp the per-row corrections this is about.
    const h = setup({ estimateSize: () => 100 })
    h.mountItem('c10', 100)
    h.mountItem('c12', 100)
    fling(h, 5000)

    h.measure('c10', 700)
    const first = h.paintOffset()
    h.measure('c12', 500)
    const second = h.paintOffset()

    // One running total, not two independent offsets — the second correction is
    // applied on top of the first, not instead of it.
    expect(Math.abs(second)).toBeGreaterThan(Math.abs(first))
  })

  it('derives the anchor from where the content is, not from scrollTop', () => {
    // The subtlest half of the compensation. While a shift is outstanding the content
    // has moved without `scrollTop`, so an anchor derived from the raw offset describes
    // a position the view is not at — and every momentum event would then re-derive it
    // wrong, compounding instead of holding.
    //
    // Observable as idempotence: once compensated, a further publish with nothing
    // changed must find no correction left to make.
    const h = setup({ estimateSize: () => 100 })
    h.mountItem('c10', 100)
    fling(h, 5000)
    h.measure('c10', 700)
    const held = h.paintOffset()
    expect(held).not.toBe(0)

    // A momentum frame that does not move: the anchor is re-derived here.
    h.scroll(5000)
    // A publish with no model change behind it.
    h.resize(800)

    expect(h.paintOffset()).toBe(held)
  })

  it('folds the shift into scrollTop once the gesture ends, and clears it', () => {
    const h = setup()
    h.mountItem('c10', 100)
    fling(h, 5000)
    h.measure('c10', 700)
    const shift = h.paintOffset()
    const offsetBefore = h.offset()

    h.scrollSettled()

    // `scrollTop` moves forward by exactly what the content was holding, and the
    // content offset returns to zero. Same visible position, different mechanism.
    expect(h.offset()).toBeCloseTo(offsetBefore + shift, 5)
    expect(h.paintOffset()).toBe(0)
  })

  it('makes the fold the only write with the shift still outstanding', () => {
    // Both states at once is what makes the registration order observable: the deferred
    // measurement holds the shift, and a `scrollToIndex` the shut gate refuses banks the
    // scroller's delta, so two listeners want the same reopening. `estimateSize` disables
    // the median estimator, whose rebuild would swamp the one correction under test.
    const h = setup({ estimateSize: () => 100 })
    h.mountItem('c10', 100)
    fling(h, 5000)
    h.measure('c10', 700)
    void h.engine.scrollToIndex(80)
    const before = h.scrollWrites().length

    h.scrollSettled()

    // One write per listener, and the fold is first: it discharges the shift, so the
    // scroller's flush — and every listener after it — writes against a `scrollTop` that
    // already owns the correction. Re-order the two registrations and this reads
    // `[true, true]`, which is the shift counted twice.
    const held = h.heldAtWrites().slice(before)
    expect(held.map((px) => Math.abs(px) > 1)).toEqual([true, false])
  })

  it('folds by the shift alone, not by the shift on top of the banked delta', () => {
    const h = setup({ estimateSize: () => 100 })
    h.mountItem('c10', 100)
    fling(h, 5000)
    h.measure('c10', 700)
    // Far enough away that the banked delta cannot be mistaken for the shift.
    void h.engine.scrollToIndex(80)
    const shift = h.paintOffset()
    expect(shift).toBeGreaterThan(1)
    const offsetBefore = h.offset()
    const before = h.scrollWrites().length

    h.scrollSettled()

    // Going first is what keeps the fold's arithmetic about the shift and nothing else.
    expect(h.scrollWrites().slice(before)[0]).toBeCloseTo(offsetBefore + shift, 5)
  })

  describe('a programmatic scroll issued mid-gesture', () => {
    // Issue #33, at the seam the two iOS suites left uncovered between them: the scroller
    // suite can drive a scroll during a gesture but has no engine holding a shift, and this
    // one holds a shift but never drove a scroll through it. Both halves are needed for the
    // destination and the coordinate it is compared against to disagree.

    it('measures the scroll against where the content is', async () => {
      const h = setup({ estimateSize: () => 100 })
      h.mountItem('c10', 100)
      fling(h, 5000)
      // 600px of correction, held on the container rather than written: `scrollTop` says
      // 5000 and the reader is looking at 5600.
      h.measure('c10', 700)
      expect(h.paintOffset()).toBeCloseTo(600, 5)

      const promise = h.engine.scrollToKey('c100')
      // Cancelled rather than settled, so it resolves where it stood — and what it reports
      // is the caller's only account of where the content had got to. c100 sits at 10_600
      // once c10 is 600px taller than its estimate, so the content has 5000 left to travel;
      // measured against `scrollTop` it claims 5600, which is the shift over again.
      h.engine.cancelScroll()

      const result = await promise
      expect(result.reason).toBe('cancelled')
      expect(result.deviation).toBeCloseTo(5000, 5)
    })

    it('lands on the item once the gesture is over', async () => {
      // The end-to-end guard, and honest about its reach: both reopen orderings converge
      // here, so it asserts the landing rather than the writes that reach it. Flushing the
      // banked distance before the shift is folded steps the list 600px past the item and
      // the loop pulls it back a frame later; folding first makes it a single write.
      const h = setup({ estimateSize: () => 100 })
      h.mountItem('c10', 100)
      fling(h, 5000)
      h.measure('c10', 700)

      const promise = h.engine.scrollToKey('c100')
      // Nothing was written while the fling ran; the destination was banked as a distance
      // the content still had to cover.
      expect(h.scrollWrites()).toEqual([])

      h.scrollSettled()
      // Real animation frames, which the fake clock drives — the only case in the file
      // that needs the convergence loop to run.
      await vi.advanceTimersByTimeAsync(120)

      const result = await promise
      expect(result.settled).toBe(true)
      expect(h.offset()).toBeCloseTo(10_600, 5)
      expect(h.paintOffset()).toBe(0)
    })
  })

  it('mounts the range the content is showing, not the one scrollTop implies', () => {
    // With a shift outstanding, `scrollTop` and the visible content differ by it. Compute
    // the rendered window from the raw offset and it is centred up to two viewports from
    // the screen — which paints blank — and the visibility band reports rows that never
    // appeared.
    // One correction bigger than the buffer plus the viewport, so the two candidate
    // windows do not overlap — otherwise `DEFAULT_BUFFER` hides the difference and the
    // assertion passes either way.
    const h = setup({ estimateSize: () => 100 })
    h.mountItem('c10', 100)
    fling(h, 5000)
    h.measure('c10', 1500)

    const held = h.paintOffset()
    expect(held).toBeGreaterThan(1200)

    // The index under the viewport top, in content space.
    const shown = h.engine.cache.indexAt(h.offset() + held)
    const [first, last] = h.engine.store.getState().renderedRange
    expect(shown).toBeGreaterThanOrEqual(first)
    expect(shown).toBeLessThanOrEqual(last)
  })

  describe('the visibility band while a shift is held', () => {
    // The other half of the split, and the half #29 left behind: the band was still
    // built from the raw offset while the candidates it is measured against came from
    // `cache.offsetOf`, i.e. content space. Nothing paints wrong — the rendered range
    // above is computed correctly — but every visibility event fired during a hold
    // describes a strip of content the reader is not looking at.
    //
    // All three cases use a correction wider than the viewport plus the buffer, so the
    // scroll-space window and the content-space window do not overlap. With a smaller
    // one both spaces name some of the same rows and the assertions pass either way.
    const record = (events: string[]): Partial<Parameters<typeof createEngine>[0]> => ({
      onVisibilityChange: (batch) => {
        for (const event of batch) events.push(`${event.phase}:${String(event.key)}`)
      },
    })

    /**
     * The row under the viewport top at `offset`, named rather than hard-coded.
     *
     * Which row that is depends on the estimate, the viewport height and how far the
     * fling went, so a literal would quietly stop being the row under test. The sentinel
     * is never visible, so a missing key fails the assertion rather than satisfying it.
     */
    const rowAt = (h: Harness, offset: number): ItemKey =>
      h.engine.keyAt(h.engine.cache.indexAt(offset)) ?? 'no-such-row'

    it('reports the items the content is showing, not the ones scrollTop implies', () => {
      const events: string[] = []
      const h = setup({ estimateSize: () => 100, ...record(events) })
      h.mountItem('c10', 100)
      fling(h, 5000)
      expect(h.engine.getVisibility(rowAt(h, h.offset())).visible).toBe(true)

      events.length = 0
      h.measure('c10', 1500)

      // The correction is held, so the content moved and `scrollTop` did not.
      const held = h.paintOffset()
      expect(held).toBeGreaterThan(1200)
      const shown = rowAt(h, h.offset() + held)
      // Or the two spaces name the same row and nothing below discriminates.
      expect(shown).not.toBe(rowAt(h, h.offset()))

      // The row the shift is keeping under the viewport top is still on screen, so it has
      // neither left nor been replaced by the row sitting at the raw offset — one the
      // reader scrolled past before the measurement landed. Reading the band in scroll
      // space reports the opposite: the candidates are a viewport and a half past the
      // band, so *nothing* overlaps it and all eight visible rows report a leave.
      expect(events).toEqual([])
      expect(h.engine.getVisibility(shown).visible).toBe(true)
    })

    it('reports the same row off iOS, where the two spaces coincide', () => {
      // The inertness guard. Off iOS the correction is written rather than held, so the
      // raw offset *is* where the content is and the fix must cost nothing. It cannot
      // fail against this bug — no shift is ever outstanding for the two spaces to
      // disagree by — which is the statement being made.
      unpretendIPhone()
      const events: string[] = []
      const h = setup({ estimateSize: () => 100, ...record(events) })
      h.mountItem('c10', 100)
      fling(h, 5000)

      events.length = 0
      h.measure('c10', 1500)

      expect(h.paintOffset()).toBe(0)
      expect(h.engine.getVisibility(rowAt(h, h.offset())).visible).toBe(true)
      expect(events).toEqual([])
    })

    it('samples the visibility deadline in content space too', () => {
      // The deadline timer re-samples on its own, and read both its candidate range and
      // its band from the raw offset. It is also the sample most likely to be the *only*
      // one taken during a hold: it fires when nothing else is happening, which is
      // exactly the reader who has stopped scrolling and is dwelling on a comment.
      //
      // `dwellMs` is what makes a deadline exist at all — with none, every enter is
      // reported on the sample that observes it and no timer is ever armed.
      const events: string[] = []
      const h = setup({
        estimateSize: () => 100,
        visibility: { dwellMs: 500 },
        ...record(events),
      })
      h.mountItem('c10', 100)
      fling(h, 5000)
      h.measure('c10', 1500)
      const held = h.paintOffset()
      expect(held).toBeGreaterThan(1200)
      // Nothing yet: the dwell has only just started.
      expect(events).toEqual([])
      expect(vi.getTimerCount()).toBeGreaterThan(0)

      // Only time passing — no scroll, no measurement, no resize. Short of both the
      // gate's 3s cap and any settle, so the shift is still outstanding.
      vi.advanceTimersByTime(600)

      // Reading the band in scroll space instead starts the dwell over on the rows at the
      // raw offset, so this deadline reports nothing at all.
      expect(events).toContain(`enter:${String(rowAt(h, h.offset() + held))}`)
    })
  })

  it('sends what a truncating platform refuses to the carry, and holds nothing', () => {
    // WebKit truncates a written scroll offset to an integer, so on the one platform this
    // runs on the fold is never exact. The shortfall is what the carry is *for*, so it
    // goes there and `MAX_CARRY` governs it — leaving no shift outstanding with the gate
    // open, which is the invariant the rest of the file's offset arithmetic rests on.
    const h = setup({ estimateSize: () => 100, truncateWrites: true })
    h.mountItem('c10', 100)
    fling(h, 5000)
    h.measure('c10', 700.5)
    expect(h.paintOffset()).toBeGreaterThan(1)

    h.scrollSettled()

    expect(Number.isInteger(h.offset())).toBe(true)
    // Nothing held: what the platform dropped is under a pixel and now rides in the carry.
    expect(Math.abs(h.paintOffset())).toBeLessThanOrEqual(1)
  })

  it('holds a correction far larger than a viewport when deep in the list', () => {
    // The regression that reached a device: the bound was first written as two viewports,
    // roughly 1300px, and a fling through mis-estimated text accumulates that in a handful
    // of rows — so it fired mid-fling and took the write, cancelling the momentum the gate
    // exists to preserve. Deep in a list there is range on both sides and the displacement
    // costs nothing, so it must be held however large it is.
    const h = setup({ estimateSize: () => 100 })
    h.scroll(500_000)
    touch(h.scroller, 'touchstart')
    touch(h.scroller, 'touchend')
    vi.advanceTimersByTime(50)
    h.scroll(500_000)
    const scrollsBefore = h.scrollWrites().length

    h.mountItem('c10', 100)
    h.measure('c10', 20_000)

    expect(h.scrollWrites().slice(scrollsBefore)).toEqual([])
    expect(h.paintOffset()).toBeGreaterThan(15_000)
  })

  it('takes the write rather than holding a shift with no room to absorb it', () => {
    // Near an end the displacement is unaffordable: the content shown at `scrollTop` is
    // the content belonging at `scrollTop + shift`, so the last `shift` pixels are
    // unreachable and the fold has nowhere to land. Losing the fling is the lesser harm.
    const h = setup({ count: 400 })
    fling(h, 5000)
    const scrollsBefore = h.scrollWrites().length

    // One absurdly tall row: 40 000px against a 100px estimate, far past 2 viewports.
    h.mountItem('c10', 40_000)

    expect(h.scrollWrites().slice(scrollsBefore)).not.toEqual([])
    expect(h.paintOffset()).toBe(0)
  })

  it('leaves no shift outstanding off iOS', () => {
    unpretendIPhone()
    const h = setup()
    h.mountItem('c10', 100)
    fling(h, 5000)

    h.measure('c10', 700)

    // The gate is inert, so the write is taken and no shift is ever held. Any paint
    // offset here is the sub-pixel carry, which is what `MAX_CARRY` bounds at 1px.
    expect(h.paintOffsets().filter((px) => Math.abs(px) > 1)).toEqual([])
  })

  it('reports every correction it was about to make, deferred or not', () => {
    // The diagnostic that made this bug measurable on a device rather than a matter
    // of opinion: it is what produced the 389px figure in #28. Tested because it is
    // load-bearing for future device work, and because it costs bundle size that has
    // to be justified.
    const seen: TraceEvent[] = []
    expect(setTraceSink((event) => seen.push(event))).toBe(true)

    try {
      const h = setup()
      h.mountItem('c10', 100)
      fling(h, 5000)
      h.measure('c10', 700)

      const writes = seen.filter((event) => event.topic === 'scroll.write')
      expect(writes.length).toBeGreaterThan(0)

      const deferred = writes.find((event) => event.data.deferred === true)
      expect(deferred).toBeDefined()
      expect(deferred?.data.restore).toBe('measure')
      // The delta is the size of the uncorrected shift, which is the whole point of
      // reporting it — a sub-pixel wobble and a 389px lurch are the same event
      // otherwise.
      expect(Math.abs(Number(deferred?.data.delta))).toBeGreaterThan(0)
    } finally {
      setTraceSink(null)
    }
  })

  it('writes a measurement correction normally when no gesture is in flight', () => {
    const h = setup()
    h.mountItem('c10', 100)
    // Above the anchor, deliberately. A row measured *below* it moves nothing the
    // anchor resolves against, so there is no correction to make and no write to
    // suppress — which is precisely why a down-fling survives this bug and an
    // up-fling does not.
    h.scroll(5000)
    const before = h.scrollWrites().length

    h.measure('c10', 700)

    expect(h.scrollWrites().slice(before)).not.toEqual([])
  })
})

/**
 * Mount a slot element, as the React adapter's ref callback would.
 *
 * `resize` drives both halves of what a real resize is — the box the element reports and
 * the observer callback announcing it — because the engine measures synchronously on
 * attach and then trusts the observer for everything after. Copied from
 * `engine.dom.test.ts`, as the rest of this file's harness already is, and which is where
 * the off-iOS baseline for the first case below lives.
 */
const mountSlot = (
  h: Harness,
  slot: SlotName,
  height: number,
): { resize: (next: number) => void } => {
  const element = document.createElement('div')
  const rect = vi
    .spyOn(element, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(0, 0, 600, height))
  document.body.appendChild(element)

  h.engine.observeSlot(element, slot)
  return {
    resize: (next) => {
      rect.mockReturnValue(new DOMRect(0, 0, 600, next))
      FakeResizeObserver.deliverTo(element, next)
    },
  }
}

/**
 * Measured slots during a gesture — issue #32.
 *
 * No slot was observed anywhere in this file before, which is why the classification could
 * be argued either way: `onSlotGeometryChange` publishes `'measure'`, yet a measured
 * `header` moves the list's *origin*, so on the face of it that is a `'model'` change
 * wearing a `'measure'` label. The argument for keeping it is in `Restore`'s doc; these
 * cases pin the two claims it rests on.
 */
describe('the engine’s measured slots on iOS WebKit', () => {
  it('holds the view when the header grows mid-fling, instead of writing it', () => {
    // The off-iOS baseline is `engine.dom.test.ts`'s "holds the view when the header
    // grows", where the same 400px of growth moves `scrollTop` by 400. Here the write is
    // refused and the paint offset carries the identical 400 — same visible result, and
    // the fling survives it.
    const h = setup()
    const header = mountSlot(h, 'header', 300)
    fling(h, 5000)
    const scrollsBefore = h.scrollWrites().length
    const anchorBefore = h.engine.getAnchor()

    header.resize(700)

    expect(h.scrollWrites().slice(scrollsBefore)).toEqual([])
    expect(h.paintOffset()).toBeCloseTo(400, 5)
    // Not merely compensated back — never disturbed. The anchor is the position of record,
    // and a geometry change is not a position change.
    expect(h.engine.getAnchor()).toEqual(anchorBefore)
  })

  it('takes the write when the header grows near the top of the list', () => {
    // The second claim, as a fact rather than an assertion: past `room` the write is taken
    // and the fling lost, so `'measure'` there does exactly what `'model'` would have.
    //
    // The top, and not the bottom, is the end that binds a *growth* — which is the whole
    // reason the classification is a judgement call and not a bug. A growing header pushes
    // the bottom away by the same 400px it displaces the content by, so the distance to the
    // bottom never shrinks; only the 100px above the reader can run out. Asserting this at
    // the bottom instead passes only because this harness leaves slot heights out of
    // `getMaxScrollOffset`, and fails the moment it does not.
    const h = setup()
    const header = mountSlot(h, 'header', 300)
    fling(h, 100)
    const scrollsBefore = h.scrollWrites().length

    header.resize(700)

    expect(h.scrollWrites().slice(scrollsBefore)).not.toEqual([])
    // Nothing held: `paintOffsets` rather than the last one, so "held nothing" is not
    // satisfied by "never wrote a paint offset at all". Anything under a pixel is the carry.
    expect(h.paintOffsets().filter((px) => Math.abs(px) > 1)).toEqual([])
  })

  it('leaves the view alone when a sticky footer resizes mid-fling', () => {
    // The case the classification was never in doubt for, and the reason it is not: a
    // sticky footer feeds `scrollPaddingEnd` and `spaceAfter`, neither of which enters the
    // conversion to scroller space, so `resolveAnchorOffset` returns the offset the list is
    // already at. `writeScroll` leaves at its sub-pixel early return, *before* the gate is
    // consulted — so an animated sticky footer under a fling is free by construction rather
    // than by deferral, and the label could not matter to it either way.
    const h = setup()
    const footer = mountSlot(h, 'stickyFooter', 100)
    fling(h, 5000)
    const scrollsBefore = h.scrollWrites().length
    const visibleEndBefore = h.engine.store.getState().visibleRange[1]

    footer.resize(300)

    expect(h.scrollWrites().slice(scrollsBefore)).toEqual([])
    expect(h.paintOffsets().filter((px) => Math.abs(px) > 1)).toEqual([])
    // A guard, not the assertion: without it every expectation above is satisfied by a
    // resize that never reached the engine. 200px more sticky footer is 200px less of the
    // scrollport for items to be visible in.
    expect(h.engine.store.getState().visibleRange[1]).toBeLessThan(visibleEndBefore)
  })

  it('takes the write when an alignToBottom footer moves the leading space', () => {
    // The one case a per-slot rule would classify differently — `leadingSpace` reaches
    // `scrollMargin` through `composeInsets`, so this resize really does move the origin —
    // coming out the same anyway, for the reason `onSlotGeometryChange`'s doc gives.
    //
    // `count: 3` is what puts 300px of content in an 800px viewport, which is what makes
    // `leadingSpace` non-zero at all; `trackContent` is what has the harness report the
    // empty scroll range that follows from it.
    const h = setup({ count: 3, alignToBottom: true, trackContent: true })
    const footer = mountSlot(h, 'footer', 100)
    // The only momentum frame this list can produce. 300px of content in an 800px viewport
    // has no scroll range, so every gesture frame reports the same offset.
    touch(h.scroller, 'touchstart')
    touch(h.scroller, 'touchend')
    vi.advanceTimersByTime(50)
    h.scroll(0)
    expect(h.maxOffset()).toBe(0)
    const scrollsBefore = h.scrollWrites().length

    footer.resize(300)

    // The exact origin move: 200px more footer is 200px less `leadingSpace`, and therefore
    // 200px less `scrollMargin`. Written, not held — a browser then clamps it to 0, which is
    // the point: there was never anywhere for a shift to go.
    expect(h.scrollWrites().slice(scrollsBefore)).toEqual([-200])
    expect(h.paintOffsets().filter((px) => Math.abs(px) > 1)).toEqual([])
  })
})

/**
 * What the engine says about its own scroll writes.
 *
 * The payload used to report `deferred`, which was computed *before* the test that decides what
 * actually happens — so a write that escaped because the bank's bound fired was recorded as a
 * successful deferral, and the demo's on-device readout printed it as `DEFER`. These assertions
 * pin the four-value taxonomy that replaced it, and `took` in particular, because that is the
 * field an on-device tool has to key on.
 */
describe('what the engine reports about a scroll write', () => {

  const writes = (events: TraceEvent[]): TraceEvent[] =>
    events.filter((event) => event.topic === 'scroll.write')

  it('says a write went through on an open gate', () => {
    const h = setup()
    h.mountItem('c10', 100)
    h.scroll(2000)
    const events = traced()

    h.measure('c10', 700)

    const write = writes(events).at(-1)
    expect(write?.data).toMatchObject({ reason: 'gate-open', took: true, deferred: false })
  })

  it('says a correction was banked rather than written, mid-gesture', () => {
    const h = setup()
    h.mountItem('c10', 100)
    const events = traced()
    fling(h, 5000)

    h.measure('c10', 700)

    const write = writes(events).at(-1)
    // `took: false` is the whole point: the gate worked, nothing was written, and the correction
    // is being carried as a paint offset instead.
    expect(write?.data).toMatchObject({ reason: 'held', took: false, deferred: true })
    expect(Number(write?.data.heldAfter)).not.toBe(0)
  })

  it('names the write that escapes because there was no room to bank it', () => {
    // The leading suspect for a fling that stops abruptly, and the one the old payload could not
    // express: `room` is the distance to the *nearer* end of the scroll range, so near either end
    // it collapses, the correction is written instead of banked, and on iOS that cancels the
    // fling — while the trace said `deferred: true` and the demo printed `DEFER`.
    //
    // Provoked at the bottom rather than the top, because at the top there is nothing above the
    // anchor to grow: a correction needs content above the viewport, and `room` there is the
    // distance already scrolled. The end of the list is where both are true at once, which is
    // also where a reader flings to.
    const h = setup({ trackContent: true })
    h.mountItem('c10', 100)
    const events = traced()

    h.scroll(h.maxOffset())
    touch(h.scroller, 'touchstart')
    touch(h.scroller, 'touchend')
    vi.advanceTimersByTime(50)
    h.scroll(h.maxOffset())

    h.measure('c10', 900)

    const escaped = writes(events).find((event) => event.data.reason === 'no-room')
    expect(escaped?.data).toMatchObject({ took: true, deferred: true })
    // And it carries what a reader needs to tell this from a rubber-band overscroll: `from`
    // against `max`.
    expect(escaped?.data).toHaveProperty('max')
  })

  it('names a model change overriding a shut gate', () => {
    // Deliberate, and legitimate — deferring a prepend moves the reader by the whole inserted
    // height — but it does cancel momentum, so it has to be distinguishable from an ordinary
    // write on an idle platform. Keyed on the gate rather than on `deferred`, which is already
    // false for a model change and so reported these as `gate-open`.
    const h = setup()
    h.mountItem('c10', 100)
    const events = traced()
    fling(h, 5000)

    h.engine.setOptions({ keys: [...KEYS(10, 'older'), ...KEYS(200)] })

    const write = writes(events).find((event) => event.data.reason === 'model')
    expect(write?.data).toMatchObject({ took: true, restore: 'model' })
  })

  it('performs no layout reads while building the payload', () => {
    // The instrument must not perturb the experiment. This thunk used to call `contentOffset()`
    // and `getScrollOffset()` twice more inside `room` — three forced layouts per traced write,
    // after `publish` had written styles, on the hottest path in the library. On a gesture
    // measured at 43 deferrals that is 129 layouts that existed only because someone was watching.
    // Two identical runs on two fresh harnesses, because the same harness measured twice is not
    // the same operation twice — a second size change takes a different path through the cache.
    const run = (withSink: boolean): { reads: number, traced: number } => {
      const events: TraceEvent[] = []
      if (withSink) setTraceSink((event) => events.push(event))
      try {
        const h = setup()
        h.mountItem('c10', 100)
        fling(h, 5000)
        const before = h.offsetReads()
        h.measure('c10', 700)
        return { reads: h.offsetReads() - before, traced: events.length }
      } finally {
        setTraceSink(null)
      }
    }

    const observed = run(true)
    const unobserved = run(false)

    expect(observed.traced).toBeGreaterThan(0)
    expect(unobserved.traced).toBe(0)
    expect(observed.reads).toBe(unobserved.reads)
  })
})

describe('what the engine reports about the fold and the paint offset', () => {

  it('reports the fold when the gate reopens, and whether it landed exactly', () => {
    // `reconcileGestureShift` emitted nothing at all before this, which made the most plausible
    // cause of a visible jump the one thing the trace could not see.
    const h = setup()
    h.mountItem('c10', 100)
    fling(h, 5000)
    h.measure('c10', 700)

    const events = traced()
    h.scrollSettled()

    const fold = events.find((event) => event.topic === 'gesture.fold')
    expect(fold?.data).toMatchObject({ clamped: false })
    expect(Number(fold?.data.shift)).not.toBe(0)
    // The one-number test for "was the fold invisible". Exactly, not within a pixel and a half:
    // this harness accepts fractional writes, so every term is exact and a tolerance a dropped
    // carry fits inside is no tripwire at all.
    expect(foldDelta(events)).toBeLessThan(1e-9)
  })

  it('keeps an outstanding carry across the fold rather than dropping it', () => {
    // The fold aimed at `scrollTop + shift` while the content sat a `carryBefore` further on,
    // and `commitScroll` replaces the carry rather than accumulating it — so the difference was
    // held by nothing. See `reconcileGestureShift`.
    //
    // `truncateWrites` is the whole condition: where fractional offsets are accepted the carry
    // is zero and the bug cannot express itself, which is why an emulated iPhone is the only
    // place it ever showed. It reached CI as a fold delta of exactly 0.75.
    const h = setup({ estimateSize: () => 100, truncateWrites: true })
    h.mountItem('c5', 100)
    h.mountItem('c10', 100)

    // A row *above* the anchor growing by a fraction is what puts a fraction in the restore:
    // everything below it moves by 0.75, so the corrected offset is fractional, the platform
    // truncates it, and what it refuses becomes the carry the fold then has to preserve.
    // Measuring the anchor itself would not do — it does not move itself.
    h.scroll(1000)
    h.measure('c5', 100.75)
    expect(h.paintOffset()).not.toBe(0)

    const events = traced()
    fling(h, 5000)
    h.measure('c10', 700.75)

    h.scrollSettled()

    expect(foldDelta(events)).toBeLessThan(1e-9)
  })

  it('reports which of the two addends moved the paint offset', () => {
    // The surface is handed only the sum, and a sub-pixel carry landing means something quite
    // different from a whole correction being banked — so the diagnosis needs them apart.
    const h = setup()
    h.mountItem('c10', 100)
    const events = traced()
    fling(h, 5000)

    h.measure('c10', 700)

    const paint = events.find((event) => event.topic === 'paint.offset')
    expect(paint?.data).toHaveProperty('carry')
    expect(paint?.data).toHaveProperty('shift')
    expect(Number(paint?.data.px)).toBe(
      Number(paint?.data.carry) + Number(paint?.data.shift),
    )
  })
})

describe('the engine off iOS', () => {
  beforeEach(() => {
    unpretendIPhone()
  })

  it('says there is no gate on this platform', () => {
    // The only way to tell "the gate stayed idle" from "there is no gate", and off iOS every
    // correction writes unconditionally — so for a reader diagnosing Android this one event is
    // the whole finding.
    const events: TraceEvent[] = []
    setTraceSink((event) => events.push(event))
    try {
      setup()
      expect(events.find((event) => event.topic === 'gate.attach')?.data).toMatchObject({
        ios: false,
      })
    } finally {
      setTraceSink(null)
    }
  })

  it('writes a prepend in full, as it always has', () => {
    // #54's safety property, on the platform where the gate is inert: with the content still, the
    // anchor is in sync, so `contentOffset() === priorAnchorOffset` and the target is bit-identical
    // to the old form. The whole change is supposed to be invisible here.
    const events = traced()
    const h = setup()
    h.mountItem('c30', 100)
    h.scroll(2000)

    h.engine.setOptions({ keys: [...KEYS(10, 'older'), ...KEYS(200)] })

    // Keyed on `restore`, not `reason`: with the gate open this is a `gate-open` write that
    // happens to have a model cause, which is exactly the distinction the two fields carry.
    const write = events.find(
      (event) => event.topic === 'scroll.write' && event.data.restore === 'model',
    )
    expect(write?.data.reason).toBe('gate-open')
    expect(Number(write?.data.delta)).toBe(1000)
  })

  it('writes a measurement correction during a touch scroll, as it always has', () => {
    // The inertness guard. None of the above may cost anything on Chromium,
    // Firefox or desktop WebKit, where writing `scrollTop` does not cancel anything.
    const h = setup()
    h.mountItem('c30', 100)
    fling(h)
    const before = h.scrollWrites().length

    h.measure('c30', 700)

    expect(h.scrollWrites().slice(before)).not.toEqual([])
  })
})
