---
'virtual-anchor': patch
---

Hold the view during an iOS gesture, instead of lurching by every correction.

iOS will not move the scroll offset while a touch gesture is in progress. Writing
`scrollTop` during a fling cancels it — which is what the momentum write gate fixed — and
writing it under a finger is undone by the gesture's own baseline. So a scroll correction
mid-gesture fails in *both* directions, and the gate's answer of deferring it left the
content lurching by the full correction instead: measured at 389px for a single row on an
iPhone, because a size estimate fitted at desktop width is wrong by hundreds of pixels once
the text wraps three times as often.

The correction now stops going through `scrollTop`. Deferred deltas accumulate into a paint
offset on the item container — `Surface.setGestureShift`, the same mechanism the sub-pixel
carry uses, which moves content without touching the scroll position and so cannot be
refused or undone by the platform. When the gesture ends and the gate reopens, the offset is
folded into `scrollTop` in a single task: the content jumps back by the shift and the scroll
offset moves forward by it, so nothing visibly moves. Whatever the browser clamps stays
outstanding rather than being discarded, which is what stops a reader ending up permanently
displaced at the end of a list.

Three details worth knowing:

- **The anchor is now derived from where the content is**, not from `scrollTop`. With a shift
  outstanding the two differ by exactly the correction already applied, so deriving from the
  raw offset would describe a position the view is not at — and every momentum event would
  re-derive it wrong, compounding rather than holding.
- **The shift is capped at two viewports.** While it is outstanding the scrollbar, `atBottom`
  and both edge thresholds are reading a position the content is no longer at, and the
  discrepancy is only recoverable while scroll range remains to absorb it. Past the cap the
  write is taken and the fling is sacrificed, which is the lesser harm.
- **The carry and the shift share one `top`**, so the surface sums them in one place. Two
  setters writing it independently would each clobber the other — invisible until both are
  non-zero at once, which is a sub-pixel landing taken mid-gesture.

`Surface` gains one method. Nothing else changes off iOS, where the gate is inert and the
shift is never non-zero.

Verified on an iPhone 15 Pro Max. Automated coverage asserts the shift is applied rather
than the write, that successive corrections accumulate into one offset, that the fold on
reopen is exact, that the cap takes the write, that the anchor derivation includes the shift,
and that no shift is ever outstanding off iOS.
