---
'virtual-anchor': patch
---

Stop reporting a landing as converged against heights the list has not measured.

`scrollToKey` could resolve `{ settled: true, reason: 'converged', deviation: 0 }` while sitting
22px from where it was asked to go. The accuracy matrix caught it in a paged window: comment #137
off by 1.25px for `align: 'start'`, 11.75px for `'center'` and 22.25px for `'end'`.

That progression is the diagnosis rather than three separate faults. #137 estimates at 162px and
measures 141, and the error is none of the 21px difference for `start`, half for `center` and all
of it for `end` — which is how much of a row's height each alignment puts on screen. The landing
was computed against the estimate.

The cause is one line, and it is a counting argument. `scrollToKey` has a fast path that skips
the convergence loop when the destination is already in place, guarded by
`cache.measuredCount === cache.length`. A count cannot say *which* rows were measured. The cache
keeps sizes by key across a change of loaded window — deliberately, because keys outlive
windows — so after the window moves it can hold as many measurements as there are items while
every item now on screen is freshly mounted and still an estimate. The guard read that as fully
measured, took the shortcut, and resolved.

Nothing downstream could notice. The write puts the offset the model asked for, reads back the
offset it wrote, and finds them equal — so `deviation` is zero. It measures the scroller's
consistency with itself, not where the row is.

The guard now also asks whether anything is still awaiting measurement, which a count cannot
answer and the size cache cannot either: an unmeasured row is either one whose `ResizeObserver`
delivery is a frame away or one the list will never mount, and only the surface can tell those
apart. The engine answers it — the destination first, because `itemsFor` mounts the pinned
destination as its own segment rather than widening the contiguous span, so the one row whose
height decides the landing is the row the rendered range does not name.

`scroll.step` gains `awaitingMeasurement`, because the defect is invisible in every other field:
a loop converging against estimates reports `arrived: true` and `remaining: 0`, and is otherwise
indistinguishable from one that landed correctly.
