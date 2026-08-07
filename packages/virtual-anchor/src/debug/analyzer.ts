/**
 * Turn a trace stream into a ranked account of why a fling misbehaved.
 *
 * A pure function of an array, deliberately. That is what makes the *diagnosis* testable
 * rather than merely the library: every row of the table below has a hand-built fixture in
 * `analyzer.test.ts` that must produce the suspect, and a second that must not. Without that,
 * a verdict is a story told about a log.
 *
 * ## The hypotheses, and what decides each
 *
 * These are the ways a fling is known or suspected to be able to jump, stutter or stop, in
 * roughly descending order of how likely they were thought to be when this was written.
 *
 * | id | what it claims | confirmed by |
 * | --- | --- | --- |
 * | `overscroll-write` | `engine.writeScroll` consults only `writeGate.canWrite()`; it never asks `writeGate.isActive()`, whose one caller is `scroller.canWriteScroll`. So in an iOS rubber-band bounce the content offset is past `max`, `room` is 0, and the engine writes into the overscroll — which `scroller.ts` says "snaps the page to the clamped value the moment the bounce ends". | `scroll.write` with `reason: 'no-room'` and `from` outside `[0, max]` |
 * | `no-room-at-end` | The general case of the above. `room` is the distance to the *nearer* end, so it tightens to nothing near either one, and every correction escapes there instead of being banked. Explains "sometimes": it needs a fling that reaches an end. | `reason: 'no-room'` with small `room`, near either end |
 * | `fold-jump` | The fold's target can exceed `max`, because `room` was checked per-deferral against an offset the fling has since moved. The browser clamps, `carryFor` discards the excess, and the reader is left displaced. | `gesture.fold` with `clamped: true`, or a break in `from + shift + carryBefore` vs `applied + carryAfter` |
 * | `fold-anchor-loss` | A clamped fold's read-back misses `isSelfWrite`'s tolerance, so the scroll handler re-derives the anchor from the clamped offset and the displacement becomes permanent. | a clamped `gesture.fold` followed by `anchor.derive` with `skipped: null` |
 * | `scroller-wake` | The convergence loop parks while the gate is shut and is woken by `gate.onOpen`, which flushes a banked delta and writes — during momentum, from the writer that emitted nothing at all until now. | `scroll.park` then `scroll.wake` then `scroll.commit` with `refused: false`, while samples are still arriving |
 * | `grace-misfire` | iOS fires no touch events during momentum, so the only thing promoting `grace` to `momentum` is a scroll arriving inside 150 ms of `touchend`. A blocked main thread delays that past the window, the gate reopens, and writes resume with the fling still running. | `scroll.gate` `grace-expired` followed by several more samples |
 * | `cap` | The gate's watchdog fired: three seconds passed with no scroll event and no settle, so it concluded the fling was over. Before #53 this was a *ceiling* from momentum onset rather than an inactivity window, and it fired on every fling longer than three seconds — which is what it was measured doing on a device. It still means the gate reopened without a settle, which is worth knowing; it should now be rare. | `scroll.gate` with `reason: 'cap'`, samples continuing after it |
 * | `model-write` | A prepend or an append overrides the gate deliberately. Legitimate, but it does cancel momentum, and a layout-signature change mid-gesture can cause one nobody asked for. | `reason: 'model'` inside the gesture |
 * | `starvation` | Nothing wrote anything; the main thread simply stopped delivering scroll events, so the rows were not repositioned while the scrollport kept moving. Content freezes, then jumps. | a sample gap far above the frame period, with `frame.long` in the same window |
 * | `not-ios` | There is no gate at all. `momentum.attach()` returns early off iOS and `canWrite()` is a constant `true`, so every correction writes unconditionally — and Chrome cancels a compositor fling on a `scrollTop` write just as WebKit does. | `gate.attach` with `ios: false`, plus writes taken during a gesture |
 *
 * `demo-noise` is deliberately **not** here. Whether the host application's own re-rendering
 * is the stutter cannot be decided from one recording: it needs the same gesture run twice,
 * once with the app's per-frame work disabled, and the two `frame.summary` figures compared.
 * A single-trace verdict claiming it would be guessing, so the README describes the
 * differential instead and this file reports `longestFrameMs` for the reader to compare.
 */

import type { TraceEvent } from '../trace.js'
import { round } from './round.js'
import type {
  AnchorDerivePayload,
  FrameLongPayload,
  GateAttachPayload,
  GestureFoldPayload,
  GestureTouchPayload,
  MeasureDonePayload,
  PaintOffsetPayload,
  ScrollCommitPayload,
  ScrollGatePayload,
  ScrollSamplePayload,
  ScrollWritePayload,
  WriteReason,
} from '../traceTopics.js'

export type SuspectId =
  | 'overscroll-write'
  | 'no-room-at-end'
  | 'fold-jump'
  | 'fold-anchor-loss'
  | 'scroller-wake'
  | 'grace-misfire'
  | 'cap'
  | 'model-write'
  | 'starvation'
  | 'not-ios'

export interface Suspect {
  id: SuspectId
  /**
   * `confirmed` means the signal is present and unambiguous; `suspected` means it is present
   * but could have an innocent reading. Nothing here reports a probability, because a trace
   * either contains the evidence or it does not.
   */
  confidence: 'confirmed' | 'suspected'
  /** One line naming the numbers that decided it, for reading off a phone. */
  evidence: string
  /** When the deciding event happened. */
  at: number
}

/** One escaped write, with enough context to tell which hypothesis it belongs to. */
export interface Escape {
  at: number
  reason: WriteReason
  delta: number
  room: number
  from: number
  max: number
  /** Milliseconds since the finger lifted, or `null` if that is not known. */
  sinceLift: number | null
}

export interface GestureVerdict {
  index: number
  startedAt: number
  endedAt: number
  durationMs: number
  /** When the finger left the glass, if a touch or gate event said so. */
  liftedAt: number | null
  /** How long the list kept moving after the lift — the fling itself. */
  flingMs: number | null
  /** Signed px/ms at lift, from the gesture probe. Negative is upward content movement. */
  liftVelocity: number | null
  /** `ios` if the momentum gate is live, `inactive` if it is not, `unknown` if nothing said. */
  gate: 'ios' | 'inactive' | 'unknown'
  states: { state: string; reason: string; at: number; ms: number }[]
  scrolls: number
  worstScrollGapMs: number
  /**
   * The longest stretch with frames but no scroll events.
   *
   * The discriminator between "the fling ended" and "the main thread was blocked": if frames
   * kept coming and scroll events did not, the scrollport was still moving and the rows were
   * not being repositioned.
   */
  frozenMs: number
  travelPx: number
  /*
   * There is deliberately no `worstVisualJump`, and the reason is worth recording because the
   * field existed and was wrong.
   *
   * It measured the largest step in `offset + carry + shift` — the content-space position of the
   * viewport top. But that is precisely the quantity a correction is *supposed* to move: when a
   * row above the anchor measures 126px taller, every item below it moves 126px down in list
   * space, and the compensation moves the content-space origin by the same 126px so the pixels on
   * screen stay put. Screen position is `itemOffset - contentOffset`, so both terms move together
   * and nothing is visible.
   *
   * So the field reported hundreds of pixels of "visual jump" for the mechanism working
   * correctly. Measured on a device: 328px on an upward fling the same verdict called clean, with
   * a fold that was clean too. A detector that fires on correct behaviour is worth nothing — the
   * standard this file's own comment sets — and there is no honest replacement computable from
   * this stream, because it would need a specific item's painted position sample by sample, which
   * nothing traces.
   *
   * What *is* detectable is compensation failing, and that is already covered: `fold.clamped` and
   * `fold.discontinuity` catch the case where the fold could not land, which is the one place the
   * two terms come apart.
   */
  writes: { taken: number; held: number; byReason: Record<WriteReason, number> }
  escapes: Escape[]
  /** The largest amount ever banked as a paint offset in this gesture. */
  heldPeak: number
  fold: {
    at: number
    shift: number
    clamped: boolean
    /** How far the fold failed to be invisible, in px. Should be ~0. */
    discontinuity: number
  } | null
  scrollerWrites: number
  parks: number
  wakes: number
  measure: { batches: number; totalMs: number; worstMs: number; invalidations: number }
  longestFrameMs: number
  /** Whether a frame probe was running, since it perturbs what it measures. */
  probeRunning: boolean
  ended: 'settled' | 'cap' | 'grace-expired' | 'touch' | 'unknown'
  /**
   * Whether the recording may be missing this gesture's start.
   *
   * When true the suspect list is empty regardless of what the events show, because a partial
   * record refutes everything it does not contain. See `recorder.ts`.
   */
  truncated: boolean
  suspects: Suspect[]
}

/** Frames slower than this are "long" for the purpose of the starvation test. */
const LONG_FRAME_MS = 32
/** A gap above this, with frames still arriving, is a freeze rather than the end of a fling. */
const FREEZE_MS = 100
/** How close to an end counts as "at an end" for the `no-room` reading. */
const NEAR_END_PX = 200
/**
 * Quiet period after the last scroll event before a gesture is considered over.
 *
 * Exported because `install.ts` has to wait *longer* than this before reporting a conclusion, and
 * a relation between two modules' constants that lives only in prose is a relation nothing keeps.
 */
export const GESTURE_QUIET_MS = 250

/**
 * Whether a topic means the gesture is still going.
 *
 * Shared with `install.ts`'s settle debounce: written out in both places, the two would eventually
 * disagree about when a gesture ended, and the once-per-gesture report guard would misfire.
 * Deliberately excludes `frame.long`, which the probe emits between gestures too and which would
 * hold every gesture open forever.
 */
export function isGestureActivity(topic: string): boolean {
  return topic === 'scroll.sample' || topic === 'scroll.gate' || topic === 'gesture.touch'
}

/**
 * Split the stream into gestures.
 *
 * Opens on whichever of three signals comes first, because they are available on different
 * platforms. `gesture.touch` comes from this module's own probe and works wherever there are
 * touch events; `scroll.gate` exists only where the momentum write gate is live, which is iOS.
 *
 * Neither of those reaches a trackpad or a wheel. That was not a gap anyone had to imagine: a
 * `not-ios` suspect has been in the table since this file was written, documenting that off iOS
 * "every correction writes unconditionally, and Chrome cancels a compositor fling on a
 * `scrollTop` write just as WebKit does" — and no recording from such a device could ever reach
 * it, because with no touch and no gate every event fell through `current === null` and was
 * dropped. The whole analyzer returned an empty array, which reads as "nothing happened" rather
 * than "this tool cannot see your platform". A scroll that the library did not cause is the only
 * other evidence a gesture happened, so it opens one.
 */
function segment(events: readonly TraceEvent[]): TraceEvent[][] {
  const groups: TraceEvent[][] = []
  let current: TraceEvent[] | null = null
  let lastActivity = 0
  /** Whether the library is scrolling itself; see the sample opener below. */
  let programmatic = false

  const opens = (event: TraceEvent): boolean =>
    (event.topic === 'gesture.touch' && (event.data as GestureTouchPayload).phase === 'start') ||
    (event.topic === 'scroll.gate' && (event.data as ScrollGatePayload).reason === 'touchstart')

  for (const event of events) {
    // Tracked ahead of everything else, because it has to be current while *no* group is open —
    // which is exactly the state the sample opener consults. The pair cannot come unbalanced:
    // `scroller.ts` routes every ending through one `finish()`, including `dispose()` and the
    // `input` cancellation a touch causes, so this cannot latch on and swallow the recording.
    if (event.topic === 'scroll.start') programmatic = true
    else if (event.topic === 'scroll.finish') programmatic = false

    if (opens(event)) {
      // One touch can produce *both* openers, and on a device it usually does: the gate's listener
      // is bound at mount while the probe's is bound on a later frame, so the order is
      // `scroll.gate`/`touchstart` then `gesture.touch`/`start`. Splitting on the second left a
      // junk one-event group before every real gesture — invisible through `lastGesture`, but it
      // double-counted `gestures()` and made the `#index` printed to the console skip numbers.
      //
      // So a second opener arriving before anything has actually *moved* is the same gesture being
      // announced twice, and is folded in rather than starting a new group.
      const announcing = current !== null && !current.some((e) => e.topic === 'scroll.sample')
      if (announcing && current !== null) {
        current.push(event)
        lastActivity = event.at
        continue
      }
      if (current !== null) groups.push(current)
      current = [event]
      lastActivity = event.at
      continue
    }
    if (current === null) {
      // Only `scroll.sample`. `scroll.gate` would let the late `cap` transition — which arrives
      // three seconds after everything else — resurrect a gesture already closed below, and
      // `gesture.touch` at `end` or `cancel` is the tail of one whose `start` the ring dropped.
      if (event.topic !== 'scroll.sample') continue
      // Not while the library is scrolling itself. A `scrollToKey` converges by writing every
      // frame, so a group opened over one would report writes taken during a gesture — which is
      // the `not-ios` signature exactly — for the convergence loop doing the job it was asked to
      // do. That is the false positive this opener would otherwise produce on every thread open.
      if (programmatic) continue
      current = [event]
      lastActivity = event.at
      continue
    }

    // A gesture ends when nothing has moved for a while. Keyed on scroll and gate activity
    // rather than on any event, because the frame probe emits continuously and would keep
    // every gesture open forever.
    const moves = isGestureActivity(event.topic)
    if (moves && event.at - lastActivity > GESTURE_QUIET_MS) {
      // A late *gate* transition still belongs to the gesture that was running, so it is kept
      // rather than dropped. the watchdog waits three seconds of silence, so the `cap` transition arrives
      // long after the last thing that moved — and discarding it meant a fling killed by the
      // ceiling could never report `cap`, which is one of the hypotheses this exists to test.
      if (event.topic === 'scroll.gate') current.push(event)
      groups.push(current)
      current = null
      continue
    }
    current.push(event)
    if (moves) lastActivity = event.at
  }
  if (current !== null) groups.push(current)
  return groups
}

/** Everything one gesture's events say, before any judgement is applied. */
function summarise(
  group: readonly TraceEvent[],
  index: number,
  truncated: boolean,
  platform: GestureVerdict['gate'],
): GestureVerdict {
  const byReason: Record<WriteReason, number> = {
    'gate-open': 0,
    held: 0,
    'no-room': 0,
    model: 0,
  }
  const states: GestureVerdict['states'] = []
  const escapes: Escape[] = []

  let liftedAt: number | null = null
  let liftVelocity: number | null = null
  let gate: GestureVerdict['gate'] = platform
  let scrolls = 0
  let worstScrollGapMs = 0
  let frozenMs = 0
  let taken = 0
  let heldWrites = 0
  let heldPeak = 0
  let fold: GestureVerdict['fold'] = null
  let scrollerWrites = 0
  let parks = 0
  let wakes = 0
  let batches = 0
  let totalMeasureMs = 0
  let worstMeasureMs = 0
  let invalidations = 0
  let longestFrameMs = 0
  let probeRunning = false
  let ended: GestureVerdict['ended'] = 'unknown'
  let anchorLostAfterFold = false

  let lastSampleAt: number | null = null
  let lastStateAt = group[0]?.at ?? 0
  let firstOffset: number | null = null
  let lastOffset = 0
  for (const event of group) {
    switch (event.topic) {
      case 'gate.attach': {
        gate = (event.data as GateAttachPayload).ios ? 'ios' : 'inactive'
        break
      }
      case 'gesture.touch': {
        const payload = (event.data as GestureTouchPayload)
        if (payload.phase !== 'start') {
          liftedAt = event.at
          liftVelocity = payload.velocity
        }
        break
      }
      case 'scroll.gate': {
        const payload = (event.data as ScrollGatePayload)
        states.push({
          state: payload.state,
          reason: payload.reason,
          at: event.at,
          ms: round(event.at - lastStateAt),
        })
        lastStateAt = event.at
        // Present wherever the gate is live, so it is the fallback for a lift when the
        // gesture probe is not installed.
        if (payload.reason === 'touchend' && liftedAt === null) liftedAt = event.at
        if (payload.state === 'idle') {
          ended =
            payload.reason === 'settled'
              ? 'settled'
              : payload.reason === 'cap'
                ? 'cap'
                : payload.reason === 'grace-expired'
                  ? 'grace-expired'
                  : ended
        }
        if (gate === 'unknown') gate = 'ios'
        break
      }
      case 'scroll.sample': {
        const payload = (event.data as ScrollSamplePayload)
        scrolls++
        if (lastSampleAt !== null) {
          const gap = event.at - lastSampleAt
          worstScrollGapMs = Math.max(worstScrollGapMs, gap)
          if (gap > FREEZE_MS) frozenMs = Math.max(frozenMs, gap)
        }
        lastSampleAt = event.at
        firstOffset ??= payload.offset
        lastOffset = payload.offset
        break
      }
      case 'paint.offset': {
        const payload = (event.data as PaintOffsetPayload)
        heldPeak = Math.max(heldPeak, Math.abs(payload.shift))
        break
      }
      case 'scroll.write': {
        const payload = (event.data as ScrollWritePayload)
        byReason[payload.reason]++
        if (payload.took) {
          taken++
          if (payload.reason === 'no-room' || payload.reason === 'model') {
            escapes.push({
              at: event.at,
              reason: payload.reason,
              delta: round(payload.delta),
              room: round(payload.room),
              from: round(payload.from),
              max: round(payload.max),
              sinceLift: liftedAt === null ? null : round(event.at - liftedAt),
            })
          }
        } else {
          heldWrites++
          heldPeak = Math.max(heldPeak, Math.abs(payload.heldAfter))
        }
        break
      }
      case 'gesture.fold': {
        const payload = (event.data as GestureFoldPayload)
        fold = {
          at: event.at,
          shift: round(payload.shift),
          clamped: payload.clamped,
          discontinuity: round(
            Math.abs(payload.from + payload.shift + payload.carryBefore - (payload.applied + payload.carryAfter)),
          ),
        }
        break
      }
      case 'anchor.derive': {
        // Only meaningful after a fold that the browser *clamped*.
        //
        // The hypothesis is specifically that a clamped fold's read-back misses
        // `isSelfWrite`'s tolerance, so the anchor is re-derived from the wrong offset and the
        // displacement becomes permanent. After a fold that landed exactly, an `anchor.derive`
        // is just the next scroll event of a fling still running — entirely innocent.
        //
        // Keyed on `clamped` only after measuring the alternative: without it, an ordinary
        // gesture with a clean 23px fold reported `fold-anchor-loss` as *confirmed*, claiming a
        // permanent displacement where the trace showed 0.25px. An analyzer that cries wolf is
        // worse than one that says nothing, because the reader stops believing the one time it
        // matters.
        if (
          fold?.clamped === true &&
          event.at - fold.at < 50 &&
          (event.data as AnchorDerivePayload).skipped === null
        ) {
          anchorLostAfterFold = true
        }
        break
      }
      case 'scroll.commit': {
        if (!(event.data as ScrollCommitPayload).refused) scrollerWrites++
        break
      }
      case 'scroll.park': {
        parks++
        break
      }
      case 'scroll.wake': {
        wakes++
        break
      }
      case 'measure.done': {
        const payload = (event.data as MeasureDonePayload)
        batches++
        totalMeasureMs += payload.ms
        worstMeasureMs = Math.max(worstMeasureMs, payload.ms)
        if (payload.invalidated) invalidations++
        break
      }
      case 'frame.long': {
        probeRunning = true
        longestFrameMs = Math.max(longestFrameMs, (event.data as FrameLongPayload).gap)
        break
      }
      case 'frame.summary': {
        probeRunning = true
        break
      }
      default:
        break
    }
  }

  const startedAt = group[0]?.at ?? 0
  const endedAt = group.at(-1)?.at ?? startedAt
  if (ended === 'unknown' && liftedAt !== null) ended = 'touch'

  const verdict: Omit<GestureVerdict, 'suspects'> = {
    index,
    startedAt: round(startedAt),
    endedAt: round(endedAt),
    durationMs: round(endedAt - startedAt),
    liftedAt: liftedAt === null ? null : round(liftedAt),
    flingMs: liftedAt === null ? null : round(Math.max(0, endedAt - liftedAt)),
    liftVelocity: liftVelocity === null ? null : round(liftVelocity),
    gate,
    states,
    scrolls,
    worstScrollGapMs: round(worstScrollGapMs),
    frozenMs: round(frozenMs),
    travelPx: round(firstOffset === null ? 0 : Math.abs(lastOffset - firstOffset)),
    writes: { taken, held: heldWrites, byReason },
    escapes,
    heldPeak: round(heldPeak),
    fold,
    scrollerWrites,
    parks,
    wakes,
    measure: {
      batches,
      totalMs: round(totalMeasureMs),
      worstMs: round(worstMeasureMs),
      invalidations,
    },
    longestFrameMs: round(longestFrameMs),
    probeRunning,
    ended,
    truncated,
  }

  return {
    ...verdict,
    // A truncated record refutes everything it does not contain, so it gets no suspects at
    // all rather than a list drawn from half a gesture. See `recorder.ts`.
    suspects: truncated ? [] : rank(verdict, anchorLostAfterFold),
  }
}

/**
 * Apply the table in the module comment.
 *
 * Ordered most-specific first, so `overscroll-write` is reported instead of the more general
 * `no-room-at-end` when the offset really was outside the scroll range — the two share a
 * signal and the sharper one is the actionable finding.
 */
function rank(verdict: Omit<GestureVerdict, 'suspects'>, anchorLostAfterFold: boolean): Suspect[] {
  const out: Suspect[] = []
  const {
    escapes,
    fold,
    gate,
    states,
    scrolls,
    frozenMs,
    longestFrameMs,
    parks,
    wakes,
    scrollerWrites,
    writes: { taken, byReason },
    measure: { worstMs: worstMeasureMs },
    ended,
  } = verdict

  const noRoom = escapes.filter((escape) => escape.reason === 'no-room')
  const overscroll = noRoom.filter((escape) => escape.from < 0 || escape.from > escape.max)
  if (overscroll.length > 0) {
    const worst = overscroll[0]
    out.push({
      id: 'overscroll-write',
      confidence: 'confirmed',
      evidence:
        `${String(overscroll.length)} write(s) landed while the content offset was outside ` +
        `[0, ${String(worst?.max ?? 0)}] — from ${String(worst?.from ?? 0)}. A write during a ` +
        `rubber-band bounce snaps the page when the bounce ends.`,
      at: worst?.at ?? 0,
    })
  }

  const atEnd = noRoom.filter(
    (escape) => escape.from < NEAR_END_PX || escape.max - escape.from < NEAR_END_PX,
  )
  if (atEnd.length > 0 && overscroll.length === 0) {
    const worst = atEnd[0]
    out.push({
      id: 'no-room-at-end',
      confidence: 'confirmed',
      evidence:
        `${String(atEnd.length)} correction(s) could not be banked near an end of the list ` +
        `(room ${String(worst?.room ?? 0)}px) and wrote scrollTop instead, which cancels momentum.`,
      at: worst?.at ?? 0,
    })
  } else if (noRoom.length > 0 && overscroll.length === 0) {
    const worst = noRoom[0]
    out.push({
      id: 'no-room-at-end',
      confidence: 'suspected',
      evidence:
        `${String(noRoom.length)} correction(s) exceeded the ${String(worst?.room ?? 0)}px bank ` +
        `limit mid-list and wrote scrollTop instead.`,
      at: worst?.at ?? 0,
    })
  }

  if (fold?.clamped === true) {
    out.push({
      id: 'fold-jump',
      confidence: 'confirmed',
      evidence:
        `the ${String(fold.shift)}px paint offset was folded into a scrollTop the browser ` +
        `clamped, leaving ${String(fold.discontinuity)}px of visible movement.`,
      at: fold.at,
    })
  } else if (fold !== null && fold.discontinuity > 1) {
    out.push({
      id: 'fold-jump',
      confidence: 'suspected',
      evidence: `the fold moved the content by ${String(fold.discontinuity)}px rather than being invisible.`,
      at: fold.at,
    })
  }

  if (anchorLostAfterFold) {
    out.push({
      id: 'fold-anchor-loss',
      confidence: 'confirmed',
      evidence:
        'the anchor was re-derived from the offset the fold actually landed on, so the ' +
        'displacement is now permanent rather than transient.',
      at: fold?.at ?? 0,
    })
  }

  if (parks > 0 && wakes > 0 && scrollerWrites > 0) {
    out.push({
      id: 'scroller-wake',
      confidence: 'suspected',
      evidence:
        `the convergence loop parked ${String(parks)}×, woke ${String(wakes)}× and wrote ` +
        `${String(scrollerWrites)}× — a programmatic scroll writing during momentum.`,
      at: 0,
    })
  }

  const graceExpired = states.find((state) => state.reason === 'grace-expired')
  if (graceExpired !== undefined && scrolls > 3) {
    out.push({
      id: 'grace-misfire',
      confidence: 'confirmed',
      evidence:
        `the gate reopened on grace-expired and then saw ${String(scrolls)} more scroll events — ` +
        `the fling was read as a tap, so writes resumed while it was still running.`,
      at: graceExpired.at,
    })
  }

  if (ended === 'cap') {
    const cap = states.find((state) => state.reason === 'cap')
    out.push({
      id: 'cap',
      confidence: 'confirmed',
      evidence:
        'the gate gave up waiting for a settle and reopened. Since #53 that needs three seconds ' +
        'with no scroll event at all, so a fling still running should not reach it.',
      at: cap?.at ?? 0,
    })
  }

  if (byReason.model > 0) {
    const model = escapes.find((escape) => escape.reason === 'model')
    out.push({
      id: 'model-write',
      confidence: 'suspected',
      evidence:
        `${String(byReason.model)} model change(s) wrote through the gate deliberately; ` +
        `legitimate for a prepend, but it does cancel momentum.`,
      at: model?.at ?? 0,
    })
  }

  if (frozenMs > FREEZE_MS && taken === 0) {
    out.push({
      id: 'starvation',
      confidence: longestFrameMs > LONG_FRAME_MS ? 'confirmed' : 'suspected',
      evidence:
        `scroll events stopped for ${String(frozenMs)}ms with no write to explain it` +
        (longestFrameMs > 0 ? `, longest frame ${String(longestFrameMs)}ms` : '') +
        (worstMeasureMs > 0 ? `, worst measure batch ${String(worstMeasureMs)}ms` : '') +
        '. The main thread was blocked, not the gate.',
      at: 0,
    })
  }

  if (gate === 'inactive' && taken > 0) {
    out.push({
      id: 'not-ios',
      confidence: 'confirmed',
      evidence:
        `no momentum gate on this platform, and ${String(taken)} write(s) went through during ` +
        `the gesture. Every correction here cancels a compositor fling.`,
      at: 0,
    })
  }

  return out
}

/**
 * Which platform this is, read from the whole stream rather than per gesture.
 *
 * `gate.attach` is emitted exactly once, when the engine mounts — long before anyone touches the
 * screen. Read only inside a gesture group it was therefore never read at all, which made `gate`
 * come out `ios` for every recording and left `not-ios` unable to fire. That is the one hypothesis
 * about a platform other than iOS, so the bug hid precisely the finding the reporter's "possibly
 * all other touch devices" was asking about.
 */
function platformOf(events: readonly TraceEvent[]): GestureVerdict['gate'] {
  const attach = events.find((event) => event.topic === 'gate.attach')
  if (attach === undefined) return 'unknown'
  return (attach.data as GateAttachPayload).ios ? 'ios' : 'inactive'
}

/**
 * Every gesture in the stream, oldest first.
 *
 * `dropped` is the recorder's discard count. Passing it is what lets a verdict say
 * `truncated` rather than quietly reporting an all-clear drawn from a partial record.
 */
export function analyzeGestures(
  events: readonly TraceEvent[],
  dropped = 0,
): GestureVerdict[] {
  const platform = platformOf(events)
  const groups = segment(events)
  // Only the first surviving gesture can have lost its start, so only it is suspect.
  return groups.map((group, index) =>
    summarise(group, index, dropped > 0 && index === 0, platform),
  )
}

/**
 * The most recent gesture, which is what an overlay shows.
 *
 * Summarises **only the last group**, where this used to call `analyzeGestures` and throw all but
 * one result away. That mattered: the overlay calls this from a frame callback, so on a full ring
 * every gesture was being segmented, summarised, ranked and given its evidence strings ten times a
 * second — measured at 0.23 ms a pass on a desktop, so 1–2 ms on a phone, inside the gesture the
 * overlay exists to observe. Segmentation is still a full pass (it is one cheap loop), but the
 * expensive half now runs once.
 */
export function lastGesture(events: readonly TraceEvent[], dropped = 0): GestureVerdict | null {
  const groups = segment(events)
  const last = groups.at(-1)
  if (last === undefined) return null
  const index = groups.length - 1
  return summarise(last, index, dropped > 0 && index === 0, platformOf(events))
}
