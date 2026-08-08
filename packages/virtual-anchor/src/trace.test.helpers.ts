/**
 * Collecting trace events, and emitting partial ones, for the suites that assert on them.
 *
 * Two things, both of which were written out by hand in five places before this file existed —
 * `momentum.dom.test.ts`, `scroller.ios.dom.test.ts`, twice in `engine.ios.dom.test.ts`, and again
 * as `collect()` in `debug/probes.dom.test.ts`. They had already drifted: two asserted
 * `setTraceSink(...) === true` and two did not, and four used the evictable single slot where the
 * fan-out is what new code should reach for.
 *
 * Named `.test.helpers.ts` for the reason `iosPlatform.test.helpers.ts` records: the name keeps it
 * out of both vitest `include` globs so it is never collected as a suite, while the `.test.`
 * segment keeps it out of the coverage `include`.
 */

import { addTraceListener, trace, type TraceEvent } from './trace.js'
import type { TracePayloads, TraceTopic } from './traceTopics.js'

/**
 * Start collecting. Returns the live array and a function to stop.
 *
 * `addTraceListener` rather than `setTraceSink`, so a suite that installs two collectors gets two,
 * and so new tests use the primitive the library now prefers.
 */
export function collectTrace(): { events: TraceEvent[]; stop: () => void } {
  const events: TraceEvent[] = []
  const stop = addTraceListener((event) => events.push(event))
  return { events, stop }
}

/**
 * Emit a partial payload, deliberately.
 *
 * `trace` is generic over its topic so that an *emitter* cannot drift from the shape
 * `traceTopics.ts` declares — that is the whole point of the map, and it caught two real cases of
 * drift the day it was introduced. But a test asserting on the recorder's ring, or on the fan-out's
 * dispatch order, does not care what is in a payload, and making it spell out eleven fields to say
 * "one event arrived" would be friction that buys nothing.
 *
 * So this is the one place the constraint is relaxed, in one line, with the reason written down —
 * rather than forty `as never` casts scattered through the suites, each of which would be a place
 * for a *real* drift to hide. Production code has no way to reach it: this file is not part of the
 * published entry graph.
 */
export function emitTrace<T extends TraceTopic>(
  topic: T,
  data: Partial<TracePayloads[T]> = {},
): void {
  trace(topic, () => data as TracePayloads[T])
}
