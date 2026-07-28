import type { ItemKey } from './types.js'

/**
 * What "visible" means for a given list.
 *
 * Two fractions rather than one, because a forum comment can easily be taller
 * than the viewport — at which point "50% of the item is showing" is
 * unreachable and a naive threshold silently never fires. This is the same
 * problem the IAB solves with a size carve-out for large ads, and the reason
 * `of: 'viewport'` exists.
 */
export type VisibilityRule =
  /** Any overlap at all, down to a single pixel. */
  | { mode: 'any' }
  /** A fraction of the item's own height, or of the viewport's. */
  | { mode: 'fraction'; of: 'item' | 'viewport'; fraction: number }
  /** The whole item, top and bottom edges included. */
  | { mode: 'full' }

export interface VisibilityOptions {
  /** Defaults to `{ mode: 'any' }`. */
  rule?: VisibilityRule
  /**
   * How long an item must satisfy the rule before `enter` is reported.
   *
   * This is what stops a fling from marking hundreds of comments as read. The
   * MRC viewable-impression standard is one *continuous* second at 50% coverage,
   * which is `{ rule: { mode: 'fraction', of: 'item', fraction: 0.5 },
   * dwellMs: 1000, dwell: 'continuous' }`.
   */
  dwellMs?: number
  /**
   * `continuous` (default) restarts the clock every time the item stops
   * satisfying the rule; `cumulative` adds up separate viewings.
   *
   * Both are offered because they are genuinely different measurements — MRC
   * means the former, most product analytics want the latter — and quietly
   * picking one changes every number downstream.
   */
  dwell?: 'continuous' | 'cumulative'
  /** Report `enter` at most once per key, ever. Impression semantics. */
  once?: boolean
  /**
   * Adopt whatever is already on screen at the first sample without reporting
   * it.
   *
   * Useful when a deep link opens mid-thread and the comments already in view
   * should not count as freshly read. Borrowed from Vuetify's `v-intersect.quiet`.
   */
  quiet?: boolean
  /**
   * Delay before reporting `leave`, in ms.
   *
   * Hysteresis: without it, an item resting exactly on the viewport edge emits
   * an enter/leave storm as the user nudges the scroll.
   */
  leaveDelayMs?: number
  /** Grow (or shrink, if negative) the visibility band, in px. */
  rootMargin?: number
}

export interface VisibilityEvent {
  readonly key: ItemKey
  readonly index: number
  readonly phase: 'enter' | 'leave'
  /** Fraction of the item's own height that is visible, 0..1. */
  readonly itemFraction: number
  /** Fraction of the viewport the item covers, 0..1. */
  readonly viewportFraction: number
  /** Whether the item's geometry came from a real measurement or an estimate. */
  readonly measured: boolean
  readonly at: number
}

/** The geometry of one candidate item for a sample. */
export interface VisibilityCandidate {
  readonly index: number
  readonly key: ItemKey
  /** Top edge, in list coordinates. */
  readonly start: number
  readonly size: number
  readonly measured: boolean
}

export interface VisibilitySample {
  /** Top of the visible band, in list coordinates. */
  readonly viewportStart: number
  /** Bottom of the visible band, in list coordinates. */
  readonly viewportEnd: number
  readonly items: Iterable<VisibilityCandidate>
  readonly now: number
  /**
   * Whether the scroller itself is actually on screen.
   *
   * Pure geometry cannot know that its scroller is inside a collapsed accordion,
   * scrolled off the page, or in a background tab — it will cheerfully report an
   * item as fully visible when nothing is on screen at all. This flag is that
   * missing knowledge, supplied by a single IntersectionObserver on the scroller
   * rather than one per item.
   */
  readonly gated: boolean
  /**
   * Skip this sample entirely.
   *
   * Set during a programmatic scroll and while a scroll correction is being
   * flushed. Without it, `scrollToKey('comment-4211')` reports an enter and a
   * leave for every comment it flies past, and one deep link marks the whole
   * thread as read. Events derived from a half-applied scroll offset are simply
   * wrong.
   */
  readonly suppressed?: boolean
}

/** Public per-item state, for a component that wants to render from it. */
export interface ItemVisibility {
  readonly visible: boolean
  readonly itemFraction: number
  readonly viewportFraction: number
  readonly hasBeenSeen: boolean
}

/**
 * Everything known about one item.
 *
 * `key` and `index` live here, and the reported/active sets hold these objects
 * rather than keys, so there is no way for the bookkeeping to disagree with
 * itself — no "in the visible set but missing from the state map" case to guard
 * against, and no index to look up separately and find absent.
 */
interface ItemState {
  readonly key: ItemKey
  /** Last known index, so a departure can still be attributed after unmount. */
  index: number
  /** Reported state: an `enter` has fired and no `leave` has followed. */
  reported: boolean
  /** When the item started satisfying the rule, or null if it does not. */
  passingSince: number | null
  /** Dwell time banked from previous viewings, for `cumulative`. */
  accumulated: number
  /** When the item stopped satisfying the rule, for `leaveDelayMs`. */
  leavePendingSince: number | null
  hasBeenSeen: boolean
  itemFraction: number
  viewportFraction: number
  /** Whether the last sample's geometry came from a real measurement. */
  measured: boolean
}

/** `full` compares against 1 with slack, since fractions are computed in float. */
const FULL_EPSILON = 1e-6

const NOT_VISIBLE: ItemVisibility = {
  visible: false,
  itemFraction: 0,
  viewportFraction: 0,
  hasBeenSeen: false,
}

function newState(key: ItemKey, index: number): ItemState {
  return {
    key,
    index,
    reported: false,
    passingSince: null,
    accumulated: 0,
    leavePendingSince: null,
    hasBeenSeen: false,
    itemFraction: 0,
    viewportFraction: 0,
    measured: false,
  }
}

/**
 * Per-item viewport tracking, derived from the same geometry that drives
 * rendering.
 *
 * No existing virtual list offers this. react-virtuoso's `rangeChanged` reports
 * the *rendered* range with overscan already folded in — so at
 * `increaseViewportBy: 600` it calls comments 600px off-screen visible — virtua
 * removed its range event outright, and TanStack's `VirtualItem` has no
 * visibility field at all.
 *
 * It is computed rather than observed. `IntersectionObserver` is structurally
 * unfit as the primary mechanism here: its callback is a queued task delivered
 * *after* the rendering update it describes, it samples geometry once per
 * rendering update — so an item that enters and leaves between two samples
 * produces no entries whatsoever — and `unobserve()` reports nothing, which
 * makes unmounting indistinguishable from leaving the viewport in a list that
 * recycles rows constantly.
 *
 * All state lives here rather than in component effects, and that is
 * architectural rather than stylistic: virtualization's unmount/remount and
 * StrictMode's double invocation both re-fire anything derived from effect runs,
 * and no amount of bookkeeping inside an effect makes that idempotent.
 */
export class VisibilityTracker {
  #options: VisibilityOptions
  #states = new Map<ItemKey, ItemState>()
  /** Items currently reported as visible, so departures can be noticed cheaply. */
  #reported = new Set<ItemState>()
  /**
   * Items that still need attention if they disappear from the candidate set:
   * either reported as visible, or with a dwell clock running.
   *
   * The clock half matters more than it looks. Without it, an item part-way to
   * its dwell threshold that scrolls out of the rendered window keeps its clock
   * running while unmounted — so when the user scrolls back, the elapsed time
   * includes everything in between and it reports almost immediately. Sweeping
   * only the reported items misses exactly that case.
   */
  #active = new Set<ItemState>()
  #started = false
  /** Set while suppressed; clears timing on the next live sample. */
  #needsTimingReset = false

  constructor(options: VisibilityOptions = {}) {
    this.#options = options
  }

  setOptions(options: VisibilityOptions): void {
    this.#options = options
  }

  /** Current state for one item, for `useItemVisibility`. */
  get(key: ItemKey): ItemVisibility {
    const state = this.#states.get(key)
    if (!state) return NOT_VISIBLE
    return {
      visible: state.reported,
      itemFraction: state.itemFraction,
      viewportFraction: state.viewportFraction,
      hasBeenSeen: state.hasBeenSeen,
    }
  }

  /** Keys currently reported as visible. */
  visibleKeys(): ReadonlySet<ItemKey> {
    const keys = new Set<ItemKey>()
    for (const state of this.#reported) keys.add(state.key)
    return keys
  }

  /** Forget everything — a different thread, or a full remount. */
  reset(): void {
    this.#states.clear()
    this.#reported.clear()
    this.#active.clear()
    this.#started = false
    this.#needsTimingReset = false
  }

  /**
   * Evaluate one frame and return the transitions to report.
   *
   * Returns a batch rather than invoking a callback per item: a hundred rows
   * changing at once should be one notification, and therefore one state update
   * downstream. react-virtuoso's `itemsRendered` allocates a fresh array of every
   * rendered item every frame instead.
   */
  sample(input: VisibilitySample): VisibilityEvent[] {
    if (input.suppressed === true) {
      this.#needsTimingReset = true
      return []
    }

    if (this.#needsTimingReset) {
      this.#resetTiming()
      this.#needsTimingReset = false
    }

    const {
      rule = { mode: 'any' },
      dwellMs = 0,
      dwell = 'continuous',
      once = false,
      quiet = false,
      leaveDelayMs = 0,
      rootMargin = 0,
    } = this.#options

    const bandStart = input.viewportStart - rootMargin
    const bandEnd = input.viewportEnd + rootMargin
    const viewportSize = input.viewportEnd - input.viewportStart

    // `quiet` applies only to the very first sample: adopt what is already on
    // screen without reporting it.
    const adoptSilently = quiet && !this.#started
    this.#started = true

    const events: VisibilityEvent[] = []
    const seenThisSample = new Set<ItemKey>()

    for (const item of input.items) {
      seenThisSample.add(item.key)

      let state = this.#states.get(item.key)
      if (state) {
        state.index = item.index
      } else {
        state = newState(item.key, item.index)
        this.#states.set(item.key, state)
      }

      const overlap = Math.max(
        0,
        Math.min(item.start + item.size, bandEnd) - Math.max(item.start, bandStart),
      )
      // A zero-height item has no fraction of itself showing. The spec's own
      // `intersectionRatio` reports 1 here, which makes empty rows look fully
      // visible to any threshold logic — not a trap worth reproducing.
      const itemFraction = item.size > 0 ? Math.min(1, overlap / item.size) : 0
      const viewportFraction = viewportSize > 0 ? Math.min(1, overlap / viewportSize) : 0
      state.itemFraction = itemFraction
      state.viewportFraction = viewportFraction
      state.measured = item.measured

      const passing =
        input.gated && satisfies(rule, overlap, itemFraction, viewportFraction, item.measured)

      if (passing) {
        state.leavePendingSince = null
        state.passingSince ??= input.now
        this.#active.add(state)

        if (!state.reported && !(once && state.hasBeenSeen)) {
          const elapsed = input.now - state.passingSince
          const banked = dwell === 'cumulative' ? state.accumulated : 0
          if (banked + elapsed >= dwellMs) {
            state.reported = true
            state.hasBeenSeen = true
            this.#reported.add(state)
            if (!adoptSilently) {
              events.push(event(state, 'enter', itemFraction, viewportFraction, input.now))
            }
          }
        }
        continue
      }

      // Not passing: bank the dwell time and consider reporting a departure.
      if (state.passingSince !== null) {
        state.accumulated += input.now - state.passingSince
        state.passingSince = null
      }

      if (!state.reported) {
        this.#active.delete(state)
        continue
      }

      if (leaveDelayMs > 0) {
        state.leavePendingSince ??= input.now
        if (input.now - state.leavePendingSince < leaveDelayMs) continue
      }

      state.reported = false
      state.leavePendingSince = null
      this.#reported.delete(state)
      this.#active.delete(state)
      if (!adoptSilently) {
        events.push(event(state, 'leave', itemFraction, viewportFraction, input.now))
      }
    }

    // Items that vanished from the candidate set — unmounted, or the window
    // moved past them — must still be settled up. `IntersectionObserver` gives
    // nothing on `unobserve`, so a recycled row would otherwise stay "visible"
    // forever, and a half-elapsed dwell clock would keep running unattended.
    //
    // A vanished item reports its departure immediately, without waiting out
    // `leaveDelayMs`: hysteresis smooths a boundary wobble, but an unmounted row
    // is definitively not on screen and there is nothing to wobble back to.
    for (const state of [...this.#active]) {
      if (seenThisSample.has(state.key)) continue

      if (state.passingSince !== null) {
        state.accumulated += input.now - state.passingSince
        state.passingSince = null
      }
      state.leavePendingSince = null
      state.itemFraction = 0
      state.viewportFraction = 0
      this.#active.delete(state)

      const wasReported = state.reported
      state.reported = false
      this.#reported.delete(state)

      if (wasReported && !adoptSilently) {
        events.push(event(state, 'leave', 0, 0, input.now))
      }
    }

    return events
  }

  /**
   * Report a departure for everything currently visible.
   *
   * For a hidden tab or a scroller that left the screen, where there is no
   * sample to derive from but the items are demonstrably not visible.
   */
  flushLeaves(now: number): VisibilityEvent[] {
    const events: VisibilityEvent[] = []
    for (const state of [...this.#reported]) {
      if (state.passingSince !== null) {
        state.accumulated += now - state.passingSince
        state.passingSince = null
      }
      state.reported = false
      state.leavePendingSince = null
      this.#reported.delete(state)
      this.#active.delete(state)
      events.push(event(state, 'leave', state.itemFraction, state.viewportFraction, now))
    }
    return events
  }

  /**
   * Stop the dwell clocks without reporting anything.
   *
   * Used when the tab is hidden: time spent in a background tab is not time the
   * comment was read, so banking it would inflate every impression.
   */
  pauseDwell(now: number): void {
    for (const state of this.#states.values()) {
      if (state.passingSince === null) continue
      state.accumulated += now - state.passingSince
      state.passingSince = null
    }
  }

  /** Discard in-flight timing while keeping what has already been reported. */
  #resetTiming(): void {
    for (const state of this.#states.values()) {
      state.passingSince = null
      state.accumulated = 0
      state.leavePendingSince = null
    }
  }
}

function event(
  state: ItemState,
  phase: 'enter' | 'leave',
  itemFraction: number,
  viewportFraction: number,
  at: number,
): VisibilityEvent {
  return {
    key: state.key,
    index: state.index,
    phase,
    itemFraction,
    viewportFraction,
    measured: state.measured,
    at,
  }
}

/**
 * Whether an item's geometry satisfies the rule.
 *
 * Fraction and `full` rules additionally require a real measurement: an
 * unmeasured item sits at an *estimated* offset, so declaring that 50% of it is
 * showing is a guess dressed as a fact. `any` is allowed through unmeasured,
 * because "some part of this overlaps the viewport" survives being approximate,
 * and holding it back would delay every event on a fast scroll into new
 * territory.
 */
function satisfies(
  rule: VisibilityRule,
  overlap: number,
  itemFraction: number,
  viewportFraction: number,
  measured: boolean,
): boolean {
  if (overlap <= 0) return false

  switch (rule.mode) {
    case 'any':
      return true
    case 'full':
      return measured && itemFraction >= 1 - FULL_EPSILON
    case 'fraction': {
      if (!measured) return false
      const value = rule.of === 'item' ? itemFraction : viewportFraction
      return value >= rule.fraction
    }
  }
}
