/**
 * The measurement toolkit: a trace recorder, frame and gesture probes, gesture analysis, an
 * on-page readout, and a console conclusion.
 *
 * ```ts
 * import { installDebug } from 'virtual-anchor/debug'
 *
 * installDebug({ target: '.my-scroller' })
 * ```
 *
 * A separate entry point rather than something behind the build flag, because the flag question
 * and the shipping question are different ones. `sideEffects: false` plus a subpath already
 * means nobody who does not import this pays for it — that is the bargain `preact/debug` makes,
 * and it is the right one here. What the flag decides is whether the *core* still contains the
 * call sites this reads; `installDebug` says so if it does not.
 *
 * The pieces are exported individually as well as assembled, because they answer different
 * needs. A consumer diagnosing a phone wants `installDebug` and nothing else. A consumer with
 * their own telemetry wants `createTraceRecorder` and `analyzeGestures` and none of the DOM —
 * `analyzeGestures` is a pure function of an event array, so it runs in a test, in a worker, or
 * over a trace someone else emailed them.
 */

export { createTraceRecorder } from './recorder.js'
export type { TraceQuery, TraceRecorder, TraceRecorderOptions } from './recorder.js'

export { createFrameDriver } from './driver.js'
export type { FrameDriver } from './driver.js'

export { startFrameProbe } from './frameProbe.js'
export type { FrameProbe, FrameProbeOptions } from './frameProbe.js'

export { startGestureProbe } from './gestureProbe.js'
export type { GestureProbe, GestureProbeOptions } from './gestureProbe.js'

export { analyzeGestures, lastGesture } from './analyzer.js'
export type { Escape, GestureVerdict, Suspect, SuspectId } from './analyzer.js'

export { formatLive, formatVerdict } from './format.js'

export { mountTraceHud } from './overlay.js'
export type { TraceHud, TraceHudOptions } from './overlay.js'

export { installDebug } from './install.js'
export type { DebugSession, InstallDebugOptions } from './install.js'
