import { isIOSWebKit } from './env.js'
import { onScrollSettled } from './settle.js'
import { TRACING, trace } from './trace.js'
import type { Viewport } from './viewport.js'

/**
 * How long after the finger lifts to keep refusing before any scroll has arrived.
 *
 * iOS fires touch events only at the *start* of momentum, so `touchend` is not the
 * end of the scrolling. This bridges the gap between the finger lifting and the
 * first momentum scroll event; it deliberately does not try to bound the fling
 * itself, which is what {@link MOMENTUM_MAX_MS} and the settle signal are for.
 */
export const IOS_TOUCH_GRACE_MS = 150

/**
 * Ceiling on an unterminated fling.
 *
 * A safety valve, not a duration: momentum normally ends at `scrollend`, or at the
 * settle helper's scroll debounce where that event is unavailable. This exists so a
 * settle that never arrives cannot wedge the gate shut forever. Deliberately below
 * the scroller's `HARD_DEADLINE_MS` of 5000, so a programmatic scroll issued
 * mid-fling still has frames left to converge in once the gate reopens.
 */
export const MOMENTUM_MAX_MS = 3000

/**
 * Where a touch-driven scroll currently is.
 *
 * `grace` and `momentum` are separate states rather than one "not idle" flag because
 * they end differently: `grace` ends on a timer *or* on the first scroll event that
 * promotes it to `momentum`, while `momentum` ends on settle *or* the hard cap. A
 * single flag cannot express "waiting to find out whether this was a tap or a fling".
 */
type GateState = 'idle' | 'touching' | 'grace' | 'momentum'

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

  const arm = (ms: number, onFire: () => void): void => {
    clearPendingTimer()
    timer = setTimer(() => {
      timer = null
      onFire()
    }, ms)
  }

  const enter = (next: GateState, reason: string): void => {
    if (state === next) return
    const wasShut = state !== 'idle'
    state = next
    if (TRACING) trace('scroll.gate', () => ({ state: next, reason }))
    // Only on the shut → open edge. Firing on every transition would run the
    // deferred work again mid-gesture, which is the thing being deferred.
    if (next === 'idle' && wasShut) {
      for (const listener of [...openListeners]) listener()
    }
  }

  /** Reopen, whatever the reason, cancelling whatever timer was going to do it. */
  const open = (reason: string): void => {
    clearPendingTimer()
    enter('idle', reason)
  }

  const onTouchStart = (): void => {
    // A second fling before the first settled. Both timers have to go, or the
    // earlier one reopens the gate with a finger still on the glass.
    clearPendingTimer()
    enter('touching', 'touchstart')
  }

  const onTouchEnd = (): void => {
    if (state !== 'touching') return
    enter('grace', 'touchend')
    // A tap, not a fling: nothing will ever scroll, so the timer is the only
    // thing that can reopen the gate. Without it a stationary press shuts the
    // list's corrections down permanently.
    arm(IOS_TOUCH_GRACE_MS, () => {
      open('grace-expired')
    })
  }

  const onScroll = (): void => {
    // Only a scroll *within* the grace window is momentum onset. Later ones are
    // the reader scrolling again, or the echo of a write we just made.
    if (state !== 'grace') return
    enter('momentum', 'momentum-onset')
    arm(MOMENTUM_MAX_MS, () => {
      open('cap')
    })
  }

  const onSettled = (): void => {
    if (state === 'idle' || state === 'touching') return
    open('settled')
  }

  return {
    attach() {
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
