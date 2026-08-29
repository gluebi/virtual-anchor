---
'virtual-anchor': minor
---

Discarding the size cache now re-measures the rows that are still mounted, instead of leaving them on their estimates.

`recheckLayoutSignature` clears every measured size when the layout signature changes — a zoom, a
rotation, a root font size change, a window dragged between displays — and nothing refilled it.
The two paths that measure cannot: `observeItem` reads a rect once per mount and only for a size
the cache does not already know, and the `ResizeObserver` fires only when a box *changes*, with a
value-level dedup on top. So a row whose height is the same under the new layout was never asked
again. It stayed on its **estimate** for as long as it remained mounted, and every row below it
was positioned from that estimate.

How much of the list this stranded depended on what moved. A width or root-font-size change
brought back the rows that re-wrap and stranded the ones pinned by something other than their
text — a fixed-height avatar, an image. A **device pixel ratio** change stranded every mounted
row, because CSS-px layout is unchanged, so no box moves and no delivery follows the clear at
all. That is a laptop being docked.

It presented as one row with a band of empty space under it rather than as list-wide drift, which
is what made it hard to place: the rows whose estimate happens to equal their height look
perfect. The tell was that scrolling the row out of view and back fixed it, because that
remounts it and `observeItem` measures on mount.

Two silent consequences went with the visible gap. Every offset in the list was an estimate, so
`scrollToKey` aimed at a position that did not exist — it still landed flush, because the rows
were positioned from the same cache, but a consumer comparing the list against the DOM or paging
on `onEdgeReached` was working from fiction. And `VirtualItem.measured` went `false` for rows the
consumer could see, which is public API and the only signal, documented for a case that does not
look like this one.

An invalidation now re-measures every attached row whose size it just discarded, after whatever
measurements the caller already holds and before anything is published from the estimates. Rows
delivered by the batch that provoked the clear were taken under the new layout and are skipped;
rows that are not mounted are left alone, back on their estimate honestly, and measured by
`observeItem` when they mount.

The cost is a `getBoundingClientRect` per attached row that nothing else refreshed, and one forced
reflow for the loop rather than one per row, since nothing before it writes styles. The batch path
is behind the existing 250ms signature re-read limit. The scrollport path is not, so a horizontal
window drag runs the loop on every delivered frame that changes the width — bounded by the drag,
and the alternative is a list that stays wrong for the length of it.

### Breaking

`Surface` gains a required `attachedItems(): Iterable<readonly [ItemKey, HTMLElement]>`, alongside
the `hasItem` that answers the same question for a single key. It is what the refill iterates, and
there is no other enumerable key-to-element map in the package.

This only affects a consumer passing their own `surface` to `createEngine` — the DOM surface the
React adapter builds implements it. A hand-rolled one returns its own attached elements; returning
an empty iterable compiles and restores the old behaviour, which is the bug above.

Fixes #111.
