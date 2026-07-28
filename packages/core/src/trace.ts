/**
 * Development-only tracing for the decisions that are hard to see from the outside.
 *
 * Scroll convergence, anchor restores and visibility dwell all decide things frame by
 * frame from state that no longer exists by the time you notice the result was wrong.
 * Every bug found in this library so far was found by measuring rather than reasoning,
 * and this is that measurement made permanent instead of re-improvised each time.
 *
 * Off unless a sink is installed, and gone entirely in production:
 *
 *   - `TRACING` folds to `false` when a bundler inlines `NODE_ENV`, so every
 *     `if (TRACING)` block and this module's body are dropped as dead code;
 *   - payloads are built inside a thunk, so nothing is computed — no object literals, no
 *     string building — when no sink is listening;
 *   - with a sink installed the cost is one call and one object per traced event.
 *
 * @example
 * ```ts
 * import { setTraceSink } from 'virtual-anchor'
 *
 * setTraceSink((event) => { console.log(event.topic, event.data) })
 * ```
 */

declare const process: { env?: { NODE_ENV?: string } } | undefined

const nodeEnv = typeof process === 'undefined' ? undefined : process.env?.NODE_ENV

/** Whether tracing exists in this build at all. */
export const TRACING: boolean = nodeEnv !== 'production'

export interface TraceEvent {
  /** `performance.now()` at the moment of the call. */
  readonly at: number
  /** Dotted topic, e.g. `scroll.step`, so a sink can filter cheaply. */
  readonly topic: string
  readonly data: Readonly<Record<string, unknown>>
}

export type TraceSink = (event: TraceEvent) => void

let sink: TraceSink | null = null

/**
 * Install a sink, or pass `null` to remove it.
 *
 * @returns whether tracing is available — `false` in a production build, where the call
 * did nothing.
 */
export function setTraceSink(next: TraceSink | null): boolean {
  if (!TRACING) return false
  sink = next
  return true
}

/** Whether anything is listening, for a caller that wants to skip expensive setup. */
export function isTracing(): boolean {
  return TRACING && sink !== null
}

/**
 * Record one event. The payload thunk runs only when a sink is installed.
 */
export function trace(topic: string, data: () => Record<string, unknown>): void {
  if (!TRACING || sink === null) return
  sink({ at: typeof performance === 'undefined' ? 0 : performance.now(), topic, data: data() })
}
