/**
 * Everything, in one call, for a consumer who wants to look rather than to build a tool.
 *
 * The parts are exported individually too, because a consumer with their own logging pipeline
 * wants the recorder and the analyzer and none of the DOM. This is the other case: a phone, a
 * misbehaving fling, and no appetite for assembling four objects first.
 */

// Straight from the flag module rather than as `TRACING` through the barrel. Going through
// `index.js` would pull the whole public surface into this entry's import graph for one boolean,
// and — because the flag folds to a literal — leave a provably unused import behind, which
// Rollup rightly complains about.
import { DEBUG } from '../debugFlag.js'
import {
  analyzeGestures,
  GESTURE_QUIET_MS,
  isGestureActivity,
  lastGesture,
  type GestureVerdict,
} from './analyzer.js'
import { createFrameDriver } from './driver.js'
import { formatVerdict } from './format.js'
import { startFrameProbe } from './frameProbe.js'
import { startGestureProbe } from './gestureProbe.js'
import { mountTraceHud, type TraceHud } from './overlay.js'
import { createTraceRecorder, type TraceQuery, type TraceRecorder } from './recorder.js'

/**
 * How long after the last sign of movement to declare a gesture over and report on it.
 *
 * Derived from the analyzer's own segmentation window rather than restated, because it has to be
 * *longer*: the gesture this reports on must be one the analyzer has already closed. Written as an
 * independent literal, raising the window in one file would silently start drawing conclusions
 * from gestures still in progress.
 */
const SETTLE_MS = GESTURE_QUIET_MS + 70

export interface InstallDebugOptions {
  /**
   * The scrollport, for the touch probe. A selector is usually easiest.
   *
   * Omit it and gestures are segmented from the momentum gate's events instead — which works
   * on iOS and **not** anywhere else, because off iOS that gate emits nothing at all.
   */
  target?: string | Element | (() => Element | null)
  /** Mount the on-page readout. Default `true`. */
  overlay?: boolean
  /**
   * Run the frame probe. Default `true`.
   *
   * It is what separates a cancelled fling from a blocked main thread, and it also perturbs
   * timing — one main-thread wakeup per frame. Turn it off to confirm a timing finding.
   */
  frameProbe?: boolean
  /** Ring capacity. Default 5,000, about fourteen seconds of scrolling. */
  capacity?: number
  /** Topic prefixes to keep, to make the ring reach further back. */
  topics?: readonly string[]
  mode?: 'live' | 'verdict' | 'both'
  container?: HTMLElement
  /**
   * Print each gesture's conclusion to the console as it settles. Default `true`.
   *
   * Independent of {@link overlay} on purpose: the two answer different situations. The
   * overlay is for a phone with nothing attached to it; the console is for a phone attached to
   * the Web Inspector, for a desktop browser, and for a Playwright run — none of which want a
   * `<pre>` over the page, and all of which want the verdict in a form that can be copied.
   *
   * Pass a function to route it somewhere else — an issue tracker, a test collector, a file.
   */
  log?: boolean | ((verdict: GestureVerdict, text: string) => void)
}

export interface DebugSession {
  recorder: TraceRecorder
  hud: TraceHud | null
  /** The most recent gesture's verdict. */
  verdict(): GestureVerdict | null
  /** Every gesture recorded. */
  gestures(): GestureVerdict[]
  /** The report as JSON, for pasting into an issue. */
  toJSON(query?: TraceQuery): string
  /** Whether this build has instrumentation at all. `false` means nothing will be recorded. */
  available: boolean
  dispose(): void
}

export function installDebug(options: InstallDebugOptions = {}): DebugSession {
  // Said once, early, and naming the fix.
  //
  // Mounted against a core built without instrumentation this would draw an empty overlay and
  // read as a defect in the library. It is the one thing in this module that needs to know
  // about the build flag at all — the module's *cost* is handled by being a separate entry
  // nobody has to import.
  if (!DEBUG) {
    console.warn(
      '[virtual-anchor] this build has no instrumentation, so there is nothing to show. ' +
        'Resolve the `development` export condition, or define __VIRTUAL_ANCHOR_DEBUG__ if you ' +
        'build this package from source.',
    )
  }

  /**
   * Report a gesture's conclusion once it has stopped moving.
   *
   * Driven from the recorder's tee rather than from a timer of its own, so it costs a string
   * comparison per event and nothing at all between gestures. The debounce is what makes the
   * conclusion a conclusion: `touchend` is not the end of the scrolling on iOS — momentum runs
   * on for seconds afterwards — so logging there would report on a fling before the part that
   * misbehaves has happened.
   */
  const report = options.log ?? true
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let reportedAt: number | null = null

  const scheduleReport = (): void => {
    if (settleTimer !== null) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settleTimer = null
      const verdict = lastGesture(recorder.select(), recorder.dropped())
      // Guarded on `startedAt` so a gesture is reported once. Without it, any later event —
      // a resize, a visibility change — would re-fire the timer and print the same conclusion
      // again, which on a phone is indistinguishable from a second bad fling.
      if (verdict === null || verdict.startedAt === reportedAt) return
      reportedAt = verdict.startedAt
      const text = formatVerdict(verdict)
      if (typeof report === 'function') {
        report(verdict, text)
        return
      }
      // A confirmed suspect is a finding and should be hard to miss in a busy console; a clean
      // gesture is not a problem and must not look like one.
      const bad = verdict.suspects.some((suspect) => suspect.confidence === 'confirmed')
      const line = `[virtual-anchor] gesture #${String(verdict.index)}\n${text}`
      if (bad) console.warn(line)
      else console.log(line)
    }, SETTLE_MS)
  }

  const recorder = createTraceRecorder({
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
    ...(options.topics === undefined ? {} : { topics: options.topics }),
    ...(report === false
      ? {}
      : {
          // The analyzer owns what counts as movement; asking it means the debounce and the
          // segmentation cannot drift apart.
          onEvent: (event) => {
            if (isGestureActivity(event.topic)) scheduleReport()
          },
        }),
  })

  // One rAF loop for both consumers of it. Two would be two wakeups per frame during the
  // fling being measured, which is the thing the frame probe reports on.
  const driver = createFrameDriver()

  const probe = options.frameProbe === false ? null : startFrameProbe({ driver })
  const gestures =
    options.target === undefined ? null : startGestureProbe({ target: options.target })

  const hud =
    options.overlay === false
      ? null
      : mountTraceHud({
          recorder,
          driver,
          ...(options.mode === undefined ? {} : { mode: options.mode }),
          ...(options.container === undefined ? {} : { container: options.container }),
        })

  return {
    recorder,
    hud,
    verdict: () => lastGesture(recorder.select(), recorder.dropped()),
    gestures: () => analyzeGestures(recorder.select(), recorder.dropped()),
    toJSON: (query) => recorder.toJSON(query),
    available: DEBUG,
    dispose() {
      // The recorder detaches *first*, and the order is the contract: after `dispose()` nothing
      // more is recorded. `probe.stop()` emits `frame.summary`, so stopping it while the recorder
      // was still listening left one phantom event in a buffer that had just been thrown away —
      // which reads as a leak. Any other listener, including a consumer's own sink, still
      // receives the summary; it is only this session's record that is closed.
      if (settleTimer !== null) clearTimeout(settleTimer)
      recorder.dispose()
      hud?.dispose()
      gestures?.stop()
      probe?.stop()
    },
  }
}
