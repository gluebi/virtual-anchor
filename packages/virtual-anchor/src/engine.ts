import {
  carryFor,
  deriveAnchor,
  isSelfWrite,
  resolveAnchorOffset,
  SELF_WRITE_TOLERANCE,
} from './anchor.js'
import { observeResolution } from './env.js'
import { composeInsets, ListGeometry, type ListInsets } from './listGeometry.js'
import { createScrollerGate, type ScrollerGate } from './gate.js'
import { createResizer, type Resizer } from './resizer.js'
import { createScrollWriteGate } from './momentum.js'
import { createScroller, type Scroller } from './scroller.js'
import { onScrollSettled } from './settle.js'
import { createNullSurface, type Surface } from './surface.js'
import { DEBUG } from './debugFlag.js'
import { trace } from './trace.js'
import { SizeCache, type SizeSnapshot } from './sizeCache.js'
import {
  createVirtualStore,
  EMPTY_RANGE,
  type VirtualItem,
  type VirtualState,
  type VirtualStore,
} from './store.js'
import type { Anchor, ItemKey, ScrollResult, ScrollToOptions, SlotName } from './types.js'
import type { Viewport } from './viewport.js'
import {
  VisibilityTracker,
  type VisibilityCandidate,
  type VisibilityEvent,
  type VisibilityOptions,
} from './visibility.js'

export interface EngineOptions {
  viewport: Viewport
  /** The loaded window, in display order. A stable reference is a no-op. */
  keys: readonly ItemKey[]
  /**
   * Size estimate for unmeasured items. May return `undefined` to fall through to
   * `defaultEstimate`.
   *
   * Honoured when passed to `setOptions` as well as at construction, but only if the
   * reference is stable: a fresh closure per call rebuilds the offset tree each time.
   */
  estimateSize?: (index: number, key: ItemKey) => number | undefined
  defaultEstimate?: number
  gap?: number
  /**
   * Extra px of items mounted beyond the viewport, in each direction.
   *
   * This is the *coverage guarantee*: at least this much is mounted ahead of and behind the
   * visible band at all times. Somewhat more is mounted in practice, because the range is held
   * across a scroll rather than recomputed on every event — see {@link RANGE_SLACK_RATIO}.
   */
  buffer?: number
  geometry?: ListInsets
  /**
   * Stay pinned to the end of the list as it grows. Off by default.
   *
   * Held with an instant write on every publish, which is what a streaming
   * message or a busy chat wants — there is nothing to animate towards when the
   * destination moves every frame, and an animation chasing it is the hazard the
   * README's fetching contract already describes. It is also what keeps
   * {@link onAtBottomChange} coherent: following goes to the scroller's true
   * maximum, which is exactly where `atBottom` is measured from.
   *
   * Dropped when the reader scrolls away deliberately, restored when they come
   * back to the bottom.
   */
  followOutput?: boolean
  /** How close to the end still counts as being at it, in px. Default 4. */
  atBottomThreshold?: number
  /**
   * Notified when either end of the *loaded* window comes within
   * {@link edgeReachedThreshold} px, for bidirectional pagination.
   *
   * Suppressed while a programmatic scroll is in flight. That is the point of
   * owning this rather than leaving it to an `onScroll` handler: the README
   * tells consumers not to fetch during a programmatic scroll, because a
   * prepend moves the target the animation is chasing — and a callback that
   * cannot fire then makes the documented footgun unreachable instead of merely
   * documented.
   */
  onEdgeReached?: (edge: 'start' | 'end') => void
  /** How near an edge counts as reaching it, in px. Default 600. */
  edgeReachedThreshold?: number
  /**
   * Hold short content against the bottom of the scroller rather than the top.
   *
   * What a chat looks like before it has a screenful in it. Implemented as space
   * *above* the items, so anything in the `header` slot stays where a header
   * belongs and the gap opens between it and the first message.
   */
  alignToBottom?: boolean
  /** Keys always kept mounted, e.g. whatever currently holds focus. */
  keepMounted?: readonly ItemKey[]
  visibility?: VisibilityOptions
  onVisibilityChange?: (events: VisibilityEvent[]) => void
  sizeSnapshot?: SizeSnapshot
  /** Identifies the layout a size snapshot was measured in. */
  layoutSignature?: string
  /**
   * Everything the engine draws.
   *
   * One owner, so that content size, scroll offset and item positions are written in
   * a single ordered pass. The ordering is not incidental: a prepend makes the
   * restored offset exceed the old maximum, and a write past it is silently clamped.
   * Defaults to a surface that draws nothing, which is what a headless test wants.
   */
  surface?: Surface
  now?: () => number
}

export interface Engine {
  readonly store: VirtualStore
  readonly cache: SizeCache
  setOptions(options: Partial<EngineOptions>): void
  /** Attach the scrollport. Returns its own teardown. */
  mount(): () => void
  observeItem(element: Element, key: ItemKey): () => void
  /**
   * Start measuring a slot. Returns its own cleanup, for a ref callback.
   *
   * Detaching gives the space back rather than merely forgetting it: a header
   * that unmounts while its measured height lingers is phantom padding nothing
   * can account for, which is react-virtuoso #1203.
   */
  observeSlot(element: Element, slot: SlotName): () => void
  /** A stable ref callback for a slot, memoised the way {@link itemRef} is. */
  slotRef(slot: SlotName): (element: HTMLElement | null) => (() => void) | undefined
  /**
   * A stable ref callback for an item.
   *
   * Memoised per key *here*, because the identity has to survive every render and the
   * cache belongs with the element registry rather than in React. Held in the adapter
   * it was either a ref read during render or a mutated memo — both of which the
   * React-compiler lint rules reject, and rightly: a mutable render-stable cache is
   * not React's to hold.
   */
  itemRef(key: ItemKey): (element: HTMLElement | null) => (() => void) | undefined
  scrollToKey(key: ItemKey, options?: ScrollToOptions): Promise<ScrollResult>
  scrollToIndex(index: number, options?: ScrollToOptions): Promise<ScrollResult>
  getAnchor(): Anchor | null
  setAnchor(anchor: Anchor): void
  takeSizeSnapshot(): SizeSnapshot
  /** Abandon any in-flight programmatic scroll, resolving it as unsettled. */
  cancelScroll(): void
  /**
   * Move focus to an item, if it is mounted.
   *
   * On the engine because it already owns the element registry; the alternative was a
   * second key→element map in the component plus a `dataset` round-trip to recover a
   * key React knew at render time.
   */
  focusItem(key: ItemKey): boolean
  /** The key at a collection index, mounted or not. */
  keyAt(index: number): ItemKey | undefined
  getVisibility(key: ItemKey): ReturnType<VisibilityTracker['get']>
  subscribeVisibility(key: ItemKey, listener: () => void): () => void
  dispose(): void
}

/**
 * How far beyond the visible band to mount, in px.
 *
 * **2500 rather than the 400 this was, and the number is measured rather than chosen.** The
 * symptom is a hard fling putting blank frames on screen: the browser scrolls on the compositor
 * thread while the mounted range is recomputed on the main thread, so anything past the buffer is
 * a region no row has been mounted for. `perf/blanking.spec.ts` counts those frames directly, and
 * on the demo at 40,000 px/s the buffer is the whole story:
 *
 * | buffer | blank frames at 20x CPU | headroom at 20x CPU |
 * | --- | --- | --- |
 * | 400 | 13 of 79 | 42 fps, 8.2 ms per scroll event |
 * | 1200 | 11 of 81 | 33 fps, 12.7 ms |
 * | 2500 | 3 of 78 | 32 fps, 14.3 ms |
 *
 * 1200 is dominated — nearly all of the cost, almost none of the benefit — so the real choice was
 * between 400 and 2500. At 1x and 6x emulated CPU, 2500 costs nothing measurable (60 fps, 0.2 ms)
 * and removes the blanking; the headroom it spends only appears past 10x, where frames are being
 * dropped regardless. Consumers who want the old trade still have `buffer`.
 *
 * What made this the fix rather than a velocity lookahead — which was written, measured and
 * dropped — is that the blank frames all land in the *first* few per cent of a gesture, where a
 * lookahead derived from velocity is necessarily zero. A larger static buffer means the rows are
 * already there before the finger moves.
 *
 * This is the guaranteed coverage, not the mounted distance: {@link RANGE_SLACK_RATIO} mounts
 * further so the range can be held still across a scroll.
 */
const DEFAULT_BUFFER = 2500



/**
 * Most rows the default may *guarantee* on each side.
 *
 * Bounds the mounted band too, at `1 + RANGE_SLACK_RATIO` times this — the slack is a fraction of
 * the guarantee, so 24 rows of coverage is at most 36 rows resident and no separate cap is
 * needed. Stated because an earlier attempt divided the guarantee to keep the *mounted* figure at
 * 24, which quietly cut the coverage `blanking.spec.ts` calibrated from 2500px to 1920px on the
 * demo — a 23% reduction in the one number that spec exists to choose.
 *
 * `DEFAULT_BUFFER` is a distance, which is right for what it buys — latency times velocity is a
 * distance — and wrong for what it costs, which is rows. Calibrated on this demo's ~162px
 * comments, 2500px is about fifteen rows a side. On a list of 20px chips the same constant is a
 * hundred and twenty-five, for a list whose rows were never the expensive part.
 *
 * So the default is whichever is smaller. A caller who states `buffer` outright is not second
 * guessed — this bounds the number nobody chose. The incident it exists against is on record in
 * `computeRanges`: an unbounded mounted range once put 7,798 rows on screen in a single frame,
 * which took 103 seconds and never scrolled at all.
 */
const MAX_DEFAULT_BUFFER_ROWS = 24

/**
 * Extra distance mounted beyond {@link EngineOptions.buffer}, as a fraction of it, so that the
 * mounted range can be *held* across a scroll instead of recomputed on every event.
 *
 * The problem this solves is not layout, it is React. `computeRanges` ran on every scroll event
 * and the mounted range moved the instant the buffered band crossed a row boundary — and
 * `needsRerender` trips on exactly that. Browsers coalesce scroll events to one per frame, so
 * the ceiling is a render per frame rather than per row; the cost is how *often* that ceiling is
 * reached. Recomputing now happens once per `buffer * RANGE_SLACK_RATIO` px of travel instead of
 * once per row, which on the demo's ~162px comments is 60 renders a second down to 32 during a
 * 40,000px/s fling, and 11.5 down to 1.6 at an ordinary reading speed of 2,000px/s.
 *
 * A skipped render is the whole of React's work — no reconcile, no commit, no effects — for
 * every mounted row. What it costs is rows resident: the mounted band grows by the slack, and
 * `itemsFor` still allocates one object per mounted row on every publish, held or not. The trade
 * is favourable at both speeds and lopsidedly so at reading speed, which is where a reader
 * actually is.
 *
 * The shape is Vuetify's — hold until the buffer is spent — because the buffered band this
 * library already computes is the natural thing to test containment against. PrimeVue and
 * holmberd reach the same behaviour through a trigger index and through precomputed
 * pixels-remaining respectively; three independent arrivals is most of the argument for doing
 * it at all.
 *
 * **Why the slack is on the recompute and not on the trigger.** The tempting version holds the
 * range until the *visible* band approaches its edge, which needs no extra rows — and quietly
 * halves the coverage the buffer promises, because the mounted set is then anywhere between one
 * buffer and none of it ahead of the reader. `blanking.spec.ts` chose `DEFAULT_BUFFER` against
 * that coverage directly. So the trigger stays exactly where it was, at the buffered band, and
 * the recompute mounts wider: coverage never falls below `buffer`, and a recompute happens once
 * per `buffer * RANGE_SLACK_RATIO` px of travel rather than once per row.
 *
 * The cost is rows resident at rest, which is why this is a ratio of the buffer rather than a
 * constant: whatever bounds the buffer — a caller's own number, or `MAX_DEFAULT_BUFFER_ROWS` for
 * a list of short rows — bounds this in proportion.
 */
const RANGE_SLACK_RATIO = 0.5

/**
 * How far past the buffered band a *live* hold's edge may sit, in slacks, before `computeRanges`
 * stops believing it was computed for this list.
 *
 * Two, and the arithmetic is tight rather than chosen: a recompute grants one slack beyond the band
 * at the edge that ran out, and the reader travels one more before the coverage test fires at the
 * other edge. So an edge two slacks clear of the band is a hold at the last moment of its
 * legitimate life, and anything past that is a hold from a list this no longer is.
 *
 * It exists because the coverage test is one-sided — it asks whether the hold is too *narrow* — so
 * without this nothing ever revisited one that was far too wide. A list momentarily shorter than
 * its own band produces exactly that: the band spans everything, so the hold is the whole list, and
 * the two keys it pins are the list's first and last. Where those keys stay first and last, as an
 * opener and a footer row do, the hold covers the whole list for as long as it exists.
 *
 * **This bounds displacement, not extent, and does not loosen the cap
 * {@link MAX_DEFAULT_BUFFER_ROWS} argues for.** A held range's *span* stays what it was granted —
 * `buffer + slack` a side — and only drifts relative to the moving band; a release takes the slack
 * on both edges, for that same per-side figure. So "at most 36 rows resident" survives unchanged,
 * and the two numbers are not comparable even though both are counted in slacks.
 */
const MAX_HOLD_DRIFT_SLACKS = 2

/**
 * How close to the end still counts as being at it.
 *
 * Small, because this is slack for rounding rather than a "near the bottom"
 * region: `getMaxScrollOffset` is built from an integer `clientHeight` while the
 * offset it is compared against is an exact float, and a sticky footer of 85.5px
 * makes the disagreement routine. Four pixels absorbs that without ever calling
 * a deliberately-scrolled-up reader pinned.
 */
const DEFAULT_AT_BOTTOM_THRESHOLD = 4
/** How near an edge of the loaded window counts as reaching it. */
const DEFAULT_EDGE_THRESHOLD = 600
/**
 * How long an input-driven scroll must be quiet before re-pinning is decided.
 *
 * The same 150ms the scroller uses to call a model still — and, as react-virtuoso
 * and virtua arrived at independently, about the shortest window that reliably
 * outlasts the gap between frames of a fling.
 */
const REPIN_QUIET_MS = 150
/**
 * How often a measurement may re-read the layout signature.
 *
 * A rate limit, not a threshold: it decides nothing about the content, only how often the
 * question is asked. Necessary because the only reliable signal that the root font size
 * changed *is* a measurement — a change re-lays-out every mounted row and fires their
 * observers — and that path runs for every row measured during a fling. Reading a computed
 * style there costs nothing per call and everything per hundred.
 *
 * 250ms because the cause is a human one: a browser's default size being changed, or an
 * accessibility toggle being flipped. A quarter of a second of latency against an action
 * that takes one is not perceptible, and it bounds the reads during a three-second fling to
 * a dozen.
 *
 * Not the timestamp comparison `momentum.ts` refuses. That one would have replaced a free
 * state check with arithmetic; this one is arithmetic standing in front of a
 * `getComputedStyle`, and there is no state to check instead — the absence of any signal is
 * the whole reason this exists.
 */
const SIGNATURE_RECHECK_MS = 250
/**
 * Whether a publish may move the scroll offset, and on whose authority.
 *
 * The distinction exists because iOS refuses scroll writes during a fling and the two
 * reasons for restoring are not equally postponable.
 *
 * - `'measure'` — the offsets moved because something got measured. Deferring it to
 *   the end of the fling costs a drift the reader is already scrolling past.
 * - `'model'` — the offsets moved because the collection or the caller's declaration
 *   moved. A prepend of forty comments shifts everything below it, and skipping *that*
 *   teleports the reader. It writes regardless of the gate, and killing the fling is
 *   the lesser harm.
 *
 * By cause, not by magnitude: a size threshold here would be the first compensation
 * heuristic in a file whose whole design is not having one.
 *
 * What the two buckets are really proxying is *whether content above the anchor moved*,
 * and one case looks like a mismatch: a measured `header` or `stickyHeader` slot moves
 * the list's origin via `scrollMargin`, yet `onSlotGeometryChange` publishes `'measure'`.
 * That is deliberate, and it is not obvious from the names, so:
 *
 * - A deferred correction is *held* as a paint offset rather than dropped, so the content
 *   sits exactly where `'model'` would have put it. The label only chooses which mechanism
 *   carries the correction — the same argument the `room` bound makes in `writeScroll`.
 * - Once the correction exceeds `room` the write is taken and the fling cancelled anyway,
 *   so near an end `'measure'` takes exactly the write `'model'` would have. Which end
 *   depends on the sign, and not symmetrically: a header that *grows* pushes the bottom
 *   away by the same amount it displaces the content, so only the space above can run out.
 * - `'model'` would cancel the fling on *every* slot resize, including the ones that
 *   repeat through a gesture: an animated composer, a sticky header rewrapping on rotate.
 */
type Restore = 'none' | 'measure' | 'model'

/**
 * A shared empty inset set.
 *
 * Shared so that "the consumer passed no geometry" is a stable reference, which
 * is what lets the composed insets be memoised against it.
 */
const NO_INSETS: ListInsets = {}

/**
 * Whether two inset sets describe the same layout.
 *
 * By value, not by reference, and the difference is load-bearing. A geometry
 * change now re-applies the anchor and re-aims any in-flight scroll — which is
 * right, because the target really has moved — but re-aiming also pushes back
 * the convergence loop's 150ms quiet window. A consumer whose `geometry` object
 * is rebuilt on some unrelated render would therefore keep a smooth
 * `scrollToKey` from ever going quiet, and it would run to its 5s hard deadline
 * and report `deadline` with the scroll still in flight. Observed exactly once
 * per full Playwright run before this comparison existed.
 */
const sameInsets = (a: ListInsets, b: ListInsets): boolean =>
  a.scrollMargin === b.scrollMargin &&
  a.scrollPaddingStart === b.scrollPaddingStart &&
  a.scrollPaddingEnd === b.scrollPaddingEnd &&
  a.spaceAfter === b.spaceAfter

/**
 * Wires the cache, anchor, resizer, scroller, visibility tracker and gate into
 * one object, and owns the single rule that makes the whole thing work:
 * **`scrollTop` is derived from the anchor whenever the layout changes.**
 */
export function createEngine(initial: EngineOptions): Engine {
  let options: EngineOptions = initial
  const now = (): number => options.now?.() ?? performance.now()

  const cache = new SizeCache({
    keys: options.keys,
    ...(options.gap === undefined ? {} : { gap: options.gap }),
    ...(options.estimateSize === undefined ? {} : { estimateSize: options.estimateSize }),
    ...(options.defaultEstimate === undefined
      ? {}
      : { defaultEstimate: options.defaultEstimate }),
    ...(options.layoutSignature === undefined
      ? {}
      : { layoutSignature: options.layoutSignature }),
    ...(options.sizeSnapshot === undefined ? {} : { snapshot: options.sizeSnapshot }),
  })

  const surface: Surface = options.surface ?? createNullSurface()
  const store = createVirtualStore()
  const tracker = new VisibilityTracker(options.visibility ?? {})
  const visibilityListeners = new Map<ItemKey, Set<() => void>>()
  /**
   * One ref callback per key, so React never sees a changed ref identity.
   *
   * Pruned to the rendered window on every publish, so it cannot outgrow the list.
   */
  const itemRefCallbacks = new Map<ItemKey, (element: HTMLElement | null) => (() => void) | undefined>()
  /** The same, for the four slots. Fixed set, so nothing to prune. */
  const slotRefCallbacks = new Map<SlotName, (element: HTMLElement | null) => (() => void) | undefined>()

  /** The position of record. Everything else is derived from it. */
  let anchor: Anchor | null = null
  /**
   * Whether the view is currently pinned to the end of the list.
   *
   * Starts on whenever `followOutput` is set, so a chat opens at the newest
   * message, and is dropped the moment the reader scrolls away deliberately.
   */
  let following = options.followOutput === true
  /**
   * Set by the scroller's input listener, cleared by the scroll event it precedes.
   *
   * Input is the *gate* and position is the *test*: a wheel says the reader
   * reached for the scroller, and where they end up says whether they meant to
   * leave the bottom. Neither alone is enough — the browser moves `scrollTop` by
   * itself when content shrinks or a window of items is replaced, and reading
   * that as intent would unpin a reader who never touched anything.
   */
  let sawUserInput = false
  /**
   * Offsets this module has written from the anchor, awaiting their scroll events.
   *
   * A queue rather than a boolean for the same reason the scroller keeps one: scroll
   * events are delivered *asynchronously*, so a flag set and cleared around a
   * synchronous write is always back to `false` by the time the event arrives. The
   * guard it replaced therefore never once fired.
   *
   * What it guards matters. The anchor must follow the *scroller's* writes — those
   * move the view intentionally, and not following them leaves the anchor describing
   * the pre-scroll position so the next prepend teleports the view back there. But it
   * must *not* follow an anchor-restore, because that read-back may have been snapped
   * to a whole pixel: absorbing that into `offsetWithinItem` re-introduces the very
   * residual the carry just removed, which shows up as a landing exactly 0.5px off.
   */
  const restoreIntents: number[] = []
  const MAX_RESTORE_INTENTS = 5
  /** Whether a scrollport observation has established a layout signature yet. */
  let signatureKnown = options.layoutSignature !== undefined
  /** Teardown for whatever `mount()` attached, so `dispose()` can undo all of it. */
  let unmount: (() => void) | null = null
  /**
   * An extra range to keep mounted, for a smooth scroll's destination.
   *
   * Part of the *inputs* to the rendered range rather than a patch applied over its
   * output, so that `publish` remains the only writer of the snapshot and `items` and
   * `renderedRange` cannot disagree.
   */
  let pinnedRange: [number, number] | null = null
  /**
   * The last ranges published, kept so an unchanged range is the *same* tuple.
   *
   * `computeRanges` runs once per scroll frame and once per React render, and the numbers it
   * produces are unchanged for most of them. Returning a fresh tuple each time made identity
   * meaningless, so every subscriber had to compare element-wise and say so in a comment;
   * handing back the previous tuple lets a reference check mean what it looks like it means.
   * Same technique as `VisibilityTracker#get`, and for the same reason.
   */
  let lastRendered: readonly [number, number] = EMPTY_RANGE
  let lastVisible: readonly [number, number] = EMPTY_RANGE
  /**
   * The ends of the mounted range, remembered by key so that a prepend cannot renumber them.
   *
   * By key for the same reason the anchor is a key. Two integers would name two different rows
   * the moment anything is inserted above, and the range would then hold the wrong ones mounted;
   * two keys either still name their rows — in which case the hold survives a prepend intact,
   * which is the behaviour worth having — or stop resolving, which reads as nothing held and
   * recomputes.
   *
   * That is one of the two mechanisms, and it is worth being clear about which is which, since
   * a reader deciding whether some new event needs a flag will look here. **Identity** changes —
   * a prepend, an append, a window that paged away — are caught here. **Geometry** changes — a
   * gap, a re-estimate, a discarded measurement cache, a resize, a slot appearing — are caught
   * by the containment test in `computeRanges`, which is computed from live offsets and a
   * geometry `syncGeometry` has already re-pointed at this pass. Neither needs a flag; between
   * them there is nothing left that can move a row without one of them noticing.
   */
  let heldStartKey: ItemKey | undefined
  let heldEndKey: ItemKey | undefined
  let gate: ScrollerGate | null = null
  let disposed = false
  /** Whether a size snapshot has been taken up; see `setOptions`. */
  let snapshotRestored = options.sizeSnapshot !== undefined

  const viewport = options.viewport
  /**
   * The single owner of scroller-space ↔ list-space conversion.
   *
   * Re-synced from the live options and viewport rather than rebuilt, so every
   * caller in this file necessarily agrees about where the visible area is. The
   * band arithmetic it replaces was written out twice here — once for the rendered
   * range and once for the visibility sample — and had to be kept in step by hand.
   */
  const listGeometry = new ListGeometry()

  /**
   * Measured heights of the four slots, all zero until one mounts.
   *
   * Engine state rather than an option, because they are facts about the DOM
   * rather than a consumer's declaration — which is the whole point of the
   * slots. virtua's `startMargin` and TanStack's `scrollMargin` are the same
   * quantity left as a number for the consumer to keep in step by hand, and
   * both have long-lived issues asking for it to be measured instead.
   */
  const slotSizes: Record<SlotName, number> = {
    header: 0,
    stickyHeader: 0,
    footer: 0,
    stickyFooter: 0,
  }
  /**
   * Empty space held above the items so short content sits at the bottom.
   *
   * A fifth contribution to the same composition the slots feed, rather than a
   * mechanism of its own — it is space before the list, which is what
   * `scrollMargin` has always meant. Recomputed in `publish`, because it depends
   * on the total size and the viewport and both move.
   */
  let leadingSpace = 0
  /** Bumped whenever a contribution to the composed insets moves. */
  let insetsVersion = 0
  let composedInsets: ListInsets = NO_INSETS
  let composedFrom: ListInsets | null = null
  let composedVersion = -1

  /**
   * The consumer's insets with the measured slots folded in.
   *
   * Composed into a plain `ListInsets` rather than held beside one, because
   * `anchor.ts` builds a throwaway `ListGeometry` from whatever object it is
   * handed — so a measurement kept anywhere else would simply not be seen by
   * the conversion that matters.
   *
   * The mapping itself lives with `ListInsets` as {@link composeInsets} — which
   * channel a measurement feeds is a fact about the channels, not about this
   * file. What stays here is the state and the memo.
   *
   * Memoised on the source object and the slot version: this runs on every
   * publish, and every scroll frame publishes.
   */
  const geometry = (): ListInsets => {
    const base = options.geometry ?? NO_INSETS
    // Nothing has ever mounted a slot: hand back the consumer's own object, so
    // a list without slots allocates nothing and behaves exactly as before.
    if (insetsVersion === 0) return base
    if (composedFrom === base && composedVersion === insetsVersion) return composedInsets

    composedInsets = composeInsets(base, { ...slotSizes, leadingSpace })
    composedFrom = base
    composedVersion = insetsVersion
    return composedInsets
  }

  /** Record a slot measurement. Returns whether it actually moved. */
  const setSlotSize = (slot: SlotName, size: number): boolean => {
    if (slotSizes[slot] === size) return false
    slotSizes[slot] = size
    insetsVersion++
    return true
  }

  /**
   * How much scrollport the content fails to fill, and which end gets it.
   *
   * There is one such quantity and two things that want it. `alignToBottom` wants it
   * above the items, to hold short content against the bottom of the scroller. A
   * `stickyFooter` wants it below them, because `position: sticky; bottom: 0` lifts a
   * box to an edge and can never push one down to one — so on a list too short to fill
   * the scrollport the slot rests at the end of the items, halfway up the box, and the
   * documented pin is a pin to nothing.
   *
   * Computed once and routed, so spending it twice is not expressible.
   *
   * Against the raw scrollport height rather than {@link ListGeometry.visibleSize}: the
   * padding describes chrome *overlapping* the scrollport, which occupies no content, so
   * the content still has the whole box to fill. The sticky slots are the exception and
   * they are already in the sum, because they are in flow.
   *
   * The consumer's own insets are in the sum and `leadingSpace` is not — this is what
   * *produces* `leadingSpace`, so reading the composed insets here would be circular.
   * Their `scrollMargin` is page content above a window-scrolled list, and it occupies
   * scrollport exactly as our own chrome does.
   *
   * Returns the trailing space rather than storing it, because only the leading one is a
   * contribution to the composed insets — see {@link geometry}. `viewportSize` is passed
   * rather than read, for the reason given at {@link syncGeometry}.
   */
  const syncSlack = (totalSize: number, viewportSize: number): number => {
    const base = options.geometry ?? NO_INSETS
    const occupied =
      (base.scrollMargin ?? 0) +
      slotSizes.header +
      slotSizes.stickyHeader +
      totalSize +
      slotSizes.footer +
      slotSizes.stickyFooter +
      (base.spaceAfter ?? 0)
    const slack = Math.max(0, viewportSize - occupied)

    const alignToBottom = options.alignToBottom === true
    const nextLeading = alignToBottom ? slack : 0
    // Reading the option rather than `nextLeading === 0` so the exclusivity is syntactic
    // rather than something a reader has to prove — and `alignToBottom` taking it is not
    // a compromise the footer loses. The sticky slot is in flow and in `occupied`, so
    // pushing the whole block down lands it on the bottom edge anyway; it needs nothing
    // of its own.
    //
    // The gate reads the raw slot rather than `spaceAfter`, because the insets cannot
    // answer it: `composeInsets` merges `footer` and `stickyFooter` into `spaceAfter` on
    // purpose. And the distinction is the whole of it — a plain `footer` is in-flow
    // content belonging under the last item, and pushing *it* down an unfilled
    // scrollport would be a different library.
    const trailing = !alignToBottom && slotSizes.stickyFooter > 0 ? slack : 0

    if (nextLeading !== leadingSpace) {
      leadingSpace = nextLeading
      insetsVersion++
    }
    return trailing
  }

  /**
   * A slot changed height, so the composed insets moved — and with a `header`, a
   * `stickyHeader`, or the `leadingSpace` a footer moves under `alignToBottom`, the
   * list's origin along with them.
   *
   * The same treatment as a measurement landing, and for the same reason: the
   * anchor names an item, `resolveAnchorOffset` re-derives `scrollTop` from it
   * against the new geometry, and the two movements cancel exactly. That is why a
   * header which loads an image does not shove the view down here — the bug every
   * other library has.
   *
   * Which is why this does not need to know *which* slot changed, though the three
   * call sites could all say. Only a header moves the origin during an ordinary
   * gesture, and `'measure'` already handles that correctly (see {@link Restore}).
   * The one case left over — a `footer` moving `leadingSpace` under `alignToBottom`
   * — arises only when the content is shorter than the viewport, which is where
   * `syncSlack` produces anything at all, and there the scroll range is
   * empty: `room` is the distance to the *nearer* end, so it is 0 whenever the
   * offset is 0, and the write is taken whatever the label says.
   */
  const onSlotGeometryChange = (): void => {
    if (DEBUG) trace('slot.resize', () => ({ ...slotSizes }))
    // A measurement, not a model change, at both ends of the list: an animated sticky
    // footer resizing under a fling is exactly the wobble the gate exists to postpone,
    // and a header's correction is *held* rather than dropped. See the `Restore` doc for
    // why holding it is indistinguishable from writing it.
    publish('measure')
    scroller.notifyModelChanged()
  }

  /**
   * Point the shared {@link ListGeometry} at the current insets and scrollport height.
   *
   * **Called once per pass, by the pass, and takes the height rather than reading it.** Both
   * halves of that were costing something. `getViewportSize` is three DOM reads on an element
   * scroller — a `getBoundingClientRect` plus `offsetHeight` and `clientHeight`, per
   * `contentHeightOf` — and this used to make them itself, from each of its two callers:
   * `computeRanges` and the visibility sample. The second of those runs *after* `publish` has
   * written every mounted row's `top` and the paint offset, so its read was not a repeat but a
   * forced synchronous layout, once per scroll event, to re-answer what the same pass had
   * already answered. Its `update` was dead work on top, since nothing between the two calls
   * moves an inset.
   *
   * A parameter rather than a cache inside `Viewport`, because the cache would need an
   * invalidation signal that does not exist: `observeSize` watches the **border** box, and a
   * horizontal scrollbar appearing changes `clientHeight` — and so the content height —
   * without changing that box at all. A cache keyed on the observer would go quietly stale by
   * the scrollbar's width; a parameter cannot.
   *
   * Must run *after* {@link syncSlack}, whose leading spacer `geometry()` folds in.
   */
  const syncGeometry = (viewportSize: number): void => {
    listGeometry.update(geometry(), viewportSize)
  }

  /**
   * Whether the scroller is at its end, within the configured slack.
   *
   * Both terms come from the viewport, deliberately. Mixing in
   * `cache.totalSize()` would straddle two different roundings —
   * `getMaxScrollOffset` derives from an integer `clientHeight` while
   * `getViewportSize` uses the exact float content height — and the predicate
   * would flicker on the sub-pixel difference. Nor is `visibleRange[1] === count
   * - 1` usable: `indexAt` clamps, so that is true for any list shorter than the
   * viewport at any scroll position.
   *
   * A list with no scroll range is at the bottom, because its end is on screen.
   *
   * Two entry points, one rule: `publish` has already paid for both reads and
   * passes them in, everything else asks the viewport. Writing the comparison
   * twice would let the store's `atBottom` — the value the consumer is told —
   * drift from the one that decides whether to re-pin.
   */
  const atBottomWithin = (max: number, offset: number): boolean =>
    max - offset <= (options.atBottomThreshold ?? DEFAULT_AT_BOTTOM_THRESHOLD)

  const atBottomNow = (): boolean =>
    atBottomWithin(viewport.getMaxScrollOffset(), viewport.getScrollOffset())

  /** The pending re-pin decision, if input-driven scrolling is still in flight. */
  let repinTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Decide whether the reader ended up back at the end, and pin them if so.
   *
   * Idempotent, and gated on `sawUserInput`, so the timer and `scrollend` can
   * both call it and whichever arrives first wins.
   */
  const repin = (): void => {
    if (repinTimer !== null) {
      clearTimeout(repinTimer)
      repinTimer = null
    }
    if (!sawUserInput) return
    sawUserInput = false
    // Re-read the option: it can have been switched off mid-scroll, in which
    // case `setOptions` has already cleared `following`.
    if (options.followOutput === true) following = atBottomNow()
  }

  /**
   * Restart the quiet window after an input-driven scroll event.
   *
   * The same 150ms the scroller uses to call a model still, and for the same
   * reason: it is long enough to outlast the gap between frames of a fling and
   * short enough that a reader who has stopped does not notice the wait.
   */
  const armRepin = (): void => {
    if (repinTimer !== null) clearTimeout(repinTimer)
    repinTimer = setTimeout(repin, REPIN_QUIET_MS)
  }

  /**
   * Which edges have already been reported since the view left them.
   *
   * A latch, not an identity check. `onVisibleRangeChange` can dedupe by handing
   * back the previous tuple because a range is a *value*; reaching an edge is an
   * *event*, and the honest way to fire it once per crossing is to remember that
   * it fired and forget when the view moves back out of range.
   */
  const edgeLatched = { start: false, end: false }

  /**
   * Report either end of the loaded window coming into reach.
   *
   * Suppressed entirely while a programmatic scroll is in flight, which is the
   * reason this belongs in the library rather than in an `onScroll` handler. A
   * page fetched mid-animation moves every offset below the insertion point,
   * including the target the animation is chasing, and the newly inserted items
   * are unmeasured so it keeps moving as they measure. The README tells
   * consumers not to do it and the pagination demo hand-rolls the guard; owning
   * the callback makes the mistake unavailable instead of merely documented.
   */
  const notifyEdges = (scrollOffset: number, max: number): void => {
    const report = options.onEdgeReached
    if (!report) return
    if (scroller.isScrolling()) return

    const threshold = options.edgeReachedThreshold ?? DEFAULT_EDGE_THRESHOLD

    const nearStart = scrollOffset <= threshold
    const nearEnd = max - scrollOffset <= threshold

    // An empty or short list is within reach of both ends at once, and that is
    // not a contradiction — there is nothing between them.
    if (nearStart && !edgeLatched.start) report('start')
    if (nearEnd && !edgeLatched.end) report('end')
    edgeLatched.start = nearStart
    edgeLatched.end = nearEnd
  }

  /**
   * The two contributions to the item container's paint offset.
   *
   * `carry` is the fraction of a pixel a *completed* scroll write lost; `pendingShift`
   * is the whole of a correction that has not been written at all, because iOS refuses
   * to move the scroll offset during a touch gesture — writing it cancels a fling, and
   * writing it under a finger is undone by the gesture's own baseline. Without the
   * second one, deferring a correction meant the view lurched by all of it: 389px for a
   * single row on a phone, since an estimate fitted at desktop width is wrong by
   * hundreds of pixels once the text wraps three times as often.
   *
   * Held apart because the anchor arithmetic needs them separately and they end
   * differently — the carry is replaced by the next landing, the shift is folded into
   * `scrollTop` — but written together, because they share one `top`. Two independent
   * writers would each clobber the other, which stays invisible until both are
   * non-zero: a sub-pixel landing taken mid-gesture.
   */
  let carry = 0
  let pendingShift = 0
  /** Last sum handed to the surface, so an unchanged value is not re-written. */
  let paintOffset = 0


  /** {@link DEFAULT_BUFFER}, bounded by {@link MAX_DEFAULT_BUFFER_ROWS} rows of the current estimate. */
  const defaultBuffer = (): number =>
    Math.min(DEFAULT_BUFFER, MAX_DEFAULT_BUFFER_ROWS * cache.estimate)

  const writePaintOffset = (): void => {
    const next = carry + pendingShift
    if (next === paintOffset) return
    paintOffset = next
    // Here rather than inside `surface.setPaintOffset`, because the surface is handed only
    // the sum and the diagnosis needs to know which addend moved: a sub-pixel carry landing
    // and a whole correction being banked write the same CSS property, and they mean opposite
    // things about whether the view is being held or has slipped.
    //
    // Only on a real change — the early return above already dedupes — so a bad gesture emits
    // roughly one per deferral rather than one per publish. Together with `scroll.sample` this
    // is a continuous record of where the reader's content actually is, since the visible
    // position is `scrollTop + px`, which is `contentOffset()`. That pair is what turns "the
    // content jumped" from a description into a number.
    if (DEBUG) trace('paint.offset', () => ({ px: next, carry, shift: pendingShift }))
    surface.setPaintOffset(next)
  }

  /** Record the carry and draw it — for the scroller, which runs outside a publish. */
  const applyCarry = (next: number): void => {
    carry = next
    writePaintOffset()
  }

  const notifyVisibility = (events: VisibilityEvent[]): void => {
    if (events.length === 0) return
    for (const event of events) {
      const listeners = visibilityListeners.get(event.key)
      if (listeners) for (const listener of listeners) listener()
    }
    options.onVisibilityChange?.(events)
  }

  /** The previous tuple when it still describes the range, so identity survives. */
  const sameRange = (
    previous: readonly [number, number],
    from: number,
    to: number,
  ): readonly [number, number] =>
    previous[0] === from && previous[1] === to ? previous : [from, to]

  /** The held range as live indices, or `null` if it no longer names two loaded rows. */
  const heldRange = (): [number, number] | null => {
    if (heldStartKey === undefined || heldEndKey === undefined) return null
    const from = cache.indexOf(heldStartKey)
    const to = cache.indexOf(heldEndKey)
    return from >= 0 && to >= from ? [from, to] : null
  }

  /**
   * The rows genuinely on screen. **Side-effect free, which is the point of it existing.**
   *
   * `computeRanges` moves the held ends, and holding is only sound if whatever moved them also
   * renders the result: the store's `items` and `renderedRange` have to describe the same set.
   * The visibility deadline timer needs a visible range and nothing else, and it fires *outside*
   * a publish — so calling the full thing there let it move the hold with nothing rendering it.
   * The next publish then found the hold covering, returned the same tuple, and `needsRerender`
   * reported no change, leaving the DOM holding rows the range no longer named. Far enough into
   * a scroll that was enough to leave the scrollport with no mounted row over it at all.
   *
   * Caught by `follow.spec.ts` in CI and not locally, because it needs a main thread slow
   * enough for the timer to land between publishes.
   *
   * It **returns** rather than assigning, which is the same rule one field further on:
   * `lastVisible` is publish-identity state too — the React adapter dedupes
   * `onVisibleRangeChange` on its identity — so letting the timer move it would fire a range
   * change for a range that never published. `computeRanges` commits both.
   */
  const computeVisible = (contentAt: number): readonly [number, number] => {
    if (cache.length === 0) return EMPTY_RANGE
    const visible = listGeometry.visibleBand(contentAt)
    return sameRange(
      lastVisible,
      cache.indexAt(visible.start),
      cache.indexAt(Math.max(visible.start, visible.end)),
    )
  }

  const computeRanges = (
    contentAt: number,
  ): { rendered: readonly [number, number]; visible: readonly [number, number] } => {
    // Through the shared constant, not a fresh `[0, -1]`: an empty list must keep publishing the
    // same reference, or emptying and staying empty reads as a change.
    if (cache.length === 0) {
      lastRendered = EMPTY_RANGE
      lastVisible = EMPTY_RANGE
      heldStartKey = undefined
      heldEndKey = undefined
      return { rendered: lastRendered, visible: lastVisible }
    }

    // Already pointed at this pass's insets and scrollport height; see {@link syncGeometry}.
    const g = listGeometry
    const buffer = options.buffer ?? defaultBuffer()
    const buffered = g.bufferedBand(contentAt, buffer)

    // The pinned scroll target is deliberately *not* unioned in here. Widening the
    // contiguous span to reach a distant target mounts every item in between: a smooth
    // scroll from comment 0 to comment 7,777 mounted 7,798 rows in a single frame,
    // which took 103 seconds and never scrolled at all. It is mounted as an extra
    // segment by `itemsFor` instead.
    // Held while it still covers what the buffer asks for. This pass is not cheaper for holding
    // — it trades two `indexAt` walks for two `indexOf` lookups — the saving is downstream, in
    // the React render `renderedRange` no longer provokes. See {@link RANGE_SLACK_RATIO}.
    //
    // `needFrom`/`needTo` are the rows the buffer demands right now: the coverage guarantee,
    // unchanged from when this was the mounted range itself.
    const slack = buffer * RANGE_SLACK_RATIO
    let held = heldRange()
    const needFrom = held === null ? 0 : cache.indexAt(buffered.start)
    const needTo = held === null ? 0 : cache.indexAt(buffered.end)

    // A hold that covers the band but reaches {@link MAX_HOLD_DRIFT_SLACKS} slacks past it was
    // computed against a list this is no longer — the shape a list momentarily shorter than its own
    // band produces. Released the way an unresolvable key already is: as nothing held, which
    // recomputes below and grants the slack on both edges, both of which a fresh hold wants.
    //
    // Guarded on coverage rather than folded into the test below, for two reasons: an edge that has
    // already run out is going to recompute anyway and would take slack on one side only, and this
    // is what keeps the extra work off the frames the hold exists to make cheap.
    if (held !== null && held[0] <= needFrom && held[1] >= needTo) {
      const drift = g.bufferedBand(contentAt, buffer + MAX_HOLD_DRIFT_SLACKS * slack)
      if (held[0] < cache.indexAt(drift.start) || held[1] > cache.indexAt(drift.end)) {
        held = null
      }
    }

    if (held === null || held[0] > needFrom || held[1] < needTo) {
      // **The slack goes on the edge that ran out, not on both.** Which edge that is says which
      // way the reader is going without the engine tracking a direction: coverage fails ahead of
      // them, never behind. Growing both would carry the same slack behind the reader, where it
      // buys nothing and costs rows on every publish for as long as they keep going — and it
      // would make each recompute mount two bursts of first-measurements instead of one, which is
      // the shape that makes a growing model lumpy near the end of a list.
      //
      // `bufferedBand` has taken `before` and `after` separately since #65 and had no caller that
      // used them; this is the caller it was shaped for.
      const mounted = g.bufferedBand(
        contentAt,
        buffer + (held === null || held[0] > needFrom ? slack : 0),
        buffer + (held === null || held[1] < needTo ? slack : 0),
      )
      held = [cache.indexAt(mounted.start), cache.indexAt(mounted.end)]
      heldStartKey = cache.keyAt(held[0])
      heldEndKey = cache.keyAt(held[1])
    }
    lastRendered = sameRange(lastRendered, held[0], held[1])

    lastVisible = computeVisible(contentAt)
    return { rendered: lastRendered, visible: lastVisible }
  }

  const itemsFor = (range: readonly [number, number]): VirtualItem[] => {
    const items: VirtualItem[] = []
    for (let index = range[0]; index <= range[1]; index++) pushItem(items, cache, index)

    // The overwhelmingly common frame has nothing pinned, and it should allocate nothing
    // extra and sort nothing: the loop above already produced ascending order.
    const keepMounted = options.keepMounted
    if ((keepMounted === undefined || keepMounted.length === 0) && pinnedRange === null) {
      return items
    }

    // Everything pinned outside the range is mounted as its own segment rather than by
    // stretching the range to reach it:
    //
    //  - `keepMounted`, normally whatever holds focus, so tabbing out of a recycled row
    //    does not drop focus to the body;
    //  - the destination of a programmatic scroll, which has to exist to be measured
    //    and aimed at while the viewport is still far away from it.
    const pinned = new Set<number>()
    const pinIfOutside = (index: number): void => {
      // `indexOf` reports -1 for a key that is not loaded, which is "outside the range" in
      // the arithmetic sense and nothing at all in the useful sense.
      if (index < 0) return
      if (index < range[0] || index > range[1]) pinned.add(index)
    }
    for (const key of keepMounted ?? []) pinIfOutside(cache.indexOf(key))
    if (pinnedRange) {
      for (let index = pinnedRange[0]; index <= pinnedRange[1]; index++) pinIfOutside(index)
    }

    // A pin *inside* the range is already mounted. `keepMounted` holds the focused row,
    // which is normally on screen, so this is the usual case whenever a keyboard user is
    // reading — and it should cost neither the extra items nor the sort.
    if (pinned.size === 0) return items

    for (const index of pinned) pushItem(items, cache, index)
    return items.sort((a, b) => a.index - b.index)
  }

  /**
   * The momentum gate this module and the scroller both consult.
   *
   * Built here rather than left to the scroller because this module writes scroll
   * offsets too, and for a long time did so without consulting the guard at all. On
   * iOS that cancelled the fling on the first measurement to land after the finger
   * lifted, which is every fling in a list whose rows are not pre-measured.
   */
  const writeGate = createScrollWriteGate({ viewport })

  /**
   * Where the content actually sits, in the coordinate space item offsets live in.
   *
   * `scrollTop` alone stops being the answer the moment either compensation is
   * outstanding: the content has been moved without it. Every read that compares
   * against an item offset goes through here — the anchor, the rendered range, the
   * visibility band — or it describes a position the view is not at, and each momentum
   * event then makes it worse rather than holding it still.
   *
   * Which reads deliberately stay in scroll space is said once, in `publish`, where both
   * offsets are taken. Deliberately not repeated here: two copies of that list is how the
   * visibility band came to be *described* as reading content space while it did not.
   */
  const contentOffset = (from = viewport.getScrollOffset()): number =>
    from + carry + pendingShift

  /**
   * Whether a publish skipped a scroll write because the gate was shut.
   *
   * Distinct from {@link pendingShift}: that holds the view *now*, this remembers that
   * the model should be re-examined once writing is allowed again. The re-publish is
   * what turns the paint offset back into a real scroll offset.
   */
  let writeDeferred = false

  /**
   * The engine's only door to `viewport.setScrollOffset`.
   *
   * A funnel rather than a check at each site, because the invariant that matters is
   * not "ask the gate" but "**no bookkeeping unless the write happened**". Marking a
   * self-write that never occurred puts a phantom entry in the scroller's intent queue,
   * and `isSelfWrite`'s 1.5px tolerance then swallows a genuine user scroll that lands
   * near it; a `restoreIntent` pushed for the same non-write is consumed by the next
   * momentum scroll event, which then skips `deriveAnchor` for a scroll that really was
   * the reader's. Returning a boolean makes both hazards structural — a caller that
   * does its bookkeeping outside the `if` cannot compile into something plausible.
   *
   * `maxOffset` is passed rather than read, so the room the shift is bounded by shares
   * the one measurement `publish` already takes.
   *
   * @returns whether the platform took the write.
   */
  const writeScroll = (
    offset: number,
    restore: Restore,
    maxOffset: number,
    from = contentOffset(),
  ): boolean => {
    // Read once, and taken from the caller where it has one, for two reasons that used to be one
    // bug each.
    //
    // `from` was computed twice — once here for `delta`, once inside the trace thunk — and
    // `room` read `getScrollOffset()` twice more, also inside the thunk. Every one of those
    // is an uncached `element.scrollTop`, and the thunk runs after `publish` has written
    // styles, so each was a *forced synchronous layout* on the hottest path in this file.
    // Three per traced write, on a gesture measured at 43 deferrals: 129 layouts that
    // existed only because someone was watching. The instrument was perturbing the thing it
    // was built to measure, which is the one thing a diagnostic may never do.
    //
    // Against the *content* offset, not the raw scroll offset: with a shift outstanding the
    // two differ by exactly the correction already applied to the content, so comparing
    // against `scrollTop` would re-apply it every publish. `maxOffset` is passed for the same
    // reason and `from` now joins it: the restore branch computes its target from this very
    // number, and two reads a few microseconds apart is two chances to disagree.
    const delta = offset - from

    // Nothing to do. Kept here so the callers do not each re-derive the threshold;
    // it exists to absorb the disagreement between an integer `clientHeight` and the
    // exact float offset it is compared against.
    //
    // Note for anyone reading a trace: this returns *before* the event below, so the absence
    // of a `scroll.write` does not mean the absence of a publish.
    if (Math.abs(delta) <= 0.01) return false

    // A model change writes through a shut gate; a measurement waits. See the
    // `Restore` doc for why the two are not interchangeable — in short, a deferred
    // prepend teleports the reader and a deferred measurement does not.
    //
    // `canWrite` is hoisted rather than asked twice because `reason` below has to key on the
    // *gate*, not on `deferred`. Keying it on `deferred` compiled but could not express the
    // case it most needed to: `deferred` is already false whenever `restore === 'model'`, so a
    // prepend deliberately overriding a shut gate reported `gate-open` — indistinguishable
    // from an ordinary write on an idle platform. The type checker caught it as an impossible
    // comparison, which is the second time in this function that the outcome and the intent
    // were being conflated.
    const canWrite = writeGate.canWrite()
    const deferred = restore !== 'model' && !canWrite
    const held = pendingShift + delta
    // Hold the view by moving the content the distance `scrollTop` was going to move.
    // The gesture never sees a scroll write, so nothing cancels it, and the reader sees
    // the correction they would have seen anyway.
    //
    // Bounded by the scroll range on either side of where we are, because that is what
    // the displacement actually costs. While a shift is outstanding the content shown at
    // `scrollTop` is the content belonging at `scrollTop + shift`, so the last `shift`
    // pixels in that direction are unreachable — the reader hits a wall short of the end
    // — and the fold needs that much room to land. Both limits are the distance to the
    // nearer end, so one expression covers them.
    //
    // Deliberately *not* a viewport multiple, which is what this was first written as and
    // is unrelated to the thing being protected: two viewports is roughly 1300px, a fling
    // through mis-estimated text accumulates that in a handful of rows, and the cap then
    // fired mid-fling and took the write — cancelling exactly the momentum the gate
    // exists to preserve. Measured on a device: 43 deferrals in one gesture. Deep in a
    // list this bound is effectively unlimited, which is where flings happen and where
    // the displacement is harmless; near either end it tightens to nothing, which is
    // where it matters.
    //
    // Not the magnitude heuristic this file refuses elsewhere: both branches correct, and
    // this only chooses which mechanism carries it — the same shape as `MAX_CARRY`, on the
    // same CSS property, with the same "refusing is the safe failure" logic.
    const scrollNow = viewport.getScrollOffset()
    const room = Math.max(0, Math.min(scrollNow, maxOffset - scrollNow))
    const bank = deferred && Math.abs(held) <= room

    // Emitted *after* the decision, which is the other half of the fix.
    //
    // `deferred` alone was computed before the `room` test and reported as though it were the
    // outcome — so the one case that matters most, a write escaping because the bound fired
    // mid-fling, was recorded as `deferred: true` and printed by the demo's on-device HUD as
    // `DEFER`. The HUD's own comment said that case was "worth naming rather than leaving to
    // be inferred", and then named it as its opposite. `took` is now the field to key on and
    // `reason` says which of the four exits was taken; `deferred` is kept, meaning what it
    // always meant — what the engine *wanted* — and nothing more.
    //
    // `max` costs nothing: it is `maxOffset`, already a parameter, already read once by
    // `publish`. It earns its place by making `room ≈ 0` legible. Deep in a list the bound is
    // effectively unlimited; at either end it tightens to nothing, and `from` outside
    // `[0, max]` is a rubber-band overscroll — a case this function does not test for at all,
    // though `scroller.canWriteScroll` does.
    if (DEBUG) {
      trace('scroll.write', () => ({
        restore,
        reason: bank
          ? 'held'
          : canWrite
            ? 'gate-open'
            : restore === 'model'
              ? 'model'
              : 'no-room',
        took: !bank,
        offset,
        from,
        delta,
        deferred,
        pendingShift,
        heldAfter: bank ? held : 0,
        room,
        max: maxOffset,
      }))
    }

    if (bank) {
      // Only here. Set on a path that went on to write, the flag would ask for a
      // re-publish that has nothing left to do.
      writeDeferred = true
      pendingShift = held
      // Deliberately not written yet: `publish` flushes the paint offset in its single
      // ordered pass, after the last read. A style write here would force a second
      // synchronous layout on the hottest path in the file — every row measured during
      // a fling.
      return false
    }

    commitScroll(offset)
    return true
  }

  /**
   * Write a scroll offset and settle everything that has to move with it.
   *
   * Extracted so the two writers cannot disagree, which they did: the reconcile kept the
   * remainder a clamped write could not take while the cap path dropped it, and dropping
   * it is exactly how a reader ends up permanently displaced at the end of a list.
   *
   * Whatever the platform would not take goes to the carry, which is what the carry is
   * for, bounded by `MAX_CARRY` as usual. On WebKit — which truncates a written offset to
   * an integer — that is every fold. The shift itself always clears, which is what makes
   * "nothing held while the gate is open" an invariant rather than an intention: a
   * correction can never exceed the content above it, so the fold's target cannot leave
   * the scrollable range and there is no larger residue to strand.
   */
  const commitScroll = (offset: number): void => {
    // `offset` is **content space**, as {@link contentOffset} returns it. The carry below is
    // replaced rather than accumulated, so a caller handing over a raw `scrollTop` silently
    // drops whatever the carry was holding — which the fold did, and which is the reason this
    // paragraph exists rather than being left to be inferred from the two call sites.
    // Declare it first: the scroll event this produces must not be mistaken for the
    // user grabbing the scrollbar, which would cancel any in-flight programmatic
    // scroll and flip the tracked scroll direction.
    scroller.markSelfWrite(offset)
    // eslint-disable-next-line no-restricted-syntax -- the engine's single gated write
    viewport.setScrollOffset(offset)

    // Cleared *after* the write, so the two never both describe the same correction.
    pendingShift = 0
    // Recorded, not drawn, and that is the whole of this line. Drawing the carry writes
    // `container.style.top`, and this sits between the scroll write above and `publish`'s last
    // two reads of `scrollTop` — so a flush here turns both into a forced synchronous layout.
    // On WebKit it is *every* commit, because it truncates a written offset to an integer and
    // the carry therefore always moves: once per measured row through a fling.
    //
    // Both callers draw it at a better moment. `writeScroll` runs inside `publish`, which
    // flushes once, last, after every read — the banked branch above already honoured that and
    // says so; this branch did not. `reconcileGestureShift` flushes on its very next line,
    // because it needs both halves in one task.
    carry = carryFor(offset, viewport.getScrollOffset())
  }

  /**
   * Measure every attached row the cache no longer knows the size of.
   *
   * Run after an invalidation discarded the cache, because nothing else will ask again. The two
   * paths that measure cannot: `observeItem` reads a rect once per mount and only for a size the
   * cache does not already know, and the `ResizeObserver` fires only when a box *changes*, with
   * a value-level dedup on top. So a row whose height is the same under the new layout is never
   * re-delivered and sits on its estimate for as long as it stays mounted, with every row below
   * it positioned from that estimate. A device-pixel-ratio change is the pure case and the one
   * with no self-healing at all: CSS-px layout is unchanged, so no box moves and no delivery
   * follows the clear for any row. See #111.
   *
   * `isMeasured` rather than measuring the lot: on the batch path the delivery that provoked the
   * invalidation was itself taken under the new layout and is already applied, so those rows are
   * known and re-reading them would be a rect read and a Fenwick update thrown away. After a
   * clear with no batch — the viewport path — nothing is known and every attached row is read.
   *
   * Reads only, no writes, and nothing before it writes styles, so this is one forced reflow for
   * the whole loop at worst rather than one per row. Two of the three entry points are
   * ResizeObserver callbacks, where layout is already clean and even that one is free; the third
   * is `observeResolution`'s `matchMedia` handler — the device-pixel-ratio case, which is the one
   * with no self-healing and therefore the one this exists for.
   * Its rate is the caller's business. The batch path is behind `SIGNATURE_RECHECK_MS`; the
   * viewport path is not, so a horizontal window drag runs this for every delivered frame it
   * changes the width on — bounded by the drag, and the alternative is a list that stays wrong
   * for the length of it.
   */
  const refillMountedSizes = (): void => {
    for (const [key, element] of surface.attachedItems()) {
      const index = cache.indexOf(key)
      if (index >= 0 && !cache.isMeasured(index)) cache.setSize(index, resizer.measure(element))
    }
  }

  /** Bound the queue at its one declared maximum, wherever an intent is recorded. */
  const pushRestoreIntent = (offset: number): void => {
    restoreIntents.push(offset)
    if (restoreIntents.length > MAX_RESTORE_INTENTS) restoreIntents.shift()
  }

  /**
   * Turn the outstanding paint offset back into a real scroll offset.
   *
   * Called when the gate reopens, which is the first moment the platform will take the
   * write. Both halves happen in one task so no frame is painted between them — the
   * content jumps back by the shift as `scrollTop` moves forward by it, and the visible
   * result is that nothing moves at all.
   */
  const reconcileGestureShift = (): void => {
    if (pendingShift === 0) return

    const shift = pendingShift
    const carryBefore = carry
    const from = viewport.getScrollOffset()
    // Where the content already appears, which is `from + shift + carryBefore` — the content is
    // not at `scrollTop` while either compensation is outstanding. Built from the raw offset
    // this aimed a `carryBefore` short: the write landed the content where `scrollTop` said it
    // was rather than where it looked, and `commitScroll` *replaces* the carry with its own
    // residual rather than accumulating it, so nothing held the difference. On a platform that
    // truncates every write — the only one this path runs on — that is a jump of up to a pixel
    // at the end of a fling. Judging on the scroll offset where the content position was meant
    // is the shape of #33.
    //
    // `from` is passed rather than re-read: `contentOffset` would take a second `scrollTop`,
    // which is a forced layout, and the two are the same value inside one task anyway.
    const target = contentOffset(from)
    pushRestoreIntent(target)
    commitScroll(target)
    writePaintOffset()

    // The one place in this file that traces *after* the fact.
    //
    // `getMaxScrollOffset()` is `scrollHeight - clientHeight` — a genuine forced layout — so it
    // happens only when something is actually listening, which is what putting it inside the thunk
    // buys. It is affordable even then because this runs once when the gate reopens, not once per
    // frame and not once per measured row.
    //
    // What it is for. This function's own doc above asserts that both halves land in one task
    // so nothing paints between them, and `commitScroll`'s asserts that "a correction can
    // never exceed the content above it, so the fold's target cannot leave the scrollable
    // range". The second claim has a gap: `room` was evaluated per-deferral against the
    // offset *at that moment*, and the fling has been moving the scroller ever since, so by
    // the time the fold lands `from + shift` may sit past `max`. The browser then clamps,
    // `carryFor` discards anything over `MAX_CARRY` as too large to carry, and the reader is
    // left displaced — which is a visible jump at exactly the moment a fling ends. Precisely
    // because the invariant is asserted, nothing would report it being broken.
    //
    // `clamped` is that test. The continuity of `from + shift + carryBefore` against
    // `applied + carryAfter` is the one-number version of "was the fold visible", and it is
    // what the e2e suite asserts rather than trusts.
    // The reads are *inside* the thunk, which is what keeps them off the path of a build that has
    // instrumentation but no listener attached — `trace` returns before calling the thunk, and
    // calls it synchronously when it does, so the values are the same either way.
    //
    // That makes one guard sufficient here. `scroller.ts`'s `traceStep` is the one site that still
    // needs both, and for a reason this site does not share: an inline thunk inside its per-frame
    // loop would allocate a closure context every frame even with nothing listening.
    if (DEBUG) {
      trace('gesture.fold', () => {
        const applied = viewport.getScrollOffset()
        return {
          shift,
          from,
          target,
          applied,
          max: viewport.getMaxScrollOffset(),
          clamped: Math.abs(applied - target) > SELF_WRITE_TOLERANCE,
          carryBefore,
          carryAfter: carry,
        }
      })
    }
  }

  /**
   * Recompute everything from the anchor and publish a new snapshot.
   *
   * `restore` is the crux: when the layout changed underneath — a prepend, an
   * append, a measurement landing — the scroll offset is re-derived from the anchor
   * rather than patched with a delta. That is what makes the correction invisible,
   * and it is why there is no compensation heuristic anywhere in this file.
   *
   * @param priorAnchorOffset Where {@link anchor} resolved *before* whatever change is being
   * published. `null` means nobody could say — the default, and what every caller but
   * `setOptions` passes today. See the restore branch for what it buys.
   */
  const publish = (restore: Restore, priorAnchorOffset: number | null = null): void => {
    if (disposed) return
    const restoreScroll = restore !== 'none'

    // **First, and before any write.** The scrollport's own box does not depend on the content
    // size about to be written, so nothing requires this to come after — and coming *before*
    // means it reads layout the browser already flushed for the last paint rather than forcing
    // a fresh one. Why the whole pass shares one read is at {@link syncGeometry}; the other
    // consumers are `syncSlack` below and the published snapshot.
    const viewportSize = viewport.getViewportSize()

    // Grow (or shrink) the content *first*. A restored offset after a prepend is
    // larger than the old maximum, and the browser silently clamps a write that
    // exceeds it.
    const totalSize = cache.totalSize()
    // Before the content size and before any offset is derived: the leading spacer moves
    // the list's origin, so an anchor resolved against a stale one is wrong by
    // exactly the amount the spacer just changed by.
    const trailingSpace = syncSlack(totalSize, viewportSize)
    // After the spacer, whose height `geometry()` folds in, and before anything reads a band.
    syncGeometry(viewportSize)
    surface.setLeadingSpace(leadingSpace)
    surface.setTrailingSpace(trailingSpace)
    surface.setContentSize(totalSize)

    // Read once, after the content size is written and before anything reads an
    // offset. `scrollHeight - clientHeight` is a layout read, and both the follow
    // target below and the at-bottom predicate further down want the same answer
    // from the same moment. Nothing between here and there changes it: the only
    // writes are `scrollTop` and the sub-pixel carry, neither of which alters the
    // scroller's extent by more than the threshold exists to absorb.
    //
    // This one genuinely has to stay on this side of the write, unlike the height above:
    // the extent is exactly what `setContentSize` just changed.
    const maxOffset = viewport.getMaxScrollOffset()

    // The anchor keeps the *user's* position stable. While a programmatic scroll
    // is in flight the scroller is authoritative instead — restoring an anchor
    // captured before it started would drag the view back and stall convergence.
    // No `scrollOffset` here, deliberately, and it used to be. Reading it inside the thunk is a
    // forced layout — this runs after the content size has been written — once per publish, which
    // during a fling is once per measured row. `scroll.sample` now reports the offset on every
    // scroll event at higher fidelity than this could, so the field was costing a layout to
    // duplicate information the reader already has.
    if (DEBUG && restoreScroll) {
      trace('anchor.restore', () => ({
        anchor,
        skipped: anchor === null ? 'no-anchor' : scroller.isScrolling() ? 'scrolling' : null,
        totalSize,
      }))
    }

    // Following the output is a *mode*, not an anchor value, and the distinction is
    // the whole reason this is a branch rather than a clever `setAnchor` call.
    //
    // Pinning by anchor looks like it should work: name the last key, give it an
    // offset past its own end, let the restore below do the scrolling. It does not
    // survive contact with the platform. The resolved offset exceeds the reachable
    // maximum, the browser clamps the write, `carryFor` discards the excess as too
    // large to carry, and the clamped read-back then fails `isSelfWrite`'s 1.5px
    // tolerance — so the scroll listener re-derives the anchor from wherever it
    // actually landed. The pin is destroyed on every publish while content grows,
    // which is precisely when following matters.
    //
    // So the bottom is asked of the browser, the same way `align: 'end'` asks for
    // the last item, and for the same reason: at the very end our own arithmetic is
    // not what the scroller will accept. Note this goes to the *true* bottom rather
    // than stopping short of `spaceAfter` — a reader pinned to a live thread wants
    // the typing indicator in the footer on screen, which is the opposite of what
    // `scrollToKey(last, { align: 'end' })` wants.
    if (following && !scroller.isScrolling()) {
      // The branch matters despite `following` being cleared on the scroll event
      // below — the two windows it survives are the first frames of a fling launched
      // from the bottom, which is momentum onset and the worst possible moment to
      // cancel one, and the re-pin that fires in the gaps of a decaying fling.
      //
      // `markSelfWrite` but deliberately *not* `restoreIntents`, and the two queues
      // mean different things. The scroller's says "this offset is mine, do not read
      // it as the user grabbing the scrollbar". The engine's says "do not re-derive
      // the anchor from this", which is right for a correction whose read-back may be
      // pixel-snapped and wrong for a move.
      //
      // Following is a move. Suppressing the re-derivation leaves the anchor
      // describing wherever the reader was before they were pinned, so the moment
      // following stops — the option flipping off, the reader scrolling back — the
      // next publish restores that stale position and the view jumps backwards.
      if (writeScroll(maxOffset, restore, maxOffset)) {
        // Recorded rather than drawn, like every carry move inside this pass; `publish`
        // flushes last. It also keeps the `contentOffset()` two lines below off the far side
        // of a style write.
        carry = 0
        // Synchronously, rather than waiting for the scroll event: a publish later in
        // the same tick would otherwise resolve the old anchor and fight this write.
        // The event still arrives and derives the same value again.
        anchor = deriveAnchor(contentOffset(), cache, geometry())
      }
    } else if (restoreScroll && anchor && !scroller.isScrolling()) {
      const restored = resolveAnchorOffset(anchor, cache, geometry())

      /**
       * What to write: where the anchor *moved to*, not where the anchor *is*.
       *
       * The two differ during momentum, and the difference cancelled flings — issue #54, found on
       * a device. `anchor` is re-derived on each scroll event, so `restored` answers "where the
       * content was when the last one arrived", while `writeScroll` compares it against
       * `contentOffset()` read now. A fling moves between those two moments, so
       *
       *     delta = (what the model change displaced) − (travel since the last scroll event)
       *
       * and for a change that displaced nothing — 500 items appended *below* the reader — the
       * whole of that is the second term. Measured on an iPhone: `delta: -7`, written because
       * `'model'` overrides the write gate, nudging the reader backwards to a stale offset and
       * killing a fling with a second of travel still in it.
       *
       * So the displacement is taken where it is actually knowable — as the difference between the
       * anchor's offset before and after the change — and applied to wherever the content has since
       * got to. Both terms are content-space, so an outstanding carry or paint offset cancels out
       * of the subtraction rather than having to be reasoned about.
       *
       * Bit-identical to the old form whenever the content is still: a stationary anchor is in
       * sync, so `contentOffset() === priorAnchorOffset` and `target === restored`. The two diverge
       * only while the content is moving under the write, which is the case being fixed. And a
       * displacement of zero then lands inside `writeScroll`'s existing no-op threshold, so
       * "changed nothing, wrote nothing" falls out rather than needing its own branch.
       *
       * `null` from every caller but `setOptions` today — the measurement paths clear and rebuild
       * the cache, where the anchor's offset genuinely has moved and the full restore is right.
       * That is a statement about the current call graph, not a design constraint: the `'measure'`
       * path has the same lag defect and the same shape would fix it.
       */
      const restoreFrom = contentOffset()
      const target =
        priorAnchorOffset === null || restored === null
          ? restored
          : restoreFrom + (restored - priorAnchorOffset)

      // A null restore means the anchored key left the window. For a grows-only
      // window that cannot happen; if it does, holding position beats jumping.
      if (target !== null && writeScroll(target, restore, maxOffset, restoreFrom)) {
        // Not `markSelfWrite`'s queue but the engine's own: do not re-derive the
        // anchor from this write's read-back, which may have been snapped to a whole
        // pixel. Absorbing that into `offsetWithinItem` re-introduces the residual
        // the carry just removed.
        // `target`, not `restored`: the queue exists to recognise this write's own read-back,
        // so it has to hold the number that was written.
        pushRestoreIntent(target)
      }
    }

    // Two offsets, deliberately, and every read below belongs to exactly one of them.
    //
    // `contentAt` — the anchor, the rendered range and the visibility band. All three
    // compare against item offsets, so all three want where the content *is*. Computing
    // the range from the raw offset while a shift is outstanding centres the mounted
    // window up to the remaining scroll range away from the screen, which paints blank;
    // computing the *band* from it hands `tracker.sample` a strip of list coordinates
    // the reader is not looking at, so every visibility event fired during the hold
    // names rows that never appeared. The band was the one missed when the space was
    // split, and it is the one nothing gives away: the render stays correct, only the
    // reporting is wrong.
    //
    // `scrollOffset` — the offset published to consumers, `atBottom` and `notifyEdges`.
    // All three are about the scrollbar, and the scrollbar is the one thing the shift is
    // deliberately hiding from: it is precisely the part of the view that has *not*
    // moved with the content.
    const contentAt = contentOffset()
    const scrollOffset = viewport.getScrollOffset()
    const ranges = computeRanges(contentAt)
    const items = itemsFor(ranges.rendered)
    const previous = store.getState()
    const atBottom = atBottomWithin(maxOffset, scrollOffset)

    store.setState({
      version: previous.version + 1,
      items,
      renderedRange: ranges.rendered,
      visibleRange: ranges.visible,
      totalSize,
      scrollOffset,
      viewportSize,
      scrolling: scroller.isScrolling(),
      atBottom,
    })

    notifyEdges(scrollOffset, maxOffset)

    // Positions are written here rather than by the consumer after commit, so the
    // content size, the scroll offset and the item positions all land in one pass.
    // Items not yet attached are positioned by `observeItem` the moment their element
    // exists, which is before paint.
    for (const item of items) surface.setItemOffset(item.key, item.start)
    // Last, and once: both contributions to the container's offset are known by now,
    // and holding the write until after every read keeps a deferred correction from
    // forcing a second synchronous layout mid-fling.
    writePaintOffset()

    // Keep the ref-callback cache bounded by what is rendered rather than by
    // everything ever scrolled past.
    if (itemRefCallbacks.size > items.length * 4) {
      const live = new Set(items.map((item) => item.key))
      for (const key of itemRefCallbacks.keys()) {
        if (!live.has(key)) itemRefCallbacks.delete(key)
      }
    }

    sampleVisibility(ranges.visible, contentAt)
  }

  let visibilityTimer: ReturnType<typeof setTimeout> | null = null
  /** The deadline the live timer was armed for, so an unchanged one is left alone. */
  let armedFor: number | null = null

  /**
   * Schedule the one sample that time alone would otherwise never produce.
   *
   * Every other sample is driven by an event — a scroll, a measurement, a resize — and
   * all of those stop when the user stops. `dwellMs` and `leaveDelayMs` are deadlines
   * measured from the last such event, so at rest they were simply never reached: with
   * `dwellMs: 600`, scrolling to a comment and stopping reported nothing at all. The
   * tracker knows when its next state change is due; this puts a timer on it and
   * re-samples, which is enough because a sample that changes nothing arms nothing.
   *
   * Called after every sample, so once per frame while scrolling. A dwell deadline is
   * `passingSince + dwellMs`, which holds still while the item keeps passing — so it is
   * usually the deadline already armed, and removing and reinserting the same timer sixty
   * times a second is pure waste.
   */
  const armVisibilityTimer = (): void => {
    const stamp = now()
    const due = disposed ? null : tracker.nextDeadline(stamp)
    if (due !== null && due === armedFor && visibilityTimer !== null) return

    if (visibilityTimer !== null) {
      clearTimeout(visibilityTimer)
      visibilityTimer = null
      armedFor = null
    }
    if (due === null) return

    if (DEBUG) trace('visibility.deadline', () => ({ due, in: due - stamp }))
    armedFor = due
    visibilityTimer = setTimeout(
      () => {
        visibilityTimer = null
        armedFor = null
        // Content space, like every other sample: this fires when nothing else is
        // happening, so during a held correction it is usually the *only* sample taken.
        const contentAt = contentOffset()
        // Its own pass, so its own sync; and the *visible* range only, which is the half of
        // `computeRanges` that moves no published state. See {@link computeVisible}.
        syncGeometry(viewport.getViewportSize())
        sampleVisibility(computeVisible(contentAt), contentAt)
      },
      Math.max(0, due - stamp),
    )
  }

  /**
   * Sample, then re-arm — always, whichever way the sampling exited.
   *
   * The arming used to sit at each of the three early returns below, which made "every
   * sample re-arms" an invariant maintained by hand: a fourth early return would silently
   * stop the clock and bring back the dwell that never completes.
   *
   * @param contentAt Content space, from {@link contentOffset}. The band built from it is
   * compared against `cache.offsetOf`, so a raw scroll offset here reports rows the reader
   * never saw for as long as a correction is held.
   */
  const sampleVisibility = (visible: readonly [number, number], contentAt: number): void => {
    sampleVisibilityOnce(visible, contentAt)
    armVisibilityTimer()
  }

  const sampleVisibilityOnce = (
    visible: readonly [number, number],
    contentAt: number,
  ): void => {
    const g = listGeometry

    // A closed gate means nothing is on screen — a collapsed accordion, a background
    // tab, a scroller scrolled off the page.
    if (gate && !gate.isOpen()) {
      notifyVisibility(tracker.flushLeaves(now()))
      return
    }

    // Narrow to the part of the scrollport genuinely on screen, so a half off-screen
    // scroller does not report its hidden half as visible. An *absent* slice means the
    // gate has not reported yet, which is not the same as nothing being visible —
    // conflating the two suppressed every visibility event until the first
    // IntersectionObserver callback, and forever for a gate target that never reports.
    //
    // The conversion from the gate's scrollport-relative band into list coordinates is
    // `ListGeometry`'s job: doing it by hand in a second place is what let the document
    // scroller apply its offset twice.
    const visibleBand = g.visibleBand(contentAt)
    const onScreen = gate?.getVisibleBand() ?? null
    const band =
      onScreen === null ? visibleBand : g.clampToOnScreen(contentAt, visibleBand, onScreen)

    if (band === null) {
      notifyVisibility(tracker.flushLeaves(now()))
      return
    }
    const { start, end } = band

    const candidates: VisibilityCandidate[] = []
    // Sample a little beyond the visible range so an item leaving is seen
    // transitioning rather than vanishing.
    const from = Math.max(0, visible[0] - 1)
    const to = Math.min(cache.length - 1, visible[1] + 1)
    for (let index = from; index <= to; index++) {
      const key = cache.keyAt(index)
      if (key === undefined) continue
      candidates.push({
        index,
        key,
        start: cache.offsetOf(index),
        size: cache.sizeOf(index),
        measured: cache.isMeasured(index),
      })
    }

    notifyVisibility(
      tracker.sample({
        viewportStart: start,
        viewportEnd: end,
        items: candidates,
        now: now(),
        gated: gate?.isOpen() ?? true,
        suppressed: scroller.isScrolling(),
      }),
    )
  }

  /**
   * Re-read the layout signature, and discard every measurement if it moved.
   *
   * `layoutSignatureFor` hashes exactly the things that reflow text — content width, root
   * font size, device pixel ratio — and is already the key a size snapshot is trusted
   * against, so reusing it means one definition of "the layout changed".
   *
   * From the scrollport, not `getElement()`: it is the scrolling box's width that decides how
   * text wraps, and this has to read the same element the adapter seeded the signature from —
   * otherwise the very first observation sees a change and clears every measurement.
   *
   * @returns whether the cache was discarded. Every caller has to act on it, because that
   * moved every offset in the list.
   */
  const recheckLayoutSignature = (): boolean => {
    // Read only by the trace below, so not read at all in a build without it. It cannot move
    // *into* the thunk, because `setLayoutSignature` overwrites it on the next line.
    const previous = DEBUG && signatureKnown ? cache.layoutSignature : null
    const signature = layoutSignatureFor(viewport.getScrollportElement())
    const changed = cache.setLayoutSignature(signature)

    // The first observation merely learns the signature; there is no previous layout for
    // it to differ from, and clearing would throw away measurements taken moments
    // earlier during mount.
    const invalidated = changed && signatureKnown
    // Before the clear, so `cleared` reports what was thrown away rather than zero.
    //
    // The signature strings are the payload's whole value: they name *which* term moved —
    // scrollport width, root font size, device pixel ratio — and that is what separates a
    // phone's URL bar collapsing mid-fling from a webfont landing from a page zoom. All three
    // reach here, all three invalidate every measurement in the list, and only one of them is
    // something the reader did. A `scroll.write` with `reason: 'model'` in the middle of a
    // gesture is otherwise unattributable.
    if (DEBUG) {
      trace('layout.signature', () => ({
        signature,
        previous,
        invalidated,
        cleared: invalidated ? cache.length : 0,
      }))
    }
    if (invalidated) {
      cache.clearAll()
      // The refill is the caller's, not this function's — see `refillMountedSizes`, which has
      // to run after whatever measurements the caller already holds.
      //
      // And drop the hold. Every row is back on its estimate, so every offset the held range
      // was judged against has moved — and unlike a prepend, the keys still resolve, so nothing
      // else here would notice. The containment test would usually catch it on the next pass;
      // "usually" is not the standard the rest of this file holds itself to, and a range held
      // across a discarded cache is a range chosen for a layout that no longer exists.
      heldStartKey = undefined
      heldEndKey = undefined
    }
    signatureKnown = true
    return invalidated
  }

  /** When the signature was last re-read off a measurement, for {@link SIGNATURE_RECHECK_MS}. */
  let signatureCheckedAt = 0

  const resizer: Resizer = createResizer({
    onItemResize(batch) {
      // Before the batch is applied, for two separate reasons.
      //
      // A `ResizeObserver` callback runs *after* layout, so the computed-style read inside
      // `layoutSignatureFor` forces no reflow here — but `publish` below writes styles, and
      // a read after that would. And a signature change clears the cache, so the batch has
      // to land afterwards: these measurements were taken under the *new* layout and are
      // the only correct sizes in the list at this moment.
      //
      // Why here at all: a root font size change re-wraps text without moving the
      // scrollport, so `observeSize` never fires and the width term never changes. What it
      // does do is re-lay-out every mounted row, which is this callback. The signal was
      // always here; nothing was asking.
      //
      // Worth being honest about the shape of this, because it is not a general mechanism:
      // each term of the signature is caught by whatever side effect it happens to have that
      // something already listens for — the width by a scrollport resize, the font size by
      // rows re-laying-out. A term with no layout consequence at all would be caught by
      // neither and would need a subscription of its own. Adding one to `layoutSignatureFor`
      // therefore means asking what would notice it, and the answer may be "nothing yet".
      //
      // Two adjacent paths deliberately not hooked:
      //
      // `observeItem` measures synchronously on attach — for a row whose height it does not
      // already know — and that path never reaches here, so a font size change with nothing
      // mounted is not seen at mount time. It does not need to be: a newly observed element
      // gets a synthetic first delivery, which lands in this batch a tick later, so the gap is
      // one delivery plus at most one rate-limit window and it closes itself. Paying a
      // `getComputedStyle` per row on the mount path — which runs for every row of every
      // scroll — to buy that tick back would be a bad trade. A row that *is* already measured
      // skips the synchronous read entirely and so arrives here on its first delivery, which
      // is the same tick by another route.
      //
      // `onSlotResize` is not hooked either, and runs *before* this in the same callback. A
      // font size change that re-lays-out a slot re-lays-out any mounted row too, so this
      // batch sees it; the case where it would not — no rows mounted at all — has nothing
      // measured to invalidate. What that leaves is one slot publish against a cache this
      // callback is about to clear, and since both publishes happen synchronously before
      // paint, nothing is drawn from the stale one.
      const stamp = now()
      let invalidated = false
      if (stamp - signatureCheckedAt >= SIGNATURE_RECHECK_MS) {
        signatureCheckedAt = stamp
        invalidated = recheckLayoutSignature()
      }

      let changed = false
      for (const [key, size] of batch) {
        const index = cache.indexOf(key)
        if (index < 0) continue
        if (cache.setSize(index, size)) changed = true
      }
      // After the batch, so the rows it just measured under the new layout are not read again,
      // and before the publish below, so nothing is drawn from the estimates the clear left.
      if (invalidated) refillMountedSizes()
      // Two independent reasons to go on: a size in the batch moved, or the cache was
      // discarded a moment ago — in which case every offset below the first item moved and
      // there is a restore to do whether or not this batch's own sizes are news.
      if (!changed && !invalidated) return
      // `scrollOffset` dropped for the same reason as `anchor.restore`'s: a forced layout inside
      // the thunk, to report a number `scroll.sample` already reports on every scroll event.
      if (DEBUG) {
        trace('measure.batch', () => ({
          count: batch.length,
          totalSize: cache.totalSize(),
          invalidated,
        }))
      }

      cache.refreshEstimate(viewport.getViewportSize())
      // Re-derive the scroll offset from the anchor: the item that was under the
      // viewport top stays under the viewport top, whatever moved above it.
      //
      // `'model'` when the signature moved, on the same reasoning as the resize path: a
      // discarded cache moved every offset below the first item, and a correction that large
      // cannot wait for a fling to end without teleporting the reader.
      publish(invalidated ? 'model' : 'measure')
      scroller.notifyModelChanged()

      // The same batch, timed. `measure.batch` above reports the decision's *inputs*; this
      // reports what it cost, and the two are deliberately separate events rather than one
      // emitted late, because a batch that throws or returns early should still have said it
      // arrived.
      //
      // `stamp` was already taken unconditionally for the rate limit, so the only new work is
      // the closing `now()`. What the number covers is everything this callback caused: the
      // signature recheck and any `clearAll`, the Fenwick updates, the estimate refresh, the
      // anchor restore, the publish, the per-item offset writes and the visibility sample.
      // That makes it the single most useful figure for deciding whether a stutter was the
      // main thread rather than the write gate — the difference between the library
      // cancelling a fling and the library simply being too slow to keep up with one.
      if (DEBUG) {
        trace('measure.done', () => ({ count: batch.length, invalidated, ms: now() - stamp }))
      }
    },

    onSlotResize(batch) {
      let changed = false
      for (const [slot, size] of batch) {
        if (setSlotSize(slot, size)) changed = true
      }
      if (changed) onSlotGeometryChange()
    },
  })

  /**
   * A scrollport resize.
   *
   * Driven by `viewport.observeSize`, which is the only thing that knows what to watch
   * for the scroller kind in play.
   */
  function onViewportResize(): void {
    // Only a change that reflows text invalidates measurements — and the *height* of the
    // scrollport reflows nothing. A mobile URL bar hiding, devtools opening, a soft
    // keyboard appearing or a vertical window drag all resize the scrollport without
    // changing a single line box, so discarding the cache for them is pure waste;
    // combined with a restored snapshot it is destructive.
    //
    // Which of the signature's terms moved is not this function's business — it asks the
    // same question a measurement asks, and `recheckLayoutSignature` is the one place that
    // answers it. A resize is simply the trigger that catches the *width* term.
    const invalidated = recheckLayoutSignature()
    // Nothing was delivered here — a scrollport resize is not a row measurement — so every
    // attached row is unknown and every one of them is read.
    if (invalidated) refillMountedSizes()

    // A reflow that discarded every measurement moved every offset in the list, so
    // the restore is not postponable. A height-only resize is — and on iOS that case
    // is the URL bar collapsing mid-fling, which must not cancel it.
    publish(invalidated ? 'model' : 'measure')
    // Discarding every measurement moves every offset below the first item, so an
    // in-flight scroll has to re-aim and drop any `scrollend` it had banked — the same
    // reason a prepend notifies. Only the two paths that *change* the model notify;
    // a height-only resize deliberately changes nothing.
    if (invalidated) scroller.notifyModelChanged()
  }

  const scroller: Scroller = createScroller({
    viewport,
    writeGate,
    getContentOffset: contentOffset,
    getCache: () => cache,
    getGeometry: geometry,
    applyCarry,
    requestRange(startIndex, endIndex) {
      // Declare an interest, then let `publish` do the work. Writing `items` directly
      // was worse than useless: it left `renderedRange` describing a different set, so
      // the very next `publish` — triggered by the scroller's own first write, one tick
      // later — recomputed from scratch and dropped the injection. The destination was
      // never mounted, let alone measured, before the animation began.
      pinnedRange =
        startIndex > endIndex
          ? null
          : [Math.max(0, startIndex - 1), Math.min(cache.length - 1, endIndex + 1)]
      publish('none')
    },
    /**
     * Is any row on screen still waiting to be measured.
     *
     * Answered here because the scroller cannot: an unmeasured row is either one whose
     * `ResizeObserver` delivery is a frame away or one the list will never mount, and only the
     * surface knows which. Every offset the landing is computed from is a sum of row heights, so
     * a landing declared while any of them is still an estimate is a landing against a model
     * that is about to change — which is #67, and why it reported `deviation: 0` while sitting
     * 22px away.
     *
     * Over the rendered range only, which is tens of rows and only while a programmatic scroll
     * is converging. The scroller bounds the wait, so a row that never reports cannot hang it.
     */
    hasPendingMeasurement(destination) {
      const mountedButUnmeasured = (index: number): boolean => {
        if (index < 0 || index >= cache.length || cache.isMeasured(index)) return false
        const key = cache.keyAt(index)
        return key !== undefined && surface.hasItem(key)
      }
      // The destination explicitly, and first. `itemsFor` mounts it as a segment of its own
      // rather than widening the contiguous span to reach it — the comment on `computeRanges`
      // explains why, and the consequence here is that the row whose height decides the landing
      // is the one row `lastRendered` does not name. Scanning only the range left the defect
      // this predicate exists for entirely invisible.
      // The destination is tested on measurement alone, without asking whether it is mounted.
      // The scroller pins it, so it is about to be — and the window it is being aimed into may
      // have been replaced a frame ago, which is exactly when the surface has not yet been told
      // about the row and the cache still holds an estimate for it. Requiring `hasItem` here
      // made the predicate answer "nothing pending" in the one situation it exists for.
      if (destination >= 0 && destination < cache.length && !cache.isMeasured(destination)) {
        return true
      }
      const [from, to] = lastRendered
      for (let index = from; index <= to; index++) {
        if (mountedButUnmeasured(index)) return true
      }
      return false
    },
    onUserInput() {
      // Recorded, not acted on. The scroll event that follows is where the
      // decision happens, because only then is there a position to judge.
      //
      // Only while following, so the flag cannot be set by a list that is not
      // following and then still be latched when one is switched on — which
      // would unpin the reader on the first scroll after enabling it.
      sawUserInput = options.followOutput === true
    },
    /**
     * The scroller landed, so the anchor follows the move it just made.
     *
     * Exactly what the `following` branch of `publish` does after its own write, for exactly
     * the reason given there: the scroll event still arrives and derives the same anchor from
     * the same offset, but a publish before it would resolve the position the view was at
     * *before* this scroll and write it back — undoing a landing already reported as
     * `converged` (#115).
     *
     * No `pushRestoreIntent`, deliberately, and the two queues at the top of this file say why:
     * the engine's queue means "do not re-derive the anchor from this read-back", which is right
     * for a correction whose landing may have been pixel-snapped and wrong for a move. This is a
     * move. Suppressing the re-derivation would leave the anchor describing the pre-scroll
     * position again, which is the bug rather than the fix.
     *
     * Nothing published here: `onScrollingChange(false)` follows immediately and publishes.
     */
    onLanded() {
      anchor = deriveAnchor(contentOffset(), cache, geometry())
    },
    onScrollingChange(scrolling) {
      // The pin exists for the duration of one programmatic scroll; holding it after
      // would keep an arbitrary slice of the list mounted forever.
      if (!scrolling) pinnedRange = null
      publish('none')
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  return {
    store,
    cache,

    setOptions(next) {
      // A snapshot passed after construction used to be accepted and then ignored, so
      // `sizeSnapshot` did nothing whatsoever through the React adapter — which only ever
      // forwards options this way.
      //
      // Applied at most once, which is enough by definition: a snapshot restores what was
      // measured before this list existed, and by the time a second one could arrive the
      // list has its own measurements, which always win. The flag — rather than reference
      // identity — is what stops an inline literal from being re-walked every render, a
      // 12,000-entry snapshot at a time.
      const snapshot = next.sizeSnapshot

      /**
       * Where the anchor sits under the *old* model.
       *
       * Captured here — before the merge below, which is what makes `geometry()` return the new
       * insets, and before every cache mutation — because it is the only moment at which the
       * question "what did this change displace?" can still be answered. `publish` needs it to
       * avoid writing the fling's own lag; see the restore branch there for why that matters.
       *
       * One Fenwick prefix sum, O(log n), per `setOptions` call.
       */
      const priorAnchorOffset = anchor === null ? null : resolveAnchorOffset(anchor, cache, geometry())

      // Captured before the merge: both move every offset below them, so both
      // belong with the prepend case below rather than with the quiet options.
      const geometryChanged =
        next.geometry !== undefined &&
        next.geometry !== options.geometry &&
        !sameInsets(next.geometry, options.geometry ?? NO_INSETS)
      const gapChanged = next.gap !== undefined && next.gap !== options.gap

      // Turning following on re-pins; turning it off lets go. Only on a genuine
      // change, so a consumer passing the same value every render does not keep
      // re-pinning a reader who has scrolled away.
      const followChanged =
        next.followOutput !== undefined && next.followOutput !== options.followOutput

      options = { ...options, ...next }
      if (followChanged) following = options.followOutput === true
      if (next.visibility) tracker.setOptions(next.visibility)

      // Before the restore below, not after: `restore` rebuilds the offset tree itself, so
      // installing the estimator afterwards would rebuild a second time in the same call —
      // the first pass having used an estimate already known to be stale.
      //
      // Both evaluated, never short-circuited. `a || b` here would skip `setDefaultEstimate`
      // on exactly the call that installs the estimator, which is the first one — the only
      // call where the tree is still empty and applying it is free. The default would then
      // land on some later render and pay a full rebuild plus an anchor-restoring publish.
      const estimatorChanged =
        next.estimateSize !== undefined && cache.setEstimateSize(next.estimateSize)
      const defaultChanged =
        next.defaultEstimate !== undefined && cache.setDefaultEstimate(next.defaultEstimate)
      const estimateChanged = estimatorChanged || defaultChanged

      if (snapshot !== undefined && !snapshotRestored) {
        snapshotRestored = true
        if (cache.restore(snapshot) > 0) publish('model')
      }
      if (next.gap !== undefined) cache.setGap(next.gap)
      if (next.layoutSignature !== undefined) cache.setLayoutSignature(next.layoutSignature)

      const keysChanged = next.keys !== undefined && cache.setKeys(next.keys)
      if (DEBUG && keysChanged) {
        trace('model.keys', () => ({ count: cache.length, firstKey: cache.keyAt(0) }))
      }

      // A changed estimate moves every unmeasured item, which is the same class of event as
      // a prepend: both need the anchor re-applied and any in-flight scroll re-aimed.
      //
      // So do a changed `gap` and a changed `geometry`, and until the slots work
      // neither said so: both fell through to `publish('none')`, which re-derives
      // nothing and tells an in-flight scroll nothing. `gap` was latent — a
      // consumer changing spacing mid-scroll is rare. `geometry` stopped being
      // latent the moment a measured header started feeding `scrollMargin`,
      // because that is a geometry change arriving on its own, mid-scroll, for
      // every list that has one.
      const modelChanged = keysChanged || estimateChanged || gapChanged || geometryChanged
      if (modelChanged) {
        // A prepend moves the target of an in-flight scroll as surely as a measurement
        // does, and the newly inserted items are unmeasured, so more movement follows as
        // they measure. Without this the convergence loop could declare the model stable
        // in the gap between the insertion and its measurements, and resolve `converged`
        // with a deviation of zero while the destination was still 331px from where it
        // had been asked to go.
        scroller.notifyModelChanged()
      }
      // A key-set change moves every offset below the insertion point. Deriving
      // the offset from the anchor is the entirety of the prepend handling — and it
      // is why this is `'model'` and not `'measure'`: a prepend that skipped its
      // restore because a fling was in progress would move the reader by the whole
      // inserted height, which is the one thing this library promises cannot happen.
      publish(modelChanged ? 'model' : 'none', priorAnchorOffset)
    },

    mount() {
      // Idempotent: a second mount would add a second scroll listener and overwrite
      // `gate`, orphaning the first behind a teardown closure nobody holds.
      if (unmount) return unmount

      const cleanups: (() => void)[] = []

      // Whatever the fling refused, once it is over. One publish, not one per skipped
      // correction: they all resolve to the same anchor, so replaying them
      // individually would write the same offset repeatedly.
      //
      // **First of the gate's open listeners, and that is the point.** `onOpen` fires
      // them in registration order, so registering here — before `scroller.attach()`
      // below registers its own — is what makes "nothing held while the gate is open"
      // true for *every* later listener rather than only for the code after this one.
      // The scroller's is waiting on this same reopening: it replays a banked delta
      // against `scrollTop` and wakes the convergence loop, both from an offset the
      // shift would otherwise still be standing in for. So a re-order does not lose the
      // correction — it applies it twice, once in the stale delta and once in the fold,
      // and silently, since every deviation is then measured post-fold.
      cleanups.push(
        writeGate.onOpen(() => {
          // Before the re-publish, not after: the publish re-derives the offset from
          // the anchor, and it has to be comparing against a `scrollTop` that already
          // owns the correction rather than one a paint offset is standing in for.
          reconcileGestureShift()
          if (!writeDeferred) return
          writeDeferred = false
          publish('measure')
        }),
      )

      // The scroller binds its input listeners here rather than at construction, so
      // that building an engine has no side effects and a speculatively-constructed one
      // cannot leak them. It also attaches the shared write gate, which is why this
      // comes before the scroll and settle handlers below: the gate's *DOM* listeners
      // must precede them, so that both of those see an already-transitioned gate. The
      // `onOpen` registration above is unaffected by that ordering — it only adds to a
      // set, and nothing can fire it until `gate.attach()` binds those listeners here.
      scroller.attach()

      // The viewport owns knowing what to watch. The engine used to observe
      // `getElement()`, and for a document scroller that is `documentElement`, whose
      // border-box height is the *content* height — so every content growth read as a
      // viewport resize and discarded the whole measurement cache.
      cleanups.push(viewport.observeSize(onViewportResize))

      // The third term of the layout signature, and the one with no layout consequence to
      // piggyback on: a device pixel ratio change need not resize the scrollport or re-lay-out
      // a single row, so neither of the other two triggers can see it. `observeResolution`
      // holds both the mechanism and the measurement that says it is worth having.
      //
      // Straight to `onViewportResize`, because what it does is re-read the signature and
      // publish accordingly, which is the whole of what is wanted here. The name is about its
      // first caller rather than its job.
      cleanups.push(observeResolution(viewport.getWindow(), onViewportResize))

      const gateTarget = viewport.getGateTarget()
      if (gateTarget) {
        gate = createScrollerGate({
          element: gateTarget,
          onChange: () => {
            publish('none')
          },
        })
        cleanups.push(() => {
          gate?.dispose()
          gate = null
        })
      }

      cleanups.push(
        viewport.addEventListener('scroll', () => {
          const offset = viewport.getScrollOffset()

          // First statement in the handler, before `notifyScroll` and before anything
          // publishes, because what this measures is *delivery time*.
          //
          // The gap between consecutive scroll events is the primary evidence for a
          // main-thread stall — the case where momentum keeps running on the compositor
          // while nothing repositions the rows, so the content appears frozen and then
          // jumps when the handler finally catches up. Stamped after `publish` instead, the
          // gap would include this handler's own duration, which folds the stall into the
          // thing being measured.
          //
          // Carries no clock of its own: `TraceEvent.at` is already `performance.now()` at
          // the call. The two addends travel with the offset because the anchor is derived
          // from their sum below, so a diagnostic that reported only the offset would be
          // reporting an input to the answer rather than the answer.
          if (DEBUG) trace('scroll.sample', () => ({ offset, carry, shift: pendingShift }))

          scroller.notifyScroll(offset)

          // The anchor records where the view *is*, so it follows every intentional
          // move — the user's and the scroller's alike. The one exception is our own
          // anchor-restore write, whose read-back may have been snapped to a whole
          // pixel; re-deriving from that would fold the platform's rounding into the
          // anchor and undo the carry.
          const restoreIndex = restoreIntents.findIndex((value) => isSelfWrite(offset, value))
          if (restoreIndex === -1) {
            // From where the content visually *is*: the offset the platform accepted plus the
            // carry compensating for the fraction it refused. `carryFor` is `desired - actual`,
            // so their sum is the position we asked for.
            //
            // Deriving from the raw offset instead folded the platform's rounding into the
            // anchor, and the next restore then reproduced it faithfully — the whole view
            // shifting half a pixel on the first prepend after a landing. Invisible while
            // every inset was a whole number; a sticky header that wraps to 85.5px makes it
            // routine.
            anchor = deriveAnchor(contentOffset(offset), cache, geometry())
          } else {
            restoreIntents.splice(0, restoreIndex + 1)
          }
          if (DEBUG) {
            trace('anchor.derive', () => ({
              offset,
              anchor,
              skipped: restoreIndex === -1 ? null : 'self-write',
            }))
          }

          // Letting go is immediate; taking hold again waits for the scrolling to
          // stop. The asymmetry is the point.
          //
          // Immediate, because the alternative is fighting the reader: following
          // writes the bottom on every publish, so staying pinned for even a few
          // frames while they scroll away drags them back under their own hands.
          //
          // Re-pinning cannot use this event, though, and that was a real bug. The
          // first scroll event after a wheel arrives while the scrolling is still
          // in flight — momentum, an engine that scrolls asynchronously, or just a
          // busy machine — so the position is not yet at the bottom and following
          // stayed off for good, because the settle that followed carried no input
          // to reconsider it. A reader who scrolled back to the end never got
          // re-pinned. Seen first on WebKit and then on Chromium under load.
          //
          // `sawUserInput` is deliberately *not* cleared here: it is what tells the
          // settle handler below that this scroll was the reader's doing.
          if (sawUserInput && options.followOutput === true && !atBottomNow()) {
            following = false
          }
          if (sawUserInput) armRepin()

          publish('none')
        }),
      )

      /**
       * `scrollend` corroborates the quiet timer; it does not replace it.
       *
       * The same relationship the scroller has with this event, and for a reason
       * measured rather than assumed: `supportsScrollEnd()` only asks whether the
       * property exists, and Firefox has the property while firing nothing at all
       * for a sequence of wheel deltas — zero events across a 700ms wait, in the
       * demo, on the exact gesture this feature is about. Re-pinning on
       * `scrollend` alone therefore never happened there.
       *
       * What it buys where it does fire is latency: the reader is re-pinned as
       * soon as the platform says the scrolling is over, rather than a further
       * quiet window later.
       */
      cleanups.push(onScrollSettled(viewport, repin))

      const onPageHide = (): void => {
        // The only reliable unload hook: report anything visible but not yet
        // counted, so a reader who closes the tab is still credited.
        notifyVisibility(tracker.flushLeaves(now()))
      }
      const doc = viewport.getElement()?.ownerDocument ?? globalThis.document
      const onDocumentVisibility = (): void => {
        if (doc.visibilityState === 'hidden') tracker.pauseDwell(now())
      }
      doc.addEventListener('visibilitychange', onDocumentVisibility)
      globalThis.addEventListener('pagehide', onPageHide)
      cleanups.push(() => {
        doc.removeEventListener('visibilitychange', onDocumentVisibility)
        globalThis.removeEventListener('pagehide', onPageHide)
      })

      // The spacer before the anchor, not after. `alignToBottom` moves the list's
      // origin, and an anchor derived against an origin of zero and then resolved
      // against the real one is wrong by the whole spacer. The trailing space it also
      // computes is dropped; nothing has been drawn yet.
      syncSlack(cache.totalSize(), viewport.getViewportSize())
      anchor = deriveAnchor(contentOffset(), cache, geometry())
      publish('none')

      const teardown = (): void => {
        for (const cleanup of cleanups) cleanup()
        cleanups.length = 0
        // Deliberately *not* disposing the write gate here. It attaches alongside
        // the scroller's own listeners, which likewise outlive a mount cycle — and
        // since `attach()` is once-only, tearing the gate down on unmount would
        // leave a remounted engine writing `scrollTop` through nothing at all. It
        // goes in `dispose()`, with the scroller.
        //
        // The shift *is* cleared: it stands in for a scroll write, and an unmounted
        // engine has no business holding the content away from the scroll offset. The
        // surface is about to be torn down or re-attached either way.
        writeDeferred = false
        pendingShift = 0
        writePaintOffset()
        if (unmount === teardown) unmount = null
      }
      unmount = teardown
      return teardown
    },

    observeItem(element, key) {
      // One attach per row actually mounted. A ref callback recreated on every render
      // would show up here as a detach/attach pair per row per frame, which is the
      // churn the per-key memoised callbacks exist to prevent.
      if (DEBUG) trace('item.attach', () => ({ key }))
      const detachFromSurface = surface.attachItem(key, element as HTMLElement)
      const index = cache.indexOf(key)

      // Position it before anything can paint. A newly mounted item has no offset
      // written yet, and `publish` cannot have positioned it because its element did
      // not exist at the time.
      if (index >= 0) surface.setItemOffset(key, cache.offsetOf(index))

      // Measure synchronously on mount, but **only for a row whose height is not already
      // known**. ResizeObserver's first callback lands after the next rendering update, so
      // waiting for it would paint one frame at the wrong offset.
      //
      // `resizer.measure` is a `getBoundingClientRect`, called here from a ref callback and
      // straight after the offset write above — so it is a forced synchronous layout in the
      // middle of React's commit, one per row rather than one per commit. Paid for every
      // mounting row it was paid on every row scrolled back over and on every row of a list
      // restored from a `sizeSnapshot`, where the answer was already in the cache. And when
      // the rect disagreed with the snapshot by a pixel it cost the whole of `publish` as
      // well — three more layout reads and a re-render — again per row.
      //
      // Skipping it is safe because of `resizer`'s own detach: unobserving deletes the
      // element's `lastSizes` entry, so the synthetic first entry ResizeObserver delivers for
      // a re-observed element is *not* swallowed as a duplicate. A row whose height changed
      // while it was unmounted is still reported, one frame later — which is the same latency
      // any other library accepts for all rows, taken here only where the cache has nothing
      // better.
      //
      // The remaining synchronous path is the hottest one and stays: during a fling it runs
      // for every row scrolling into view for the first time, whose real height differs from
      // its estimate — in variable-height text, very nearly all of them.
      if (index >= 0 && !cache.isMeasured(index)) {
        // No `> 0` test: `setSize` refuses a non-positive or non-finite size itself, and says
        // in its own doc that the guard lives there rather than at each call site. The batch
        // path below already relies on that.
        if (cache.setSize(index, resizer.measure(element))) {
          publish('measure')
          scroller.notifyModelChanged()
        }
      }

      const stopObserving = resizer.observeItem(element, key)
      return () => {
        stopObserving()
        detachFromSurface()
      }
    },

    observeSlot(element, slot) {
      if (DEBUG) trace('slot.attach', () => ({ slot }))

      // Measured synchronously for the same reason an item is: ResizeObserver's
      // first callback lands after the next rendering update, and a slot whose
      // height is still zero at that point means every item below it is
      // positioned against the wrong origin for one painted frame.
      if (setSlotSize(slot, resizer.measure(element))) onSlotGeometryChange()

      const stopObserving = resizer.observeSlot(element, slot)
      return () => {
        stopObserving()
        if (setSlotSize(slot, 0)) onSlotGeometryChange()
      }
    },

    scrollToKey(key, scrollOptions) {
      if (cache.length === 0) {
        return Promise.resolve({
          settled: false,
          deviation: 0,
          clamped: false,
          iterations: 0,
          reason: 'empty' as const,
        })
      }

      const index = cache.indexOf(key)
      if (index < 0) {
        // Distinct from 'empty': the list has items, this key is not among them —
        // almost always a caller that changed the loaded window and scrolled before the
        // change reached the list, which is a completely different fix.
        return Promise.resolve({
          settled: false,
          deviation: 0,
          clamped: false,
          iterations: 0,
          reason: 'unknown-key' as const,
        })
      }
      return scroller.scrollToIndex(index, scrollOptions)
    },

    scrollToIndex(index, scrollOptions) {
      return scroller.scrollToIndex(index, scrollOptions)
    },

    getAnchor: () => anchor,

    setAnchor(next) {
      anchor = next
      // An explicit command from the consumer: honour it whatever the platform is
      // doing. Refusing would silently drop a restore the caller asked for by name.
      publish('model')
    },

    takeSizeSnapshot: () => cache.snapshot(),

    cancelScroll: () => {
      scroller.cancel()
    },

    itemRef(key) {
      const existing = itemRefCallbacks.get(key)
      if (existing) return existing

      const callback = (element: HTMLElement | null): (() => void) | undefined => {
        if (element === null || disposed) return undefined
        return this.observeItem(element, key)
      }
      itemRefCallbacks.set(key, callback)
      return callback
    },

    slotRef(slot) {
      const existing = slotRefCallbacks.get(slot)
      if (existing) return existing

      const callback = (element: HTMLElement | null): (() => void) | undefined => {
        if (element === null || disposed) return undefined
        return this.observeSlot(element, slot)
      }
      slotRefCallbacks.set(slot, callback)
      return callback
    },

    focusItem: (key) => surface.focusItem(key),

    getVisibility: (key) => tracker.get(key),

    subscribeVisibility(key, listener) {
      let listeners = visibilityListeners.get(key)
      if (!listeners) {
        listeners = new Set()
        visibilityListeners.set(key, listeners)
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) visibilityListeners.delete(key)
      }
    },

    /**
     * The key at `index`, whether or not it is mounted.
     *
     * Keyboard navigation needs this: moving focus to the next article means the next
     * item in the *collection*, and stepping through the mounted array instead makes the
     * behaviour depend on what happens to be rendered — a focused row pinned far from
     * the viewport made PageDown jump to wherever the viewport was.
     */
    keyAt(index) {
      return cache.keyAt(index)
    },

    dispose() {
      disposed = true
      // Undo `mount()` too. Leaving its scroll, visibilitychange and pagehide listeners
      // attached kept the cache, store and tracker reachable — a whole engine retained
      // per disposed list for anyone using the core directly. The React adapter only
      // avoided it by accident of effect-cleanup ordering.
      unmount?.()
      if (visibilityTimer !== null) {
        clearTimeout(visibilityTimer)
        visibilityTimer = null
      }
      if (repinTimer !== null) {
        clearTimeout(repinTimer)
        repinTimer = null
      }
      armedFor = null
      itemRefCallbacks.clear()
      surface.dispose()
      scroller.dispose()
      resizer.dispose()
      // After the scroller, which unsubscribes its banked-correction flush from it.
      // Note this is the *write* gate, not the on-screen `gate` below: two different
      // questions that unfortunately want the same word.
      writeGate.dispose()
      gate?.dispose()
      gate = null
      tracker.reset()
      visibilityListeners.clear()
    },
  }
}

/**
 * Append one item's snapshot, if the index is loaded.
 *
 * At module scope rather than a closure inside `itemsFor`: that runs once per publish, so
 * once per frame during a scroll, and a closure there allocates a function object plus a
 * context for the enclosing scope every time — in the one function whose comment promises
 * the common frame allocates nothing.
 */
function pushItem(items: VirtualItem[], cache: SizeCache, index: number): void {
  const key = cache.keyAt(index)
  if (key === undefined) return
  items.push({
    key,
    index,
    start: cache.offsetOf(index),
    size: cache.sizeOf(index),
    measured: cache.isMeasured(index),
  })
}

/** Re-exported for the React adapter's convenience. */
export type { VirtualItem, VirtualState }

/**
 * Build the layout signature a size snapshot is keyed against.
 *
 * A height measured at a different container width, root font size or device
 * pixel ratio is not stale, it is *wrong* — restoring it would place the list
 * confidently in the wrong position. Including these in the key means a
 * responsive change or a browser zoom discards the snapshot instead.
 *
 * The device pixel ratio earns its place by measurement rather than by argument, since CSS
 * pixel layout is *nominally* independent of it. See `observeResolution` in `env.ts`, which
 * carries the numbers and is what notices a change at runtime.
 */
export function layoutSignatureFor(element: HTMLElement | null): string {
  if (!element) return ''
  const view = element.ownerDocument.defaultView
  const width = Math.round(element.clientWidth)
  const rootFontSize = view
    ? view.getComputedStyle(element.ownerDocument.documentElement).fontSize
    : ''
  const dpr = view?.devicePixelRatio ?? 1
  return `w=${String(width)}|f=${rootFontSize}|dpr=${String(dpr)}`
}
