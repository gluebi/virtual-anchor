---
'virtual-anchor': minor
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
offset on the item container — the same mechanism the sub-pixel carry uses, which moves
content without touching the scroll position and so cannot be refused or undone by the
platform. When the gesture ends and the gate reopens, the offset is
folded into `scrollTop` in a single task: the content jumps back by the shift and the scroll
offset moves forward by it, so nothing visibly moves.

Whatever the platform will not take goes to the carry, bounded by `MAX_CARRY` as it always
is — and on WebKit, which truncates written offsets to integers, that is every fold. The
shift itself always clears, so nothing is ever held while the gate is open: a correction
cannot exceed the content above it, so the fold's target cannot leave the scrollable range
and there is no larger residue to strand.

Three details worth knowing:

- **Content-space reads now go through one helper.** The anchor, the rendered range and the
  visibility band all compare against item offsets, so all three read where the content
  *is*: computing them from the raw offset while a shift is outstanding centres the mounted
  window up to two viewports from the screen — which paints blank — and reports comments
  visible that never appeared. `atBottom` and the offset published to consumers stay in
  scroll space, since both are about the scrollbar.
- **The shift is bounded by the scroll range on either side of where you are**, because that
  is what the displacement actually costs: the content shown at `scrollTop` belongs at
  `scrollTop + shift`, so the last `shift` pixels in that direction are unreachable and the
  fold needs that much room to land. Deep in a list that bound is effectively unlimited,
  which is where flings happen and where the displacement is harmless; near either end it
  tightens to nothing, and the write is taken instead. Deliberately not a viewport multiple —
  that was the first attempt, it is unrelated to the thing being protected, and at ~1300px it
  fired part-way through a real fling and cancelled the momentum this exists to preserve.
- **The carry and the shift share one `top`**, so the engine — which already holds both for
  its own arithmetic — sums them and the surface takes one number. `Surface.setCarry` is
  renamed `setPaintOffset` to say so: two writers of one property would each clobber the
  other, invisibly until both are non-zero at once, which is a sub-pixel landing taken
  mid-gesture.

**Breaking:** `Surface.setCarry` is now `Surface.setPaintOffset`. Only an implementor of that
interface is affected; consumers of `VirtualList`, `useVirtualList` or `createEngine` are not.

Nothing changes off iOS, where the gate is inert and no shift is ever held — asserted
directly.

Verified on an iPhone 15 Pro Max. Automated coverage asserts the correction is held as a
paint offset rather than written, that successive corrections accumulate into one, that the
fold on reopen moves `scrollTop` by what the content was holding, that a truncating platform
leaves nothing held, that the rendered range follows the content rather than `scrollTop`,
that the cap takes the write, that the anchor derivation
includes the shift, and that nothing is held off iOS. The `mobile-webkit` project asserts in
a real WebKit that no write escapes a gesture; it deliberately does not assert the
correction's *size*, which depends on how wrong the demo's estimate happens to be at the
device descriptor's viewport rather than on anything the library does.
