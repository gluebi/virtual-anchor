---
'virtual-anchor': patch
---

Hold the mounted range across a scroll instead of recomputing it on every event.

`computeRanges` ran per scroll event and the mounted range moved the instant the buffered band
crossed a row boundary — and `needsRerender` trips on exactly that. Browsers coalesce scroll
events to one per frame, so the ceiling was a React render per frame, each reconciling every
mounted row; #65 raising the resting buffer to 2500px multiplied what each one cost.

The range is now **held** while the buffered band still fits inside it, and recomputed to a
wider band when it does not. On the demo's ~162px comments that is 60 renders a second down to
32 during a 40,000px/s fling, and 11.5 down to 1.6 at an ordinary reading speed of 2,000px/s —
the case a reader is actually in.

**The coverage guarantee is unchanged, deliberately.** The tempting version holds until the
*visible* band nears the edge, which needs no extra rows and quietly halves the distance the
buffer promises — and `blanking.spec.ts` chose `DEFAULT_BUFFER` against that distance directly.
So the trigger stays exactly where it was, at the buffered band, and the *recompute* mounts
wider. A test walks a scroll through eight hold-and-recompute cycles asserting the mounted range
never falls inside the buffer at any point.

The held ends are remembered **by key**, for the same reason the anchor is a key: two integers
would name two different rows the moment anything is inserted above. Keeping keys means a
prepend does not remount the window at all — the ends still name their rows, so the same set
stays mounted, shifted. A key that stops resolving reads as nothing held and recomputes.

There are two invalidation mechanisms and they divide cleanly: identity changes (prepend,
append, a window that paged away) are caught by the keys, and geometry changes (a gap, a
re-estimate, a discarded measurement cache, a resize, a slot appearing) by the containment test,
which is computed from live offsets every pass. Neither needs a flag.

`MAX_DEFAULT_BUFFER_ROWS` now bounds the rows the default actually *mounts* rather than the rows
its guarantee covers, since the slack is what mounts a row. On the demo's comments the pixel
limit still wins and coverage stays at 2500; on a list of short rows the cap binds where it
always meant to.

Costs rows resident — the mounted band grows by half the buffer on each side, and `itemsFor`
still allocates one object per mounted row on every publish whether the range moved or not. A
skipped render is the whole of React's work for every mounted row, so the trade is favourable at
fling speed and lopsidedly so at reading speed.
