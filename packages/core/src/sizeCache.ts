import type { ItemKey } from './types.js'

/**
 * A restorable set of measured item sizes.
 *
 * Only *measured* sizes are stored, keyed by item key — offsets are derivable
 * and go stale the moment the window shifts, so persisting them would be worse
 * than useless. `layoutSignature` exists because a size is only valid for the
 * layout it was measured in: change the container width, the root font size or
 * the device pixel ratio and every stored height is a lie. Restoring across a
 * signature change is refused rather than silently trusted.
 */
export interface SizeSnapshot {
  readonly version: 1
  readonly layoutSignature: string
  readonly estimate: number
  readonly sizes: ReadonlyArray<readonly [ItemKey, number]>
}

/** An item resolved from an offset, with everything a caller needs about it. */
export interface ResolvedItem {
  readonly index: number
  readonly key: ItemKey
  /** Offset of the item's top edge, in list coordinates. */
  readonly start: number
  readonly size: number
}

export interface SizeCacheOptions {
  /** The loaded window, in display order. */
  keys?: readonly ItemKey[]
  /** Uniform spacing between items, in px. Item margins are not supported — see README. */
  gap?: number
  /**
   * Caller-supplied size estimate. Supplying a good one is the single most
   * effective way to make `scrollToKey` land in one iteration instead of three,
   * because the first target is computed entirely from estimates.
   *
   * When omitted, the cache estimates from the median of what it has measured.
   */
  estimateSize?: (index: number, key: ItemKey) => number
  /** Fallback before anything is measured and with no `estimateSize`. */
  defaultEstimate?: number
  layoutSignature?: string
  snapshot?: SizeSnapshot
}

const DEFAULT_ESTIMATE = 120
/** Floor for a non-positive estimate; see `#estimateFor`. */
const MIN_ESTIMATE = 1

/**
 * Exact item offsets over a window of variably-sized items.
 *
 * Backed by a Fenwick tree (binary indexed tree) so that `offsetOf`, `indexAt`
 * and `setSize` are all O(log n) with **no invalidation step**. That last part
 * is the reason for the choice: this workload is dominated by first-measurements
 * arriving in bursts as the user scrolls into unvisited parts of a thread, and
 * the obvious alternatives all pay for a write by throwing away reads.
 *
 * - A dense prefix-sum array with a dirty watermark (virtua) discards every
 *   offset above the changed index, so a burst of measurements repeatedly
 *   invalidates the sums below it.
 * - Rebuilding the prefix sum from the lowest dirty index (TanStack) is
 *   O(count − min) per measurement: one item resizing at index 5 of 50,000
 *   recomputes 49,995 offsets.
 * - A tree of size *ranges* (react-virtuoso) scales with the number of distinct
 *   size classes, which is ideal for uniform rows and actively bad for prose,
 *   where nearly every height differs and the tree degenerates to one node per
 *   item with much worse constants.
 *
 * Sizes are held as float64 and never rounded per item. Rounding each
 * measurement — as TanStack does — accumulates into visible drift over
 * thousands of items and forces a wider convergence tolerance to compensate.
 *
 * `gap` is folded into the tree by storing each item's *slot* (size + gap), so
 * `offsetOf` needs no separate gap arithmetic and `indexAt` can binary-lift
 * directly over the tree. Only `totalSize` adjusts, by dropping the trailing gap.
 */
export class SizeCache {
  #keys: readonly ItemKey[] = []
  #indexByKey = new Map<ItemKey, number>()
  /** Measured sizes only, by key. Survives every window change. */
  #measured = new Map<ItemKey, number>()

  /** 1-indexed Fenwick tree over per-item slot sizes (size + gap). */
  #tree = new Float64Array(1)
  /** Largest power of two <= length, for binary lifting in `indexAt`. */
  #liftStart = 0

  #gap: number
  #estimate: number
  #estimateSize: SizeCacheOptions['estimateSize']
  #layoutSignature: string

  /** Sum of measured sizes only, used to gate the first auto-estimate. */
  #measuredTotal = 0
  /** `#measured.size` at the last auto-estimate; next runs when it doubles. */
  #lastEstimateAt = 0

  constructor(options: SizeCacheOptions = {}) {
    this.#gap = options.gap ?? 0
    this.#estimate = options.defaultEstimate ?? DEFAULT_ESTIMATE
    this.#estimateSize = options.estimateSize
    this.#layoutSignature = options.layoutSignature ?? ''

    if (options.snapshot) this.restore(options.snapshot)
    this.setKeys(options.keys ?? [])
  }

  get length(): number {
    return this.#keys.length
  }

  get gap(): number {
    return this.#gap
  }

  /** The size currently assumed for items that have not been measured. */
  get estimate(): number {
    return this.#estimate
  }

  get measuredCount(): number {
    return this.#measured.size
  }

  /**
   * Replace the loaded window.
   *
   * Measured sizes are keyed, so a prepend or append preserves every one of
   * them — only the index-ordered projection is rebuilt. That rebuild is O(n),
   * which is the one operation a Fenwick tree dislikes since it is rooted at
   * index 0; at a window of tens of thousands it is well under a millisecond and
   * happens once per page load, not per frame.
   *
   * Identity-checked: passing the same array reference is a no-op, so callers
   * can call this unconditionally on every render.
   *
   * @returns whether anything was rebuilt.
   */
  setKeys(keys: readonly ItemKey[]): boolean {
    if (keys === this.#keys) return false
    this.#keys = keys

    this.#indexByKey = new Map()
    for (let i = 0; i < keys.length; i++) {
      // A duplicate key would make indexOf ambiguous and silently mis-anchor.
      // Failing loudly in development is far kinder than the resulting drift.
      this.#indexByKey.set(keys[i]!, i)
    }
    if (process.env.NODE_ENV !== 'production' && this.#indexByKey.size !== keys.length) {
      throw new Error(
        `[virtual-anchor] getItemKey produced ${String(keys.length - this.#indexByKey.size)} duplicate key(s). ` +
          'Keys must be unique and stable, or anchoring and visibility events will target the wrong items.',
      )
    }

    this.#rebuild()
    return true
  }

  /** Index of `key` in the current window, or -1 if it is not loaded. */
  indexOf(key: ItemKey): number {
    return this.#indexByKey.get(key) ?? -1
  }

  keyAt(index: number): ItemKey | undefined {
    return this.#keys[index]
  }

  isMeasured(index: number): boolean {
    const key = this.#keys[index]
    return key !== undefined && this.#measured.has(key)
  }

  /** Measured size if known, otherwise the current estimate for that index. */
  sizeOf(index: number): number {
    const key = this.#keys[index]
    if (key === undefined) return 0
    return this.#measured.get(key) ?? this.#estimateFor(index, key)
  }

  /**
   * Distance from the top of the list to the top edge of `index`.
   *
   * Accepts `length` as a valid argument, returning the end of the last item
   * plus its trailing gap — the raw prefix sum. Out-of-range values clamp.
   */
  offsetOf(index: number): number {
    return this.#prefix(clamp(index, 0, this.#keys.length))
  }

  /** Total scrollable size of the window: all items plus interior gaps only. */
  totalSize(): number {
    const n = this.#keys.length
    if (n === 0) return 0
    return this.#prefix(n) - this.#gap
  }

  /**
   * The item whose box contains `offset`.
   *
   * Binary-lifts over the Fenwick tree in O(log n) — no linear scan and no
   * "resume from the last computed index" watermark, so seeking backwards after
   * a deep-link jump costs exactly as much as seeking forwards.
   */
  indexAt(offset: number): number {
    const n = this.#keys.length
    if (n === 0) return -1
    if (offset <= 0) return 0

    let pos = 0
    let remaining = offset
    for (let step = this.#liftStart; step > 0; step >>= 1) {
      const next = pos + step
      if (next <= n) {
        const slot = this.#tree[next]!
        if (slot <= remaining) {
          pos = next
          remaining -= slot
        }
      }
    }
    return reconcileIndex(clamp(pos, 0, n - 1), offset, n, (i) => this.#prefix(i))
  }

  /**
   * Resolve an offset to the item containing it, in one traversal.
   *
   * Callers that need more than just the index — the anchor, the visibility
   * engine — would otherwise follow `indexAt` with `keyAt` and `offsetOf` and
   * walk the tree three times. It also removes the need for an untestable
   * "index was valid but the key was missing" guard at every call site: the
   * only failure mode is an empty window, and that is expressed in the return
   * type.
   */
  itemAt(offset: number): ResolvedItem | null {
    const n = this.#keys.length
    if (n === 0) return null

    const index = this.indexAt(offset)
    // Bounds are guaranteed by the guard above plus indexAt's clamp.
    const key = this.#keys[index]!
    return {
      index,
      key,
      start: this.#prefix(index),
      size: this.#measured.get(key) ?? this.#estimateFor(index, key),
    }
  }

  /**
   * Record a real measurement.
   *
   * Zero and negative sizes are refused. A hidden tab, a `display: none`
   * ancestor, a collapsed `<details>` and a suspended subtree all measure 0×0,
   * and a single zero in the prefix sum collapses the geometry — which makes a
   * `scrollToKey` target move every frame and the convergence loop never
   * terminate. This guard is the cheapest defence against that hang, so it
   * lives here rather than only at the call site.
   *
   * @returns whether the stored value actually changed.
   */
  setSize(index: number, size: number): boolean {
    const key = this.#keys[index]
    if (key === undefined) return false
    if (!Number.isFinite(size) || size <= 0) return false

    const previous = this.#measured.get(key)
    if (previous === size) return false

    this.#measured.set(key, size)
    this.#measuredTotal += size - (previous ?? 0)

    const before = previous ?? this.#estimateFor(index, key)
    this.#add(index, size - before)
    return true
  }

  /** Forget a single measurement, reverting the item to the estimate. */
  clearSize(index: number): boolean {
    const key = this.#keys[index]
    if (key === undefined) return false
    const previous = this.#measured.get(key)
    if (previous === undefined) return false

    this.#measured.delete(key)
    this.#measuredTotal -= previous
    this.#add(index, this.#estimateFor(index, key) - previous)
    return true
  }

  /** Drop every measurement — for a viewport resize that reflows all text. */
  clearAll(): void {
    this.#measured.clear()
    this.#measuredTotal = 0
    this.#lastEstimateAt = 0
    this.#rebuild()
  }

  setGap(gap: number): boolean {
    if (gap === this.#gap) return false
    this.#gap = gap
    this.#rebuild()
    return true
  }

  /**
   * Re-derive the estimate for unmeasured items from the **median** of what has
   * been measured.
   *
   * Median, not mean: one 4,000px comment in a thread of 200px ones would drag a
   * mean estimate far off for every unmeasured item. `viewportSize` gates the
   * first run so a partial first paint — a handful of items measured before the
   * list has filled — cannot poison the estimate. Afterwards it re-runs each
   * time the measured count doubles, so accuracy improves quickly without
   * paying O(m log m) every frame.
   *
   * Safe to call freely, which is worth noting: in an offset-addressed list a
   * changed estimate moves every unmeasured item and therefore shifts the view
   * (the root cause of react-window's #863). Here the anchor is a key, so the
   * viewport is unaffected by construction and re-estimating is purely an
   * accuracy win.
   *
   * @returns whether the estimate changed.
   */
  refreshEstimate(viewportSize: number): boolean {
    if (this.#estimateSize) return false

    const count = this.#measured.size
    if (count === 0) return false
    if (this.#lastEstimateAt === 0 && this.#measuredTotal <= viewportSize) return false
    if (count < this.#lastEstimateAt * 2) return false

    const sorted = Array.from(this.#measured.values()).sort((a, b) => a - b)
    const mid = sorted.length >> 1
    const median =
      sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!

    this.#lastEstimateAt = count
    if (median === this.#estimate) return false

    this.#estimate = median
    this.#rebuild()
    return true
  }

  setLayoutSignature(signature: string): boolean {
    if (signature === this.#layoutSignature) return false
    this.#layoutSignature = signature
    return true
  }

  get layoutSignature(): string {
    return this.#layoutSignature
  }

  snapshot(): SizeSnapshot {
    return {
      version: 1,
      layoutSignature: this.#layoutSignature,
      estimate: this.#estimate,
      sizes: Array.from(this.#measured.entries()),
    }
  }

  /**
   * Restore measured sizes from a snapshot.
   *
   * Refused when the layout signature differs, because a height measured at a
   * different container width or font size is wrong rather than merely stale,
   * and restoring it would put the list confidently in the wrong place.
   *
   * @returns whether the snapshot was accepted.
   */
  restore(snapshot: SizeSnapshot): boolean {
    if (snapshot.version !== 1) return false
    if (snapshot.layoutSignature !== this.#layoutSignature) return false

    this.#measured = new Map(snapshot.sizes)
    this.#measuredTotal = 0
    for (const size of this.#measured.values()) this.#measuredTotal += size
    this.#estimate = snapshot.estimate
    this.#lastEstimateAt = this.#measured.size
    this.#rebuild()
    return true
  }

  /**
   * The assumed size for an unmeasured item, guaranteed positive.
   *
   * A zero or negative estimate is not merely inaccurate, it breaks the
   * structure: `indexAt` inverts `offsetOf` by binary-lifting over the tree,
   * which requires slots to be strictly increasing. A zero-width slot makes the
   * inversion ambiguous and `scrollToKey` unable to converge, so a non-positive
   * estimate is floored rather than propagated.
   */
  #estimateFor(index: number, key: ItemKey): number {
    const value = this.#estimateSize?.(index, key) ?? this.#estimate
    if (value > 0) return value

    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn(
        `[virtual-anchor] estimated size for item ${String(key)} was ${String(value)}; ` +
          `using ${String(MIN_ESTIMATE)}px instead. Estimates must be positive.`,
      )
    }
    return MIN_ESTIMATE
  }

  /** Sum of the first `count` slots. `count` must be within [0, length]. */
  #prefix(count: number): number {
    let sum = 0
    for (let i = count; i > 0; i -= i & -i) sum += this.#tree[i]!
    return sum
  }

  #add(index: number, delta: number): void {
    if (delta === 0) return
    const n = this.#keys.length
    for (let i = index + 1; i <= n; i += i & -i) this.#tree[i]! += delta
  }

  /** O(n) in-place Fenwick construction. */
  #rebuild(): void {
    const n = this.#keys.length
    const tree = new Float64Array(n + 1)

    for (let i = 0; i < n; i++) {
      const key = this.#keys[i]!
      const size = this.#measured.get(key) ?? this.#estimateFor(i, key)
      tree[i + 1] = size + this.#gap
    }
    for (let i = 1; i <= n; i++) {
      const parent = i + (i & -i)
      if (parent <= n) tree[parent]! += tree[i]!
    }

    this.#tree = tree
    let lift = 1
    while (lift * 2 <= n) lift *= 2
    this.#liftStart = n === 0 ? 0 : lift
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * Nudge a candidate index until it is the exact answer to
 * "the largest `i` in [0, n) with `prefixAt(i) <= offset`".
 *
 * This exists because binary lifting over a Fenwick tree and a direct prefix sum
 * add up the *same* node values in *different* orders, and float64 addition is
 * not associative. At an exact item boundary the two can disagree by ~1e-13 —
 * enough for `indexAt(offsetOf(3))` to answer 2, which in turn is enough for
 * `scrollToKey` to converge on the wrong comment.
 *
 * Reconciling through `prefixAt` — the very function `offsetOf` uses — makes
 * `indexAt` an exact inverse of `offsetOf` by construction, rather than to
 * within some hand-tuned epsilon that would need revisiting every time the
 * magnitude of the offsets changed.
 *
 * Both directions are corrected. In ~13M randomized probes the lifting error
 * only ever undershot, so the downward branch may be unreachable in practice —
 * but "I could not produce it" is not "it cannot happen" for floating point, and
 * the guard costs one comparison. It is kept, and tested directly below rather
 * than left to chance.
 *
 * @internal
 */
export function reconcileIndex(
  candidate: number,
  offset: number,
  count: number,
  prefixAt: (index: number) => number,
): number {
  let index = candidate
  while (index > 0 && prefixAt(index) > offset) index--
  while (index + 1 < count && prefixAt(index + 1) <= offset) index++
  return index
}
