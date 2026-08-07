/**
 * Development-only tracing for the decisions that are hard to see from the outside.
 *
 * Scroll convergence, anchor restores and visibility dwell all decide things frame by
 * frame from state that no longer exists by the time you notice the result was wrong.
 * Every bug found in this library so far was found by measuring rather than reasoning,
 * and this is that measurement made permanent instead of re-improvised each time.
 *
 * Off unless a listener is installed, and **absent** — not merely inert — in the default
 * build:
 *
 *   - payloads are built inside a thunk, so with no listener nothing is computed — no
 *     object literals, no string building;
 *   - every call site is guarded by {@link DEBUG}, which this package's own build folds to
 *     a literal, taking the guards, the topic strings, the thunks and this module with
 *     them.
 *
 * That second point is new, and it corrects a claim this file used to make. It said the
 * guards and topic strings survived minification because "neither esbuild nor terser
 * propagates this module-level constant", and accepted a few hundred bytes of unreachable
 * code as the price. Both halves were wrong: the residue was ~2 kB minified, and the cause
 * was not cross-module propagation but that esbuild's bundler prints every top-level
 * `const` as `var` — so what reached a consumer's minifier was not a constant at all.
 * `src/debugFlag.ts` records the measurements; `scripts/check-package.mjs` greps the
 * shipped artifact for topic strings so the claim is enforced rather than asserted.
 *
 * @example
 * ```ts
 * import { addTraceListener } from 'virtual-anchor'
 *
 * const stop = addTraceListener((event) => { console.log(event.topic, event.data) })
 * ```
 */

import { DEBUG } from './debugFlag.js'
import type { TracePayloads, TraceTopic } from './traceTopics.js'

export interface TraceEvent {
  /** `performance.now()` at the moment of the call. */
  readonly at: number
  /** Dotted topic, e.g. `scroll.step`, so a listener can filter cheaply. */
  readonly topic: string
  readonly data: Readonly<Record<string, unknown>>
}

export type TraceSink = (event: TraceEvent) => void

/**
 * Everything listening, in insertion order.
 *
 * A set rather than a slot because one slot was already not enough, and the demo proved it:
 * it installed a ring-buffer listener and then *replaced* it with a HUD listener that had
 * to re-implement the ring-buffer push by hand, because installing the second silently
 * discarded the first. A consumer's own listener and `virtual-anchor/debug`'s overlay have
 * exactly that collision, and it is silent in both directions.
 */
const listeners = new Set<TraceSink>()

/** The one slot {@link setTraceSink} owns, so it keeps replacing rather than accumulating. */
let replaceable: TraceSink | null = null

/**
 * Add a listener; call the returned function to remove it.
 *
 * Three properties worth relying on. Listeners are called in **insertion order**. They all
 * receive the **same event object** — the payload thunk runs once per emission — which is
 * what makes {@link TraceEvent}'s `readonly` typing load-bearing rather than stylistic: a
 * listener that mutates the event corrupts every listener after it. And removing a listener
 * from inside a listener is safe, because `Set` iteration tolerates deletion.
 *
 * Deliberately no `try`/`catch` around the dispatch. A throwing listener costs the
 * listeners after it their event and breaks no invariant, whereas catching would let the
 * debug overlay quietly swallow a defect in the consumer's own listener — in the module
 * whose entire purpose is being trustworthy about what happened. The same reasoning orders
 * `cancelOnInput` and `notifyVisibility`: arrange so a throw cannot corrupt state, rather
 * than pretending it cannot happen.
 *
 * @returns an unsubscribe. In a build with no instrumentation it is a no-op, so a caller
 * never has to branch on whether tracing exists.
 */
export function addTraceListener(listener: TraceSink): () => void {
  if (!DEBUG) return () => {}
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Install a sink, or pass `null` to remove it.
 *
 * The one-slot spelling, kept because it is the published API: it replaces whatever *it*
 * installed last rather than adding to the fan-out, so an existing caller sees exactly what
 * it saw before. What it no longer does is evict listeners it did not install, which no
 * correct caller could have depended on. {@link addTraceListener} is the one to reach for in
 * new code.
 *
 * @returns whether tracing is available — `false` in a build with no instrumentation, where
 * the call did nothing.
 */
export function setTraceSink(next: TraceSink | null): boolean {
  if (!DEBUG) return false
  if (replaceable !== null) listeners.delete(replaceable)
  replaceable = next
  if (next !== null) listeners.add(next)
  return true
}

/** Whether anything is listening, for a caller that wants to skip expensive setup. */
export function isTracing(): boolean {
  return DEBUG && listeners.size > 0
}

/**
 * Record one event. The payload thunk runs only when something is listening.
 *
 * Generic over the topic, so the payload is checked against the shape `traceTopics.ts` declares
 * for it. That file's whole justification is that the analyzer reads payloads by *field name* from
 * several modules away, so a renamed field would leave everything compiling and the diagnosis
 * silently empty — and until this signature existed the file guaranteed none of that, because no
 * emitter was checked against the map. Making it generic cost one line and immediately caught two
 * emitters that had already drifted from their own declarations.
 *
 * Zero runtime cost: the constraint is erased.
 */
export function trace<T extends TraceTopic>(topic: T, data: () => TracePayloads[T]): void {
  if (!DEBUG || listeners.size === 0) return
  const event: TraceEvent = {
    at: typeof performance === 'undefined' ? 0 : performance.now(),
    topic,
    data: data(),
  }
  for (const listener of listeners) listener(event)
}
