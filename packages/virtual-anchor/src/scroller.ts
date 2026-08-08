import {
  carryFor,
  convergenceTolerance,
  isSelfWrite,
  offsetForIndex,
} from './anchor.js'
import { visibleSizeOf, type ListInsets } from './listGeometry.js'
import { prefersReducedMotion } from './env.js'
import { createScrollWriteGate, type ScrollWriteGate } from './momentum.js'
import { onScrollSettled } from './settle.js'
import { DEBUG } from './debugFlag.js'
import { isTracing, trace } from './trace.js'
import type { StepPayload } from './traceTopics.js'
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
 * How long into a scroll a pending measurement may still hold the landing back.
 *
 * A cut-off on the age of the whole scroll, not a timer that starts when the wait does — which
 * is the useful shape: the race this closes is a `ResizeObserver` delivery for a row that has
 * just mounted, one or two frames after the scroll begins, so anything still unmeasured well
 * past that is not arriving.
 *
 * Bounded rather than absolute because "never measured" is a legitimate state: a caller can aim
 * at a row the list will not mount, and waiting indefinitely would turn a landing that used to
 * report `converged` into one that reports `deadline` five seconds later. Past this the model is
 * as good as it is going to get, and converging against it is the honest answer.
 *
 * The same 150ms as {@link MODEL_QUIET_MS}, and for the same reason: it is the window in which
 * the model is still expected to move.
 */
const MEASURE_GRACE_MS = 150
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
  /**
   * Whether a row is mounted but not yet measured, so its real height is still coming.
   *
   * The scroller cannot answer this from the cache alone: an unmeasured row is either one whose
   * `ResizeObserver` delivery is a frame away, or one the list will never mount at all, and the
   * two want opposite treatment. Only the engine knows which, because only the engine knows what
   * is on screen.
   *
   * Optional, and absent means "nothing is pending" — a caller driving the scroller directly is
   * not running a surface for it to ask about.
   */
  hasPendingMeasurement?: () => boolean
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
  /**
   * The momentum-aware write gate, shared with whoever else writes scroll offsets.
   *
   * Optional so a standalone `createScroller` still guards itself; the engine passes
   * its own in, because its two direct writes have to consult the same answer. They
   * did not, which is the whole of issue #26: a measurement landing mid-fling wrote
   * `scrollTop` straight past this module and cancelled the fling.
   */
  writeGate?: ScrollWriteGate
  /**
   * Where the content sits, in the space item offsets live in.
   *
   * Optional so a standalone `createScroller` still works; the engine passes its own
   * `contentOffset()` in, because since #29 `getScrollOffset()` is where the *scrollbar* is
   * and every comparison against an item offset wants the other one.
   *
   * Defaults to the scroll offset plus the carry this scroller last applied, which is the
   * whole of the difference when no engine is holding a gesture shift.
   */
  getContentOffset?: () => number
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
 * Record one frame of the convergence loop.
 *
 * Two deliberate choices. It is at module scope rather than an inline thunk inside `step`,
 * because a closure there forces a context object for the whole scope on every call —
 * whether or not tracing is on — and that loop is the hottest code in this library.
 *
 * And it takes a named record rather than a positional list: four of these fields are
 * consecutive booleans, so transposing two of them would compile clean and then lie in
 * every trace, in the module whose entire purpose is being trustworthy about what
 * happened. The record is built only when a listener is attached, which is why the call site
 * asks `isTracing()` *as well as* `DEBUG`, rather than either alone: `DEBUG` is the part an
 * optimizer can decide, so it is what deletes this function and its topic string from a
 * build without instrumentation, and `isTracing()` is the part that can only be answered at
 * runtime, so it is what decides whether to build the record. This was the single call site
 * that the constant alone could not eliminate — a function call is not statically decidable,
 * so `traceStep` stayed referenced and kept `'scroll.step'` alive.
 */
function traceStep(step: StepPayload): void {
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
  /**
   * When `step` last ran at all, including frames the write gate blocked.
   *
   * Separate from {@link lastStepAt} because it answers a different question: that
   * one is "how far should the easing advance", this one is "how much time should
   * the deadline not be charged for".
   */
  lastTickAt: number
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
    hasPendingMeasurement,
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
  // corrections are banked until the gesture is demonstrably over. The decision of
  // *when* that is lives in the gate, which the engine shares so its own writes
  // cannot bypass it.
  const gate = options.writeGate ?? createScrollWriteGate({ viewport })
  /** Whether this scroller built the gate and must therefore dispose of it. */
  const ownsGate = options.writeGate === undefined
  let deferredCorrection = 0

  /** The visual carry last handed to `applyCarry`; see the default below for its one reader. */
  let appliedCarry = 0
  /**
   * Where the content is, resolved once rather than at each of its readers.
   *
   * The default is `scrollTop` plus the carry, because a standalone scroller has no engine
   * holding a gesture shift for it and the carry is then the whole of the difference — and
   * this module applied that carry itself, so it is the one thing here that can know. The
   * term is load-bearing rather than tidy: without it the arrival test cannot accept a
   * truncation the carry has already made good, for the reason spelled out there.
   */
  const getContentOffset =
    options.getContentOffset ?? (() => viewport.getScrollOffset() + appliedCarry)

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

    // First, and unconditionally. The gate's listeners must be registered ahead of
    // the engine's scroll and settle handlers — `engine.mount()` calls this before
    // binding either — so that by the time the engine asks `canWrite()` the gate has
    // already seen the same event and transitioned.
    gate.attach()
    // Two things wait on the gate reopening.
    //
    // The banked correction needs somewhere to go once the fling is over. It used to
    // ride on the next scroll event, which worked only because the guard reopened
    // *during* momentum while events were still arriving. Now that it stays shut
    // until settle, the reopening is the last thing that happens — so the flush has
    // to hang off that rather than off an event that will never come.
    //
    // And the convergence loop parks itself rather than spinning through a fling, so
    // this is what wakes it. Guarded on `pending` because the scroll it was running for
    // may have been replaced or cancelled while it slept, and on `frame` because a
    // `notifyModelChanged` may already have restarted it.
    cleanups.push(
      gate.onOpen(() => {
        // Before the flush, so a reader can tell what was waiting from what happened next.
        if (DEBUG) {
          trace('scroll.wake', () => ({ pending: pending !== null, banked: deferredCorrection }))
        }
        flushDeferredCorrection()
        schedule()
      }),
    )

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

  }

  /** Whether it is currently safe to write a scroll offset. */
  const canWriteScroll = (): boolean => {
    if (!gate.canWrite()) return false
    // iOS only, like everything else here. Applying the range test on every platform
    // was a regression caught by the demo's e2e suite: Chromium reports an offset
    // outside `[0, max]` often enough — mid-clamp, while content is growing — that
    // refusing those writes stalled an ordinary `scrollTop` nudge outright.
    if (!gate.isActive()) return true

    // Refuse while in rubber-band overscroll: a write there snaps the page to the
    // clamped value the moment the bounce ends. Kept here rather than in the gate
    // because it is a *position* test, not a time one — the gate answers "is a
    // gesture in flight", runs on every publish, and reads no geometry.
    //
    // The raw offset, deliberately, where everything else in this file now reads content
    // space: the question is whether the *scrollbar* has been dragged outside its own
    // range, and a paint offset moves the content without moving the scrollbar at all.
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
        // Where the content is, not where the scrollbar is: "is this item already on
        // screen" is a question about the screen. Two problems in one read, in fact — the
        // `else` branch returns this value as the target, and every other branch here
        // returns a content-space offset.
        const current = getContentOffset()
        if (start < current) target = start
        else if (start + size - visibleSize > current) target = start + size - visibleSize
        // Already fully visible: the right amount of scrolling is none at all.
        else target = current
        break
      }
    }

    // Two scroll-space numbers in an otherwise content-space function, both deliberate and
    // both only correct because nothing is held when a target is written: `maxOffset` above
    // is the browser's own answer to "as far down as this goes", and the clamp here is the
    // range the write has to land in. While a shift is outstanding the reachable content
    // range is that window displaced by it — which is what bounds the shift in the first
    // place, in the engine, so a target clamped here cannot be outside it once it is folded.
    return Math.min(Math.max(target + extra, 0), maxOffset)
  }

  /**
   * Write an offset, remembering the intent so the echo is recognisable.
   *
   * Takes a **content-space** offset, like everything else built from item offsets here,
   * and hands it to a scroll-space setter. Exact rather than approximate, and it rests on
   * one invariant this module *requires* rather than merely observes: nothing is ever held
   * while the gate is open. A gesture shift is only accumulated while writing is refused,
   * and the engine folds an outstanding one into `scrollTop` ahead of every other reopen
   * listener — so at the moment of a write the two spaces coincide. Flush a banked
   * content-space distance before that fold and the shift is applied twice.
   */
  /**
   * Write an offset.
   *
   * `from` is where the content already is, **passed rather than read**. Every one of the five
   * callers has it in hand — `step` computed it as `actual`, `flushDeferredCorrection` as
   * `offset`, `scrollToIndex` for its arrival test — and reading it again here would be a fresh
   * `element.scrollTop`, which is an uncached layout read.
   *
   * That is not hypothetical tidiness. The engine removed three such reads from `scroll.write`'s
   * payload for exactly this reason, and the first version of the trace below reintroduced one in
   * this module: per convergence frame at up to 120 Hz, and — worse — once on the gate-open path,
   * which runs immediately after `reconcileGestureShift` has written a style. That one is a
   * guaranteed forced synchronous layout at the precise moment a fling ends, which is the moment
   * the whole gate exists to protect. Defaulted rather than required so a future caller cannot
   * quietly get it wrong by omission.
   */
  const write = (offset: number, from = getContentOffset()): void => {
    const allowed = canWriteScroll()

    // This module wrote `scrollTop` and said nothing about it, for as long as there has been
    // tracing at all. `scroll.step` reports that the convergence loop *ran*, which is not the
    // same claim — and the demo's on-device HUD filtered on `scroll.write`, the engine's door,
    // so every conclusion of the form "no write escaped during that gesture" was drawn from
    // half the writers. This is the other half.
    //
    // One event for both branches, with `refused` saying which, because the interesting
    // question during a fling is not "did the scroller write" but "did the scroller *want* to
    // write" — a refusal banks a delta that will be replayed the moment the gate reopens, and
    // that replay is a write during a moment nobody was watching.
    if (DEBUG) {
      trace('scroll.commit', () => ({
        offset,
        from,
        refused: !allowed,
        banked: deferredCorrection,
        carry: appliedCarry,
      }))
    }

    if (!allowed) {
      // A content-space *distance*: both terms are content space, and replaying it later
      // against wherever the content has got to is the whole point of banking a delta.
      deferredCorrection = offset - from
      return
    }
    rememberIntent(offset)
    // eslint-disable-next-line no-restricted-syntax -- gated by canWriteScroll above
    viewport.setScrollOffset(offset)

    // Recover the fraction the platform refused to take, as a visual offset. The raw
    // offset, because the question is what the platform did with the number just handed
    // to it — which is about `scrollTop` and nothing else.
    appliedCarry = carryFor(offset, viewport.getScrollOffset())
    applyCarry(appliedCarry)
  }

  /**
   * Apply a correction banked while writing was refused.
   *
   * A *delta*, not a destination: what was banked is how far the view needed to move,
   * and by the time it can be applied the fling has carried the scroller somewhere
   * else entirely. Replaying the original absolute offset would undo the gesture.
   *
   * Measured and replayed in the same space — where the content is, at both ends. Doing
   * both against `scrollTop` looks equally symmetrical and is not: the gesture shift
   * changes in between, either because another correction accumulated into it or because
   * the gate reopening folded it away, so the raw offset means a different thing at each
   * end and the replay lands off by the difference.
   *
   * Reached from two places, because there are two reasons a write gets refused and
   * they end differently. A gesture-driven refusal ends when the gate reopens, and
   * there may be no scroll event after that. A rubber-band refusal never moves the
   * gate at all — the bounce simply comes back into range — so the next scroll event
   * is the only signal it is over.
   */
  const flushDeferredCorrection = (): void => {
    if (deferredCorrection === 0 || !canWriteScroll()) return

    const banked = deferredCorrection
    const offset = getContentOffset()
    const next = offset + deferredCorrection
    // At the bottom clamp a negative correction has already been absorbed by the
    // browser; replaying it would lift the list off the end.
    const max = viewport.getMaxScrollOffset()
    deferredCorrection = 0
    const skipped = offset >= max && next < offset
    // After the early return above, so the common case — nothing banked — costs nothing, and
    // `max` is already read. `skipped` is the bottom-clamp refusal, which is otherwise
    // indistinguishable from a flush that never happened.
    if (DEBUG) trace('scroll.flush', () => ({ banked, from: offset, next, max, skipped }))
    if (skipped) return
    write(Math.min(Math.max(next, 0), max), offset)
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

    // How far the content is from where the caller asked it to be. For a settled scroll
    // this is normally exactly zero — the carry recovers the fraction the platform
    // refused, and it is part of where the content is — and for an unsettled one it is
    // the honest remaining gap.
    const finalTarget = targetFor(indexFor(current), current.align, current.offset)
    const actual = getContentOffset()
    const deviation = finalTarget - actual

    if (DEBUG) {
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

    // A scroll that is not allowed to move must not be allowed to time out either.
    // The gate can now stay shut for the length of a fling — seconds, not the 150ms
    // it used to be — and a loop whose clock kept running through that would burn
    // `SOFT_DEADLINE_MS` and resolve `deadline` with a large deviation for a scroll
    // that was never given a single chance to write. So the deadline clock is
    // suspended: carry its origins forward by the time that just passed.
    //
    // `lastTickAt` rather than `lastStepAt`, which belongs to the smooth integrator
    // and is only touched on frames that actually advance. Measuring the suspension
    // against that would bill the first blocked frame for every open frame before it.
    //
    // Gated on the *gesture*, not on `canWriteScroll()`, which also refuses during
    // rubber-band overscroll. Two reasons: a bounce is ~300ms and well inside every
    // deadline, so it needs no suspension; and the positional half of that predicate
    // reads `scrollTop` and `scrollHeight`, which has no business running at the top of
    // every frame of every ordinary scroll.
    const tick = now()
    const sinceTick = Math.max(tick - current.lastTickAt, 0)
    current.lastTickAt = tick
    if (!gate.canWrite()) {
      current.startedAt += sinceTick
      current.lastModelChangeAt += sinceTick
      current.lastStepAt += sinceTick
      // Once per park, not once per frame — which is the same property the sleep below
      // exists for, and the reason this event is affordable at all. A reader seeing
      // `scroll.park` immediately followed by `scroll.wake` and a `scroll.commit` knows the
      // convergence loop wrote during a gesture, which is one of the ways momentum dies.
      if (DEBUG) trace('scroll.park', () => ({ elapsed: tick - current.startedAt, suspended: sinceTick }))
      // Sleep rather than spin. The gate stays shut for the length of a fling, so
      // re-requesting here would schedule a main-thread wakeup every frame for up to
      // `MOMENTUM_IDLE_MS` — hundreds of them, all guaranteed to do nothing — during the
      // one moment on iOS where contention is most visible. `attach` subscribes the
      // resume to `gate.onOpen`, which is the event that ends the wait.
      return
    }

    const elapsed = tick - current.startedAt
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

    /**
     * Whether the model is still learning the heights the landing is computed from.
     *
     * Every offset a landing aims at is a sum of row heights, so declaring arrival while any row
     * on screen is still an estimate is declaring it against a model that is about to change.
     * The loop then agrees perfectly with a target that is simply wrong: it writes the offset the
     * model asked for, reads back the offset it wrote, and reports `deviation: 0` because the
     * model and the offset agree with each other while both disagree with the DOM.
     *
     * Measured on the demo: comment #137 estimates at 162px (`56 + 2 * 53`) and measures 141.
     * Landing before that arrives is out by the 21px difference — none of it for `start`, half
     * for `center`, all of it for `end` — which is exactly the -1.25 / -11.75 / -22.25 the
     * accuracy matrix reported while every landing claimed to have converged. See #67.
     *
     * Asked of the engine rather than read from the cache, because an unmeasured row is either
     * one whose delivery is a frame away or one the list will never mount, and only the surface
     * can tell those apart. The fast path in `scrollToKey` already refuses to shortcut an
     * unmeasured list on the same reasoning.
     */


    // Arrival is judged on where the content *appears*, not on the raw scroll
    // offset. Both compensations move it there: the carry is what makes the visual
    // position exact on an engine that will not accept a fractional offset — on WebKit
    // at dPR 2 a 0.75px truncation the carry fully absorbs would never satisfy a 0.5px
    // tolerance, and the loop would run to its deadline reporting a deviation of zero —
    // and the gesture shift is hundreds of pixels of the same thing.
    //
    // This read is what the comment above it has always claimed, which is the irony in
    // #33: it compensated for one contributor to the container's paint offset and not
    // the other, from the moment the second one existed.
    const actual = getContentOffset()
    const remaining = target - actual
    const arrived = Math.abs(remaining) <= tolerance
    // Either the model has been still for long enough, or the platform has told us the
    // scrolling itself is over. The second is strictly better information when it
    // arrives, and it usually arrives sooner.
    const quiet = settledExternally || tick - current.lastModelChangeAt > MODEL_QUIET_MS

    if (DEBUG && isTracing()) {
      traceStep({
        key: current.key,
        index,
        target,
        actual,
        remaining,
        arrived,
        awaitingMeasurement: hasPendingMeasurement?.() ?? false,
        targetMoved,
        quiet,
        settledExternally,
        stableFrames: current.stableFrames,
        elapsed,
      })
    }

    // The age test first, so the scan below costs nothing for the rest of the scroll: it walks
    // the rendered range, which the larger default buffer made about six times longer, and its
    // answer can only matter inside the grace.
    //
    // Named for what it is rather than what it wishes: past the grace the heights are not known,
    // the loop has simply stopped waiting for them.
    const heightsSettled =
      elapsed > MEASURE_GRACE_MS || !(hasPendingMeasurement?.() ?? false)

    if (!targetMoved && arrived && quiet && heightsSettled) {
      current.stableFrames++
      if (current.stableFrames >= STABLE_FRAMES) {
        // Converged at tolerance; commit the exact float so the landing is not
        // left a fraction short of where it was asked to be.
        write(target, actual)
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
          //
          // Interpolated from `actual` rather than a fresh read: nothing since it writes a
          // scroll offset, so one position serves the whole frame's decision.
          const elapsedSinceStep = Math.min(
            Math.max(tick - current.lastStepAt, 0),
            MAX_STEP_MS,
          )
          const k = 1 - Math.exp(-elapsedSinceStep / SMOOTH_TAU_MS)
          const advance = (target - actual) * k

          // Snap the last stretch rather than easing into it. An exponential
          // approach's step shrinks without limit, and once it falls below what
          // the platform will accept the offset simply stops changing — the next
          // frame computes the same advance and the animation stalls short of its
          // target forever. See SMOOTH_MIN_STEP.
          current.lastStepAt = tick
          write(Math.abs(advance) <= SMOOTH_MIN_STEP ? target : actual + advance, actual)
        } else {
          write(target, actual)
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
        lastTickAt: startedAt,
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
      // Read once, and *outside* the thunk. It was inside, which made it a layout read that
      // happened only when someone was watching — the same defect as `scroll.write`'s three, and
      // the write two lines below then read it a second time. Hoisting serves both.
      const startedFrom = getContentOffset()
      if (DEBUG) {
        // `key` captured from the local rather than read off `pending`, which is a mutable
        // module-level slot the thunk would close over: typed `ItemKey | undefined` and, if the
        // scroll were ever cancelled before the thunk ran, reported as `undefined` for a scroll
        // that certainly had a key. The generic signature on `trace` is what surfaced it.
        const startKey = pending.key
        trace('scroll.start', () => ({
          key: startKey,
          index: clamped,
          align,
          smooth,
          target,
          // The same space as `target`: a diagnostic reporting two coordinate systems in
          // one line would be reading the bug rather than exposing it.
          actual: startedFrom,
        }))
      }

      if (!smooth) write(target, startedFrom)

      // Fast path: when every item is measured the target cannot move, so there
      // is nothing to converge towards and waiting out the quiet period would
      // only delay the settle promise — and with it the caller's highlight.
      //
      // The proximity test is in content space, like the arrival test it stands in for.
      // Against the raw offset it resolves `settled: true` while a gesture shift is
      // outstanding: the scrollbar is at the target, the content is a shift away from it,
      // the write above was refused and banked, and the loop that would have corrected
      // both has just been told there is nothing to do.
      //
      // Note this loop is driven by animation frames, not by scroll events, so it
      // does not need the "synthesise a completion when the write is a no-op"
      // guard that event-driven implementations hang without. Frames keep coming
      // whether or not the offset changed.
      const tolerance = convergenceTolerance(viewport.getDevicePixelRatio())
      const fullyMeasured = cache.measuredCount === cache.length
      const at = getContentOffset()
      if (!smooth && fullyMeasured && Math.abs(at - target) <= tolerance) {
        write(target, at)
        finish(true, 'converged')
        return promise
      }

      schedule()
      return promise
    },

    notifyModelChanged() {
      if (DEBUG) trace('scroll.modelChanged', () => ({ pending: pending !== null }))
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

      // Covers the refusal the gate knows nothing about: a rubber-band bounce, which
      // ends by coming back into range rather than by any state change. A correction
      // banked during a *fling* has normally been flushed by `gate.onOpen` before this
      // runs, and finds nothing left to do.
      flushDeferredCorrection()

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
      // Only the gate we built. One handed in belongs to the engine, which disposes
      // of it alongside everything else `mount()` attached — tearing it down from
      // here would leave a still-mounted engine with an unguarded write path.
      if (ownsGate) gate.dispose()
    },
  }
}

