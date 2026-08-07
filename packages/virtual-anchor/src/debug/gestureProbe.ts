/**
 * Where the finger was, and how fast it was going when it left.
 *
 * This is what makes the analyzer work **off iOS**. There, the momentum write gate binds
 * nothing and emits no transitions at all, so a segmentation that keyed on `scroll.gate` would
 * find no gestures on Android — the platform the fling report also suspected. Gesture
 * boundaries come from here instead, and the gate's events are treated as corroboration.
 *
 * It belongs in this module rather than in `momentum.ts` for the same reason the frame probe
 * does. That module does not listen to `touchmove`, holds no clock — its own doc says "there is
 * deliberately no `now`" — and its minimalism is load-bearing, because it runs on every publish.
 * Adding per-move coordinate tracking and a velocity estimator to it would be putting a
 * diagnostic's state into the hot path.
 *
 * **Nothing is emitted during the drag.** The last two positions live in closure variables and
 * only the lift produces an event. That matters twice over: a `touchmove` at 120 Hz would fill
 * the recorder with the least interesting part of the gesture, and the drag is not the part
 * that misbehaves — the reporter said slow scrolling is fine. The one number the drag has to
 * contribute is the velocity at lift, because that is what says whether a fling long enough to
 * outlast the momentum watchdog window was even plausible.
 *
 * `event.touches[0].clientY` is a property read on an event object, not a layout read, so this
 * costs nothing measurable even at the highest touch rate.
 */

import { trace } from '../trace.js'

export interface GestureProbeOptions {
  /**
   * The scrollport, or a way to find it.
   *
   * A selector or a thunk is accepted because of an ordering problem with no clean answer: the
   * listener has to be installed before the engine is built, and the engine is built during
   * render, so the element does not exist yet. Resolution is therefore retried until it
   * succeeds.
   */
  target: Element | string | (() => Element | null)
  /** Where to look up a selector. Defaults to `document`. */
  root?: Document | Element
}

export interface GestureProbe {
  stop(): void
  /** Whether the listeners are bound yet — the target may not have existed at first. */
  attached(): boolean
}

/** Resolve the target now, or `null` if it is not there yet. */
const resolve = (
  target: GestureProbeOptions['target'],
  root: Document | Element,
): Element | null => {
  if (typeof target === 'string') return root.querySelector(target)
  if (typeof target === 'function') return target()
  return target
}

export function startGestureProbe(options: GestureProbeOptions): GestureProbe {
  const root = options.root ?? document
  let element: Element | null = null
  let retry: number | null = null

  let startY = 0
  let startAt = 0
  let lastY = 0
  let lastAt = 0
  let previousY = 0
  let previousAt = 0
  let moves = 0

  /**
   * The finger's position, or `null` if the event does not carry one.
   *
   * A plain `new Event('touchstart')` has no `touches` at all, and that is not a hypothetical:
   * it is what `e2e/ios-momentum.spec.ts` dispatches, deliberately, because
   * `page.touchscreen.tap` also lifts the finger and so ends the gesture it is trying to start.
   * A probe that required coordinates would emit nothing for those, and the analyzer would find
   * no gesture to report on — which is exactly what happened the first time this was run.
   */
  const positionOf = (event: Event): number | null => {
    const touches = (event as TouchEvent).touches as TouchList | undefined
    return touches?.[0]?.clientY ?? null
  }

  const onStart = (event: Event): void => {
    // A synthesised event still opens a gesture; it just has no position to report. Position 0
    // is honest here — `dy` and `velocity` come out as 0, which is the truth about an event
    // that never said where the finger was.
    const y = positionOf(event) ?? 0
    startY = y
    lastY = y
    previousY = y
    startAt = event.timeStamp
    lastAt = event.timeStamp
    previousAt = event.timeStamp
    moves = 0
    trace('gesture.touch', () => ({
      phase: 'start',
      y: Math.round(startY),
      dy: 0,
      ms: 0,
      moves: 0,
      velocity: 0,
    }))
  }

  const onMove = (event: Event): void => {
    // Unlike `touchstart`, a move with no position tells us nothing at all, so it is dropped
    // rather than recorded as a move to zero — which would read as an enormous flick.
    const y = positionOf(event)
    if (y === null) return
    // Two positions, not a running average: velocity at lift is what matters, and the last
    // interval is the best available estimate of it. Averaging the whole drag would report a
    // slow flick as fast whenever it began with a fast one.
    previousY = lastY
    previousAt = lastAt
    lastY = y
    lastAt = event.timeStamp
    moves++
  }

  const onEnd = (event: Event): void => {
    const phase = event.type === 'touchcancel' ? 'cancel' : 'end'
    const span = lastAt - previousAt
    // Content moves opposite to the finger, so the sign is flipped to match scroll offsets:
    // a finger moving up (decreasing clientY) increases the scroll offset.
    const velocity = span > 0 ? (previousY - lastY) / span : 0
    trace('gesture.touch', () => ({
      phase,
      y: Math.round(lastY),
      dy: Math.round(startY - lastY),
      ms: Math.round(lastAt - startAt),
      moves,
      velocity: Math.round(velocity * 1000) / 1000,
    }))
  }

  const bindings = [
    ['touchstart', onStart],
    ['touchmove', onMove],
    ['touchend', onEnd],
    ['touchcancel', onEnd],
  ] as const

  const bind = (): void => {
    element = resolve(options.target, root)
    if (element === null) {
      // The scrollport is created during React's render, so a probe installed before the root
      // is mounted has nothing to bind to yet. One frame later it does.
      retry = requestAnimationFrame(bind)
      return
    }
    retry = null
    for (const [type, listener] of bindings) {
      element.addEventListener(type, listener, { passive: true })
    }
  }

  bind()

  return {
    stop() {
      if (retry !== null) cancelAnimationFrame(retry)
      retry = null
      if (element === null) return
      for (const [type, listener] of bindings) element.removeEventListener(type, listener)
      element = null
    },
    attached: () => element !== null,
  }
}
