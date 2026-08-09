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

Measured with `perf/`, median of 4 runs on an M1, `main` against this change. The wheel
scenario at increasing emulated CPU slowdown, which is the axis that separates headroom from
"already at the display ceiling":

| slowdown | demo | fps | drop% | handler p50 | handler p95 |
| --- | --- | --- | --- | --- | --- |
| 6× | live | 60.0 → 60.0 | 0 → 0 | 1.20 → 1.20 | 4.60 → 3.30 |
| 10× | live | 58.5 → 60.0 | 2.5 → 0.0 | 2.00 → 1.80 | 7.90 → 5.10 |
| 20× | live | 34.1 → 37.3 | 43.2 → 37.9 | 12.40 → 7.60 | 22.10 → 13.30 |
| 20× | quiet | 37.1 → 41.9 | 38.2 → 30.1 | 10.90 → 5.00 | 18.70 → 9.50 |

At 1× through 6× the display is the ceiling and nothing visible changes; the p95 handler still
falls, which is the headroom the 10× and 20× rows spend. `scroll-fps` is unchanged at 60fps
across every dataset, and `scrollToKey` still reports `settled=true deviation=0.000px` after
the same 87 iterations — so none of this moved a landing.

Skipping the read is safe because of something `resizer` already did and had not written down:
detaching deletes the element's `lastSizes` entry, so the synthetic first entry the observer
delivers for the row's replacement element is reported rather than dropped as a duplicate. A
height that changed while the row was unmounted is still corrected, one frame later — the
latency every other virtual list accepts for every row, taken here only where the cache has
nothing better. That line now carries a comment saying so.

The hot path is untouched: a row scrolling into view for the first time still measures
synchronously, which during a fling through variable-height text is very nearly all of them.
