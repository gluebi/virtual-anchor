---
'virtual-anchor': minor
---

Aim programmatic scrolls at where the content is, not at where the scrollbar is.

Holding the view through an iOS gesture split one coordinate into two. `getScrollOffset()`
is where the *scrollbar* is; the content sits at that plus the corrections being carried on
the item container, which during a gesture is the whole of a correction the platform will
not accept as a `scrollTop` write. The engine's reads were converted to the second of those
and `scroller.ts` was left on the first — while every destination in that module is built
from `offsetForIndex` over cache offsets, which is the second. So a `scrollToKey` or
`scrollToIndex` issued during a touch gesture aimed at a position the reader is not at, and
then reported success.

Silent, and the suite was green through all of it: the scroller's iOS suite can drive a
scroll during a gesture but had no engine holding a shift for it, and the engine's iOS suite
holds a shift but never drove a scroll through it. Both halves are needed for the
destination and the coordinate it is compared against to disagree, so eighteen iOS cases
passed straight over the top of it.

Every read that compares against an item offset moves into content space: the `align: 'auto'`
visibility test — which also *returns* that read as its target, so it was two problems in one
expression — the banked correction and its replay, the convergence loop's arrival test and the
smooth integrator's starting point, the deviation reported to the caller, and the fully-measured
fast path, which could resolve `settled: true, deviation: 0` about a position the content was
hundreds of pixels from, with no convergence loop left to correct it. The reads that stay
deliberately in scroll space each now say why: the rubber-band test asks whether the
*scrollbar* has been dragged outside its own range, the clamp is the range a write has to land
in, and the write itself plus the carry it recovers are about what the platform did with the
number handed to it.

The seam is one new optional member of `ScrollerOptions`:

- **`getContentOffset?: () => number`**, defaulted so a standalone `createScroller` behaves
  exactly as it did. Deliberately not a method on `Viewport`: the React adapter builds its
  viewport before either the engine or the surface exists, the gesture shift is engine state
  written by the `Surface`, and `Viewport` is public API — a required member there would
  break every hand-rolled viewport and all six test fakes.
- The default is `scrollTop` plus **the carry this module applied itself**, which is a
  correction to the smaller version of the same bug rather than tidiness. The arrival test
  used to re-derive the carry from the residual, and `carryFor` returns the whole residual
  below `MAX_CARRY` and zero above it — so the old expression accepted anything within a
  pixel, whatever the tolerance said. Reading where the content is replaces that with the
  real number, and dropping the carry term from the default would leave a 0.75px truncation
  the carry has already made good unable to satisfy a 0.5px tolerance: the convergence loop
  would run to its soft deadline at dPR 2 on the one engine that truncates. That is the
  exact failure the arrival test's own comment describes, and there is now a test for it.

Writing a content-space target straight into `setScrollOffset` is exact rather than
approximate, and the reason is worth stating: a write only happens with the gate open, the
engine folds any outstanding shift into `scrollTop` before any other reopen listener runs,
and a shift is only ever held while the gate is shut — so nothing is outstanding at the
moment of the write and the two spaces coincide.

`target - actual - carryFor(target, actual)`, which appeared at both the arrival test and
the reported deviation, is gone: it was a hand-rolled one-contributor content offset, and
`target - getContentOffset()` is the same quantity with the real carry instead of a
re-derived one. The step trace's `uncarried` field becomes `remaining` to match, since the
carry is now inside the position rather than subtracted from the distance.

Not a regression from the gesture work in the sense that it was ever right — before it there
was no shift to be wrong about. The coordinate became two-valued and one module was not
told. Reaching it needs a scroll issued while a finger is down or a fling is running, on
iOS, which a consumer that scrolls in response to a tap does routinely: the tap's `touchend`
starts the grace window, so a scroll issued from the handler lands inside it.

New coverage asserts that the banked correction is replayed from where the content is and
lands where the same script lands with no shift held, that `align: 'auto'` judges visibility
by the content, that the fast path does not resolve settled for a target only the scrollbar
has reached, that the reported deviation is the distance the content has left to travel, and
— at engine level, through the real `contentOffset` wiring — that a `scrollToKey` issued
mid-fling measures itself against the content and lands on the item once the gesture is
over. Each of the first four fails against the raw-offset reads. Nothing changes off iOS,
where no shift is ever held: with the shift set to zero every existing assertion in the
scroller's iOS suite is unchanged, which is the regression guard for the default.
