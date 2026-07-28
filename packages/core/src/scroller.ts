import {
  type AnchorGeometry,
  carryFor,
  convergenceTolerance,
  isSelfWrite,
  offsetForIndex,
} from './anchor.js'
import { isIOSWebKit, prefersReducedMotion, supportsScrollEnd } from './env.js'
import type { SizeCache } from './sizeCache.js'
import type { ScrollAlign, ScrollResult, ScrollToOptions } from './types.js'
import type { Viewport } from './viewport.js'

/** How long without a measurement counts as "the model has stopped moving". */
const MEASUREMENT_QUIET_MS = 150
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
/** iOS only fires touch events at the start of momentum, so a timer is needed. */
const IOS_TOUCH_GRACE_MS = 150

export interface ScrollerOptions {
  viewport: Viewport
  /** Read the live cache — it is replaced as the window grows. */
  getCache: () => SizeCache
  getGeometry: () => AnchorGeometry
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
  now?: () => number
  requestFrame?: (callback: () => void) => number
  cancelFrame?: (handle: number) => void
}

export interface Scroller {
  scrollToIndex(index: number, options?: ScrollToOptions): Promise<ScrollResult>
  /** Feed in the fact that measurements landed, to drive convergence. */
  notifyMeasured(): void
  /**
   * Feed in an observed scroll offset.
   *
   * @returns whether this was the echo of our own write rather than user input.
   */
  notifyScroll(offset: number): boolean
  /** Whether a programmatic scroll is in flight (visibility events suppressed). */
  isScrolling(): boolean
  /** Abandon any in-flight scroll, resolving it honestly as unsettled. */
  cancel(): void
  dispose(): void
}

interface PendingScroll {
  index: number
  align: ScrollAlign
  offset: number
  smooth: boolean
  startedAt: number
  lastTarget: number
  stableFrames: number
  lastMeasurementAt: number
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
  /** What we last asked the browser for, so its echo is recognisable. */
  let intendedOffset: number | null = null
  let disposed = false

  // iOS WebKit: writing scrollTop during momentum cancels the fling, so
  // corrections are banked until the gesture is demonstrably over.
  const isIOS = isIOSWebKit()
  let iosTouching = false
  let iosGraceUntil = 0
  let deferredCorrection = 0

  const cleanups: Array<() => void> = []

  if (isIOS) {
    const element = viewport.getElement()
    if (element) {
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
    if (align === 'end' && index === cache.length - 1) return maxOffset

    // `start` is the offset that puts the item's top edge at the top of the
    // *visible* area — below any sticky header — so every other alignment is
    // expressed relative to it and the padding never has to be reasoned about
    // twice.
    const start = offsetForIndex(index, cache, geometry)
    const size = cache.sizeOf(index)
    const visibleSize =
      viewport.getViewportSize() -
      (geometry.scrollPaddingStart ?? 0) -
      (geometry.scrollPaddingEnd ?? 0)

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
    intendedOffset = offset
    viewport.setScrollOffset(offset)

    // Recover the fraction the platform refused to take, as a visual offset.
    applyCarry(carryFor(offset, viewport.getScrollOffset()))
  }

  const finish = (settled: boolean): void => {
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
    const finalTarget = targetFor(current.index, current.align, current.offset)
    const actual = viewport.getScrollOffset()
    const deviation = finalTarget - actual - carryFor(finalTarget, actual)

    current.resolve({ settled, deviation, iterations: current.iterations })
  }

  const step = (): void => {
    frame = null
    const current = pending
    if (!current || disposed) return

    const elapsed = now() - current.startedAt
    if (elapsed > HARD_DEADLINE_MS) {
      finish(false)
      return
    }

    const target = targetFor(current.index, current.align, current.offset)
    const tolerance = convergenceTolerance(viewport.getDevicePixelRatio())
    const targetMoved = Math.abs(target - current.lastTarget) > tolerance
    const arrived = Math.abs(viewport.getScrollOffset() - target) <= tolerance
    const quiet = now() - current.lastMeasurementAt > MEASUREMENT_QUIET_MS

    if (!targetMoved && arrived && quiet) {
      current.stableFrames++
      if (current.stableFrames >= STABLE_FRAMES) {
        // Converged at tolerance; commit the exact float so the landing is not
        // left a fraction short of where it was asked to be.
        write(target)
        finish(true)
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
          const from = viewport.getScrollOffset()
          const k = 1 - Math.exp(-16 / SMOOTH_TAU_MS)
          const next = from + (target - from) * k
          write(Math.abs(target - next) <= tolerance ? target : next)
        } else {
          write(target)
        }
      }
    }

    // Past the soft budget, stop re-aiming and settle for what we have rather
    // than fighting a list that will not hold still.
    if (elapsed > SOFT_DEADLINE_MS && quiet) {
      finish(arrived)
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
        return Promise.resolve({ settled: false, deviation: 0, iterations: 0 })
      }

      // A new absolute command invalidates any banked correction.
      deferredCorrection = 0

      const clamped = Math.min(Math.max(index, 0), cache.length - 1)
      const align = scrollOptions.align ?? 'start'
      const extra = scrollOptions.offset ?? 0
      const smooth = scrollOptions.behavior === 'smooth' && !prefersReducedMotion()

      // Replace any scroll already in flight, resolving it honestly.
      if (pending) finish(false)

      const startedAt = now()
      let resolve!: (result: ScrollResult) => void
      const promise = new Promise<ScrollResult>((r) => {
        resolve = r
      })

      pending = {
        index: clamped,
        align,
        offset: extra,
        smooth,
        startedAt,
        lastTarget: Number.NaN,
        stableFrames: 0,
        lastMeasurementAt: startedAt,
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
        finish(true)
        return promise
      }

      schedule()
      return promise
    },

    notifyMeasured() {
      if (pending) {
        pending.lastMeasurementAt = now()
        schedule()
      }
    },

    notifyScroll(offset) {
      const self = isSelfWrite(offset, intendedOffset)
      intendedOffset = null

      // A genuine user scroll cancels an in-flight programmatic scroll: fighting
      // the user's thumb is never the right answer.
      if (!self && pending) finish(false)

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

    cancel() {
      if (pending) finish(false)
      deferredCorrection = 0
    },

    dispose() {
      disposed = true
      if (pending) finish(false)
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

  const view = viewport.getWindow()
  let timer: ReturnType<typeof setTimeout> | null = null

  const off = viewport.addEventListener('scroll', () => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(callback, SCROLL_END_FALLBACK_MS)
  })

  return () => {
    if (timer !== null) clearTimeout(timer)
    off()
    void view
  }
}
