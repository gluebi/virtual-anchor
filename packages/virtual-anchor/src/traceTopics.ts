/**
 * The shape of every trace payload, in one place.
 *
 * Declarations only — this module emits nothing, and must keep emitting nothing, so that
 * importing it from a hot path costs a type check and no bytes.
 *
 * It exists because of who reads a payload. Every *emitter* writes an object literal at one
 * call site and would notice immediately if it were wrong. The analyzer in
 * `virtual-anchor/debug` is the only reader, it reads by field name, and it is several
 * modules away — so renaming `took` or dropping `room` would leave it compiling perfectly
 * and reporting nothing, in the tool whose entire purpose is being trustworthy about what
 * happened. A shared type turns that silence into a compile error.
 *
 * Every interface extends `Record<string, unknown>` for the reason `StepTrace` already
 * documented: an interface without it is not assignable to `TraceEvent['data']`, and a bare
 * type alias trips `consistent-type-definitions`.
 */

import type { GateReason, GateState } from './momentum.js'
import type { ItemKey, ScrollEndReason } from './types.js'

/** Why the layout is being restored — mirrors `engine.ts`'s `Restore`. */
export type RestoreCause = 'none' | 'measure' | 'model'

/**
 * Why a scroll write did or did not happen.
 *
 * The distinction the old payload could not make. `deferred` told you what the engine
 * *wanted*; it was computed before the test that decides what it *does*, so a write that
 * escaped because the bound fired was recorded — and displayed on a phone — as a successful
 * deferral. These four values key on the **gate**, not on that intent, and cover every exit:
 *
 *  - `held`        — the gate was shut and the correction was banked as a paint offset. The
 *                    gate working, and the only value for which `took` is `false`.
 *  - `gate-open`   — the platform was accepting writes; the ordinary case.
 *  - `model`       — the gate was shut and this was a prepend or an append, which overrides it
 *                    deliberately, because deferring one moves the reader by the whole
 *                    inserted height.
 *  - `no-room`     — the gate was shut, this was only a measurement, and yet the write went
 *                    through, because banking it would have exceeded the scroll range on this
 *                    side. **On iOS this cancels the fling**, and it is the leading suspect
 *                    for a fling that stops abruptly near either end of a list.
 *
 * Keying on intent instead is not merely less informative, it is wrong: `deferred` is already
 * `false` whenever the restore is a model change, so a prepend overriding a shut gate would
 * report `gate-open` and look like an ordinary write on an idle platform.
 */
export type WriteReason = 'gate-open' | 'held' | 'no-room' | 'model'

/** `scroll.write` — every attempt by the engine to move the scroll offset. */
export interface ScrollWritePayload extends Record<string, unknown> {
  restore: RestoreCause
  reason: WriteReason
  /** Whether the platform was actually given the offset. The field to key on. */
  took: boolean
  /** The destination, in content space. */
  offset: number
  /** Where the content was, in the same space. */
  from: number
  delta: number
  /**
   * Whether a deferral was *wanted*. Kept for continuity; `reason` is what happened.
   *
   * `deferred: true` with `reason: 'no-room'` is the case that used to be indistinguishable
   * from the gate working.
   */
  deferred: boolean
  /** The paint offset outstanding before this write. */
  pendingShift: number
  /** The paint offset outstanding after it, or 0 if the write went through. */
  heldAfter: number
  /** Scroll range on the nearer side, which is what bounds the bank. */
  room: number
  /** The scroller's maximum offset, so `room ≈ 0` can be told from an overscroll. */
  max: number
}

/**
 * `gesture.fold` — a banked correction turning back into a real scroll offset.
 *
 * `clamped` tests an invariant that `reconcileGestureShift`'s own doc asserts cannot be
 * violated, which is exactly why nobody would notice it being violated.
 */
export interface GestureFoldPayload extends Record<string, unknown> {
  shift: number
  from: number
  target: number
  /** What the platform actually took, read back. */
  applied: number
  max: number
  clamped: boolean
  carryBefore: number
  carryAfter: number
}

/**
 * `scroll.sample` — one scroll event, stamped at delivery.
 *
 * Carries no clock of its own: `TraceEvent.at` is already `performance.now()` at the call,
 * and the inter-arrival gap is a subtraction the analyzer does for free.
 */
export interface ScrollSamplePayload extends Record<string, unknown> {
  offset: number
  carry: number
  shift: number
}

/** `paint.offset` — the container's visual displacement, and which addend moved it. */
export interface PaintOffsetPayload extends Record<string, unknown> {
  px: number
  carry: number
  shift: number
}

/** `scroll.commit` — the scroller's own write, which used to emit nothing at all. */
export interface ScrollCommitPayload extends Record<string, unknown> {
  offset: number
  from: number
  refused: boolean
  banked: number
  carry: number
}

/** `scroll.flush` — a banked delta replayed once writing is allowed again. */
export interface ScrollFlushPayload extends Record<string, unknown> {
  banked: number
  from: number
  next: number
  max: number
  /** At the bottom clamp a negative correction is already absorbed; replaying it would lift. */
  skipped: boolean
}

/**
 * `scroll.suspend` — a gap between frames too long to be a frame rate, credited back to the clock.
 *
 * Both halves are reported because the ratio is the diagnosis: a blocked main thread has a `gap` in
 * the thousands and almost all of it `credited`, where a device merely running at 8fps reports a
 * `gap` a little over the cap on every frame and is charged for nearly all of it.
 *
 * Starvation only. A frame the momentum gate blocked is `scroll.park`, whose `suspended` is the
 * whole of its gap — so the two never describe the same span and a reader can add them up.
 */
export interface ScrollSuspendPayload extends Record<string, unknown> {
  gap: number
  credited: number
  /** The budget already spent, *after* the credit — what the deadlines will be compared against. */
  elapsed: number
}

/** `scroll.park` — the convergence loop giving up its frame request while the gate is shut. */
export interface ScrollParkPayload extends Record<string, unknown> {
  elapsed: number
  /** Time the deadline is not charged for, because no frame ran. */
  suspended: number
}

/** `scroll.wake` — the gate reopening, and what was waiting. */
export interface ScrollWakePayload extends Record<string, unknown> {
  pending: boolean
  banked: number
}

/**
 * `gate.attach` — emitted once, *before* the off-iOS early return.
 *
 * Before it deliberately: it is the only way to tell "the gate stayed idle" from "there is
 * no gate", and off iOS every correction writes unconditionally, so that distinction is the
 * whole diagnosis for a non-iOS touch device.
 */
export interface GateAttachPayload extends Record<string, unknown> {
  ios: boolean
  attached: boolean
  disposed: boolean
}

/** `scroll.gate` — a state transition of the momentum write gate. */
export interface ScrollGatePayload extends Record<string, unknown> {
  state: GateState
  reason: GateReason
}

/** `measure.batch` — a ResizeObserver delivery, before it is applied. */
export interface MeasureBatchPayload extends Record<string, unknown> {
  count: number
  totalSize: number
  invalidated: boolean
}

/**
 * `measure.done` — the same batch, after everything it caused.
 *
 * `ms` covers the signature recheck, any `clearAll`, the Fenwick updates, the anchor
 * restore, the publish and the item-offset pass — which makes it the single most useful
 * number for deciding whether a stutter was the main thread rather than the gate.
 */
export interface MeasureDonePayload extends Record<string, unknown> {
  count: number
  invalidated: boolean
  ms: number
}

/**
 * `layout.signature` — the environment fingerprint that invalidates every measurement.
 *
 * The signature strings name *which* term moved — width, root font size, device pixel ratio
 * — which is what separates a URL bar collapsing from a webfont landing from a page zoom.
 */
export interface LayoutSignaturePayload extends Record<string, unknown> {
  signature: string
  previous: string | null
  invalidated: boolean
  cleared: number
}

/** `anchor.restore` — a publish deciding whether to re-derive the scroll offset. */
export interface AnchorRestorePayload extends Record<string, unknown> {
  anchor: unknown
  skipped: string | null
  totalSize: number
}

/** `anchor.derive` — the anchor being re-read from an observed scroll offset. */
export interface AnchorDerivePayload extends Record<string, unknown> {
  offset: number
  anchor: unknown
  skipped: string | null
}

/** `scroll.step` — one frame of the convergence loop. */
export interface StepPayload extends Record<string, unknown> {
  key: ItemKey
  index: number
  target: number
  /** Where the content is — the space `target` is in, not the raw scroll offset. */
  actual: number
  /** Signed distance still to travel, after everything already moving the content. */
  remaining: number
  arrived: boolean
  /**
   * Whether a row on screen is still waiting to be measured.
   *
   * Here because its absence is invisible in every other field: a loop converging against
   * estimated heights reports `arrived: true` and `remaining: 0`, and is indistinguishable from
   * one that landed correctly. That is #67, and this is the field that separates them.
   */
  awaitingMeasurement: boolean
  targetMoved: boolean
  quiet: boolean
  settledExternally: boolean
  stableFrames: number
  elapsed: number
}

/** `scroll.start` / `scroll.finish` — the ends of a programmatic scroll. */
export interface ScrollStartPayload extends Record<string, unknown> {
  key: ItemKey
  index: number
  align: string
  smooth: boolean
  target: number
  actual: number
}

export interface ScrollFinishPayload extends Record<string, unknown> {
  key: ItemKey
  index: number
  settled: boolean
  reason: ScrollEndReason
  deviation: number
  clamped: boolean
  finalTarget: number
  actual: number
  iterations: number
}

/**
 * `frame.long` and `frame.summary` — emitted by `virtual-anchor/debug`, not by the core.
 *
 * Declared here anyway, because the analyzer reads them alongside everything else and the
 * point of this module is that it reads one vocabulary rather than two.
 */
export interface FrameLongPayload extends Record<string, unknown> {
  gap: number
  frames: number
  /**
   * Only when `sampleScrollTop` is on, which is off by default and costs a layout read per frame.
   *
   * Declared rather than left to the spread that adds it: an object spread evades excess-property
   * checking, so this topic was already out of step with its declaration without a compile error —
   * in the file whose whole job is to make that impossible.
   */
  scrollTop?: number
}

export interface FrameSummaryPayload extends Record<string, unknown> {
  frames: number
  elapsed: number
  longest: number
  over: number
}

/**
 * The topics that predate this file, kept honest by the same generic.
 *
 * All eight were emitted and *not* declared here, which the first `trace<T>` typecheck found
 * immediately — so the map's claim to be "every topic this library emits" was already false when it
 * was written. None of them is read by the analyzer; they are here because a map with holes in it is
 * worse than no map, and because the next person to add a field to one should have to say so.
 */
export interface SlotResizePayload extends Record<string, unknown> {
  /** One entry per measured slot, so the shape follows `SlotName`. */
  header?: number
  stickyHeader?: number
  footer?: number
  stickyFooter?: number
}

export interface VisibilityDeadlinePayload extends Record<string, unknown> {
  due: number
  /** Milliseconds from now, which is the number a reader actually wants. */
  in: number
}

export interface ModelKeysPayload extends Record<string, unknown> {
  count: number
  firstKey: ItemKey | undefined
}

export interface ItemAttachPayload extends Record<string, unknown> {
  key: ItemKey
}

export interface SlotAttachPayload extends Record<string, unknown> {
  slot: string
}

export interface ScrollModelChangedPayload extends Record<string, unknown> {
  pending: boolean
}

/** `snapshot.restore` — emitted for both the accepted and the rejected case. */
export interface SnapshotRestorePayload extends Record<string, unknown> {
  accepted: boolean
  count: number
  version: number
  snapshotSignature: string
  cacheSignature?: string
  /** How many sizes were actually taken, on the accepted path. */
  applied?: number
  reason?: string
}

/** `gesture.touch` — the debug module's own touch probe. */
export interface GestureTouchPayload extends Record<string, unknown> {
  phase: 'start' | 'end' | 'cancel'
  y: number
  dy: number
  ms: number
  moves: number
  /** Signed px/ms at lift, so a fling long enough to hit the 3s cap can be told from a flick. */
  velocity: number
}

/**
 * Every topic this library emits, mapped to what it carries.
 *
 * The analyzer indexes this rather than re-declaring the shapes, so a field that moves
 * breaks a build instead of a diagnosis.
 */
export interface TracePayloads {
  'anchor.derive': AnchorDerivePayload
  'anchor.restore': AnchorRestorePayload
  'frame.long': FrameLongPayload
  'frame.summary': FrameSummaryPayload
  'gate.attach': GateAttachPayload
  'gesture.fold': GestureFoldPayload
  'gesture.touch': GestureTouchPayload
  'item.attach': ItemAttachPayload
  'layout.signature': LayoutSignaturePayload
  'measure.batch': MeasureBatchPayload
  'measure.done': MeasureDonePayload
  'model.keys': ModelKeysPayload
  'paint.offset': PaintOffsetPayload
  'scroll.commit': ScrollCommitPayload
  'scroll.finish': ScrollFinishPayload
  'scroll.flush': ScrollFlushPayload
  'scroll.gate': ScrollGatePayload
  'scroll.modelChanged': ScrollModelChangedPayload
  'scroll.park': ScrollParkPayload
  'scroll.sample': ScrollSamplePayload
  'scroll.start': ScrollStartPayload
  'scroll.step': StepPayload
  'scroll.suspend': ScrollSuspendPayload
  'scroll.wake': ScrollWakePayload
  'scroll.write': ScrollWritePayload
  'slot.attach': SlotAttachPayload
  'slot.resize': SlotResizePayload
  'snapshot.restore': SnapshotRestorePayload
  'visibility.deadline': VisibilityDeadlinePayload
}

/** A topic name this library emits. */
export type TraceTopic = keyof TracePayloads
