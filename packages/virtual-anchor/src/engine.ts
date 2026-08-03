import {
  carryFor,
  deriveAnchor,
  isSelfWrite,
  resolveAnchorOffset,
} from './anchor.js'
import { composeInsets, ListGeometry, type ListInsets } from './listGeometry.js'
import { createScrollerGate, type ScrollerGate } from './gate.js'
import { createResizer, type Resizer } from './resizer.js'
import { createScrollWriteGate } from './momentum.js'
import { createScroller, type Scroller } from './scroller.js'
import { onScrollSettled } from './settle.js'
import { createNullSurface, type Surface } from './surface.js'
import { TRACING, trace } from './trace.js'
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
  /** Extra px of items mounted beyond the viewport, in each direction. */
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

const DEFAULT_BUFFER = 400
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
 * The honest caveat, since it is not obvious from the names: what the two buckets are
 * really proxying is *whether content above the anchor moved*, and the proxy is not
 * exact. A measured `header` or `stickyHeader` slot moves the list's origin, so it is a
 * `'model'` change wearing a `'measure'` label — see `onSlotGeometryChange`.
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
   * Recompute the space that pushes short content to the bottom.
   *
   * Against the raw scrollport height rather than {@link ListGeometry.visibleSize}:
   * the padding describes chrome *overlapping* the scrollport, which occupies no
   * content, so the content still has the whole box to fill. The sticky slots are
   * the exception and they are already in the sum, because they are in flow.
   *
   */
  const syncLeadingSpace = (totalSize: number): void => {
    const occupied =
      slotSizes.header +
      slotSizes.stickyHeader +
      totalSize +
      slotSizes.footer +
      slotSizes.stickyFooter
    const next =
      options.alignToBottom === true
        ? Math.max(0, viewport.getViewportSize() - occupied)
        : 0

    if (next === leadingSpace) return
    leadingSpace = next
    insetsVersion++
  }

  /**
   * A slot changed height, so the list's origin moved.
   *
   * The same treatment as a measurement landing, and for the same reason: the
   * anchor names an item, `resolveAnchorOffset` re-derives `scrollTop` from it
   * against the new geometry, and the two movements cancel exactly. This is the
   * bug every other library has — a header that loads an image and shoves the
   * view down — not being written here rather than being fixed here.
   */
  const onSlotGeometryChange = (): void => {
    if (TRACING) trace('slot.resize', () => ({ ...slotSizes }))
    // A measurement, not a model change: an animated sticky footer resizing under a
    // fling is exactly the wobble the gate exists to postpone.
    publish('measure')
    scroller.notifyModelChanged()
  }

  const syncGeometry = (): ListGeometry => {
    listGeometry.update(geometry(), viewport.getViewportSize())
    return listGeometry
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

  /** Last applied carry, so an unchanged value is not re-written to the DOM. */
  let carry = 0
  const applyCarry = (next: number): void => {
    if (next === carry) return
    carry = next
    surface.setCarry(next)
  }

  const notifyVisibility = (events: VisibilityEvent[]): void => {
    if (events.length === 0) return
    for (const event of events) {
      const listeners = visibilityListeners.get(event.key)
      if (listeners) for (const listener of listeners) listener()
    }
    options.onVisibilityChange?.(events)
  }

  /** Items to mount: everything within the viewport plus the buffer. */
  /** The previous tuple when it still describes the range, so identity survives. */
  const sameRange = (
    previous: readonly [number, number],
    from: number,
    to: number,
  ): readonly [number, number] =>
    previous[0] === from && previous[1] === to ? previous : [from, to]

  const computeRanges = (
    scrollOffset: number,
  ): { rendered: readonly [number, number]; visible: readonly [number, number] } => {
    // Through the shared constant, not a fresh `[0, -1]`: an empty list must keep publishing the
    // same reference, or emptying and staying empty reads as a change.
    if (cache.length === 0) {
      lastRendered = EMPTY_RANGE
      lastVisible = EMPTY_RANGE
      return { rendered: EMPTY_RANGE, visible: EMPTY_RANGE }
    }

    const g = syncGeometry()
    const visible = g.visibleBand(scrollOffset)
    const buffered = g.bufferedBand(scrollOffset, options.buffer ?? DEFAULT_BUFFER)

    // The pinned scroll target is deliberately *not* unioned in here. Widening the
    // contiguous span to reach a distant target mounts every item in between: a smooth
    // scroll from comment 0 to comment 7,777 mounted 7,798 rows in a single frame,
    // which took 103 seconds and never scrolled at all. It is mounted as an extra
    // segment by `itemsFor` instead.
    lastRendered = sameRange(
      lastRendered,
      cache.indexAt(buffered.start),
      cache.indexAt(buffered.end),
    )
    lastVisible = sameRange(
      lastVisible,
      cache.indexAt(visible.start),
      cache.indexAt(Math.max(visible.start, visible.end)),
    )
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
   * Whether a publish skipped a scroll write because the gate was shut.
   *
   * A flag rather than a banked offset: the restore is a pure function of the anchor,
   * the size cache and the geometry, so recomputing it when the gate reopens beats
   * replaying a number that was only correct for one frame of a moving fling.
   *
   * Note what that means in practice for a real fling: the scroll listener re-derives
   * `anchor` from the actual offset on every momentum event, so by the time the gate
   * reopens the anchor already describes the uncorrected position and the replay finds
   * nothing over the threshold. The correction is *dropped*, which is the right answer
   * for a sub-pixel wobble the reader has already scrolled past. It genuinely replays
   * only where no scroll intervened — a tap, or the hard cap.
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
   * @returns whether the platform took the write.
   */
  const writeScroll = (offset: number, restore: Restore): boolean => {
    // Nothing to do. Kept here so the callers do not each re-derive the threshold;
    // it exists to absorb the disagreement between an integer `clientHeight` and the
    // exact float offset it is compared against.
    if (Math.abs(offset - viewport.getScrollOffset()) <= 0.01) return false

    // A model change writes through a shut gate; a measurement waits. See the
    // `Restore` doc for why the two are not interchangeable — in short, a deferred
    // prepend teleports the reader and a deferred measurement does not.
    const deferred = restore !== 'model' && !writeGate.canWrite()

    // The size of each correction, and whether it was taken. This is the number that
    // says whether deferring one is invisible or a visible lurch: the design assumes
    // sub-pixel, and a list whose estimate is fitted to a different viewport width
    // produces hundreds of pixels per row.
    if (TRACING) {
      trace('scroll.write', () => ({
        restore,
        offset,
        from: viewport.getScrollOffset(),
        delta: offset - viewport.getScrollOffset(),
        deferred,
      }))
    }

    if (deferred) {
      writeDeferred = true
      return false
    }

    // Declare it first: the scroll event this produces must not be mistaken for the
    // user grabbing the scrollbar, which would cancel any in-flight programmatic
    // scroll and flip the tracked scroll direction.
    scroller.markSelfWrite(offset)
    // eslint-disable-next-line no-restricted-syntax -- the engine's single gated write
    viewport.setScrollOffset(offset)
    return true
  }

  /**
   * Recompute everything from the anchor and publish a new snapshot.
   *
   * `restore` is the crux: when the layout changed underneath — a prepend, an
   * append, a measurement landing — the scroll offset is re-derived from the anchor
   * rather than patched with a delta. That is what makes the correction invisible,
   * and it is why there is no compensation heuristic anywhere in this file.
   */
  const publish = (restore: Restore): void => {
    if (disposed) return
    const restoreScroll = restore !== 'none'

    // Grow (or shrink) the content *first*. A restored offset after a prepend is
    // larger than the old maximum, and the browser silently clamps a write that
    // exceeds it.
    const totalSize = cache.totalSize()
    // Before the content size and before any offset is derived: the spacer moves
    // the list's origin, so an anchor resolved against a stale one is wrong by
    // exactly the amount the spacer just changed by.
    syncLeadingSpace(totalSize)
    surface.setLeadingSpace(leadingSpace)
    surface.setContentSize(totalSize)

    // Read once, after the content size is written and before anything reads an
    // offset. `scrollHeight - clientHeight` is a layout read, and both the follow
    // target below and the at-bottom predicate further down want the same answer
    // from the same moment. Nothing between here and there changes it: the only
    // writes are `scrollTop` and the sub-pixel carry, neither of which alters the
    // scroller's extent by more than the threshold exists to absorb.
    const maxOffset = viewport.getMaxScrollOffset()

    // The anchor keeps the *user's* position stable. While a programmatic scroll
    // is in flight the scroller is authoritative instead — restoring an anchor
    // captured before it started would drag the view back and stall convergence.
    if (TRACING && restoreScroll) {
      trace('anchor.restore', () => ({
        anchor,
        skipped: anchor === null ? 'no-anchor' : scroller.isScrolling() ? 'scrolling' : null,
        scrollOffset: viewport.getScrollOffset(),
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
      if (writeScroll(maxOffset, restore)) {
        applyCarry(0)
        // Synchronously, rather than waiting for the scroll event: a publish later in
        // the same tick would otherwise resolve the old anchor and fight this write.
        // The event still arrives and derives the same value again.
        anchor = deriveAnchor(viewport.getScrollOffset(), cache, geometry())
      }
    } else if (restoreScroll && anchor && !scroller.isScrolling()) {
      const restored = resolveAnchorOffset(anchor, cache, geometry())
      // A null restore means the anchored key left the window. For a grows-only
      // window that cannot happen; if it does, holding position beats jumping.
      if (restored !== null && writeScroll(restored, restore)) {
        // Not `markSelfWrite`'s queue but the engine's own: do not re-derive the
        // anchor from this write's read-back, which may have been snapped to a whole
        // pixel. Absorbing that into `offsetWithinItem` re-introduces the residual
        // the carry just removed.
        restoreIntents.push(restored)
        if (restoreIntents.length > MAX_RESTORE_INTENTS) restoreIntents.shift()

        // Recover the fraction the platform refused to take — the same treatment
        // every scroller write gets. This path had been writing raw, which meant the
        // *most frequent* correction (a measurement landing, a prepend) was the one
        // place the carry did not apply. It went unnoticed only because a first-frame
        // `clearAll()` used to force a fresh scroller write straight afterwards; with
        // that gone, a cold-start deep link lands exactly 0.5px short without this.
        applyCarry(carryFor(restored, viewport.getScrollOffset()))
      }
    }

    const scrollOffset = viewport.getScrollOffset()
    const ranges = computeRanges(scrollOffset)
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
      viewportSize: viewport.getViewportSize(),
      scrolling: scroller.isScrolling(),
      atBottom,
    })

    notifyEdges(scrollOffset, maxOffset)

    // Positions are written here rather than by the consumer after commit, so the
    // content size, the scroll offset and the item positions all land in one pass.
    // Items not yet attached are positioned by `observeItem` the moment their element
    // exists, which is before paint.
    for (const item of items) surface.setItemOffset(item.key, item.start)

    // Keep the ref-callback cache bounded by what is rendered rather than by
    // everything ever scrolled past.
    if (itemRefCallbacks.size > items.length * 4) {
      const live = new Set(items.map((item) => item.key))
      for (const key of itemRefCallbacks.keys()) {
        if (!live.has(key)) itemRefCallbacks.delete(key)
      }
    }

    sampleVisibility(ranges.visible, scrollOffset)
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

    if (TRACING) trace('visibility.deadline', () => ({ due, in: due - stamp }))
    armedFor = due
    visibilityTimer = setTimeout(
      () => {
        visibilityTimer = null
        armedFor = null
        const scrollOffset = viewport.getScrollOffset()
        sampleVisibility(computeRanges(scrollOffset).visible, scrollOffset)
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
   */
  const sampleVisibility = (visible: readonly [number, number], scrollOffset: number): void => {
    sampleVisibilityOnce(visible, scrollOffset)
    armVisibilityTimer()
  }

  const sampleVisibilityOnce = (
    visible: readonly [number, number],
    scrollOffset: number,
  ): void => {
    const g = syncGeometry()

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
    const visibleBand = g.visibleBand(scrollOffset)
    const onScreen = gate?.getVisibleBand() ?? null
    const band =
      onScreen === null ? visibleBand : g.clampToOnScreen(scrollOffset, visibleBand, onScreen)

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

  const resizer: Resizer = createResizer({
    onItemResize(batch) {
      let changed = false
      for (const [key, size] of batch) {
        const index = cache.indexOf(key)
        if (index < 0) continue
        if (cache.setSize(index, size)) changed = true
      }
      if (!changed) return
      if (TRACING) {
        trace('measure.batch', () => ({
          count: batch.length,
          totalSize: cache.totalSize(),
          scrollOffset: viewport.getScrollOffset(),
        }))
      }

      cache.refreshEstimate(viewport.getViewportSize())
      // Re-derive the scroll offset from the anchor: the item that was under the
      // viewport top stays under the viewport top, whatever moved above it.
      publish('measure')
      scroller.notifyModelChanged()
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
    // `layoutSignatureFor` already hashes exactly the things that *do* reflow — content
    // width, root font size, device pixel ratio — and is already the key a size snapshot
    // is trusted against. Reusing it means one definition of "the layout changed".
    // From the scrollport, not `getElement()`: it is the scrolling box's width that decides how
    // text wraps, and this has to read the same element the adapter seeded the signature from —
    // otherwise the very first observation sees a change and clears every measurement.
    const signature = layoutSignatureFor(viewport.getScrollportElement())
    const changed = cache.setLayoutSignature(signature)

    // The first observation merely learns the signature; there is no previous layout for
    // it to differ from, and clearing would throw away measurements taken moments
    // earlier during mount.
    const invalidated = changed && signatureKnown
    if (invalidated) cache.clearAll()
    signatureKnown = true

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
    onUserInput() {
      // Recorded, not acted on. The scroll event that follows is where the
      // decision happens, because only then is there a position to judge.
      //
      // Only while following, so the flag cannot be set by a list that is not
      // following and then still be latched when one is switched on — which
      // would unpin the reader on the first scroll after enabling it.
      sawUserInput = options.followOutput === true
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
      if (TRACING && keysChanged) {
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
      publish(modelChanged ? 'model' : 'none')
    },

    mount() {
      // Idempotent: a second mount would add a second scroll listener and overwrite
      // `gate`, orphaning the first behind a teardown closure nobody holds.
      if (unmount) return unmount

      // The scroller binds its input listeners here rather than at construction, so
      // that building an engine has no side effects and a speculatively-constructed one
      // cannot leak them. It also attaches the shared write gate, which is why this
      // comes first: the gate's listeners must precede the scroll and settle handlers
      // below, so that both of those see an already-transitioned gate.
      scroller.attach()

      const cleanups: (() => void)[] = []

      // Whatever the fling refused, once it is over. One publish, not one per skipped
      // correction: they all resolve to the same anchor, so replaying them
      // individually would write the same offset repeatedly.
      cleanups.push(
        writeGate.onOpen(() => {
          if (!writeDeferred) return
          writeDeferred = false
          publish('measure')
        }),
      )

      // The viewport owns knowing what to watch. The engine used to observe
      // `getElement()`, and for a document scroller that is `documentElement`, whose
      // border-box height is the *content* height — so every content growth read as a
      // viewport resize and discarded the whole measurement cache.
      cleanups.push(
        viewport.observeSize(() => {
          onViewportResize()
        }),
      )

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
            anchor = deriveAnchor(offset + carry, cache, geometry())
          } else {
            restoreIntents.splice(0, restoreIndex + 1)
          }
          if (TRACING) {
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
      // against the real one is wrong by the whole spacer.
      syncLeadingSpace(cache.totalSize())
      anchor = deriveAnchor(viewport.getScrollOffset(), cache, geometry())
      publish('none')

      const teardown = (): void => {
        for (const cleanup of cleanups) cleanup()
        cleanups.length = 0
        // Deliberately *not* disposing the write gate here. It attaches alongside
        // the scroller's own listeners, which likewise outlive a mount cycle — and
        // since `attach()` is once-only, tearing the gate down on unmount would
        // leave a remounted engine writing `scrollTop` through nothing at all. It
        // goes in `dispose()`, with the scroller.
        writeDeferred = false
        if (unmount === teardown) unmount = null
      }
      unmount = teardown
      return teardown
    },

    observeItem(element, key) {
      // One attach per row actually mounted. A ref callback recreated on every render
      // would show up here as a detach/attach pair per row per frame, which is the
      // churn the per-key memoised callbacks exist to prevent.
      if (TRACING) trace('item.attach', () => ({ key }))
      const detachFromSurface = surface.attachItem(key, element as HTMLElement)
      const index = cache.indexOf(key)

      // Position it before anything can paint. A newly mounted item has no offset
      // written yet, and `publish` cannot have positioned it because its element did
      // not exist at the time.
      if (index >= 0) surface.setItemOffset(key, cache.offsetOf(index))

      const measured = resizer.measure(element)
      if (index >= 0 && measured > 0 && cache.setSize(index, measured)) {
        // Measure synchronously on mount. ResizeObserver's first callback lands
        // after the next rendering update, so waiting for it would paint one
        // frame at the wrong offset.
        //
        // The hottest of the deferrable paths: during a fling this runs for every
        // row that scrolls into view whose real height differs from its estimate,
        // which in a list of variable-height text is very nearly all of them.
        publish('measure')
        scroller.notifyModelChanged()
      }

      const stopObserving = resizer.observeItem(element, key)
      return () => {
        stopObserving()
        detachFromSurface()
      }
    },

    observeSlot(element, slot) {
      if (TRACING) trace('slot.attach', () => ({ slot }))

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
        return Promise.resolve({ settled: false, deviation: 0, iterations: 0, reason: 'empty' as const })
      }

      const index = cache.indexOf(key)
      if (index < 0) {
        // Distinct from 'empty': the list has items, this key is not among them —
        // almost always a caller that changed the loaded window and scrolled before the
        // change reached the list, which is a completely different fix.
        return Promise.resolve({
          settled: false,
          deviation: 0,
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
