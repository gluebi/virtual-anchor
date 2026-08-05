# virtual-anchor

## 0.6.0

### Minor Changes

- 984c81a: `Viewport.observeSize`'s callback no longer receives a size.

  The parameter dates from a time when a scrollport resize _was_ a height change: the callback
  reported the new block size, and reporting it was the point. Nothing has read that number for
  some time. The engine — the only consumer — subscribed with a closure whose entire body was to
  throw the argument away:

  ```ts
  viewport.observeSize(() => {
    onViewportResize();
  });
  ```

  and `onViewportResize()` takes no parameter at all. It re-reads the layout signature from
  `viewport.getScrollportElement()` and asks `viewport.getViewportSize()` for the scrolling axis,
  because both of those are questions about _now_, and a number captured when the observer fired
  is not. So the size was computed on every delivery, handed across the seam, and dropped.

  Making a width-only resize forward at all is what turned that from dead weight into a
  falsehood. One number cannot say which axis moved, and the callback that carries it is
  documented as observing "the scrollport's size" — so a consumer reading the signature would
  reasonably conclude the block size is what changed, which is now exactly the case it may not
  be. The honest contract is the empty one: the scrollport's box moved on one axis or the other,
  and a consumer that wants a dimension asks the viewport for it.

  Both implementations now call back identically, with no arguments, and there is a test that
  fails if either stops. That is not ceremony. `createWindowViewport` subscribes to the window's
  `resize` and `visualViewport`'s, and the DOM calls a listener **with** the `Event` — so handing
  the consumer's callback straight to `addEventListener` would have the window implementation
  calling back with an argument while the element implementation called back with none. The
  callback's type says neither, which is the shape of disagreement this interface exists to rule
  out: two implementations of one seam differing in a way nothing in the type system can see. A
  one-line wrapper per subscription keeps them identical.

  ## Breaking

  `Viewport.observeSize(onResize: (size: number) => void)` is now
  `Viewport.observeSize(onResize: () => void)`.

  Only an implementor of the interface is affected — the same scope as #29's `Surface.setCarry`
  to `setPaintOffset` rename. Consumers of `VirtualList`, `useVirtualList` or `createEngine` are
  not, and neither is anyone using `createElementViewport` or `createWindowViewport`, which are
  the two implementations this repo ships. If you hand-rolled a `Viewport`, delete the parameter
  your `observeSize` passes to `onResize`; a callback that ignored it already compiles unchanged.

- 299c785: Aim programmatic scrolls at where the content is, not at where the scrollbar is.

  Holding the view through an iOS gesture split one coordinate into two. `getScrollOffset()`
  is where the _scrollbar_ is; the content sits at that plus the corrections being carried on
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
  visibility test — which also _returns_ that read as its target, so it was two problems in one
  expression — the banked correction and its replay, the convergence loop's arrival test and the
  smooth integrator's starting point, the deviation reported to the caller, and the fully-measured
  fast path, which could resolve `settled: true, deviation: 0` about a position the content was
  hundreds of pixels from, with no convergence loop left to correct it. The reads that stay
  deliberately in scroll space each now say why: the rubber-band test asks whether the
  _scrollbar_ has been dragged outside its own range, the clamp is the range a write has to land
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

### Patch Changes

- 062a045: Fold the gesture shift into `scrollTop` before any other write-gate listener runs.

  `ScrollWriteGate.onOpen` fires its listeners in **registration order** — it is a `Set`,
  iterated in insertion order — and `engine.mount()` registered the engine's own listener
  _after_ `scroller.attach()` had registered the scroller's. So on the one event that ends a
  gesture, the scroller went first and the engine second, which is exactly backwards: the
  engine's listener is the one that turns the outstanding paint offset back into a real scroll
  offset, and everything else waiting on that event reads `scrollTop`.

  Two listeners want the same reopening, for two different reasons, and neither of them is
  optional. The scroller banks a _delta_ when the gate refuses a write — how far the view
  needed to move, not where it needed to end up, because a fling has carried the scroller
  somewhere else entirely by the time the delta can be applied — and it replays that delta
  against `viewport.getScrollOffset()` when the gate reopens. The engine holds the gesture
  shift: the whole of a correction that was never written at all, standing in for `scrollTop`
  as a paint offset on the item container, and folded back into `scrollTop` in one task once
  the platform will take the write. Run the flush first and it replays its delta from an
  offset the shift is still standing in for; the fold then adds the shift on top. The
  correction is applied twice, and the scroller's `finish()` measures its deviation against
  the post-fold offset and reports ≈0 — so nothing in the library notices.

  The fix is the registration order: the `writeGate.onOpen(...)` call moves above
  `scroller.attach()`. Nothing else moves with it. `onOpen` only adds to a set, and nothing
  can fire it until `gate.attach()` — reached from inside `scroller.attach()` — binds the DOM
  listeners that drive the state machine, so the ordering constraint that put
  `scroller.attach()` first (the gate's `touchstart`/`touchend`/`scroll` listeners must
  precede the engine's own scroll and settle handlers, so that both of those see an
  already-transitioned gate) is about DOM listeners and is untouched. The teardown order is
  unchanged: the `onOpen` unsubscribe was already the first entry in `cleanups`, and the gate
  itself is deliberately disposed with the scroller rather than on unmount.

  What this restores is an invariant the engine's own docs already assert and rely on:
  **nothing is held while the gate is open.** `commitScroll` says so, and the offset
  arithmetic elsewhere in the file rests on it — but it was false for the duration of the
  first listener, which is precisely where a second consumer of `scrollTop` was running. The
  fold now happens before any other listener, so the invariant holds for _every_ one of them:
  the scroller's banked-correction flush, the convergence loop parked on the same event, and
  anything registered later. The comment in `mount()` says that, and says what a re-order
  silently costs, so the ordering is load-bearing rather than incidental.

  Two regression tests pin it, both of which need a shift held _and_ a correction banked at
  the same moment — a deferred measurement establishes the first, a `scrollToIndex` the shut
  gate refuses banks the second. One asserts the sequence directly, by reading the paint
  offset in effect at each `scrollTop` write: exactly one write on reopen is made with the
  content held away from `scrollTop`, and it is the fold. The other asserts the fold moves
  `scrollTop` by the shift alone rather than by the shift on top of a delta already replayed.
  Both fail against the old order.

  This is the ordering half of a two-part problem. The scroller also compares content-space
  destinations against the raw scroll offset, which is a separate bug in `scroller.ts` and is
  what decides whether the landing is _right_; this change decides only that the shift is
  folded once, and first.

- 8e62b93: Invalidate measurements when the scrollport changes width without changing height.

  The size cache is keyed on a layout signature — `w=<clientWidth>|f=<rootFontSize>|dpr=<dpr>`,
  the same key a `sizeSnapshot` is trusted against — because a row height measured at a
  different container width is not stale, it is _wrong_. The scrollport's width is in that key
  for the only reason that matters: it is what decides where text wraps.

  Only one thing re-read that key at runtime, and it was reached from exactly one place:
  `viewport.observeSize`. For an element scroller that callback compared the delivered **block**
  size against the last one and returned early when they matched — so a `ResizeObserver`
  delivery reporting a new width and the same height stopped there.
  `observe(element, { box: 'border-box' })` does fire for a width-only change; the callback
  simply discarded it, the signature was never re-read, and nothing was invalidated. The irony
  is that the consumer's own comment says "the _height_ of the scrollport reflows nothing", and
  a height change was the only thing that could reach it.

  What that produced downstream is rows drawn overlapping or with gaps, rather than a wrong
  scroll extent. The rows inside the mounted window are re-measured by the item observer as
  soon as the reflow changes their height, so they heal on their own; the rows outside it keep
  the height they were measured at under the old width, because nothing mounts them and nothing
  cleared them. The prefix sum then mixes current and stale heights and places rows at offsets
  that do not match their real heights. Scrolling such a row out of the window and back in
  unmounts, re-mounts and re-measures it, which fixes that one row — the "scroll it away and
  back and it's fine" symptom, reported against 0.5.0 on a desktop forum thread list where a
  responsive column narrowed without the list's height moving.

  `createElementViewport().observeSize` now remembers the last border box on both axes and
  forwards a delivery when either one moved. The callback still carries the block size, so the
  `Viewport` interface is unchanged. A forwarded delivery that turns out to change nothing
  material costs one `layoutSignatureFor`, a string compare that `setLayoutSignature` no-ops on,
  and the same non-invalidating `publish` any height resize already performs — so a width the
  signature rounds to the same integer is cheap rather than free. A height-only resize still
  keeps every measurement, which is the case that
  distinction exists for: a mobile URL bar hiding, devtools opening, a soft keyboard appearing
  or a vertical window drag reflow nothing, and discarding the cache for them is wasteful and —
  against a restored snapshot — destructive.

  The first delivery is still forwarded, as it always was. `observe()` synthesises one for a
  newly observed element, and not reading _that_ one as a change is the consumer's job: the
  engine learns the signature on the first observation and only compares from the second. Which
  is why the regression test has to deliver the scrollport's starting box before the width
  change — without it the width change is a first delivery, reports either way, and the test
  passes against the defect.

  `createWindowViewport` needed no change, and there is now a test saying so rather than a
  claim: its `observeSize` deduplicates nothing at all, reporting `view.innerHeight` on every
  `resize` and `visualViewport` resize, and the engine discards the number and re-reads the
  signature itself. So a horizontal window resize — the ordinary way a `windowScroller` list's
  scrollport changes width — already invalidated correctly.

  One hole in the same class remains, and this does not close it: the signature is only ever
  re-read on a resize, so a `devicePixelRatio` change with no box change (a window dragged to a
  display with a different scale factor) or a root-font-size change that alters no CSS box
  notifies nothing at all. Both are in the key and neither has an observer behind it.

- 0a3a875: Discard stale measurements when the root font size changes, not only when the scrollport does.

  The size cache is keyed on a layout signature — `w=<clientWidth>|f=<rootFontSize>|dpr=<dpr>` — and
  each of those three terms is in the key because changing it makes a measured row height _wrong_
  rather than merely old. But only one thing re-read that key at runtime, and it was reachable from
  exactly one place: `viewport.observeSize`. So runtime invalidation covered whatever a scrollport
  resize reports, which after the width fix is the width, and nothing else.

  A root font size change is the term with a real defect behind it. Raising a browser's default text
  size, or flipping an app's own accessibility toggle, re-wraps every line of every row — and moves
  the scrollport not at all. Nothing was delivered, the signature was never re-read, and every
  measured height stayed keyed to a layout that had stopped existing. The rows still mounted are
  re-measured by the item observer and heal; the rest keep a height taken under the old font and are
  placed by a prefix sum that mixes the two, which is the same end state as the width bug and the
  same symptom — rows drawn overlapping or with gaps, fixing themselves when scrolled out of the
  mounted window and back in.

  What closes it is not a new observer. The signal was already arriving: a font size change re-lays-out
  every mounted row, so the shared `ResizeObserver` fires for all of them. Nothing was asking the
  question. The signature check moves out of the resize handler into one helper, and the item batch
  asks it too — so a resize is now simply the trigger that happens to catch the width term, rather
  than the only trigger there is.

  Three details, since none of them is arbitrary:

  - **The read happens before the batch is applied.** A `ResizeObserver` callback runs after layout, so
    reading a computed style there forces no reflow — but the same callback goes on to write styles
    through `publish`, and a read after that would. It also has to precede the batch because a
    signature change clears the cache, and those measurements are the only ones in the list taken
    under the new layout.
  - **It is rate-limited to once every 250ms.** The top of that callback is the hot path — every row
    measured during a fling — and a `getComputedStyle` per row is not acceptable there. A limit rather
    than a threshold: it decides nothing about the content, only how often the question is asked. The
    cause is a human action that takes about a second, so a quarter of a second of latency is not
    perceptible, and it bounds the reads through a three-second fling to a dozen.
  - **An invalidation publishes as a model change, not a measurement.** Discarding every measurement
    moves every offset below the first item, and a correction that large cannot wait for a gesture to
    end without teleporting the reader — the same reasoning the resize path already applies.

  The mount path is deliberately untouched: `observeItem` measures each row synchronously as it
  attaches, and putting a computed-style read there would pay it per row for the whole of a scroll.
  A font size change while nothing is mounted is caught by the first batch after it, which is the
  first moment there is anything to be wrong about.

  The device pixel ratio term still has no runtime trigger. That is not an oversight and not the same
  problem: CSS-pixel layout is largely independent of it, so a change may not alter a single row
  height, in which case invalidating would discard a whole cache for nothing. It is being settled by
  measurement separately.

- 5226f64: Discard stale measurements when the device pixel ratio changes.

  This is the last of the three terms in the layout signature to get a runtime trigger, and the
  only one whose answer was not obvious in advance. The width is caught by a scrollport resize.
  The root font size is caught by rows re-laying-out. A device pixel ratio change need not do
  either: it can leave the scrollport exactly as it was and re-lay-out nothing, so neither
  existing trigger can see it.

  The question worth asking first was whether it should be caught at all. CSS pixel layout is
  _nominally_ independent of the ratio, and if that held then a change would alter no row height,
  the term would not belong in the key, and invalidating on it would discard a whole cache for
  nothing — a window dragged between two displays would throw away every measurement in a long
  thread and re-estimate it. Deleting the term would then have been the fix.

  It does not hold. Measured on the demo at a fixed 1280px viewport, first six rows:

  | ratio   | Chromium | Firefox | WebKit        |
  | ------- | -------- | ------- | ------------- |
  | 1, 2, 3 | 277.25   | 277.25  | 277.25        |
  | 1.25    | 277.25   | 277.25  | **276.84375** |

  On WebKit at a _fractional_ ratio every row is 0.40625px shorter, uniformly. Integer ratios
  agree exactly on all three engines, and Chromium and Firefox agree everywhere. Per row that
  difference is invisible; across a few thousand rows it is a wrong scroll extent and a landing
  that misses by more than a screen, which is the failure this library exists to prevent. And
  fractional ratios are not exotic — browser page zoom is how most people produce one.

  So the term stays and gets an observer. There is no event for `devicePixelRatio`, so
  `observeResolution` uses the standard trick: a `(resolution: Xdppx)` media query matches only
  the ratio it names and stops matching the moment the ratio moves. That means it has to be
  re-armed against the new value on every change, because one query cannot answer "has this
  changed" twice — miss that and the first zoom is the only one ever noticed. It reuses the
  `matchMedia` guard `prefersReducedMotion` already established, so a host without it gets an
  inert unsubscribe rather than a crash.

  The callback goes straight to the existing resize handler, which re-reads the signature and
  publishes accordingly. That is the whole of what is wanted, and it is only reusable because the
  handler takes no arguments — its name is about its first caller rather than its job.

- e2f5552: Report visibility against where the content is, not where the scrollbar is.

  While a correction is held as a paint offset on iOS, `scrollTop` and the content disagree by
  exactly the held amount — that is what holding it _means_. The anchor and the rendered range
  were converted to read the content's position when the gesture compensation landed; the
  visibility band was named as the third such reader and was not. It kept taking a scroll
  offset as a parameter, and both callers kept handing it the raw one.

  The band is the wrong place for that mismatch to hide. It is built by converting an offset
  into list coordinates, and it is then compared against candidate items whose bounds come
  straight from the size cache — which is content space, and always was. Two coordinate spaces
  in one overlap calculation makes the answer meaningless rather than approximate: with a
  correction wider than the viewport, the band and the candidates do not intersect at all, so
  the sample reports every row currently on screen as having _left_ and reports nothing in its
  place. A smaller correction is worse to diagnose, not better: the two windows partly overlap
  and the events are plausible but wrong.

  Two call sites, and they were wrong in different ways. The publish path already computed the
  content position for the rendered range one line above and passed the raw offset to the band
  anyway, so the candidate range and the band it was measured against disagreed by the shift.
  The visibility deadline timer — the re-sample that exists because dwell and leave delays are
  measured in time rather than in events — read the raw offset for _both_, so its candidates
  and its band agreed with each other and both described a strip of the list the reader was
  not looking at. That is also the sample most likely to be the only one taken during a hold:
  it fires when nothing else is happening, which is precisely the reader who has stopped
  scrolling to read a comment.

  Both now take the content position from the same helper the anchor and the rendered range
  read, and both parameters that carry it are named for the space they are in rather than for
  the scroller — the name is what made two callers pass the wrong number, and the range's own
  parameter carried the same wrong hint one line away.

  Nothing painted wrong before this, and that is why it survived a release: the rendered range
  was computed correctly, so no row was ever missing from the DOM and no blank space ever
  appeared. Only the reporting was wrong — `onVisibilityChange`, the per-item visibility a
  component renders from, and anything a consumer drives from them: read receipts, impression
  counts, lazy-loading of media. For the duration of a held correction those described the
  wrong comments, and a hold lasts as long as an iOS fling does.

  Three reads deliberately stay in scroll space, and the split is now stated once where the
  two offsets are taken: the offset published to consumers, `atBottom`, and the edge callbacks
  that drive pagination. All three are about the scrollbar, and the scrollbar is the one part
  of the view a held correction is deliberately hiding from — it has not moved with the
  content, and these three are asking where it is.

  iOS-only, since nothing else holds a correction. Off iOS the write is taken and the two
  spaces coincide, which is asserted directly rather than assumed.

  New coverage drives a correction of a viewport and a half, so the row at the raw offset and
  the row the content is showing are provably different rows — with a smaller one the two
  windows overlap and an assertion passes either way. It then asserts that the row the shift
  is holding under the viewport top is still reported visible and that nothing reported a
  leave, where reading the band in scroll space reports all eight visible rows as having left;
  and that a dwell deadline elapsing mid-hold reports that row, where reading the band in
  scroll space restarts the dwell on the scrollbar's rows and reports nothing at all. Both
  rows are derived from the size cache rather than named, so neither assertion survives the
  arithmetic drifting out from under it.

## 0.5.0

### Minor Changes

- a2b6281: Hold the view during an iOS gesture, instead of lurching by every correction.

  iOS will not move the scroll offset while a touch gesture is in progress. Writing
  `scrollTop` during a fling cancels it — which is what the momentum write gate fixed — and
  writing it under a finger is undone by the gesture's own baseline. So a scroll correction
  mid-gesture fails in _both_ directions, and the gate's answer of deferring it left the
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
    _is_: computing them from the raw offset while a shift is outstanding centres the mounted
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
  correction's _size_, which depends on how wrong the demo's estimate happens to be at the
  device descriptor's viewport rather than on anything the library does.

### Patch Changes

- 8424eda: Stop cancelling iOS momentum scrolling from `engine.publish()`.

  Writing `scrollTop` during a fling cancels it on iOS WebKit. The library guarded against
  that, but the guard lived inside the scroller and only `scroller.write()` consulted it —
  while `engine.publish()` wrote scroll offsets directly, from two places, gated only on
  `!scroller.isScrolling()`. That flag is about _programmatic_ scrolls, so a user's momentum
  fling was precisely the state in which it let the write through. In a list with
  variable-height rows, every row measured on mount mid-fling took that path, which is very
  nearly all of them: momentum died on the first frame after the finger lifted. A list with
  uniform rows and an accurate estimate produced no correction, no write, and no symptom,
  which is why this went unnoticed.

  The decision now lives in one place — an internal `ScrollWriteGate` — and the engine's two
  writes consult the same answer. An eslint rule fails the build on a third ungated
  `setScrollOffset` call, since two releases of exactly that is how this arrived.

  Two further fixes fall out of it:

  - **The grace period never bounded a fling.** `IOS_TOUCH_GRACE_MS` is 150ms and iOS
    momentum runs for one to three seconds, so the old guard reopened mid-flight and the
    next banked correction killed the scroll anyway. The gate is now a state machine —
    `idle → touching → grace → momentum` — that stays shut until the platform reports the
    scrolling over, via `scrollend` where available and the settle helper's scroll debounce
    where not. The 150ms timer keeps its real job of bridging `touchend` to the first
    momentum event, and two escape hatches guarantee the gate cannot wedge shut: a
    `touchend` that never scrolls reopens on that timer, and a fling that never settles
    reopens at a 3s cap.
  - **A `scrollToIndex` issued mid-fling no longer spends its deadline while refused.** With
    the closed window now measured in seconds rather than milliseconds, the convergence loop
    would otherwise burn `SOFT_DEADLINE_MS` and resolve `deadline` with a large deviation for
    a scroll never given a chance to write.

  A prepend still writes through a shut gate, deliberately: deferring a _model_ change would
  move the reader by the whole inserted height, which is the one thing an anchored list
  promises cannot happen. Only _measurement_ corrections are postponed. `publish`'s parameter
  changes from a boolean to `'none' | 'measure' | 'model'` to carry that distinction by cause
  rather than by a size threshold, which this file has never had.

  Two honest caveats on that. A postponed correction is re-derived from the anchor when the
  gate reopens — but the scroll listener re-derives the anchor from the actual offset on every
  momentum event, so after a real fling the replay normally finds nothing left to do and the
  correction is _dropped_ rather than applied. That is the right answer for a wobble the
  reader has already scrolled past, and it genuinely replays only where no scroll intervened
  (a tap, or the hard cap). And the `'measure'`/`'model'` split is a proxy for "did content
  above the anchor move", which it does not capture exactly: a measured `header` or
  `stickyHeader` slot moves the list's origin, so it is a model change wearing a measurement
  label. Both are noted in the source; neither is a regression against 0.4.0, where the write
  was simply unconditional.

  Nothing changes off iOS: the gate binds no listeners, arms no timers, and `canWrite()` is a
  constant `true` on Chromium, Firefox and desktop WebKit.

  Verification is still partly manual. A new `mobile-webkit` Playwright project runs real
  WebKit behind an iPhone descriptor, so the gate is live and the suite can prove no write
  escapes a gesture — but Playwright produces no actual momentum, so that momentum _survives_
  remains a real-device check. New `momentum.dom.test.ts`, `settle.dom.test.ts` and
  `engine.ios.dom.test.ts` cover the rest; the last of those is the first engine-level iOS
  coverage this package has had, and its absence is the reason the bypass survived.

## 0.4.0

### Minor Changes

- e9f1922: `VirtualList` now sets `scrollbar-gutter: stable` on the scrollport it creates. Opt out with
  `stableScrollbarGutter={false}`; an explicit `style={{ scrollbarGutter: … }}` still wins, and
  nothing is written under `windowScroller`.

  **Changed, not fixed** — a list that never passed the style gets a reserved gutter it did not have
  before. Visually that is a narrow strip on the right of a list short enough not to overflow.
  Functionally it is the fix.

  **The failure it prevents is internal to the component, which is why it is the default.** The list
  mounts and measures its first rows against a scrollport with no scrollbar. Enough of them are
  measured that the content overflows, the browser inserts a scrollbar, and the scrollport gets
  narrower — so text wraps differently and every height taken before that moment is now wrong. The
  list correctly throws all of them away. But those rows are outside the window by then and nothing
  will re-measure them: they keep their estimate for good, and every offset derived from them is out
  by the difference. What a consumer sees is a scrollbar slightly the wrong length and a
  `scrollToKey` that overshoots on a cold list, neither of which points back at a scrollbar that
  appeared once, seconds ago.

  Nothing in that reasoning is application-specific. It holds for any virtualiser that measures
  variable-height rows in a scroller it owns, which is exactly what this component is — so a setting
  every correct call site must pass, for a reason the caller cannot see, is the component's default
  rather than the caller's responsibility. Without it, the fourth list someone adds is silently
  wrong until somebody notices.

  The counter-argument is that a library should not impose layout, and it is thin here: the gutter is
  reserved only on a scrollport the library itself created, it is the width the scrollbar was going
  to take anyway, and it is one prop to turn off.

  **Ignored under `windowScroller`** whatever the prop says, because there the page is the scroller.
  Reserving a gutter on the document is the host page's decision, and a list is not entitled to make
  it.

  **`both-edges` is deliberately not a value.** It is a layout preference rather than a correctness
  one, and `style` already reaches this element — so a consumer who wants it, or who wants `auto`
  back, has one without the prop growing a third state.

  Consumers already passing `style={{ scrollbarGutter: 'stable' }}` by hand see no change: same
  computed value, and the merge order keeps their declaration winning either way. That line can go
  whenever it suits, and nothing breaks if it never does.

  The React entry's size budget moves from 11.7 kB to 11.95 kB, against an actual of 11704 B. Both
  this and the deferred notifications fit under the old ceiling on their own and are 4 bytes over it
  together, which is the ceiling behaving exactly as intended — and also the shape of budget that
  stops being a budget: with 46 bytes of headroom the next change is discussed on its file size
  rather than on its merits, and the one after that gets the ceiling raised in a hurry by whoever
  happens to be holding it. 250 bytes is enough room to have the argument properly. The core entry
  is untouched at 9.38 kB against 9.5 kB, and the gap between the two entries stays ~2.3 kB — the
  figure worth watching, because it says the React layer is still a translation rather than a second
  implementation.

### Patch Changes

- 831bbeb: `onVisibleRangeChange`, `onAtBottomChange` and `onEdgeReached` are handed to the consumer a
  microtask after the publish that caused them, instead of synchronously from inside it. Setting
  state from any of the three is now safe.

  **The bug was that a publish is not always post-commit.** Options are pushed into the engine
  _during_ render — deliberately, so a prepend is positioned in the very commit that renders it — and
  `setOptions` publishes. Anything called synchronously from that publish therefore runs inside
  React's render phase, and a consumer's `setState` there is the cross-component update React
  refuses:

      Cannot update a component (`Thread`) while rendering a different component (`VirtualList`).

  The stack trace points at the consumer's `setState`, so the callback reads as the thing doing
  something wrong. Nothing at the call site says otherwise: a callback named `onVisibleRangeChange`
  is indistinguishable from a post-commit one until it isn't.

  **The hazard was already understood in this file, and only half of it was guarded.** The re-render
  subscription has hopped a microtask since it was written, with a comment explaining exactly this;
  the notification subscription immediately above it did not. One of two subscribers to the same
  store was safe and its sibling was not, for no reason anyone had decided.

  `onEdgeReached` was the worst of the three and the last to be noticed, because it needs no
  interaction at all to reach. A list that opens at the top is already at its start edge, and the
  publish that notices sits in the same render that hands the engine its options — so _"where you
  load the next page"_, which is a `setState` by definition, ran during render on mount for every
  consumer following the documentation.

  **What is decided at the emission stays at the emission; only the hand-off moves.** The
  de-duplication refs are still written synchronously, so the comparison happens in publish order and
  each notification carries the value that caused it rather than re-reading a ref that has since
  moved on — a burst inside one tick is delivered as the sequence of ranges that actually occurred.
  `onEdgeReached`'s latch and its suppression during a programmatic scroll also stay where they were,
  in the engine, so the suppression still reads the scroll state as it was rather than as it is a
  microtask later.

  **Nothing cancels a scheduled hand-off when the subscription ends**, which is a decision rather than
  an omission and is now pinned by a test. StrictMode runs the effect's cleanup _before_ the queued
  microtask, while the reported-value refs deliberately live outside the effect — so a `disposed`
  guard would drop the opening report, and the remount pass, finding it already reported, would queue
  nothing to replace it. Consumers would learn where the list started in production and not in
  development. What not guarding costs is one late call when a publish and an unmount land in the same
  tick, which React absorbs.

  **The one visible timing change**: the first range and the first at-bottom state now arrive one
  microtask after mount rather than inside the mounting effect. Both were already post-commit, so
  neither was unsafe — they are deferred anyway so the callback has one timing contract instead of a
  contract that depends on which publish it came from. If you depended on the opening report landing
  before your own first post-mount effect, that is the line to read twice.

  Two paths are deliberately **not** changed: `onVisibilityChange` and `useItemVisibility`'s
  subscription are reachable from the same `publish`, but neither could be driven during a render in
  jsdom — visibility needs real layout and a real IntersectionObserver — and a fix nothing can
  demonstrate is a fix nobody can keep.

- 4e156c6: The last two notifications the React adapter forwards — `onVisibilityChange`, and the
  subscription behind `useItemVisibility` — are handed over a microtask, the same way the other
  three now are. Every callback this adapter routes to a consumer, and every wake-up it gives React,
  now has one timing contract: after the publish that caused it, never inside it.

  **These two have no crash behind them, which is the honest reason to say so here.** `publish`
  samples visibility at its end, so they sit on exactly the stack that made
  `onVisibleRangeChange` and `onEdgeReached` fail, and `useItemVisibility` is a store waking React
  from a subscription — the same shape the hook's own `useSyncExternalStore` subscription has always
  deferred. But nothing drives them during a render in practice. A rule with a `dwellMs` reports
  `enter` from a timer rather than from the sample, and every attempt to force one produced events
  only after the commit: in jsdom against a stubbed observer, and against the demo in a real browser
  with the dwell taken down to zero.

  So this is uniformity rather than a fix, and it is worth the bytes because the alternative is what
  the previous release was: one hand-off guarded, its neighbour not, for a reason nobody had written
  down. The next person to add a rule that emits from a sample should not have to rediscover it.

  Each visibility event still carries an `at` stamped where it was sampled, so a batch describes when
  it was taken rather than when it arrived — dwell arithmetic downstream is unaffected.

## 0.3.0

### Minor Changes

- f2c6f98: Following the output of a list that is still growing: `followOutput`, `alignToBottom`,
  `onAtBottomChange` with `atBottomThreshold`, and `onEdgeReached` with
  `edgeReachedThreshold`. A chat, a log tail, a thread with a live reply arriving.

  **Following is a mode, not an anchor value**, and that is the design decision the rest
  follows from. The tempting implementation is to name the last key with an offset past its
  own end and let the existing restore path do the scrolling — it does not survive contact
  with the platform. `resolveAnchorOffset` happily returns an offset past the reachable
  maximum, the browser clamps the write, `carryFor` discards the excess as too large to
  carry, and the clamped read-back then fails `isSelfWrite`'s 1.5px tolerance — so the
  scroll listener re-derives the anchor from wherever it actually landed. The pin is
  destroyed on every publish while content grows, which is precisely when following
  matters. So the bottom is asked of the browser, the way `align: 'end'` already asks for
  the last item, and for the same reason: at the very end our own arithmetic is not what
  the scroller will accept.

  **It writes, but it does not suppress the anchor.** The engine keeps two self-write
  queues that look interchangeable and are not: the scroller's says "this offset is mine,
  do not read it as the user grabbing the scrollbar", and the engine's `restoreIntents`
  says "do not re-derive the anchor from this", which is right for a correction whose
  read-back may be pixel-snapped and wrong for a move. Following is a move. Pushing to both
  left the anchor describing wherever the reader was before they were pinned, so the moment
  following stopped — the option flipping off, the reader scrolling back — the next publish
  restored that stale position and the view jumped backwards. Found by the test for exactly
  that, which is the case a consumer hits by toggling a prop.

  **Instant, not animated.** The API is `followOutput?: boolean` rather than virtuoso's
  `false | 'auto' | 'smooth'`, and dropping the third value was deliberate rather than
  lazy. Smooth following has to reach the same place instant following does, or `atBottom`
  reports `false` while the list is actively following itself; but the scroller's only
  entry point is `scrollToIndex`, which with a footer present stops at the last _item_,
  short of the true bottom by the footer's height. Reaching the true bottom smoothly would
  mean a second entry point in the file that decides where every scroll lands. It is not
  worth it for a behaviour whose own documentation would have to warn against using it:
  under rapid appends the destination moves every frame, and an animation chasing that is
  the hazard the README's fetching contract already describes.

  **`atBottom` is measured against the viewport, twice from the same source.** Not
  `totalSize - scrollOffset - viewportSize`: `getMaxScrollOffset` derives from an integer
  `clientHeight` while `getViewportSize` uses the exact float content height, so a
  predicate straddling the two flickers on the sub-pixel difference. Nor
  `visibleRange[1] === count - 1`, which `indexAt`'s clamping makes true for any list
  shorter than the viewport at any scroll position at all. A list with no scroll range is
  at its bottom, because its end is on screen.

  **Letting go uses input as the gate and position as the test.** `ScrollerOptions` gains
  `onUserInput`, fired from the listener that already cancels an in-flight scroll on a
  wheel, touch, pointer or key. A scroll with no input behind it decides nothing, because
  the browser moves `scrollTop` by itself when content shrinks and when a window of items is
  replaced — and reading that as intent would unpin a reader who touched nothing. The
  scroller's own comment already argued this for cancellation; it is the same argument.

  **Letting go is immediate; taking hold again waits for the scrolling to stop**, and the
  asymmetry is load-bearing in both directions. Unpinning cannot wait: following writes the
  bottom on every publish, so staying pinned for even a few frames while the reader scrolls
  away drags them back under their own hands. Re-pinning cannot be decided on the same
  event: the first scroll after a wheel routinely arrives while the scrolling is still in
  flight — momentum, an engine that scrolls asynchronously, or simply a loaded machine — so
  the position is not yet at the end, following stays off, and the settle that follows
  carries no input to reconsider it. A reader who scrolled back to the newest message never
  got re-pinned. Found on WebKit, then reproduced on Chromium under load.

  The re-pin is therefore decided on a 150ms quiet window after input-driven scrolling, with
  `scrollend` short-circuiting it where the platform sends one. `scrollend` alone was tried
  and is not enough, which is measurable rather than defensive: `supportsScrollEnd()` only
  asks whether the property exists, and Firefox has the property while firing **zero** events
  across a 700ms wait for a sequence of wheel deltas — the exact gesture this feature is
  about. That is the same relationship the scroller already has with the event: corroboration
  for latency, never the mechanism.

  **`onEdgeReached` is suppressed while a programmatic scroll is in flight.** This is the
  point of it existing rather than being left to `onScroll`. The README tells consumers not
  to fetch during a programmatic scroll and both demos hand-rolled the guard; owning the
  callback makes the mistake unavailable instead of merely documented. What remains the
  consumer's is the part that is genuinely a product decision — whether there is more to
  load and whether a fetch is already running. It is latched per crossing rather than
  deduped by identity, because reaching an edge is an event and not a value.

  **`alignToBottom` is a fifth contribution to the slot composition**, not a mechanism of
  its own: space above the items is what `scrollMargin` has always meant, so it composes
  into the same inset the measured slots feed. Written as a margin on the item container
  rather than a spacer element — the container is already a node the surface owns and whose
  height it already writes, where a spacer would need a node in every adapter and a ref to
  reach it. Margins are refused on _items_ because no ResizeObserver box includes them;
  that argument does not apply to a box whose size is written rather than measured. It is
  computed before the anchor is derived at mount, because an anchor taken against an origin
  of zero and then resolved against the real one is wrong by the whole spacer.

  Smaller changes:

  - `cancelScroll` reaches the React layers. It has been on the engine since the engine
    existed and was exposed by neither the hook nor the component, so every consumer that
    did not build its own engine could start a smooth scroll and had no way to stop it.
  - `VirtualState` gains `atBottom`, deliberately absent from `needsRerender` — a scroll
    that merely reaches the end within the mounted set still costs no React work, and
    `onAtBottomChange` is fed from a store subscription in the same shape as
    `onVisibleRangeChange`. Its ref seeds to `null` rather than to the empty state, whose
    `atBottom` is `true`: seeding from that would swallow the opening report of every list
    that starts pinned, which is the one report a chat cares about.
  - Both demos lost their hand-rolled distance-to-bottom arithmetic. The thread demo had
    _two_ copies — an `onScroll` handler reading `scrollTop`/`clientHeight`/`scrollHeight`
    off the element, and a `window` listener doing the same against
    `scrollY`/`innerHeight`/`documentElement`, because the host's `onScroll` never fires
    when the page is what scrolls. The library knows which one it is.

  The size budgets move with it, which is a decision rather than an accident: 9 kB → 9.5 kB
  for the core entry and 11 kB → 11.7 kB for the React one, against actuals of 9.38 kB and
  11.65 kB. Two features have landed on top of the 8.45 kB those ceilings were set around,
  both of them in the core so that a Vue or Svelte adapter would inherit them. The previous
  ceiling left 70 bytes of headroom, which is not a budget so much as a tripwire; ~250
  bytes is enough for the next change to be discussed on its merits. The gap between the
  two entries is unchanged at ~2.2 kB, which is the figure worth watching — it says the
  React layer is still a translation and not a second implementation.

- 8a550c4: `VirtualList` gains four measured slots for content that shares the scroller with the list —
  `header`, `stickyHeader`, `footer` and `stickyFooter` — replacing the `before` prop, whose
  height the consumer had to declare twice and keep in step by hand.

  **The slots are measured, and the view does not move when one resizes.** This is the whole
  point, and it is the one thing none of the prior art does. virtua leaves the height of content
  above the list to you as `startMargin`; TanStack leaves it to you as `scrollMargin` and
  documents "to dynamically measure this you can use `getBoundingClientRect()` or
  ResizeObserver"; react-window declined a footer outright. react-virtuoso does measure its
  `Header`, but nothing compensates the scroll position when that measurement changes, so a
  header that decodes an image or swaps a font shoves the view down mid-read — virtua #458,
  react-virtuoso #1245 and react-window #520 are the same bug filed three times.

  Measuring is safe here because the anchor names a comment rather than an offset. A slot's
  height feeds `ListGeometry.margin`; when it changes, `resolveAnchorOffset` derives a
  `scrollTop` larger by exactly the same amount, and the two movements cancel. There is no
  compensation code, no scroll-direction check and no threshold — it is the prepend argument
  applied to chrome, and it needed no new mechanism to work.

  **Two channels, not one.** A `position: sticky` slot occupies in-flow space _and_ covers part
  of the scrollport, so it counts towards both where the list begins and how much height the
  items can use:

      margin       = scrollMargin       + header + stickyStart
      paddingStart = scrollPaddingStart +          stickyStart
      paddingEnd   = scrollPaddingEnd   +          stickyEnd
      spaceAfter   =                      footer + stickyEnd

  react-virtuoso needed `headerHeight` and `fixedHeaderHeight` as separate measured values for
  exactly this reason; TanStack conflated the two into `paddingStart` and had to add
  `scrollPaddingStart` afterwards to recover the distinction (#265). This library already had
  the split — `scrollMargin` against `scrollPaddingStart` — so the slots feed the channels that
  existed rather than inventing a third.

  **`ListInsets` gains `spaceAfter`, for one caller.** `scrollToIndex`'s `align: 'end'` shortcut
  on the last item deliberately asks the browser for its maximum scroll offset instead of
  trusting our own arithmetic, because borders and padding outside the list still occupy
  scrollable space. With a footer below the items that maximum is past the last comment, so
  "scroll the last comment to the bottom of the screen" would have scrolled to the footer and
  left the comment off the top by its height.

  `spaceAfter` is read as a **predicate, not a quantity**: non-zero means the trailing space has
  been measured, so the shortcut is skipped and the general alignment handles the last item from
  exact offsets. It is deliberately never subtracted, and that is not fastidiousness — a sticky
  footer is in-flow content _and_ overlapping chrome, so it lands in `spaceAfter` _and_ in
  `scrollPaddingEnd`, and subtracting takes it twice. The warning is on the field rather than in
  a scroller comment, because the field is where the next person looking for a number to subtract
  will land. Nothing else in the conversion touches it: a footer is below every item, so it
  cannot move where any of them sits.

  **A geometry or `gap` change is now treated as a model change.** `setOptions` computed
  `modelChanged` from the key set and the estimator only, so a changed `geometry` fell through
  to `publish(false)`: the anchor was not re-applied and any in-flight programmatic scroll was
  not told its target had moved. For `gap` this was latent — changing spacing mid-scroll is
  rare. For `geometry` it stopped being latent the moment a measured header started feeding
  `scrollMargin`, because that is a geometry change arriving on its own, mid-scroll, on every
  list that has a header. Both are fixed together.

  Insets are compared **by value** for that decision, not by reference, and the difference is
  load-bearing. Re-aiming an in-flight scroll also pushes back the convergence loop's 150ms
  quiet window, so a consumer whose `geometry` object is rebuilt on an unrelated render would
  keep a smooth `scrollToKey` from ever going quiet: it runs to the 5s hard deadline and
  resolves `{ settled: false, reason: 'deadline' }` with the scroll still in flight. That
  appeared as one failure per full Playwright run — a different scenario each time, which is
  what an intermittent timing regression looks like — and comparing the four numbers instead of
  the object identity is what removed it.

  **The zero-height question, which the item path never had to answer.** An item measuring zero
  is always refused: no real comment is 0px tall, and a zero slot in the prefix sum collapses
  the geometry. A slot can legitimately be zero — an empty footer, a header whose content has
  not arrived — and refusing that would leave its space behind forever, which is
  react-virtuoso #1203. But `display: none` measures zero too, and reading a hidden tab as "the
  header went away" would restore the anchor against a scroller that cannot scroll, clamp the
  write to zero and lose the position for real. The two are separated by whether the element has
  any client rects at all, consulted only for a zero measurement.

  Smaller changes that came with it:

  - The headless `useVirtualList` returns `headerRef`, `stickyHeaderRef`, `footerRef` and
    `stickyFooterRef`, so a consumer writing their own markup gets the same measurement rather
    than inheriting the contract the slots exist to remove. One ref each rather than one
    parameterised by slot, unlike `itemRef`: the set is closed at four, so naming them costs
    nothing and reads as markup instead of as a lookup. The engine keeps a `slotRef(slot)`
    underneath, which is where the per-slot memoisation lives and what an `onEngineReady`
    consumer would reach for.
  - `ListGeometry.visibleSize()` is floored at zero and shared with the scroller as
    `visibleSizeOf`, which had been subtracting the padding itself. A second copy of that
    expression was a tidiness complaint until sticky slots started feeding
    `scrollPaddingStart`; a copy that forgot them would land every `align: 'end'` behind the
    sticky footer. Chrome taller than the scrollport is reachable now — a composer and a filter
    bar on a phone in landscape — and a negative height would invert the visible band, which
    does not report "nothing is visible" so much as silently stop every visibility event.
  - Slot wrappers get `display: flow-root` and a `data-virtual-slot` attribute. The attribute is
    the entire styling API for them: react-virtuoso wraps header content in a div nobody can
    reach and had to add a stringly-typed `headerFooterTag` prop so people could change even the
    tag name. Taking `ReactNode` rather than component types also avoids its "do not inline the
    components definitions" caveat and #407.

  **Breaking:** `before` is removed. Replace it with `header` and drop the matching
  `scrollMargin` number — the slot is measured, so there is nothing left to keep in sync.
  `scrollMargin` itself stays, and now means only what it always described: how far the list
  sits down the document, which is what `windowScroller` needs. It composes additively with a
  measured header rather than being replaced by one.

  The `align: 'end'` shortcut deserves its own note, because the first two attempts at it were
  wrong and the Playwright suite caught both. Subtracting `spaceAfter` from the browser's
  maximum double-counts a sticky footer, which is in-flow content _and_ overlapping chrome, so
  it lands the last comment exactly one composer-height too low — behind the composer, at
  80.25px out in all three engines. Correcting for that lands Chromium and WebKit exactly and
  Firefox 0.55px short, which is `getMaxScrollOffset` being built from an integer
  `clientHeight`. So the shortcut is now taken only when `spaceAfter` is zero: it exists for
  trailing space that _cannot_ be measured, and once the trailing space is known, our own exact
  float offsets are the better answer and the general alignment already computes them.

  Bundle size moves from 8.45 kB to 8.96 kB for the core entry and 10.35 kB to 11.08 kB for the
  React one, minified and brotlied, and the figures the README quotes move with them. The core
  budget is unchanged at 9 kB; the React one goes from 11 kB to 11.2 kB, because four named slot
  refs cost the ~70 bytes of headroom that were left and then eleven more. That is the trade the
  API is worth: `ref={list.headerRef}` reads as markup where `ref={list.slotRef('header')}` reads
  as a lookup, and the set of slots is closed at four so there is nothing to parameterise over.

## 0.2.0

### Minor Changes

- 268de04: `estimateSize` and `defaultEstimate` now work when set through `useVirtualList` or `VirtualList`.
  Until this release they were accepted and silently dropped: `estimateSize` was called zero times, and
  every unmeasured item was laid out at the internal 120px default no matter what you supplied.

  `SizeCache` read both options in its constructor only, and `engine.setOptions` never forwarded
  them — while the React adapter supplies options exclusively that way, because the engine is derived
  from a scroll element that does not exist on the first render. So the wrapper the adapter builds to
  map a key back to an item was unreachable code. It was found by driving that file's coverage to 100%
  and noticing the wrapper had never executed.

  `SizeCache` gains `setEstimateSize` and `setDefaultEstimate`, both following `setKeys`: a reference
  check, then a full rebuild of the offset tree. The rebuild is not an optimisation to skip. `setSize`
  folds a first measurement in incrementally, as `size - (previous ?? estimateFor(index, key))`, so a
  slot built with one estimate and adjusted against another is wrong by the difference — permanently,
  because nothing recomputes it. There is a test that measures an item after changing the estimator and
  asserts offsets are still exactly invertible.

  A changed estimate moves every unmeasured item, so `setOptions` now treats it like a prepend: the
  anchor is re-applied and any in-flight programmatic scroll is re-aimed. Because the anchor names a
  key rather than an offset, the view does not move — which is the property that makes re-estimating
  safe at all, and is what react-window's #863 is about.

  Two smaller changes come with it:

  - `estimateSize` may now return `undefined`, meaning "no opinion about this item", which falls
    through to `defaultEstimate` and then to the learned median. The React adapter uses this for a key
    it cannot resolve to data, instead of reproducing the fallback itself.
  - `defaultEstimate` is tracked separately from the estimate actually in use. They shared one field,
    and a caller passing a constant every render would have compared it against a median the estimator
    had since learned, found them different, and overwritten the better number — rebuilding the tree
    each time.

  **This changes item placement** for anyone passing `estimateSize`, which is the point: you now get
  what you asked for rather than a median of what happened to be measured. Note the corollary — a
  caller-supplied estimator disables the median estimator, as documented, so a _bad_ estimate is now
  genuinely worse than none. The demo's own estimate was wrong by 270px at the long end and has been
  refitted against measured heights; it had never mattered before.

- c9f0c34: One answer to "what does the page scroll", and one mechanism for `scrollerRef`.

  Three places used to decide this independently: `createWindowViewport` clamped scroll targets against
  `documentElement.scrollHeight`, the React adapter fingerprinted the layout from `documentElement`, and
  `VirtualList` handed `document.scrollingElement` to `scrollerRef`. In standards mode all three are the
  same element, so the disagreement was invisible. In quirks mode `body` is what scrolls, which made two
  of them wrong — and the clamp especially so, since clamping against something that is not the scroll
  extent is the TanStack #1001 failure the `Viewport` interface's own documentation warns about.

  `documentScrollElement(view)` is now exported from the core and is the only implementation.
  `Viewport` gains `getScrollportElement()` — the node that scrolls — kept deliberately distinct from
  `getElement()`, which remains the measurement and input scope and remains `documentElement` for a
  document scroller. Conflating those two once made every content growth look like a viewport resize and
  discarded the whole measurement cache, so the distinction is load-bearing rather than pedantic.

  The layout fingerprint now follows the scrollport at both of its call sites, which had to move
  together: the adapter seeds the signature and the engine recomputes it on the first scrollport
  observation, and had only one of them moved, that first observation would have seen a change and
  cleared every measurement, restored snapshots included.

  `scrollerRef` is published from the ref callback in both modes instead of from the ref callback in one
  and an effect in the other. That gives the prop a single lifetime and a single timing — the commit ref
  phase, which is what keeps a consumer's `useEffect(…, [])` from finding the ref empty — and it removes
  an effect that re-published the page scroller on every render whenever the call site passed an inline
  ref.

  Nothing observable changes for a standards-mode consumer, which is every real one. `Viewport` gaining
  a required member is the reason this is a minor rather than a patch: anyone implementing that
  interface by hand has to add it.

- 43b6290: Four additions for consumers, and one removal.

  **A trailing-edge visibility rule.** `{ mode: 'edge', edge: 'start' | 'end', tolerancePx }` is
  satisfied when the named edge of an item is inside the visible band, which makes it the only rule
  that works whatever the item's height is. Every fraction has a hole: `of: 'item'` is unreachable
  above `viewport / fraction`, `of: 'viewport'` unreachable below `fraction × viewport`, and `full`
  unreachable for anything taller than the viewport. A thread containing both one-liners and
  fourteen-paragraph essays has no single correct fraction — one setting marks a long comment read
  with half of it still below the fold, the other never marks it at all. `edge: 'end'` is "they got
  to the end of this". `tolerancePx` defaults to 1 and stacks on `rootMargin`. Like `{ mode: 'any' }`
  and unlike the fraction rules it does not require a measurement, because withholding the event
  would read as "not read" rather than "not sure"; the event reports `measured` truthfully instead.

  **`scrollerRef` on `VirtualList`.** The handle is the scroll API; this is the node, for a consumer
  sharing the scrollport with pull-to-refresh, a scroll-linked gradient or a third-party scroll
  library. Without it the only routes were a `firstElementChild` off a wrapper or a marker class,
  both of which put this component's DOM shape in the call site. Under `windowScroller` it resolves
  to `document.scrollingElement`, since the page is what scrolls.

  **`onEngineReady` on `VirtualList`.** `useItemVisibility(engine, key)` was presented as a
  first-class API that no component consumer could reach — and `Engine` was not even re-exported
  from `virtual-anchor/react`. Both are fixed. A callback rather than a field on the handle because
  that hook subscribes through the engine, so it has to be reactive: in element-scroller mode there
  is no engine until the scrollport ref has attached, and a handle read during render would return
  `null` forever. It is called with `null` on teardown, so a consumer holding it in state cannot keep
  subscribing to a disposed engine.

  **`onVisibleRangeChange`, replacing the `visibleRange` field.** `useVirtualList` no longer returns
  `visibleRange`; it returns `getVisibleRange()` and accepts `onVisibleRangeChange`. The field was a
  trap. `needsRerender` deliberately omits the visible range — a scroll that moves it within the
  mounted set produces no React work at all, which is what makes most scroll frames free — so a
  field fed from the render snapshot sat still through exactly the scrolling it described.
  `renderedRange` stays a field, and the asymmetry is the point: that one _is_ part of
  `needsRerender`, so a render always sees a current one. The notification comes from a store
  subscription and costs no renders of its own.

  The component's own keyboard paging was affected and is fixed with it: with nothing focused,
  PageDown started from the snapshot's range, which could be a whole buffer out of date.

  The README's migration table offered `visibleRange` as the answer to Virtuoso's `rangeChanged`,
  which no `VirtualList` consumer could reach at all. That path now exists.

### Patch Changes

- d659433: Drop the `subscribeWithSelector` middleware, and make an unchanged index range publish the same tuple.

  The store was wrapped in zustand's `subscribeWithSelector`, whose whole purpose is the
  `subscribe(selector, listener, { equalityFn })` overload — but the exported `VirtualStore` type is
  plain `StoreApi<VirtualState>`, which erases that overload. So the middleware shipped in every
  consumer's bundle and no typed caller could reach it. All three subscription sites used the
  one-argument form. Removing it alone would take the core entry from 8.46 kB to 8.35 kB; the tuple
  memoisation below adds a little of that back, for a net 8.42 kB core and 10.36 kB react.

  The reason it was there at all — deduping notifications — is now handled where it belongs.
  `computeRanges` allocated a fresh `visibleRange` and `renderedRange` tuple on every publish, which is
  once per scroll frame and once per React render, so tuple identity meant nothing and every subscriber
  had to compare element-wise. The engine now hands back the previous tuple while the range is
  unchanged, and the adapter's visible-range notification is a reference check. `EMPTY_RANGE` is
  exported and shared so an empty list keeps publishing one reference rather than a fresh `[0, -1]`
  each time.

  `visibleRange` is still deliberately absent from `needsRerender`. Identity stability makes including
  it cheap but no more desirable: it would put a React render on every item boundary crossed while
  scrolling, which is exactly the zero-render property the library is built around.

## 0.1.1

### Patch Changes

- 1e2cfaf: State the measured bundle size on the npm page.

  Minified and brotlied, including zustand: 8.34 kB for the core entry and 9.96 kB if you import
  the React adapter, which contains the core rather than duplicating it — the two entries share a
  chunk. Both numbers are enforced as CI budgets, so the README cannot drift from what ships.

  This is also the first release published through npm trusted publishing: no token exists, and
  the tarball carries a provenance attestation linking it to the commit and workflow that built
  it.

## 0.1.0

### Minor Changes

- da2b802: Initial release.

  A virtual list that models scroll position as an anchor — "this pixel of this item" — rather
  than a pixel offset into an index-addressed list. Prepending cannot move the view,
  measurements landing above the viewport need no compensation heuristic, and `scrollToKey`
  converges to a fixed point instead of computing one offset and hoping.

  Two entry points from one package: `virtual-anchor` is framework-agnostic, and
  `virtual-anchor/react` is a React 19 adapter. React is an optional peer, so the core entry
  pulls in no framework.

  Also two things no existing virtual list offers: per-item viewport events with configurable
  threshold, dwell and fire-once semantics, and a settle promise that reports honestly when it
  could not get there, with a reason.

  Sub-pixel landing verified on Chromium, WebKit and Firefox across alignments, scroll padding,
  a list sharing its scroller with other content, and the window scroller — with the whole
  12,000-comment thread loaded, so the distances and the offset tree are real.

  Not verified on real iOS hardware: the momentum-deferral path is written from the spec and
  exercised only in a desktop WebKit build.
