---
'virtual-anchor': patch
---

Stop reading a row's rect when its height is already known.

`observeItem` measured every mounting row synchronously. The comment defending that is right
about why the read exists — ResizeObserver's first callback lands after the next rendering
update, so a row with nothing in the cache would paint one frame at its estimate — but that is
an argument about a row with *no measurement*, not about every row that mounts.

`resizer.measure` is a `getBoundingClientRect` called from a ref callback, immediately after
the offset write on the line above. So it is a forced synchronous layout in the middle of
React's commit, and one **per row** rather than one per commit, because each row's `style.top`
dirties layout again before the next row reads. It was paid for every row scrolled back over
and for every row of a list restored from a `sizeSnapshot`, where the answer was already in the
cache. Where the rect then disagreed with the snapshot by a pixel it cost the whole of
`publish` as well — three more layout reads and a re-render — again per row. The resting buffer
has been 2500px since #65, so that is tens of rows per range change rather than a handful.

Measured with `perf/headroom.spec.ts`, medians of four runs, one session on an M1, against
`main`. The wheel scenario at increasing emulated CPU slowdown is the axis that separates
headroom from "already at the display ceiling":

| slowdown | demo | fps | drop% | handler p50 | handler p95 |
| --- | --- | --- | --- | --- | --- |
| 1× | live | 60.0 → 60.0 | 0 → 0 | 0.50 → 0.40 | 2.50 → 1.80 |
| 6× | live | 60.0 → 60.0 | 0 → 0 | 0.60 → 0.50 | 3.60 → 2.70 |
| 10× | live | 60.0 → 60.0 | 0 → 0 | 1.10 → 0.90 | 6.70 → 4.50 |
| 20× | live | 39.4 → 43.9 | 34.4 → 26.8 | 7.60 → 4.40 | 19.70 → 10.60 |
| 20× | quiet | 47.3 → 47.3 | 21.1 → 21.1 | 4.30 → 2.80 | 13.50 → 8.50 |

Below 10× the display is the ceiling and nothing visible changes; the p95 handler still falls,
which is the headroom the 20× row spends. `scroll-fps` is unchanged at 60fps across every
dataset, and `scrollToKey` still reports `settled=true deviation=0.000px` — so none of this
moved a landing.

Skipping the read is safe because of something `resizer` already did and had not written down:
detaching deletes the element's `lastSizes` entry, so the synthetic first entry the observer
delivers for the row's replacement element is reported rather than dropped as a duplicate. A
height that changed while the row was unmounted is still corrected, one frame later — the
latency every other virtual list accepts for every row, taken here only where the cache has
nothing better. That line now carries a comment saying so.

The hot path is untouched: a row scrolling into view for the first time still measures
synchronously, which during a fling through variable-height text is very nearly all of them.
