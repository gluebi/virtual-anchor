/**
 * A bounded record of what the library said, and an honest account of what it dropped.
 *
 * A fixed array with a moving head: one store and one increment per event, and no reallocation.
 *
 * The obvious alternative is an array plus `shift()`, which is what the demo had. Worth being
 * accurate about why this is better, because the first version of this comment was not: `shift()`
 * is nominally O(n), but V8 has a fast path for it and the measured difference is 0.05 µs against
 * 0.01 µs per event. So the honest reason is not that `shift()` is slow — it is that this shape has
 * no worst case to reason about, and that a ring which reports what it dropped needs a head index
 * anyway.
 *
 * ## Why `dropped()` is not a statistic
 *
 * A scroll on a 120 Hz iPhone emits `scroll.sample`, `anchor.derive` and — during a
 * programmatic scroll — `scroll.step`, so roughly 360 events a second. The 5,000-event
 * default is therefore about fourteen seconds of scrolling, and a diagnosis session is
 * longer than that.
 *
 * If the ring has discarded the start of a gesture, a verdict computed over what remains is
 * not approximately right, it is **wrong in a way that reads as a clean result**: no
 * `touchstart`, so no gesture boundary; no `gate.attach`, so the platform looks unknown; no
 * early `scroll.write`, so the escape that killed the fling is simply absent and every
 * suspect comes back refuted. So the count is surfaced, the analyzer keys `truncated` off it,
 * and it declines to rank rather than reporting a false all-clear.
 */

import { devicePixelRatioOf } from '../env.js'
import { addTraceListener, type TraceEvent } from '../trace.js'

export interface TraceRecorderOptions {
  /** How many events to keep. Default 5,000 — about fourteen seconds of scrolling. */
  capacity?: number
  /**
   * Keep only these topics, matched as prefixes (`'scroll.'` keeps every scroll topic).
   *
   * Worth reaching for on a long session: filtering to `['scroll.', 'gesture.', 'frame.']`
   * roughly triples how far back the ring reaches, because the per-frame anchor and
   * visibility topics are what fill it.
   */
  topics?: readonly string[]
  /** Tee every kept event onward, for a live readout that would rather not poll. */
  onEvent?: (event: TraceEvent) => void
}

export interface TraceQuery {
  /** Inclusive lower bound on `TraceEvent.at`. */
  since?: number
  /** Inclusive upper bound on `TraceEvent.at`. */
  until?: number
  /** Topic prefixes to keep. */
  topics?: readonly string[]
  /** Most recent N matches, after the other filters. */
  limit?: number
}

export interface TraceRecorder {
  /** How many events are held. */
  size(): number
  /**
   * Monotonic count of everything ever recorded.
   *
   * For a reader that repaints on a timer and would otherwise re-analyse an unchanged buffer.
   * The overlay compares this against the last value it analysed, which turns an idle page from
   * "re-segment the whole ring ten times a second" into one integer compare per frame.
   */
  revision(): number
  /**
   * How many events the ring discarded.
   *
   * Non-zero means any verdict drawn from this buffer may be missing the evidence that
   * mattered. See the module comment.
   */
  dropped(): number
  /** Matching events, oldest first. */
  select(query?: TraceQuery): TraceEvent[]
  /** A report, with enough environment to be read by someone holding a different device. */
  toJSON(query?: TraceQuery): string
  clear(): void
  /** Stop recording and detach from the trace stream. */
  dispose(): void
}

/** Whether a topic starts with any of the given prefixes. */
const matches = (topic: string, prefixes: readonly string[] | undefined): boolean => {
  if (prefixes === undefined || prefixes.length === 0) return true
  for (const prefix of prefixes) if (topic.startsWith(prefix)) return true
  return false
}

/**
 * Start recording.
 *
 * Subscribes on construction rather than offering a separate `start()`, because the events
 * worth having are the ones emitted while the engine is being built — a size snapshot being
 * restored, most of all — and an API with two steps invites installing it too late.
 */
export function createTraceRecorder(options: TraceRecorderOptions = {}): TraceRecorder {
  const capacity = Math.max(1, Math.floor(options.capacity ?? 5000))
  const { topics, onEvent } = options

  // Pre-sized and never resized. Holes only until the first lap.
  const ring = new Array<TraceEvent | undefined>(capacity)
  let head = 0
  let held = 0
  let discarded = 0

  let revision = 0

  const detach = addTraceListener((event) => {
    if (!matches(event.topic, topics)) return
    if (held === capacity) discarded++
    ring[head] = event
    head = (head + 1) % capacity
    if (held < capacity) held++
    revision++
    onEvent?.(event)
  })

  /**
   * Matching events, oldest first — which is the only order an analyzer can read.
   *
   * Every filter is applied inside the single ring walk rather than as a chain of `.filter()`
   * calls. The chained form allocated a full `held`-length array and then a fresh array per
   * clause: up to five arrays of five thousand references to answer one query, and the query the
   * *phone* runs is `toJSON({ since })` while exporting.
   */
  const select = (query: TraceQuery = {}): TraceEvent[] => {
    const { since, until, limit, topics: only } = query
    const out: TraceEvent[] = []
    const start = held === capacity ? head : 0
    for (let i = 0; i < held; i++) {
      const event = ring[(start + i) % capacity]
      if (event === undefined) continue
      if (since !== undefined && event.at < since) continue
      if (until !== undefined && event.at > until) continue
      if (!matches(event.topic, only)) continue
      out.push(event)
    }
    // Trimmed at the end rather than counted from the back: `limit` is "the most recent N of what
    // matched", and what matched is not known until the walk is done.
    return limit !== undefined && out.length > limit ? out.slice(out.length - limit) : out
  }

  return {
    size: () => held,
    revision: () => revision,
    dropped: () => discarded,
    select,

    /**
     * The report, as JSON.
     *
     * `meta` carries the user agent, the device pixel ratio and the viewport because the
     * whole point of this file is a report arriving from a device the reader does not have —
     * and a fling that misbehaves at 3× on a 390px-wide iPhone says very little without those
     * three numbers. `dropped` travels with it for the reason in the module comment: a reader
     * has to be able to see that the record is incomplete.
     */
    toJSON(query) {
      const view = typeof window === 'undefined' ? undefined : window
      return JSON.stringify(
        {
          meta: {
            at: typeof performance === 'undefined' ? 0 : performance.now(),
            ua: typeof navigator === 'undefined' ? null : navigator.userAgent,
            // Through the library's own probe, which screens a 0/NaN/non-number ratio — a report
            // handed to someone holding a different device must not carry a nonsense one.
            dpr: view === undefined ? null : devicePixelRatioOf(view),
            viewport: view === undefined ? null : { w: view.innerWidth, h: view.innerHeight },
            capacity,
            held,
            dropped: discarded,
          },
          events: select(query),
        },
        null,
        2,
      )
    },

    clear() {
      ring.fill(undefined)
      head = 0
      held = 0
      discarded = 0
      // Deliberately *not* reset: a reader gating on it must see a change, and "cleared" is a
      // change. Resetting to zero could leave it equal to the value a reader last saw.
      revision++
    },

    dispose() {
      detach()
    },
  }
}
