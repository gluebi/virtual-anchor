import { isIOSWebKit } from './env.js'
import { onScrollSettled } from './settle.js'
import { DEBUG } from './debugFlag.js'
import { trace } from './trace.js'
import type { Viewport } from './viewport.js'

/**
 * How long after the finger lifts to keep refusing before any scroll has arrived.
 *
 * iOS fires touch events only at the *start* of momentum, so `touchend` is not the
 * end of the scrolling. This bridges the gap between the finger lifting and the
 * first momentum scroll event; it deliberately does not try to bound the fling
 * itself, which is what {@link MOMENTUM_IDLE_MS} and the settle signal are for.
 */
const IOS_TOUCH_GRACE_MS = 150

/**
 * How long momentum may go *quiet* before the gate gives up waiting for a settle.
 *
 * A safety valve, not a duration, and the distinction is the whole of issue #53. Momentum
 * normally ends at `scrollend`, or at the settle helper's scroll debounce where that event
 * is unavailable; this exists only so a settle that never arrives cannot wedge the gate shut
 * forever.
 *
 * It used to be a *ceiling*: armed once at momentum onset and fired 3000ms later whatever
 * else had happened. On a twelve-thousand-row thread that is not a safety valve, it is the
 * common case. Measured on an iPhone, every fling that ran longer than three seconds hit it
 * and none that ran shorter did:
 *
 * | fling | outcome |
 * | --- | --- |
 * | 837ms, 2266ms | settled |
 * | 3032, 3251, 3782, 4504, 4721, 8467ms | **cap** |
 *
 * And firing it mid-fling does precisely what the gate exists to prevent: `canWrite()` starts
 * answering true again with the fling still running, the next measurement writes `scrollTop`,
 * and WebKit cancels the momentum. That is the "stops abruptly" this whole mechanism is for.
 *
 * So the timer is re-armed by every scroll event, which makes it an inactivity watchdog — and
 * inactivity is the right predicate for the thing it actually guards against. A fling still
 * delivering two hundred scroll events is self-evidently not a wedged gate.
 *
 * Three seconds of *silence* rather than something tighter, because a blocked main thread can
 * stop delivering scroll events for a while without the fling being over: the worst gap measured
 * on a device was 205ms, and on a simulator 202ms. The window has to clear that comfortably or
 * the watchdog re-creates the bug it fixes.
 *
 * The old note that this sat "deliberately below the scroller's `HARD_DEADLINE_MS` of 5000"
 * no longer applies and was already obsolete: the convergence loop suspends its deadline clock
 * while parked, so a longer gate-shut window costs a programmatic scroll nothing.
 */
const MOMENTUM_IDLE_MS = 3000

/**
 * Where a touch-driven scroll currently is.
 *
 * `grace` and `momentum` are separate states rather than one "not idle" flag because
 * they end differently: `grace` ends on a timer *or* on the first scroll event that
 * promotes it to `momentum`, while `momentum` ends on settle *or* on the watchdog going
 * quiet. A single flag cannot express "waiting to find out whether this was a tap or a
 * fling" — nor "a scroll event means onset here and means keep waiting there".
 */
export type GateState = 'idle' | 'touching' | 'grace' | 'momentum'

/**
 * Why the gate changed state.
 *
 * A union rather than a `string` because the analyzer in `virtual-anchor/debug` branches on these
 * exact spellings to find gesture boundaries and to recognise the `cap` and `grace-expired`
 * hypotheses. Typed loosely, renaming one would compile everywhere and silently stop the analyzer
 * segmenting — which is the failure `traceTopics.ts` exists to prevent, on the fields that decide
 * the most.
 */
export type GateReason =
  | 'touchstart'
  | 'touchend'
  | 'grace-expired'
  | 'momentum-onset'
  | 'cap'
  | 'settled'

/**
 * Whether the platform will accept a scroll write right now.
 *
 * Exists because iOS WebKit cancels an in-flight fling the instant `scrollTop` is
 * written, and the library has three places that write it. Keeping the decision in
 * one object — rather than as private state inside the scroller, which is where it
 * used to live — is what lets the engine's two writes consult the same answer.
 */
export interface ScrollWriteGate {
  /** Bind the touch, scroll and settle listeners. Idempotent. */
  attach(): void
  /**
   * Whether a scroll write would be honoured.
   *
   * Runs on every publish, so it is a single state comparison and reads nothing
   * from the DOM. Position-dependent refusals — rubber-band overscroll — stay with
   * the caller that already has the offsets in hand.
   */
  canWrite(): boolean
  /**
   * Whether this platform needs any of these guards at all.
   *
   * Exposed because the momentum latch is not the only iOS-only refusal: rubber-band
   * overscroll is the other, and it is a *position* test that belongs with the caller
   * holding the offsets. That caller still has to know whether to apply it — and
   * applying it everywhere is a real regression, because a non-iOS engine reporting
   * an out-of-range offset would then be refused a write it has always accepted.
   */
  isActive(): boolean
  /** Notified when the gate reopens after having been shut. Returns an unsubscribe. */
  onOpen(callback: () => void): () => void
  dispose(): void
}

export interface ScrollWriteGateOptions {
  viewport: Viewport
  /**
   * Timer seam.
   *
   * Injected rather than taken from the ambient scheduler so the state machine can
   * be driven by the same fake clock as the scroller's convergence loop; a test that
   * advances one and not the other sees the two disagree about whether a fling is
   * still running.
   *
   * Note there is deliberately no `now`. Every transition out of a shut state is
   * either an event or a timer firing, so the gate needs no clock of its own — and a
   * `canWrite()` that compared timestamps would be doing work on every publish that
   * a single state comparison already does.
   */
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Test seam: override the platform sniff. */
  isIOS?: boolean
}

/**
 * The momentum-aware write gate.
 *
 * Inert off iOS: `canWrite()` is a constant `true`, `attach()` binds nothing, and no
 * timer is ever armed. Chromium, Firefox and desktop WebKit are unaffected by any of
 * this, which is deliberate — the fling-cancelling behaviour is WebKit-on-iOS only,
 * and a guard that fires anywhere else would delay corrections for no reason.
 */
export function createScrollWriteGate(options: ScrollWriteGateOptions): ScrollWriteGate {
  const { viewport } = options
  const setTimer =
    options.setTimer ?? ((callback: () => void, ms: number): unknown => setTimeout(callback, ms))
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown): void => {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    })
  const isIOS = options.isIOS ?? isIOSWebKit()

  let state: GateState = 'idle'
  let timer: unknown = null
  let attached = false
  let disposed = false
  const cleanups: (() => void)[] = []
  const openListeners = new Set<() => void>()

  const clearPendingTimer = (): void => {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  /**
   * Replace the pending timer with a new one.
   *
   * Clears first, so the caller never has to. `enter` already argues that "clearing here rather
   * than at each call site is what stops a new transition needing to remember" — this is the same
   * argument one level down, and it exists because the watchdog re-arm below *is* a call site that
   * arms without a transition, and so was the one place having to remember.
   *
   * The two fire callbacks are hoisted rather than written inline: this runs on every scroll event
   * during momentum, and an inline arrow would allocate two closures per event — a couple of
   * hundred a second on a ProMotion device, for the length of every fling.
   */
  const arm = (ms: number, onFire: () => void): void => {
    clearPendingTimer()
    timer = setTimer(() => {
      timer = null
      onFire()
    }, ms)
  }

  const graceExpired = (): void => {
    enter('idle', 'grace-expired')
  }
  const watchdogFired = (): void => {
    enter('idle', 'cap')
  }

  /**
   * Move to a new state, cancelling whatever timer was going to move us instead.
   *
   * Every transition invalidates the pending timer — a second fling starting must not
   * be reopened by the first one's cap, and a settle must not be undone by the grace
   * expiry behind it — so clearing here rather than at each call site is what stops a
   * new transition needing to remember.
   */
  const enter = (next: GateState, reason: GateReason): void => {
    if (state === next) return
    clearPendingTimer()
    // The early return above is what makes this the shut → open *edge*: reaching
    // `idle` means we were not already there. Firing on every transition would run
    // the deferred work mid-gesture, which is the thing being deferred.
    const reopened = next === 'idle'
    state = next
    if (DEBUG) trace('scroll.gate', () => ({ state: next, reason }))
    if (reopened) {
      for (const listener of [...openListeners]) listener()
    }
  }

  const onTouchStart = (): void => {
    enter('touching', 'touchstart')
  }

  const onTouchEnd = (): void => {
    if (state !== 'touching') return
    enter('grace', 'touchend')
    // A tap, not a fling: nothing will ever scroll, so the timer is the only
    // thing that can reopen the gate. Without it a stationary press shuts the
    // list's corrections down permanently.
    arm(IOS_TOUCH_GRACE_MS, graceExpired)
  }

  /** Wait `MOMENTUM_IDLE_MS` of silence, then conclude the fling is over. */
  const armWatchdog = (): void => {
    arm(MOMENTUM_IDLE_MS, watchdogFired)
  }

  const onScroll = (): void => {
    // A scroll *during* momentum is the fling still going, so it pushes the watchdog back rather
    // than being ignored. Without this the timer was a fixed ceiling from onset and fired in the
    // middle of every fling longer than three seconds — see `MOMENTUM_IDLE_MS` for the measurements.
    //
    // `enter` is deliberately not used: the state is not changing, and going through it would emit
    // a transition event for a transition that did not happen. Its early return on an unchanged
    // state would swallow the re-arm anyway.
    if (state === 'momentum') {
      armWatchdog()
      return
    }

    // Only a scroll *within* the grace window is momentum onset. Later ones are
    // the reader scrolling again, or the echo of a write we just made.
    if (state !== 'grace') return
    enter('momentum', 'momentum-onset')
    armWatchdog()
  }

  const onSettled = (): void => {
    // A settle with a finger still down is the end of a scroll the reader is about to
    // continue, not the end of the gesture. Already-idle needs no guard: `enter`
    // returns early on it, so no listener is notified.
    if (state === 'touching') return
    enter('idle', 'settled')
  }

  return {
    attach() {
      // Before the early return, deliberately, and this is the only trace in this module
      // that is not a state transition.
      //
      // Off iOS this gate binds nothing and `canWrite()` is a constant `true`, so it emits
      // no transitions at all — which means "the gate stayed idle for the whole gesture" and
      // "there is no gate on this platform" are the same observation from the trace alone.
      // They could not be more different: off iOS *every* correction writes `scrollTop`
      // unconditionally, and Chrome cancels a compositor fling on such a write just as
      // WebKit does. So a reader diagnosing a stuttering fling on Android needs to know that
      // none of the momentum machinery is even running, and this one event is the only thing
      // that can tell them.
      //
      // Deliberately *not* accompanied by a clock. See {@link ScrollWriteGateOptions} for why
      // this module has none: every transition out of a shut state is an event or a timer
      // firing, and the analyzer can subtract `TraceEvent.at` stamps for free.
      if (DEBUG) trace('gate.attach', () => ({ ios: isIOS, attached, disposed }))
      if (attached || disposed || !isIOS) return
      attached = true

      const element = viewport.getElement()
      if (element) {
        const bindings = [
          ['touchstart', onTouchStart],
          ['touchend', onTouchEnd],
          ['touchcancel', onTouchEnd],
        ] as const
        for (const [type, listener] of bindings) {
          element.addEventListener(type, listener, { passive: true })
        }
        cleanups.push(() => {
          for (const [type, listener] of bindings) element.removeEventListener(type, listener)
        })
      }

      // Its own scroll subscription rather than being fed from `notifyScroll`, so
      // the state machine is testable with no scroller and cannot be broken by a
      // caller forgetting to report. Registered from inside `scroller.attach()`,
      // which runs before the engine's own scroll and settle listeners — so the
      // gate has already transitioned by the time either of those reads it.
      cleanups.push(viewport.addEventListener('scroll', onScroll))
      cleanups.push(onScrollSettled(viewport, onSettled))
    },

    canWrite: () => !isIOS || state === 'idle',

    isActive: () => isIOS,

    onOpen(callback) {
      openListeners.add(callback)
      return () => {
        openListeners.delete(callback)
      }
    },

    dispose() {
      disposed = true
      clearPendingTimer()
      for (const cleanup of cleanups) cleanup()
      cleanups.length = 0
      openListeners.clear()
      state = 'idle'
    },
  }
}
