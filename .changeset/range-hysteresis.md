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

What that is worth was measured with `perf/headroom.spec.ts`, medians of three to four runs,
one session on an M1, against `main` — so this table is the whole stack, not this change alone:

| slowdown | demo | fps | drop% | handler p50 | handler p95 |
| --- | --- | --- | --- | --- | --- |
| 1× | live | 60.0 → 60.0 | 0 → 0 | 0.30 → 0.20 | 1.70 → 0.70 |
| 4× | live | 60.0 → 60.0 | 0 → 0 | 0.70 → 0.40 | 3.00 → 1.00 |
| 6× | live | 60.0 → 60.0 | 0 → 0 | 1.30 → 0.50 | 4.60 → 1.50 |
| 10× | live | 59.0 → 58.5 | 1.6 → 2.4 | 2.10 → 1.10 | 7.60 → 2.80 |
| 20× | live | 37.7 → 52.7 | 37.1 → 12.2 | 7.80 → 1.20 | 18.80 → 4.90 |
| 20× | quiet | 39.3 → 57.6 | 34.4 → 4.1 | 6.90 → 0.10 | 15.10 → 4.00 |

**`blanking.spec.ts` is within its own noise, and is reported rather than claimed.** Back to
back on the same machine at 40,000px/s it gave 0 blank captures of 79 against `main`'s 1 at 6×
CPU, and 2 of 78 against `main`'s 0 at 20×; three runs of this branch at 20× gave 0, 9 and 2.
That spec does not repeat and take a median — its own header says so — and single counts of
small integers cannot separate those. What can be said structurally is that the coverage
guarantee is byte-identical to `main` and the mounted band is strictly larger, so there is no
mechanism by which the compositor has *fewer* rows ahead of it than before.

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
