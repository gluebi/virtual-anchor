---
'virtual-anchor': patch
---

Hold the mounted range across a scroll instead of recomputing it on every event.

`computeRanges` ran per scroll event and the mounted range moved the instant the buffered band
crossed a row boundary — and `needsRerender` trips on exactly that. Browsers coalesce scroll
events to one per frame, so the ceiling was a React render per frame, each reconciling every
mounted row; #65 raising the resting buffer to 2500px multiplied what each one cost.

The range is now **held** while the buffered band still fits inside it, and recomputed to a
wider band when it does not.

The cadence is arithmetic: a recompute happens once per `buffer * RANGE_SLACK_RATIO` = 1250px
of travel instead of once per row, and publishes are capped at one per frame — so on the demo's
~162px comments that is 60 store-driven renders a second down to 32 during a 40,000px/s fling,
and 12 down to 1.6 at an ordinary reading speed of 2,000px/s.

What that is worth was measured with `perf/headroom.spec.ts`, medians of four runs, against the
change below it in the stack:

| slowdown | demo | fps | drop% | handler p50 | handler p95 |
| --- | --- | --- | --- | --- | --- |
| 1× | live | 60.0 → 60.0 | 0 → 0 | 0.40 → 0.30 | 1.60 → 0.60 |
| 6× | live | 60.0 → 60.0 | 0 → 0 | 0.50 → 0.10 | 2.40 → 1.40 |
| 10× | live | 60.0 → 60.0 | 0 → 0 | 0.90 → 0.10 | 4.00 → 2.90 |
| 20× | live | 46.3 → 56.6 | 22.8 → 5.6 | 4.00 → 0.10 | 9.80 → 5.40 |
| 20× | quiet | 49.8 → 57.1 | 17.1 → 4.8 | 1.90 → 0.00 | 7.80 → 3.30 |

The largest of the three steps in the stack, and it lands where it was aimed: at 20× CPU the
dropped-frame share falls from 22.8% to 5.6%. Cumulatively against `main` — the three changes
together — that row reads 39.4fps and 34.4% dropped becoming 56.6fps and 5.6%.

And the risk it was carrying did not materialise. `perf/blanking.spec.ts` counts composited
blank frames during a compositor-driven fling, which is what the extra mounted rows were bought
to protect: identical at 1× and 6× (1 blank capture of 79, at 3% into the gesture, on both
sides), and at 20× the branch has none where `main` has one — the emptiest frame goes 0.27 to
0.47, meaning it never went fully blank. That spec does not repeat and take a median, so read
the 20× improvement as one sample; what it does establish is the absence of a regression.

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

There is a third fact the hold rests on, and it is the one that had to be found the hard way:
only a publish may move it. The visibility deadline timer wants a visible range and fires from
outside any publish, so it now asks for exactly that and nothing else — moving the mounted range
from there moved it with nothing rendering the result.

`MAX_DEFAULT_BUFFER_ROWS` now bounds the rows the default actually *mounts* rather than the rows
its guarantee covers, since the slack is what mounts a row. On the demo's comments the pixel
limit still wins and coverage stays at 2500; on a list of short rows the cap binds where it
always meant to.

Costs rows resident — the mounted band grows by half the buffer on each side, and `itemsFor`
still allocates one object per mounted row on every publish whether the range moved or not. A
skipped render is the whole of React's work for every mounted row, so the trade is favourable at
fling speed and lopsidedly so at reading speed.
