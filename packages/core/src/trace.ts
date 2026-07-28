/**
 * Development-only tracing for the decisions that are hard to see from the outside.
 *
 * Scroll convergence, anchor restores and visibility dwell all decide things frame by
 * frame from state that no longer exists by the time you notice the result was wrong.
 * Every bug found in this library so far was found by measuring rather than reasoning,
 * and this is that measurement made permanent instead of re-improvised each time.
 *
 * Off unless a sink is installed, and inert in production:
 *
 *   - payloads are built inside a thunk, so with no sink nothing is computed — no object
 *     literals, no string building;
 *   - `TRACING` is `false` once a bundler inlines `NODE_ENV`, so `setTraceSink` refuses
 *     to install anything and every guarded block is skipped;
 *   - with a sink installed the cost is one call and one object per traced event.
 *
 * What it does *not* do is vanish from the bundle. Measured rather than assumed: neither
 * esbuild nor terser propagates this module-level constant into the `if (TRACING)` blocks
 * in other modules, so the guards and the topic strings survive minification — a few
 * hundred bytes that never execute. The alternative is repeating
 * `process.env.NODE_ENV !== 'production'` at every call site, which is what the
 * development warnings in `sizeCache` and `resizer` do precisely because those *are*
 * eliminated. That trade is not worth making for a dozen call sites in the hot path.
 *
 * @example
 * ```ts
 * import { setTraceSink } from 'virtual-anchor'
 *
 * setTraceSink((event) => { console.log(event.topic, event.data) })
 * ```
 */

/**
 * Whether tracing exists in this build at all.
 *
 * Written as this exact expression, not behind a `typeof process` guard: bundlers
 * pattern-match `process.env.NODE_ENV` literally, and `process.env?.NODE_ENV` does not
 * match — which left every topic string and call site in a minified production bundle
 * while claiming they had been dropped. The rest of this package already relies on the
 * same substitution for its development warnings.
 */
export const TRACING: boolean = process.env.NODE_ENV !== 'production'

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
