import {
  carryFor,
  convergenceTolerance,
  isSelfWrite,
  offsetForIndex,
} from './anchor.js'
import { visibleSizeOf, type ListInsets } from './listGeometry.js'
import { isIOSWebKit, prefersReducedMotion, supportsScrollEnd } from './env.js'
import { isTracing, TRACING, trace } from './trace.js'
import type { SizeCache } from './sizeCache.js'
import type {
  ItemKey,
  ScrollAlign,
  ScrollEndReason,
  ScrollResult,
  ScrollToOptions,
} from './types.js'
import type { Viewport } from './viewport.js'

/**
 * How long without the model moving counts as "it has stopped moving".
 *
 * Both a measurement landing and items being inserted count: either moves the offsets the
 * target is computed from, so waiting only on measurements would let the loop settle in
 * the gap after a prepend.
 */
const MODEL_QUIET_MS = 150
/**
 * Longest step the smooth approach will integrate over.
 *
 * After a stall — a background tab, a long task — the honest thing is to cover the ground
 * that time actually passed for, rather than crawling as though no time had. Capped so a
 * multi-second stall resolves to "jump there" instead of an enormous single easing step
 * whose arithmetic is dominated by one sample.
 */
const MAX_STEP_MS = 100

/** Consecutive frames at the target before declaring victory. */
const STABLE_FRAMES = 2
/** Soft budget: past this, stop re-aiming and report what we got. */
const SOFT_DEADLINE_MS = 2000
/** Hard safety valve, so a pathologically unstable list cannot hang a promise. */
const HARD_DEADLINE_MS = 5000
/** Fallback settle timeout where `scrollend` is unavailable. */
const SCROLL_END_FALLBACK_MS = 150
/** Time constant for the self-driven smooth approach. */
const SMOOTH_TAU_MS = 120
/**
 * Smallest per-frame advance worth attempting, in CSS px.
 *
 * A whole pixel, not `1 / devicePixelRatio`: WebKit truncates a written scroll
 * offset to an integer, so a sub-pixel advance is discarded outright — the offset
 * does not move, the next frame computes the same advance, and the animation
 * stalls short of its target forever. Below a pixel of remaining travel the jump
 * is imperceptible anyway.
 */
const SMOOTH_MIN_STEP = 1
/** iOS only fires touch events at the start of momentum, so a timer is needed. */
const IOS_TOUCH_GRACE_MS = 150

export interface ScrollerOptions {
  viewport: Viewport
  /** Read the live cache — it is replaced as the window grows. */
  getCache: () => SizeCache
  getGeometry: () => ListInsets
  /**
   * Apply the sub-pixel remainder the browser refused to take.
   *
   * Written as a visual offset on the item container rather than chased with
   * another `scrollTop` write, which is what makes landing exact on engines that
   * snap or truncate scroll offsets.
   */
  applyCarry: (carry: number) => void
  /**
   * Mount and measure a range before a smooth scroll begins.
   *
   * Native smooth scrolling cannot be used here at all: its destination is fixed
   * in pixels at call time, and any `scrollTop` write during the animation
   * cancels it outright in Chrome — so smooth scrolling and scroll correction
   * are mutually exclusive (TanStack discussion #495). Pre-measuring the
   * destination means the target is already nearly stationary when motion
   * starts.
   */
  requestRange?: (startIndex: number, endIndex: number) => void
  /** Notified when a programmatic scroll starts and stops. */
  onScrollingChange?: (scrolling: boolean) => void
  /**
   * The user reached for the scroller: a wheel, a touch, a pointer or a key.
   *
   * The same signal that cancels an in-flight programmatic scroll, surfaced
   * because "the reader deliberately scrolled" has a second consumer — deciding
   * that they no longer want to be pinned to the newest comment. It is
   * deliberately an *input* event and not an offset comparison, for the reason
   * spelled out on {@link cancelOnInput}: the browser moves `scrollTop` by
   * itself often enough that an offset alone cannot tell intent from clamping.
   *
   * Says only that input happened. Whether it means anything is the caller's to
   * decide from where the scroller then ends up.
   */
  onUserInput?: () => void
  now?: () => number
  requestFrame?: (callback: () => void) => number
  cancelFrame?: (handle: number) => void
}

export interface Scroller {
  scrollToIndex(index: number, options?: ScrollToOptions): Promise<ScrollResult>
  /**
   * Feed in the fact that the model moved, to drive convergence.
   *
   * Both measurements landing and items being added or removed qualify: each moves the
   * offsets the target is computed from, and either one means an earlier `scrollend` no
   * longer says anything about the target holding still.
   */
  notifyModelChanged(): void
  /**
   * Feed in an observed scroll offset.
   *
   * @returns whether this was the echo of our own write rather than user input.
   */
  notifyScroll(offset: number): boolean
  /** Whether a programmatic scroll is in flight (visibility events suppressed). */
  isScrolling(): boolean
  /**
   * Declare that the caller is about to write this scroll offset itself.
   *
   * The anchor-restore path writes `scrollTop` directly, and without this the
   * resulting scroll event is indistinguishable from the user grabbing the
   * scrollbar — which cancels any in-flight programmatic scroll.
   */
  markSelfWrite(offset: number): void
  /** Bind the DOM listeners. Called once, from `engine.mount()`. */
  attach(): void
  /** Abandon any in-flight scroll, resolving it honestly as unsettled. */
  cancel(): void
  dispose(): void
}

/**
 * One frame's worth of convergence decision, as the trace reports it.
 *
 * Extends the sink's payload type so the named fields survive while still satisfying it —
 * an interface without that is not assignable to `Record<string, unknown>`, and a bare
 * type alias trips `consistent-type-definitions`.
 */
interface StepTrace extends Record<string, unknown> {
  key: ItemKey
  index: number
  target: number
  actual: number
  uncarried: number
  arrived: boolean
  targetMoved: boolean
  quiet: boolean
  settledExternally: boolean
  stableFrames: number
  elapsed: number
}

/**
 * Record one frame of the convergence loop.
 *
 * Two deliberate choices. It is at module scope rather than an inline thunk inside `step`,
 * because a closure there forces a context object for the whole scope on every call —
 * whether or not tracing is on — and that loop is the hottest code in this library.
 *
 * And it takes a named record rather than a positional list: four of these fields are
 * consecutive booleans, so transposing two of them would compile clean and then lie in
 * every trace, in the module whose entire purpose is being trustworthy about what
 * happened. The record is built only when a sink is attached, which is why the call site
 * asks `isTracing()` rather than `TRACING`.
 */
function traceStep(step: StepTrace): void {
  trace('scroll.step', () => step)
}

interface PendingScroll {
  /**
   * The destination *item*, not its ordinal.
   *
   * An index is only valid until the collection changes: prepending 40 comments while a
   * scroll to comment 6018 was in flight left the scroller still aiming at index 38,
   * which by then was a different comment — and it converged there with a deviation of
   * zero, reporting success for landing on the wrong item. Since a window that grows
   * upward is the case this library exists for, the target is tracked by key and the
   * index re-resolved every frame.
   */
  key: ItemKey
  /** Last resolved index; the fallback if the key leaves the collection entirely. */
  index: number
  align: ScrollAlign
  offset: number
  smooth: boolean
  startedAt: number
  lastTarget: number
  stableFrames: number
  /** When the model last moved — a measurement, or items inserted or removed. */
  lastModelChangeAt: number
  /** When `step` last ran, so the smooth approach can advance by elapsed time. */
  lastStepAt: number
  iterations: number
  resolve: (result: ScrollResult) => void
}

export function createScroller(options: ScrollerOptions): Scroller {
  const {
    viewport,
    getCache,
    getGeometry,
    applyCarry,
    requestRange,
    onScrollingChange,
    now = () => performance.now(),
  } = options

  const view = viewport.getWindow()
  const requestFrame =
    options.requestFrame ??
    ((callback: () => void) => (view ? view.requestAnimationFrame(callback) : 0))
  const cancelFrame =
    options.cancelFrame ??
    ((handle: number) => {
      view?.cancelAnimationFrame(handle)
    })

  let pending: PendingScroll | null = null
  let frame: number | null = null
  let disposed = false

  /**
   * Offsets we have asked the browser for and not yet seen echoed back.
   *
   * A queue rather than a single slot, because scroll events are delivered
   * *asynchronously*: two writes in the same task — an anchor restore followed by
   * a scroll target, say — produce their events later, by which time a single slot
   * only remembers the second. The first event then looks like the user grabbing
   * the scrollbar and cancels the programmatic scroll that just started.
   *
   * Browsers also coalesce several writes into one event, so a match consumes
   * every older entry too.
   */
  const intended: number[] = []
  const MAX_INTENTS = 5

  const rememberIntent = (offset: number): void => {
    intended.push(offset)
    if (intended.length > MAX_INTENTS) intended.shift()
  }

  const consumeIntent = (observed: number): boolean => {
    const index = intended.findIndex((value) => isSelfWrite(observed, value))
    if (index === -1) return false
    intended.splice(0, index + 1)
    return true
  }

  // iOS WebKit: writing scrollTop during momentum cancels the fling, so
  // corrections are banked until the gesture is demonstrably over.
  const isIOS = isIOSWebKit()
  let iosTouching = false
  let iosGraceUntil = 0
  let deferredCorrection = 0

  const cleanups: (() => void)[] = []

  /**
   * Cancel an in-flight programmatic scroll on genuine user input.
   *
   * Deliberately driven by *input* events rather than by unrecognised scroll
   * offsets. The browser moves `scrollTop` on its own more often than it looks —
   * clamping it when content shrinks, adjusting it when a window of items is
   * replaced — and those are indistinguishable from a user drag if all you have is
   * the offset. Treating them as input cancels scrolls nobody asked to cancel;
   * watching for a wheel, a touch, a pointer or a key is unambiguous.
   */
  const cancelOnInput = (): void => {
    if (pending) finish(false, 'input')
    // After the cancel, not before: a listener that throws must not leave a
    // programmatic scroll running with nothing left to stop it.
    options.onUserInput?.()
  }

  /**
   * Attach the DOM listeners.
   *
   * Separate from construction on purpose. Attaching in the constructor meant merely
   * *building* a scroller bound 4–7 listeners to the scroll element, so anything that
   * constructed one speculatively — a React `useMemo` or a `setState` updater React
   * chose to run twice — leaked them with no way to reach the `dispose` that would
   * have removed them. Constructing is now inert; `attach()` is called once from
   * `engine.mount()`.
   */
  let attached = false
  /** Set when the platform reports that scrolling has stopped. */
  let settledExternally = false
  const attach = (): void => {
    if (attached || disposed) return
    attached = true

    // `scrollend` is corroboration, not the primary mechanism: the rAF loop is what
    // establishes that the *target* has stopped moving, which no scroll event can tell
    // you. What this adds is latency — once the platform says scrolling has ended and we
    // are already at an unmoving target, there is nothing left to wait for, so the
    // measurement-quiet window can be short-circuited.
    //
    // Where the event is unavailable, `onScrollSettled` debounces `scroll` instead; the
    // loop's own deadline means neither path can hang.
    cleanups.push(
      onScrollSettled(viewport, () => {
        if (pending) settledExternally = true
      }),
    )

    const element = viewport.getElement()
    if (!element) return

    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
    for (const type of events) {
      element.addEventListener(type, cancelOnInput, { passive: true })
    }
    cleanups.push(() => {
      for (const type of events) element.removeEventListener(type, cancelOnInput)
    })

    if (isIOS) {
      const onTouchStart = (): void => {
        iosTouching = true
      }
      const onTouchEnd = (): void => {
        iosTouching = false
        iosGraceUntil = now() + IOS_TOUCH_GRACE_MS
      }
      element.addEventListener('touchstart', onTouchStart, { passive: true })
      element.addEventListener('touchend', onTouchEnd, { passive: true })
      element.addEventListener('touchcancel', onTouchEnd, { passive: true })
      cleanups.push(() => {
        element.removeEventListener('touchstart', onTouchStart)
        element.removeEventListener('touchend', onTouchEnd)
        element.removeEventListener('touchcancel', onTouchEnd)
      })
    }
  }

  /** Whether it is currently safe to write a scroll offset. */
  const canWriteScroll = (): boolean => {
    if (!isIOS) return true
    if (iosTouching) return false
    if (now() < iosGraceUntil) return false

    // Refuse while in rubber-band overscroll: a write there snaps the page to the
    // clamped value the moment the bounce ends.
    const offset = viewport.getScrollOffset()
    return offset >= 0 && offset <= viewport.getMaxScrollOffset()
  }

  /**
   * Where the pending scroll's destination is *now*.
   *
   * Re-resolved rather than remembered, so a prepend that shifts every index does not
   * silently redirect the scroll. A key that has left the collection keeps its last
   * known index: aiming at a stale position is better than aiming at nothing, and the
   * loop's deadline still ends it.
   */
  const indexFor = (current: PendingScroll): number => {
    const index = getCache().indexOf(current.key)
    if (index >= 0) current.index = index
    return current.index
  }

  /**
   * The offset that puts `index` where `align` asks for, clamped to reality.
   *
   * Clamped against the browser's own maximum, never against the cache's
   * estimated total — clamping in the wrong space is the whole of TanStack
   * #1001, where the error grew with the list's distance from the top of the
   * page.
   */
  const targetFor = (index: number, align: ScrollAlign, extra: number): number => {
    const cache = getCache()
    const geometry = getGeometry()
    const maxOffset = viewport.getMaxScrollOffset()

    // The last item aligned to the end is the one case where our measurements
    // cannot be trusted: borders and padding outside the list still occupy
    // scrollable space, so ask the browser instead of arriving a pixel short.
    //
    // Unless we have measured what is down there. `spaceAfter` is non-zero
    // exactly when a footer or a sticky composer occupies that space and its
    // height is known — and once it is known, our own offsets are the better
    // answer, because they are exact floats while `getMaxScrollOffset` is built
    // from an integer `clientHeight`. Both halves of that were observed: taking
    // the shortcut and subtracting `spaceAfter` parks the last comment behind
    // the composer (80.25px out in all three engines, a composer-height,
    // because a sticky footer counts in `spaceAfter` and in `paddingEnd` both);
    // correcting for that lands Chromium and WebKit exactly and Firefox
    // 0.55px short, which is the integer `clientHeight` and nothing else.
    // Falling through to the general case has neither problem, and expresses
    // the alignment once rather than twice.
    if (align === 'end' && index === cache.length - 1 && (geometry.spaceAfter ?? 0) === 0) {
      return maxOffset
    }

    // `start` is the offset that puts the item's top edge at the top of the
    // *visible* area — below any sticky header — so every other alignment is
    // expressed relative to it and the padding never has to be reasoned about
    // twice.
    const start = offsetForIndex(index, cache, geometry)
    const size = cache.sizeOf(index)
    const visibleSize = visibleSizeOf(geometry, viewport.getViewportSize())

    let target: number
    switch (align) {
      case 'start':
        target = start
        break
      case 'end':
        target = start + size - visibleSize
        break
      case 'center':
        target = start + size / 2 - visibleSize / 2
        break
      case 'auto': {
        const current = viewport.getScrollOffset()
        if (start < current) target = start
        else if (start + size - visibleSize > current) target = start + size - visibleSize
        // Already fully visible: the right amount of scrolling is none at all.
        else target = current
        break
      }
    }

    return Math.min(Math.max(target + extra, 0), maxOffset)
  }

  /** Write an offset, remembering the intent so the echo is recognisable. */
  const write = (offset: number): void => {
    if (!canWriteScroll()) {
      deferredCorrection = offset - viewport.getScrollOffset()
      return
    }
    rememberIntent(offset)
    viewport.setScrollOffset(offset)

    // Recover the fraction the platform refused to take, as a visual offset.
    applyCarry(carryFor(offset, viewport.getScrollOffset()))
  }

  const finish = (settled: boolean, reason: ScrollEndReason): void => {
    const current = pending
    if (!current) return

    pending = null
    if (frame !== null) {
      cancelFrame(frame)
      frame = null
    }
    onScrollingChange?.(false)

    // What the sub-pixel carry could not absorb. For a settled scroll this is
    // normally exactly zero — the carry recovers the fraction the platform
    // refused — and for an unsettled one it is the honest remaining gap.
    const finalTarget = targetFor(indexFor(current), current.align, current.offset)
    const actual = viewport.getScrollOffset()
    const deviation = finalTarget - actual - carryFor(finalTarget, actual)

    if (TRACING) {
      trace('scroll.finish', () => ({
        key: current.key,
        index: current.index,
        settled,
        reason,
        deviation,
        finalTarget,
        actual,
        iterations: current.iterations,
      }))
    }

    current.resolve({ settled, deviation, iterations: current.iterations, reason })
  }

  const step = (): void => {
    frame = null
    const current = pending
    if (!current || disposed) return

    const elapsed = now() - current.startedAt
    if (elapsed > HARD_DEADLINE_MS) {
      finish(false, 'deadline')
      return
    }

    const previousIndex = current.index
    const index = indexFor(current)
    // Follow the destination if it moved: the pin exists to keep it mounted and measured,
    // and a pin left on the index it used to occupy holds the wrong row instead. The
    // index from the previous frame is the only state this needs — `scrollToIndex` has
    // already pinned the starting one.
    if (current.smooth && requestRange && index !== previousIndex) {
      requestRange(index, index)
    }
    const target = targetFor(index, current.align, current.offset)
    const tolerance = convergenceTolerance(viewport.getDevicePixelRatio())
    const targetMoved = Math.abs(target - current.lastTarget) > tolerance

    // Arrival is judged on where the content *appears*, not on the raw scroll
    // offset. The carry is what makes the visual position exact on an engine that
    // will not accept a fractional offset, so ignoring it here asks the scroller
    // to achieve something the platform has already refused — on WebKit at dPR 2
    // a 0.75px truncation the carry fully absorbs would never satisfy a 0.5px
    // tolerance, and the loop runs to its deadline reporting a deviation of zero.
    const actual = viewport.getScrollOffset()
    const uncarried = target - actual - carryFor(target, actual)
    const arrived = Math.abs(uncarried) <= tolerance
    // Either the model has been still for long enough, or the platform has told us the
    // scrolling itself is over. The second is strictly better information when it
    // arrives, and it usually arrives sooner.
    const quiet =
      settledExternally || now() - current.lastModelChangeAt > MODEL_QUIET_MS

    if (isTracing()) {
      traceStep({
        key: current.key,
        index,
        target,
        actual,
        uncarried,
        arrived,
        targetMoved,
        quiet,
        settledExternally,
        stableFrames: current.stableFrames,
        elapsed,
      })
    }

    if (!targetMoved && arrived && quiet) {
      current.stableFrames++
      if (current.stableFrames >= STABLE_FRAMES) {
        // Converged at tolerance; commit the exact float so the landing is not
        // left a fraction short of where it was asked to be.
        write(target)
        finish(true, 'converged')
        return
      }
    } else {
      current.stableFrames = 0

      if (targetMoved || !arrived) {
        current.lastTarget = target
        current.iterations++

        if (current.smooth) {
          // Exponential approach, re-aimed every frame. A fixed-duration ease
          // over a moving endpoint produces a visible discontinuity each time the
          // endpoint moves; absorbing the movement into the approach does not.
          //
          // Stepped by *elapsed time*, not per frame. A fixed fraction per frame ties the
          // animation's wall-clock duration to the frame rate: the same scroll that takes
          // 700ms at 60fps takes 1.4s at 30fps and can then miss the deadline entirely —
          // four WebKit landings on a loaded CI runner ended 300–580px short, reporting
          // `deadline` honestly for a scroll that simply ran out of frames. Time-based, it
          // takes the same wall clock at any frame rate.
          const from = viewport.getScrollOffset()
          const elapsedSinceStep = Math.min(
            Math.max(now() - current.lastStepAt, 0),
            MAX_STEP_MS,
          )
          const k = 1 - Math.exp(-elapsedSinceStep / SMOOTH_TAU_MS)
          const advance = (target - from) * k

          // Snap the last stretch rather than easing into it. An exponential
          // approach's step shrinks without limit, and once it falls below what
          // the platform will accept the offset simply stops changing — the next
          // frame computes the same advance and the animation stalls short of its
          // target forever. See SMOOTH_MIN_STEP.
          current.lastStepAt = now()
          write(Math.abs(advance) <= SMOOTH_MIN_STEP ? target : from + advance)
        } else {
          write(target)
        }
      }
    }

    // Past the soft budget, stop re-aiming and settle for what we have rather
    // than fighting a list that will not hold still.
    if (elapsed > SOFT_DEADLINE_MS && quiet) {
      finish(arrived, arrived ? 'converged' : 'deadline')
      return
    }

    frame = requestFrame(step)
  }

  const schedule = (): void => {
    if (frame === null && pending) frame = requestFrame(step)
  }

  return {
    scrollToIndex(index, scrollOptions = {}) {
      const cache = getCache()
      if (disposed || cache.length === 0) {
        return Promise.resolve({ settled: false, deviation: 0, iterations: 0, reason: 'empty' })
      }

      // A new absolute command invalidates any banked correction.
      deferredCorrection = 0

      const clamped = Math.min(Math.max(index, 0), cache.length - 1)
      // Non-null because `clamped` is within `[0, length - 1]` of a cache the check above
      // proved non-empty. Asserted rather than branched: a runtime guard here would be
      // unreachable code that the coverage floors then have to be loosened for, and it is
      // what lets the pending scroll hold a plain `ItemKey` instead of testing for
      // `undefined` every frame.
      const key = cache.keyAt(clamped)!
      const align = scrollOptions.align ?? 'start'
      const extra = scrollOptions.offset ?? 0
      const smooth = scrollOptions.behavior === 'smooth' && !prefersReducedMotion()

      // Replace any scroll already in flight, resolving it honestly.
      if (pending) finish(false, 'replaced')

      const startedAt = now()
      let resolve!: (result: ScrollResult) => void
      const promise = new Promise<ScrollResult>((r) => {
        resolve = r
      })

      settledExternally = false
      pending = {
        key,
        index: clamped,
        align,
        offset: extra,
        smooth,
        startedAt,
        lastTarget: Number.NaN,
        stableFrames: 0,
        lastModelChangeAt: startedAt,
        lastStepAt: startedAt,
        iterations: 0,
        resolve,
      }
      onScrollingChange?.(true)

      if (smooth && requestRange) {
        // Mount the destination so it is measured before the animation starts.
        requestRange(clamped, clamped)
      }

      const target = targetFor(clamped, align, extra)
      pending.lastTarget = target
      if (TRACING) {
        trace('scroll.start', () => ({
          key: pending?.key,
          index: clamped,
          align,
          smooth,
          target,
          actual: viewport.getScrollOffset(),
        }))
      }

      if (!smooth) write(target)

      // Fast path: when every item is measured the target cannot move, so there
      // is nothing to converge towards and waiting out the quiet period would
      // only delay the settle promise — and with it the caller's highlight.
      //
      // Note this loop is driven by animation frames, not by scroll events, so it
      // does not need the "synthesise a completion when the write is a no-op"
      // guard that event-driven implementations hang without. Frames keep coming
      // whether or not the offset changed.
      const tolerance = convergenceTolerance(viewport.getDevicePixelRatio())
      const fullyMeasured = cache.measuredCount === cache.length
      if (!smooth && fullyMeasured && Math.abs(viewport.getScrollOffset() - target) <= tolerance) {
        write(target)
        finish(true, 'converged')
        return promise
      }

      schedule()
      return promise
    },

    notifyModelChanged() {
      if (TRACING) trace('scroll.modelChanged', () => ({ pending: pending !== null }))
      if (pending) {
        pending.lastModelChangeAt = now()
        // The scrolling may have stopped, but the model just moved — so the earlier
        // `scrollend` no longer tells us anything about the target being stable.
        settledExternally = false
        schedule()
      }
    },

    notifyScroll(offset) {
      // Recognising our own echo still matters — the caller uses it to decide
      // whether to re-derive its anchor — but an unrecognised offset is *not*
      // treated as a cancellation signal. See `cancelOnInput` for why.
      const self = consumeIntent(offset)

      // Flush a correction banked during iOS momentum, now that scrolling has
      // demonstrably continued past it.
      if (deferredCorrection !== 0 && canWriteScroll()) {
        const next = offset + deferredCorrection
        // At the bottom clamp a negative correction has already been absorbed by
        // the browser; replaying it would lift the list off the end.
        const max = viewport.getMaxScrollOffset()
        deferredCorrection = 0
        if (!(offset >= max && next < offset)) write(Math.min(Math.max(next, 0), max))
      }

      return self
    },

    isScrolling: () => pending !== null,

    attach,

    markSelfWrite(offset) {
      rememberIntent(offset)
    },

    cancel() {
      if (pending) finish(false, 'cancelled')
      deferredCorrection = 0
    },

    dispose() {
      disposed = true
      if (pending) finish(false, 'disposed')
      if (frame !== null) {
        cancelFrame(frame)
        frame = null
      }
      for (const cleanup of cleanups) cleanup()
      cleanups.length = 0
    },
  }
}

/**
 * Settle detection: the native `scrollend` event where available, a timeout
 * otherwise.
 *
 * `scrollend` became baseline when Safari 26.2 joined Chrome/Edge 114 and
 * Firefox 109. Two things make a fallback mandatory regardless: it does not fire
 * at all when the scroll position did not change, and older Safari lacks it
 * entirely. The README points those consumers at the optional `scrollyfills`
 * peer dependency.
 */
export function onScrollSettled(viewport: Viewport, callback: () => void): () => void {
  if (supportsScrollEnd()) {
    return viewport.addEventListener('scrollend', callback)
  }

  let timer: ReturnType<typeof setTimeout> | null = null

  const off = viewport.addEventListener('scroll', () => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(callback, SCROLL_END_FALLBACK_MS)
  })

  return () => {
    if (timer !== null) clearTimeout(timer)
    off()
  }
}
