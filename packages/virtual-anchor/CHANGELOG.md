# virtual-anchor

## 0.9.1

### Patch Changes

- c7c6e34: The gesture fold now aims at where the content is, not at where `scrollTop` is, so an outstanding carry survives it.
  
  `reconcileGestureShift` turns a banked gesture shift back into a real scroll offset when the
  momentum gate reopens, and its whole promise is that nothing moves while it does: the content
  jumps back by the shift as `scrollTop` moves forward by it. It built its target as
  `scrollTop + shift` — from the raw offset, while the content was sitting a `carryBefore`
  further on, because the visible position is `scrollTop` plus the paint offset and never
  `scrollTop` alone. `commitScroll` then *replaces* the carry with its own truncation residual
  rather than accumulating it, so nothing was left holding the difference and the reader saw the
  content shift by up to a pixel exactly as a fling ended.
  
  Only reachable on a platform that refuses fractional scroll offsets, which is the only platform
  the fold runs on: WebKit truncates every write, so the carry is non-zero almost always, and
  whether it was non-zero *at the moment the gate reopened* was the difference between a clean
  fold and a visible one. That is why it sat undetected — it needs a fractional carry outstanding
  when a fling ends, and the demo's geometry had to change before the e2e fold assertion started
  landing in that state. It reported `before - after` of exactly 0.75, which is the dropped carry
  and nothing else.
  
  The fix is the read the anchor and the scroller's arrival test already use, for the same reason:
  judging on the scroll offset where the content position was meant is the shape of #33.
  
  The engine now folds to `contentOffset(from)`, so `from + shift + carryBefore` and
  `applied + carryAfter` agree exactly rather than to within a carry.
  
  Two things found alongside it. `contentOffset`'s own documentation says every read that compares
  against an item offset goes through it, "the anchor" named first — and the scroll listener had
  its body written out by hand, so a third compensation term would have missed the hottest anchor
  derivation in the library. It now calls `contentOffset(offset)` with the offset it already read.
  And `commitScroll` never said which coordinate space its argument is in, which is the ambiguity
  that let a raw `scrollTop` in; it says so now.

## 0.9.0

### Minor Changes

- a823dda: `deviation` is now measured against the offset the caller asked for, and a new `clamped` flag on `ScrollResult` says when that offset was outside the scroller's range.
  
  It was documented as "signed px between where the target landed and where it was asked to
  land", and it was not that number whenever the request fell outside `[0, maxScrollOffset]`.
  There it was zero by construction, and every other field agreed the scroll had succeeded.
  `targetFor` clamped its answer, arrival was judged against the clamped target, and `finish`
  recomputed the deviation by calling `targetFor` again — subtracting the clamp from an offset
  already sitting at the clamp. The request was discarded before anything could compare
  against it.
  
  On the demo, a 720px scrollport over 1392px of content, so an offset that stops at 672:
  
  | target | item top | final `scrollTop` | gap from the top | reported |
  | --- | --- | --- | --- | --- |
  | comment-5 | 608.75 | 609 | 0 | `settled:true deviation:0 converged` |
  | comment-6 | 898 | 672 | 226 | `settled:true deviation:0 converged` |
  | comment-7 | 1017.75 | 672 | 345.75 | `settled:true deviation:0 converged` |
  
  Byte-identical in chromium, webkit and firefox — arithmetic, not a platform. The third row
  now reports `deviation: 345.75, clamped: true`, and the first still reports `0, false`.
  
  The condition for a target to be reachable at `align: 'start'` is that it has a scrollport's
  worth of content below it. A short thread does not, so a reader deep-linked to their first
  unread comment is left partway down the screen — correct behaviour from the scroller, and
  previously indistinguishable from a flush landing. The band scales with the viewport, which
  is why it is roughly twice as wide on a desktop window as on a phone, and why it read twice
  as a timing problem.
  
  The clamp itself is right and is kept. `arrived` still judges against the clamped target: a
  convergence loop chasing an offset the platform refuses would run to its deadline instead of
  resolving. No scroll moves differently for it — this is a reporting change.
  
  `settled` and `reason` keep their meanings. `settled` answers "did motion stop with the
  target holding still", which it did, so a clamped landing normally resolves `settled: true`
  and `converged`. `clamped` is a separate axis rather than a new `ScrollEndReason` precisely
  because the two are independent: a list that keeps resizing while its target is also out of
  reach reports `deadline` and `clamped: true` both, where a single slot would have had to
  pick one. It also cannot be re-derived by a consumer, which is the argument for the flag
  over the number alone — that needs `maxScrollOffset` and the target's own content offset,
  and `deviation` on its own cannot be told apart from a scroll that merely ran out of frames.
  
  One behaviour does change. The `align: 'end'` shortcut for the last item returned the
  browser's maximum and dropped the `offset` option on the floor, so an `offset` passed with
  that alignment on that item did nothing at all — and reported `deviation: 0` while doing it.
  It now applies, which is what lifting the last comment clear of a footer asks for. With no
  `offset` the shortcut returns the maximum exactly as before, so the alignment that
  legitimately coincides with the clamp still reports `deviation: 0, clamped: false`.
  
  `align: 'auto'` returns the current offset for an item that is already fully visible. That
  is not a clamp and does not report as one.
  
  Fixes #101.

## 0.8.1

### Patch Changes

- 3cd32da: The convergence loop's deadlines are budgets of frames given, not of wall clock.

  `scrollToKey` resolved `{ settled: false, reason: 'deadline', iterations: 0 }` for scrolls that
  were never given a single frame. The loop is driven by `requestAnimationFrame` and its deadlines
  were measured against `now()`, so a main thread blocked across one — a phone parsing a page of
  content between the call and the first frame, a long task, a backgrounded tab — spent the whole
  budget while no frames were delivered. The first line of `step` to execute was then the
  hard-deadline check, which is what `iterations: 0` was telling anyone who looked: the loop did not
  run once. See #92.

  `scroller.ts` had already drawn this conclusion for the gesture gate, and stated the invariant
  outright — _"A scroll that is not allowed to move must not be allowed to time out either […] a
  loop whose clock kept running through that would burn `SOFT_DEADLINE_MS` and resolve `deadline`
  with a large deviation for a scroll that was never given a single chance to write."_ A starved
  main thread is exactly "never given a single chance to write". It just was not gated on
  `gate.canWrite()`, so nothing suspended the clock for it.

  ### What it cost

  `restrealitaet/rr-forum-frontend#508` — "scroll to comment when opening a thread does not work
  reliably", reported only from a low-budget Android phone. A thread of 15,715 comments landing on
  comment 8000: every open that got the loop even one frame landed flush, and every open that got
  none landed 95px out, reporting `deviation: 0` for it. That list is windowed, so its first aim is
  a sum of estimates and genuinely needs the correction the loop provides; 95px was the estimator's
  error, left uncorrected because the loop that exists to correct it had already resolved.

  Reproducible in the demo with no throttling of any kind, which is what the new e2e case does:
  block the main thread for 5.5s immediately after `scrollToKey`, and comment 8000 lands **145px
  short in all three engines** with the promise reporting a deviation of zero — the model and the
  offset agreeing with each other while both disagree with the DOM.

  ### The fix

  A gap between frames longer than a frame rate could explain is credited back to the clocks the
  deadlines are measured from, instead of being charged to them:

  ```ts
  const stalled = Math.max(sinceTick - MAX_FRAME_GAP_MS, 0);
  const credit = blocked ? sinceTick : stalled;
  if (credit > 0) suspend(current, credit);
  ```

  `MAX_FRAME_GAP_MS` is `MAX_STEP_MS` — not a second literal that happens to equal it, because the
  equality is load-bearing and a relation kept only in prose is a relation nothing keeps. Every
  credit leaves exactly that much of the gap charged, so `tick - lastStepAt` never falls below the
  bound the smooth integrator clamps to, and crediting `lastStepAt` therefore cannot change a single
  smooth step. It is also the one honest answer: "too long to be a frame" is one question, and that
  constant already answered it. The debug analyzer's `FREEZE_MS` is 100ms as well.

  Only the excess is credited, which is what keeps the deadlines meaning anything: a list that will
  not hold still while frames arrive perfectly normally is the case they exist for, and it still
  spends its 2s and 5s. What changes is that the budget now stretches over more wall clock as the
  gaps grow — a device delivering four frames a second gets the same number of chances to converge
  as one delivering ten.

  ### It completes the gate's suspension too

  The same credit closes a hole in the suspension that was already there. The loop _parks_ while
  the gate is shut, so only the frame that noticed ever ran — and the parked span, park to
  `gate.onOpen`, was charged in full to the first waking frame. A three-second fling therefore
  handed the convergence loop a scroll with its soft budget already spent, and the first frame after
  the gesture was also its last: `keeps the whole convergence budget for after the fling, not what
is left of one` measures **one** frame before the change and about 125 after it. Invisible
  whenever the banked correction happens to land exactly, which is why no existing case caught it,
  and costly precisely when the landing needs correcting — a windowed list whose measurements arrive
  after the gesture, which is the ordinary case on the platform that file is about.

  Collapsing the two carries into one `suspend` also dropped something from it: the gate's version
  moved `lastModelChangeAt`, and it should not. That stamp is _pushed_ rather than sampled —
  `notifyModelChanged` arrives from a measurement or an insertion, and an insertion is consumer state
  that a tab without frames still processes — so "the model has not moved" is an observation the loop
  still holds after a stall, and carrying the stamp forward discarded it and made every stalled
  scroll wait out a fresh `MODEL_QUIET_MS` for nothing. Two iOS cases that waited three extra frames
  for that are what surfaced it. What keeps it safe is not the clock: the resuming frame re-resolves
  its target from the live cache, so a model that _did_ move is caught by `targetMoved` there.

  ### Two things deliberately not changed

  **No new `ScrollEndReason`.** `iterations: 0` alongside `deadline` was the only way a caller could
  tell "timed out having never run" from "timed out having tried", and naming it — `starved`, say —
  was the obvious next step. It would name nothing: with the clock credited, that state is no longer
  reachable, because a loop that has had no frames has not yet had its chance. The diagnosis moves
  to a trace event instead.

  **No absolute wall-clock ceiling.** The budget is frames, so a scroll in a tab without them stays
  pending and resolves when they resume, rather than reporting a failure that did not happen.
  `dispose()` still resolves `disposed`, so a torn-down list cannot hang a promise, and the README's
  _Older Safari_ note and `ScrollEndReason.deadline`'s own doc now say which of the two a caller is
  promised.

  Worth stating plainly, because it is the real cost of that choice: an unsettled result is now
  bounded in _frames_ and not in seconds, so on a device with 250ms gaps the 50 charged frames of
  `HARD_DEADLINE_MS` are about 12 seconds rather than 5. While a programmatic scroll is in flight the
  engine suppresses visibility sampling and refuses `onEdgeReached`, so a list that would otherwise
  paginate at the edge waits that much longer in the worst case. Off iOS that window used to be
  bounded at 5s; a parked fling has always had this property, and the trade is deliberate — a late
  correct answer beats a prompt wrong one, and `cancel()`, user input and `dispose()` all still end
  it immediately.

  ### What pins it

  Four cases in `a main thread that stops delivering frames`: the issue's reproduction as a unit
  test, including that the correction it names actually happens (`iterations > 0` and the offset at
  150,000 rather than the first aim's 50,000); that a device with 250ms gaps gets as many frames as
  one at the cap, over two and a half times the wall clock; that an ordinary 16ms frame rate is
  still charged in full, so the deadline still bounds an unstable list; and the new `scroll.suspend`
  trace, which reports `gap` and `credited` both because the ratio is the diagnosis.

  Two iOS cases, one of them new, and the strengthened one now asserts the _result_ where it only
  ever asserted the offset — the landing was never the whole claim. Plus the browser reproduction in
  `e2e/robustness.spec.ts`, and `covers all of the distance even at four frames a second`, which is
  no longer "nearly all": at 4fps the smooth approach now lands exactly, where the hard deadline
  used to take the last stretch.

  All four size budgets still fit unchanged; the core entry measures 10.2kB and the React entry
  12.55kB, and the README's advertised figures are the measured ones again.

## 0.8.0

### Minor Changes

- 06a466b: `Surface` gains `setTrailingSpace`, and `setContentSize` goes back to meaning what it says.

  #82's sticky-footer fix needed empty space below the items — space that carries a `stickyFooter`
  down to the bottom edge on a list too short to fill the scrollport, because `position: sticky;
bottom: 0` lifts a box to an edge and can never push one down to one. It took that space out of
  the only write that could already produce it, `setContentSize`, by padding the sizer:

  ```ts
  surface.setContentSize(contentSizeFor(totalSize, viewportSize));
  ```

  Which made the interface's own documentation false. `setContentSize` is _"Total scrollable content
  size"_, and it is the write every scroll write is ordered against. After that change it meant the
  items' total most of the time, and the items padded out to the scrollport when a sticky footer sat
  under short content — with nothing at the call boundary saying which. Meanwhile `store.totalSize`
  kept publishing the honest number, so the model and the DOM disagreed by up to a scrollport in
  exactly one configuration. Harmless, because the padding stops _at_ the scrollport and the
  browser's maximum stays 0, but `totalSize` is public API — it comes out of `useVirtualList` — and
  anything comparing it against DOM extent had a several-hundred-pixel discrepancy and no signal
  that it was expected.

  The space is now its own write:

  ```ts
  surface.setLeadingSpace(leadingSpace);
  surface.setTrailingSpace(trailingSpaceFor(totalSize, viewportSize));
  surface.setContentSize(totalSize); // literally true again
  ```

  Computed and handed straight to the surface, where its counterpart `leadingSpace` is engine state.
  The asymmetry is not an oversight: `leadingSpace` is a contribution to the composed insets, so it
  has to be state the composition can read, while this is computed _from_ the composition and
  contributing to it would be self-referential. Nothing else reads it, and nothing could — it is
  only ever positive where the scroll range is 0.

  ### Padding, not a margin

  `setLeadingSpace` writes `marginTop`, so the symmetric write would be `marginBottom`. It is
  `paddingBottom` instead, and the reason is a real defect the margin would have carried: the sticky
  footer slot is the container's immediately following sibling, and adjacent siblings' margins
  collapse. A consumer styling `[data-virtual-slot="stickyFooter"]` with a `margin-top` would get
  the max of the two rather than the sum, leaving the composer short of the edge by their margin.
  Padding cannot collapse with anything. It is safe for the items because they are absolutely
  positioned against the container's _padding_ box, whose top edge `padding-bottom` does not move.

  Which is also the answer to the obvious follow-up — why `setLeadingSpace` does not get the same
  treatment, since it has the identical exposure to a preceding slot's margin. That same fact runs
  the other way at the top: `padding-top` does not move the padding box's top edge either, so it
  would grow the container without moving a single item, which is the whole of what leading space is
  for. One edge wants the items to move and the other wants them not to; that is what picks the
  property, not symmetry.

  `padding-bottom` in turn requires `box-sizing: content-box`, or the `* { box-sizing: border-box }`
  reset almost every app carries — the demo included — absorbs it into the height and the footer
  does not move a pixel. `a composer on a short thread still sits on the bottom edge` fails in
  Chromium without it, which is how that was confirmed rather than assumed; jsdom cannot answer it,
  since laying out `position: sticky` is exactly what jsdom does not do. It is written once on first
  sight of the container, beside the height, rather than when a composer arrives: a box model that
  flipped mid-life would reinterpret the `height` already written — and `width: 100%` with it — at
  that instant, for every list that has one.

  ### What pins it

  Seven cases in `createDomSurface trailing space` mirror the five `setLeadingSpace` cases and add
  two the box model needs — `adds to the written height rather than coming out of it` and `settles
the box model before the height, not when a composer arrives`. The ten cases in `engine trailing
space` moved off the sizer and onto the new write, and got stronger doing it: where they used to
  assert the sizer grew to 500 and shrank back, they now assert the space goes `[0, 200, 0]` **and**
  that the sizer never leaves `[300]` — `leaves the sizer at the items’ own total` is the case that
  would have caught the seam in the first place.

  The browser case is unchanged and untouched, which is the point: the composer is still on the
  bottom edge and the short thread still has no scroll range, by a different mechanism.

  ### Breaking

  `Surface` gains a required method:

  ```ts
  setTrailingSpace(px: number): void
  ```

  Only an implementor of the interface is affected — the same scope as #29's `Surface.setCarry` to
  `setPaintOffset` rename and #37's `Viewport.observeSize` change. Consumers of `VirtualList`,
  `useVirtualList` or `createEngine` are not, and neither is anyone using `createDomSurface` or
  `createNullSurface`, which are the two implementations this repo ships. If you hand-rolled a
  `Surface`, add a method that holds `px` of empty space below the item container — a
  `padding-bottom` on the same node whose height your `setContentSize` writes, with
  `box-sizing: content-box` on that node so it adds rather than absorbs.

  Three size limits move by 0.1kB: the core entry 10.14 → 10.19kB, the React entry 12.45 → 12.48,
  the instrumented core 11.05 → 11.12. All three still fit their old budgets locally, but CI
  measures ~0.03kB higher, and this repo has twice now found sub-0.1kB headroom to be noise between
  toolchains rather than margin. The README's advertised figures were two bumps stale and are now
  the measured ones.

### Patch Changes

- 6a6be13: fix: reach the bottom edge with a sticky footer, not the end of the last item

  `stickyFooter` is documented as "content inside the scroller, below the list, pinned to the bottom
  edge", and the README repeats it — "`stickyHeader` and `stickyFooter` pin to an edge". That held
  only while the content overflowed. On a list shorter than its scrollport the slot rested wherever
  the last item ended, halfway up the box with the app's background beneath it.

  `position: sticky; bottom: 0` can lift a box but never push one down. The slot is the last flow
  child of the scrollport, so its static position is the end of the sizer — and the sizer's height
  was `cache.totalSize()`, the items and nothing else. `spaceAfter`, which `composeInsets` already
  grows by the measured sticky footer, feeds the scroller's arithmetic and was never written to the
  DOM. The gap was exactly `viewportSize − totalSize − stickyFooter`, less any other chrome.

  | content vs scrollport                    | where the slot rested                                          |
  | ---------------------------------------- | -------------------------------------------------------------- |
  | items + slot taller than the scrollport  | at the bottom edge — sticky lifts it there from anywhere below |
  | items + slot shorter than the scrollport | at its static position, i.e. under the last item               |

  Reported from a thread view whose comment composer sat directly under the last comment on a short
  thread (restrealitaet/rr-forum-frontend#487), and reachable there without a contrived list: the
  comment list always ends in a ~240px clearance row, the opener is a few hundred more, and a desktop
  scrollport with the composer open lands close to the boundary already — so a one-to-three-comment
  thread on a tall window is enough. The shape generalises past that consumer to any list with a
  composer, an action bar or a "N new comments" pill: an empty state, a filter that matched nothing,
  or the first render before a single row has measured.

  The sizer is now filled to whatever the chrome leaves, so the slot's static position lands on the
  bottom edge and the slack falls **between the last item and the footer** — the items stay at the
  top, which is what separates this from `syncLeadingSpace`, whose job is the mirror image of moving
  short content _down_ under `alignToBottom`. Measured in a real browser on a three-comment thread
  with an 80px composer: **259.5px above the bottom edge before, on it after**.

  Four properties keep it narrow, and each has a case:

  - **It only ever grows, and only where there is no scroll range.** Once the content reaches the
    scrollport the expression is `totalSize` exactly, so no anchor, offset, band or alignment can
    observe it. Padding _to_ the scrollport rather than past it keeps the browser's maximum at 0 —
    a short list gains no scrollbar. The published `totalSize` is still the items' own, so nothing
    reading the snapshot sees the fill either.
  - **The fill is released** when the viewport shrinks under the content, when the composer
    unmounts, and when the items grow past the scrollport.
  - **It is gated on a _sticky_ footer.** A plain `footer` is in-flow content belonging under the
    last item; pushing it down an unfilled scrollport would be a different library.
  - **`alignToBottom` cannot spend the same slack twice.** `syncLeadingSpace` has already taken it
    from above, so the composed `scrollMargin` carries it and the expression collapses to
    `totalSize`. Short content held against the bottom _and_ padded away from it would be the bug
    this must not introduce.

  `contentSizeFor` subtracts the _composed insets_ — `scrollMargin` and `spaceAfter` — rather than a
  sum of the four slot heights. Those are already the two quantities wanted, everything scrollable
  above the sizer and everything below it, so the fill makes `margin + content + spaceAfter` equal
  the scrollport exactly. It also picks up a consumer's own `scrollMargin`, which is page content
  above a window-scrolled list that no sum of _our_ slots can see; filling past it would have given
  the page a scroll range it did not have.

  That makes a second reader of `spaceAfter`, whose doc said not to subtract it at all. The warning
  was really about one space: a sticky footer counts in `spaceAfter` _and_ in `scrollPaddingEnd`, so
  taking it off the browser's maximum takes it twice and parks the last item one composer-height too
  low — 80.25px out in all three engines before the scroller stopped doing it. In content space
  nothing consults `scrollPaddingEnd` and the double count cannot arise, so the doc now says which
  space each reader is in rather than forbidding the subtraction outright.

  Ten cases pin it, in `engine sticky footer fill`. Seven fail against the old code; the three that
  pass are the negative controls — `adds nothing once the items fill the scrollport`, `leaves the
sizer alone for a footer that merely scrolls away` and `spends the slack once under alignToBottom`
  — which is what a gate's tests should do. One more runs in
  chromium, webkit and firefox, because `position: sticky` is precisely what jsdom does not
  implement: `a composer on a short thread still sits on the bottom edge` asks the browser where the
  composer's box actually is, and asserts the scroller still has no range to scroll.

  Three size limits move by 0.1kB to fit it. The change itself is 0.03kB on each of the three
  affected budgets — 10.11 → 10.14kB on the core entry, 12.42 → 12.45 on the React one, 11.02 →
  11.05 on the instrumented core — which fits every current limit locally. The bump is for the gap
  between toolchains rather than for the code: #79 measured the same source at 10.11kB in CI against
  10.08 locally, so 0.06kB of local headroom is not margin, it is one CI run away from red.

- 47b7cc0: fix: hold short content against the bottom of the _scroller_, not of the list

  `alignToBottom` pads above the items so a thread too short to fill the scrollport sits at the
  bottom of it. The padding was computed against everything the library measures for itself — the
  four slots and the items — and against nothing the consumer declares. So `geometry.scrollMargin`,
  which is page content above the list and the one inset that is routinely non-zero under
  `windowScroller`, was not subtracted, and the spacer came out that much too tall. The same
  omission applied to `geometry.spaceAfter` below the list.

  The result is the opposite of what the option is for: on a document-scrolled page with 200px above
  a three-comment thread in an 800px window, the spacer was 500px where 300px is the room, so the
  content was pushed 200px past the bottom of the window and the page gained a scrollbar. A list
  that fits, made to scroll, by the option whose whole job is to place a list that fits.

  Both terms are now in the sum. `holds short content against the bottom of the scroller, not of the
list` and `counts the consumer’s own trailing space too` pin the two halves; both fail against the
  previous build.

  ### One slack, computed once

  The fix fell out of merging two functions that had been computing the same quantity.

  There is exactly one such quantity — how much of the scrollport the content fails to fill — and
  two things that want it. `alignToBottom` wants it above the items. A `stickyFooter` wants it below
  them, because `position: sticky; bottom: 0` lifts a box to an edge and can never push one down to
  one. They were separate functions deriving it separately, and they avoided spending the same
  pixels twice only by accident of composition: `syncLeadingSpace` wrote `leadingSpace`,
  `composeInsets` folded it into `scrollMargin`, and `trailingSpaceFor` subtracted `scrollMargin`.
  Three hops, an ordering constraint spelled out in prose at three separate sites, and a test whose
  entire job was to prove the collision did not happen.

  `syncSlack` subtracts once and routes the answer to one end or the other as exclusive branches of
  a single decision, so spending it twice is not expressible. The ordering constraint _between the
  two halves_ is gone with it — the one between the leading spacer and `syncGeometry` remains,
  because `composeInsets` still folds it in. The trailing half also stops going through `geometry()`
  and reads the consumer's insets directly, which is a coupling removed rather than a cost: that
  call was always a memo hit, and it is what hid the two missing terms.

  A test proving two mechanisms do not collide is a reasonable sign they want to be one; `spends the
slack once under alignToBottom` stays anyway, because the bug it describes is worth naming even
  once it is unreachable. Worth saying plainly, since the arrangement reads like arbitration: under
  `alignToBottom` the footer loses nothing. It is in flow and in the sum, so pushing the whole block
  down lands it on the bottom edge regardless — leading placement satisfies both promises at once.

  The gate still reads `slotSizes.stickyFooter` rather than `spaceAfter`, and now does so from the
  one place where that is the natural thing to read. The insets cannot answer it — `composeInsets`
  merges `footer` and `stickyFooter` into `spaceAfter` on purpose — and the distinction is the whole
  of the trailing branch: a plain `footer` is in-flow content belonging under the last item, and
  pushing _it_ down an unfilled scrollport would be a different library.

  No size limit moves.

## 0.7.2

### Patch Changes

- 7dbfa30: fix: release a held range that is too wide, not only one that is too narrow

  The range hold added in #73 was one-sided. `computeRanges` revisited a hold that failed to cover
  the buffered band, and nothing revisited one that covered far more than it — so a hold computed
  against a geometry the list no longer has was kept for as long as its two keys resolved.

  A list momentarily shorter than its own buffered band computes exactly such a hold: the band spans
  everything, so the hold is the whole list, and the keys it pins are the list's first and last. That
  is not a contrived shape. A thread view mounts its opener and its footer row before any comments
  have arrived — two rows against an 800px scrollport and a 2500px buffer — and those two keys stay
  first and last for the life of the list. Every comment that arrived afterwards was mounted and
  stayed mounted.

  Measured in the consumer that reported it (restrealitaet/rr-forum-frontend#483), on an 11,398
  comment thread opened at its read position: **1,501 rows resident where 38 covered the scrollport**,
  constant across thirty scroll steps. Not a slower virtual list — an unwindowed one. It cost 11.4s
  behind the open placeholders against 3.7s on 0.7.0, and every subsequent scroll frame carried
  fifteen hundred rows of React reconciliation, which is what the report describes as new comments
  taking "ages" to appear. Linking this build into that app takes it to 39 rows and 3.3s.

  An over-wide hold is now released the way an unresolvable key already was — as nothing held — so
  the recompute below it, and the slack it grants on both edges, are reached unchanged.
  `MAX_HOLD_DRIFT_SLACKS` is 2 because that is the most a live hold can exceed the band by: a
  recompute grants one slack past the band at the edge that ran out, and the reader travels one more
  before the coverage test fires at the other edge. The test is guarded on coverage, so the two extra
  `indexAt` lifts stay off the frames the hold exists to make cheap.

  Coverage is untouched in both directions: the trigger stays at the buffered band, and
  `blanking.spec.ts`'s calibrated distance is unchanged. The bound `MAX_DEFAULT_BUFFER_ROWS` argues
  for is also unchanged — this bounds a hold's _displacement_ from the moving band, not its span.

  One case pins it: `drops a hold computed while the list was shorter than its own band` grows a
  two-row list to 1,502 and asserts the mounted range is the band around a reader at 75,000px, asked
  of the cache rather than written as a row count. Against the old code it reports "mounted 1502 of
  1502 rows".

  All three affected size limits move by 0.1kB to fit it. The core entry needed it too: 10.11kB
  against a 10.1kB limit, where the same source measures 10.08kB locally — 0.02kB of headroom on that
  budget is noise between toolchains, not margin.

## 0.7.1

### Patch Changes

- 3d93f6b: Make the committed scroll write honour the ordering the banked one already did.

  `publish` writes the paint offset once, last, and after every read. Its own comment says so, and
  the _banked_ branch of `writeScroll` honoured it explicitly — "Deliberately not written yet …
  A style write here would force a second synchronous layout on the hottest path in the file."
  The **committed** branch did not. `commitScroll` drew the carry itself, through `applyCarry`,
  and it sits between the `scrollTop` write and this pass's final two reads of `scrollTop` — so
  that draw turned both into a forced synchronous layout.

  **It does not show on the benchmark, and this is not sold as a speed-up.** Measured back to
  back against the change below it on a quiet machine, `perf/headroom.spec.ts` moves in both
  directions and by less than its own run-to-run spread: at 6× CPU the handler p50 goes 0.40ms to
  0.20ms, at 10× it goes 0.30ms to 0.90ms, at 20× the dropped-frame share goes 9.8% to 8.1% while
  the p95 goes 5.90ms to 6.10ms. There is no signal there. The reason is the two changes below
  this one: holding the mounted range made publishes that _commit_ a scroll much rarer, so the
  layout this removes now fires seldom on the wheel scenario the harness drives.

  What is not in doubt is that the layout was being forced, because a unit test discriminates
  deterministically — the paint offset lands at write index 3 with a scroll read at 4, and after
  the change the last read is at 3 with the paint at 48. And on WebKit it is _every_ commit rather
  than an occasional one: it truncates a written offset to an integer, so the carry always moves
  and the write is never deduped away.

  So this is filed as restoring an invariant the file already states rather than as a measured
  win. A reader deciding whether it is worth carrying should know both halves.

  The carry is now recorded at the two call sites inside `publish` and drawn only by `publish`'s
  terminal flush. `reconcileGestureShift` still draws on its own next line, because it runs from
  the gate's `onOpen` with no publish behind it and needs both halves in one task; the scroller
  keeps the drawing `applyCarry`, because its frame loop is outside a publish too.

  The `follow` branch gains the same thing incidentally: its `contentOffset()` read used to sit
  behind an `applyCarry(0)`.

  Pinned by a case that fails against the old code — the paint offset lands at write index 3 with
  a scroll read at 4, where it should be the other way round. Modelling the carry at all needed
  the test harness to truncate written offsets the way WebKit does, which it now does under the
  same option name and in the same order as the iOS harness that already had one.

- 5bfea32: Hold the mounted range across a scroll instead of recomputing it on every event.

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

  | slowdown | demo  | fps         | drop%       | handler p50 | handler p95  |
  | -------- | ----- | ----------- | ----------- | ----------- | ------------ |
  | 1×       | live  | 60.0 → 60.0 | 0 → 0       | 0.30 → 0.20 | 1.70 → 0.70  |
  | 4×       | live  | 60.0 → 60.0 | 0 → 0       | 0.70 → 0.40 | 3.00 → 1.00  |
  | 6×       | live  | 60.0 → 60.0 | 0 → 0       | 1.30 → 0.50 | 4.60 → 1.50  |
  | 10×      | live  | 59.0 → 58.5 | 1.6 → 2.4   | 2.10 → 1.10 | 7.60 → 2.80  |
  | 20×      | live  | 37.7 → 52.7 | 37.1 → 12.2 | 7.80 → 1.20 | 18.80 → 4.90 |
  | 20×      | quiet | 39.3 → 57.6 | 34.4 → 4.1  | 6.90 → 0.10 | 15.10 → 4.00 |

  **`blanking.spec.ts` is within its own noise, and is reported rather than claimed.** Back to
  back on the same machine at 40,000px/s it gave 0 blank captures of 79 against `main`'s 1 at 6×
  CPU, and 2 of 78 against `main`'s 0 at 20×; three runs of this branch at 20× gave 0, 9 and 2.
  That spec does not repeat and take a median — its own header says so — and single counts of
  small integers cannot separate those. What can be said structurally is that the coverage
  guarantee is byte-identical to `main` and the mounted band is strictly larger, so there is no
  mechanism by which the compositor has _fewer_ rows ahead of it than before.

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

  `MAX_DEFAULT_BUFFER_ROWS` now bounds the rows the default actually _mounts_ rather than the rows
  its guarantee covers, since the slack is what mounts a row. On the demo's comments the pixel
  limit still wins and coverage stays at 2500; on a list of short rows the cap binds where it
  always meant to.

  Costs rows resident — the mounted band grows by half the buffer on each side, and `itemsFor`
  still allocates one object per mounted row on every publish whether the range moved or not. A
  skipped render is the whole of React's work for every mounted row, so the trade is favourable at
  fling speed and lopsidedly so at reading speed.

- f3f27da: Read the scrollport's height once per pass, instead of three times.

  `getViewportSize` is three DOM reads on an element scroller — a `getBoundingClientRect` plus
  `offsetHeight` and `clientHeight`, per `contentHeightOf` — and a publish reached it from three
  places: `syncLeadingSpace` for the `alignToBottom` spacer, `computeRanges` through
  `syncGeometry`, and the visibility sample through `syncGeometry` again.

  The third one is the one that cost something. `sampleVisibility` is the last thing `publish`
  does, so it runs **after** every mounted row's `top` and the paint offset have been written.
  A read there is not a repeat, it is a forced synchronous layout — once per scroll event — to
  re-answer a question the same pass had already answered. `engine.dom.test.ts` pins it: with the
  old code the reads land at write-counts `[220, 220, 254]`, and that third entry is thirty-four
  style writes after the pass began.

  The pass now reads it once, before it writes anything, and hands it down. `syncGeometry` also
  moves up to the pass rather than being called by each consumer, which removes a second
  `listGeometry.update` with identical arguments in every path that existed.

  Measured with `perf/headroom.spec.ts`, medians of four runs, same session and same machine as
  the change below it in the stack. Against that parent, so this is what removing the forced
  layout buys on its own:

  | slowdown | demo  | fps         | drop%       | handler p50 | handler p95  |
  | -------- | ----- | ----------- | ----------- | ----------- | ------------ |
  | 1×       | live  | 60.0 → 60.0 | 0 → 0       | 0.40 → 0.40 | 1.80 → 1.60  |
  | 6×       | live  | 60.0 → 60.0 | 0 → 0       | 0.50 → 0.50 | 2.70 → 2.40  |
  | 10×      | live  | 60.0 → 60.0 | 0 → 0       | 0.90 → 0.90 | 4.50 → 4.00  |
  | 20×      | live  | 43.9 → 46.3 | 26.8 → 22.8 | 4.40 → 4.00 | 10.60 → 9.80 |
  | 20×      | quiet | 47.3 → 49.8 | 21.1 → 17.1 | 2.80 → 1.90 | 8.50 → 7.80  |

  The smallest of the three steps, and honestly so: one forced layout per publish is one frame's
  worth of headroom, not a frame rate. What makes it worth having is that it is monotonic — every
  CPU level and both demo modes improve, none regresses — and that the thing removed was work
  nobody had asked for.

  Deliberately **not** a cache inside `Viewport`, which is the obvious alternative: it would need
  an invalidation signal that does not exist. `observeSize` watches the _border_ box, and a
  horizontal scrollbar appearing changes `clientHeight` — and so the content height — without
  moving that box at all. A cache keyed on that observer would go quietly stale by the
  scrollbar's width. A parameter cannot.

  One path still reads for itself, and should: the visibility deadline timer is not inside a
  publish, so it has no pass to take the number from. It fires when nothing else is happening, so
  the read is neither hot nor forced.

  No behaviour changes. `getMaxScrollOffset` still reads the DOM after the content-size write,
  because the extent is exactly what that write changed — deriving it from our own total is
  TanStack #1001, which `viewport.ts` already warns against.

- b3170ee: Stop reading a row's rect when its height is already known.

  `observeItem` measured every mounting row synchronously. The comment defending that is right
  about why the read exists — ResizeObserver's first callback lands after the next rendering
  update, so a row with nothing in the cache would paint one frame at its estimate — but that is
  an argument about a row with _no measurement_, not about every row that mounts.

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

  | slowdown | demo  | fps         | drop%       | handler p50 | handler p95   |
  | -------- | ----- | ----------- | ----------- | ----------- | ------------- |
  | 1×       | live  | 60.0 → 60.0 | 0 → 0       | 0.50 → 0.40 | 2.50 → 1.80   |
  | 6×       | live  | 60.0 → 60.0 | 0 → 0       | 0.60 → 0.50 | 3.60 → 2.70   |
  | 10×      | live  | 60.0 → 60.0 | 0 → 0       | 1.10 → 0.90 | 6.70 → 4.50   |
  | 20×      | live  | 39.4 → 43.9 | 34.4 → 26.8 | 7.60 → 4.40 | 19.70 → 10.60 |
  | 20×      | quiet | 47.3 → 47.3 | 21.1 → 21.1 | 4.30 → 2.80 | 13.50 → 8.50  |

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

## 0.7.0

### Minor Changes

- 0ba0678: Instrument the fling, and make the instrumentation free when it is off.

  This ships measurement, **not a fix**. A fling on iOS jumps, stutters and sometimes stops
  abruptly while slow scrolling is perfect, and the reason it was not already diagnosed is that
  every tool for diagnosing it was broken in a different way. Four of those, each verified against
  the source or the shipped artifact rather than reasoned about:

  **The instrumentation was compiled out of the build under test.** `TRACING` was
  `process.env.NODE_ENV !== 'production'`, and a phone is served a production build. `setTraceSink`
  returned `false`, the demo's overlay printed "tracing is compiled out of this build", and there
  was nothing to read. Running a dev server instead is not the answer: dev-mode React and
  `StrictMode`'s double invoke are themselves a source of jank, which makes them a confound when
  the symptom _is_ smoothness.

  **`deferred` meant _wanted_, not _did_.** In `writeScroll` the flag was computed, and traced,
  before the test that decides whether the write actually happens — `Math.abs(held) <= room`, forty
  lines further down. So a correction that escaped because the bank's bound fired was recorded as
  `deferred: true`, and the demo's on-device readout printed it as `DEFER`. That readout's own
  comment said the case was "worth naming rather than leaving to be inferred from a WRITE among
  DEFERs", and then named it as its opposite — while it is the leading suspect for the abrupt stop.
  `scroll.write` now carries `reason` (`held`, `gate-open`, `model`, `no-room`) and `took`, keyed on
  the _gate_ rather than on the intent. Keying on intent is not merely less informative but wrong:
  `deferred` is already `false` for a model change, so a prepend overriding a shut gate reported
  `gate-open` and looked like an ordinary write on an idle platform. The type checker caught that as
  an impossible comparison.

  **There was a second writer, entirely untraced.** `scroller.ts` writes `scrollTop` and emitted
  nothing; `scroll.step` says the convergence loop _ran_, which is not the same claim. The overlay
  filtered on `scroll.write`, the engine's door. Every conclusion of the form "no write escaped
  during that gesture" was drawn from half the writers. It now emits `scroll.commit`, plus
  `scroll.park`, `wake` and `flush`, which together make "the parked loop woke and wrote during
  momentum" legible.

  **And the instrument perturbed the experiment.** The `scroll.write` thunk called
  `contentOffset()` and then `getScrollOffset()` twice more inside `room` — three forced synchronous
  layouts per traced write, in a thunk that runs after `publish` has written styles, on the hottest
  path in the library. On a gesture this file's own comments record at 43 deferrals, that is 129
  layouts that existed only because someone was watching. The values are now hoisted and the thunk
  reads nothing.

  Four more of the same kind went with it, three of them found by reviewing this change rather than
  the code it replaced. `anchor.restore` and `measure.batch` dropped their `scrollOffset` field, which
  `scroll.sample` now reports at higher fidelity anyway. `scroll.start` had one inside its thunk, and
  the write two lines below it read the same value again. And the new `scroll.commit` had reintroduced
  the defect in the sibling module: once per convergence frame, and once on the gate-open path — which
  runs immediately after a style write, making it a _guaranteed_ forced layout at the exact moment a
  fling ends. `write()` now takes the offset its caller already holds. An engine-level test asserts
  that a traced measurement performs the same number of scroll-offset reads as an untraced one.

  `reconcileGestureShift` — the fold of a banked correction back into `scrollTop`, and the most
  plausible cause of a visible jump — emitted nothing at all. Worth knowing when reading a trace:
  the fold _is_ a `scrollTop` write, and it is deliberately not a `scroll.write`, because it is not a
  correction — it is a correction already taken being converted from a paint offset back into a real
  offset. Three topics therefore account for every write the library makes: `scroll.write` from the
  engine, `scroll.commit` from the scroller, and `gesture.fold`. An e2e assertion reconciles all three
  against a patched `scrollTop` setter, which is what stops the trace from quietly disagreeing with
  the platform.

  The event carries `clamped`, which tests an invariant the function's own doc comment asserts cannot
  be violated: `room` was checked per deferral against an offset the fling has since moved, so by the
  time the fold lands its target may sit past the maximum. Precisely because the invariant is asserted
  in prose, nothing would have reported it broken.

  Also new: `scroll.sample` (every scroll event, stamped at _delivery_, so the inter-arrival gap is
  not contaminated by the handler's own duration), `paint.offset` (which of the two addends moved the
  container), `gate.attach` (emitted _before_ the off-iOS early return, because otherwise "the gate
  stayed idle" and "there is no gate on this platform" are the same observation — and off iOS every
  correction writes unconditionally), `measure.done` with a duration, and `layout.signature`, whose
  strings name which term moved and so separate a URL bar collapsing from a webfont landing.

  ### What is new for a consumer

  `addTraceListener(fn)` returns an unsubscribe and composes, so your own listener and the debug
  overlay can coexist. `setTraceSink` is unchanged in signature, return value and replace-the-last
  semantics; it simply no longer evicts listeners it did not install, which no correct caller could
  have depended on. The demo was the proof that one slot was not enough: it installed a ring buffer
  and then replaced it with a HUD that re-implemented the buffer by hand.

  `virtual-anchor/debug` is a new entry point — a trace recorder, a frame probe, a touch probe, an
  on-page readout, and a **pure** `analyzeGestures` that ranks the ways a fling is known to be able
  to misbehave and says which one the recording shows. It prints a verdict to the console as each
  gesture settles. Every hypothesis has a unit-test fixture that must produce it and a second that
  must not; that second half caught a confident false positive during development, reporting a
  permanent anchor displacement where the trace showed a quarter of a pixel.

  `trace` is now generic over its topic, checked against a map of payload shapes. That is not
  ceremony: the analyzer reads payloads by field name from several modules away, so a renamed field
  would leave everything compiling and the diagnosis silently empty. Turning the map into a
  constraint immediately found that eight emitted topics were missing from it, that `scroll.start` was
  sending a possibly-`undefined` key where its declaration promised one, and that `frame.long` was
  spreading in a field it never declared. The gate's `state` and `reason` are unions rather than
  `string` for the same reason — they are what segmentation keys on.

  ### What it costs when off

  Less than before. The default entry is **9.7 kB** brotlied, down from 10.24 kB, and the React
  entry 12.07 kB from 12.56 kB — because the topic strings and guards now actually vanish, where
  previously about 2 kB of them shipped. `scripts/check-package.mjs` greps the published artifact and
  fails the build if a single topic string survives, so the claim is enforced rather than stated.

  The reason it did not work before is worth recording, because a doc comment in this package
  asserted the opposite and a reader may have relied on it. It blamed minifiers for not propagating a
  module-level constant across modules. What actually happens is narrower: esbuild's bundler prints
  every top-level `const` as `var`, so the shipped chunk read
  `var TRACING = process.env.NODE_ENV !== "production"` and a `var` is not a constant. The const-ness
  was destroyed by this package's own build, before any consumer's minifier saw the file — so no
  consumer-side configuration could ever have recovered it, and the fold has to happen here.
  `minifySyntax` in `tsup.config.ts` is what enables it, and it costs nothing in readability because
  the existing Rollup pass re-prints.

  `virtual-anchor/debug` ships only if imported, so a consumer who never writes that import ships
  none of it. Both facts have size budgets in CI.

  ### Turning it on

  Off by default. To keep the instrumentation in a _production_ build, resolve the new `development`
  export condition — one line of resolver config, and the README has it per bundler. Your app stays a
  production build: React 19 ships no `development` condition, so nothing about this flips React.

  The published tarball grows, because two builds ship: 412 kB, of which `dist/dev` is 668 kB of the
  1,464 kB unpacked — mostly source maps. That is a download-once cost for whoever installs the
  package; what a consumer _bundles_ went down, which is the number in the section above.

  An export condition rather than an alias, deliberately: a condition switches the whole export map
  at once, so the package cannot be half-switched into two module instances — which is the same
  hazard the ESM-only decision exists to prevent, since the trace sink is module state.

  ### What it found

  Two defects, both on a real device, both fixed in the two changes stacked on top of this one: the
  momentum gate's
  ceiling cutting off every fling longer than three seconds, and a model change during momentum
  writing the fling's own lag. Neither was the mechanism predicted before there was any data — that
  was `overscroll-write`, which never fired once. The second was found by a consumer reading a
  recording this produced, which is the case the toolkit was built for.

  `overscroll-write` remains ranked and unobserved: `writeScroll` consults `writeGate.canWrite()` but
  never `writeGate.isActive()`, whose only caller is the scroller, so nothing applies the rubber-band
  refusal on the engine's path. It stays in the table because the reasoning still holds and the signal
  is now recorded if it ever happens.

- 9ec925e: Stop a hard fling putting blank frames on screen.

  The symptom, reported from use and then reproduced: scroll fast enough and the content
  disappears — empty space where rows should be, filling in once the gesture slows. The mechanism
  is a race that is always present and only sometimes visible. The browser scrolls on the
  **compositor** thread; the mounted range is recomputed on the **main** thread from a scroll
  event. Overscan buys the main thread time, and it was a fixed 400 px, so at 60 Hz a scroll of
  24,000 px/s spent the entire buffer within a single frame of latency. Past that the compositor is
  presenting a region no row has been mounted for.

  **The default buffer is now 2500 px, and the number is measured rather than argued.**
  `perf/blanking.spec.ts` counts blank composited frames directly — through a screencast, because
  the obvious instrument cannot see this at all. A `requestAnimationFrame` probe runs _after_ the
  scroll handler in the same frame, so it only ever observes a world the handler has already made
  consistent; it reports ~2% for gestures that visibly blank. On the demo at 40,000 px/s:

  | buffer | blank frames at 20x CPU | headroom at 20x CPU             |
  | ------ | ----------------------- | ------------------------------- |
  | 400    | 13 of 79                | 42 fps, 8.2 ms per scroll event |
  | 1200   | 11 of 81                | 33 fps, 12.7 ms                 |
  | 2500   | 3 of 78                 | 32 fps, 14.3 ms                 |

  1200 is dominated — nearly all of the cost, almost none of the benefit. At 1x and 6x emulated CPU
  2500 costs nothing measurable (60 fps, 0.2 ms per scroll event) and removes the blanking; the
  headroom it spends appears only past 10x, where frames are being dropped regardless. `buffer` is
  still yours to set if you want the old trade.

  Mounting is now also **asymmetric**: the band extends further in the direction of travel, by the
  distance the content will cover in the next 50 ms, capped at 2000 px and decaying to nothing once
  scrolling stops. It costs no rows at rest.

  Worth recording that this second part is _not_ what fixed the blanking, because the obvious story
  about it is wrong. Every blank frame lands in the first few per cent of a gesture — at onset,
  where two samples have not yet arrived and the velocity is therefore zero. A lookahead derived
  from velocity is necessarily nothing at exactly the moment it is wanted, and switching it on alone
  changed the count not at all: 13 blank frames of 79 at a 20x slowdown, before and after. What
  fixed it was having the rows _already mounted_ before the finger moved, which only a larger
  resting buffer can do. The lookahead is kept because it is cheap where the buffer is expensive —
  on top of it, the 20x count went from 5 to 3 and the 1x count from 1 to 0.

  Measured after the change: 10.03 kB for the core entry and 12.35 kB with the React adapter,
  minified and brotlied. Both size budgets move up to match. The README's stated figures were
  already behind the budgets they claim cannot drift — 9.38 and 11.65 against limits of 9.9 and
  12.2 — so they now say what the build actually produces rather than what it produced some
  releases ago.

### Patch Changes

- 9ec925e: Stop reporting a landing as converged against heights the list has not measured.

  `scrollToKey` could resolve `{ settled: true, reason: 'converged', deviation: 0 }` while sitting
  22px from where it was asked to go. The accuracy matrix caught it in a paged window: comment #137
  off by 1.25px for `align: 'start'`, 11.75px for `'center'` and 22.25px for `'end'`.

  That progression is the diagnosis rather than three separate faults. #137 estimates at 162px and
  measures 141, and the error is none of the 21px difference for `start`, half for `center` and all
  of it for `end` — which is how much of a row's height each alignment puts on screen. The landing
  was computed against the estimate.

  The cause is one line, and it is a counting argument. `scrollToKey` has a fast path that skips
  the convergence loop when the destination is already in place, guarded by
  `cache.measuredCount === cache.length`. A count cannot say _which_ rows were measured. The cache
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

- a22a5e2: Stop a model change during momentum writing the fling's own lag.

  A `'model'` restore — `setOptions` with new keys, a gap, an estimate or geometry — overrides
  the write gate, which is right for a prepend and wrong for anything that leaves the reader
  where they are. When one landed during an iOS fling, the engine wrote `scrollTop` even though
  the change had displaced nothing, and what it wrote was not a correction at all: it was the
  distance the fling had travelled since the last scroll event.

  The cause is a coordinate-space mismatch between two lines. `resolveAnchorOffset(anchor, …)`
  answers _where the content was at the last scroll event_, because that is when the anchor was
  last derived. `writeScroll` compares it against `contentOffset()` read _now_. During momentum
  those are never equal, so

  ```
  delta = (what the model change displaced) − (travel since the last scroll event)
  ```

  On the device recording that found this, the first term was zero — 500 items appended _below_
  the reader, `firstKey` unchanged, the anchor byte-identical before and after — and the second
  was 7px. So `-7` was written, clearing the `0.01` no-op guard, nudging the reader backwards to
  a stale offset and cancelling a fling with about a second and 250px of travel still in it.

  Now the displacement is taken where it is knowable — the anchor's resolved offset before the
  change versus after it, captured at the top of `setOptions` before the merge and before any
  cache mutation — and applied to wherever the content has since got to:

  ```ts
  target = contentOffset() + (restored - priorAnchorOffset);
  ```

  Both terms of the subtraction are content-space, so an outstanding carry or paint offset
  cancels out rather than having to be reasoned about. When the content is still the anchor is in
  sync, `contentOffset() === priorAnchorOffset`, and the target is bit-identical to before — the
  two forms diverge only while the content is moving under the write, which is the case being
  fixed. A displacement of zero then falls inside the existing no-op threshold, so "changed
  nothing, wrote nothing" needs no branch of its own. Cost is one Fenwick prefix sum per
  `setOptions`, O(log n).

  This also fixes a case the report predicted but could not observe: a real prepend landing
  mid-fling was writing `inserted height − travel`. Measured in a unit test, a 1000px prepend
  with 7px of lag wrote **993**; it now writes 1000, and the same prepend with and without lag
  produces an identical correction.

  Covered by unit tests for the append (writes nothing), the prepend (writes its real height,
  twice, with and without lag), an outstanding banked paint offset, an anchored key the change
  removes, and the off-iOS path where the gate is inert and nothing should change. Plus an
  end-to-end test in real WebKit that pages 200 items in mid-fling and asserts no write and that
  scroll events keep arriving — which fails without the fix.

  Fixes #54. Reported against the unreleased instrumentation branch by a consumer, diagnosed from a
  `virtual-anchor/debug` recording, and confirmed by reverting the fix under both suites.

  Uncovered by #53: under the old momentum ceiling the same fling was already being killed 326ms
  earlier, so this never got the chance to show.

- 78f6dcf: Stop the momentum gate cutting off flings longer than three seconds.

  `MOMENTUM_MAX_MS` was armed once at momentum onset and fired 3000ms later regardless of what
  else had happened. Its own doc called it "a safety valve, not a duration" — but on a
  twelve-thousand-row thread it was not a safety valve, it was the common case. Measured on an
  iPhone, the correlation with fling duration is exact:

  | fling                                | outcome |
  | ------------------------------------ | ------- |
  | 837ms, 2266ms                        | settled |
  | 3032, 3251, 3782, 4504, 4721, 8467ms | **cap** |

  And firing mid-fling does precisely what the gate exists to prevent. `canWrite()` starts
  answering `true` again with the fling still running, the next measurement writes `scrollTop`,
  and WebKit cancels the momentum — which is the "stops abruptly, sometimes" the whole mechanism
  was built for. On the worst recordings three or four writes landed in the moments after the
  cap fired.

  The timer is now re-armed by every scroll event during momentum, making it an inactivity
  watchdog — and inactivity is the right predicate for the thing it actually guards against. A
  fling still delivering two hundred scroll events is self-evidently not a wedged gate; three
  seconds of silence is. Renamed `MOMENTUM_IDLE_MS`, because a constant that changes meaning
  while keeping its name is a trap.

  Three seconds of _silence_ rather than something tighter, because a blocked main thread can
  stop delivering scroll events without the fling being over: the worst gaps measured were 205ms
  on a device and 202ms on a simulator. The window has to clear that comfortably or the watchdog
  re-creates the bug it fixes.

  The old note that this sat "deliberately below the scroller's `HARD_DEADLINE_MS` of 5000" no
  longer applies, and was already obsolete before this change: the convergence loop suspends its
  deadline clock while parked, so a longer gate-shut window costs a programmatic scroll nothing.

  Verified on a device — the same upward flings that previously reported `cap` at 3032ms now run
  to `settled` at 3354ms and 3355ms with no suspect at all, folding 1044px and 1178px of banked
  correction cleanly at the end. Covered by three unit tests (an eight-second fling is not
  capped; a fling that goes quiet still reopens the gate; a 250ms stall does not trip it) and an
  end-to-end test in real WebKit.

  Fixes #53. Found with `virtual-anchor/debug`.

## 0.6.1

### Patch Changes

- c7d250d: Under `once`, hold an unmeasured item back instead of reporting it.

  `once` and the `measured` flag were individually sound and jointly broken. `satisfies`
  lets an `edge` rule through unmeasured on purpose, and says why: gating it "would mean
  an item never reports until measured — which for read tracking reads as 'not read yet'
  rather than 'not sure yet'. The event carries `measured` truthfully, so a consumer
  wanting only confirmed geometry can filter on it." Add `once` to that and the advice
  becomes a trap: the filtered event is also the only one that key will ever get.

  The first sample of a list's life is guaranteed to be the unmeasured one, and the
  ordering runs the wrong way to fix by waiting. `useVirtualList` pushes options into the
  engine from the **render body** — deliberately, so a prepend lands in the same commit
  that renders it — `setOptions` ends in `publish`, and `publish` ends in a visibility
  sample. `observeItem`'s synchronous `getBoundingClientRect` is a _commit-phase_ ref
  callback, so it has not run yet. Neither suppression path intervenes either: `gate` is
  still `null` at that point, so `gated` defaults to `true`, and nothing is scrolling. With
  `dwellMs` unset, `#dueAt` returns `passingSince + 0` and every in-band candidate reports
  on that sample with `measured: false` — then sets `hasBeenSeen`, after which `#dueAt`
  returns `null` for the key forever.

  The visible symptom was total on short lists and invisible on long ones. Rows below the
  fold mount inside the overscan buffer, are measured at ref-attach, and only cross the
  band on a later scroll sample, so they report `measured: true` and a read marker
  advances off them quite happily. Only the rows in the band _at mount_ are poisoned — so
  on a forum thread short enough to fit the viewport, every row is, every event is
  discarded, and the thread can never be marked read at all. There is no scroll left to
  recover from it.

  `#dueAt` now returns `null` for an unmeasured item under `once`, so it neither reports
  nor latches, and reports on the first sample where it both passes and is measured.
  `null` rather than a deadline is the load-bearing part: what unblocks the item is a
  measurement, and a measurement always publishes. A deadline would fire, find `sample`
  still declining to report, and re-arm at delay zero — the spin `#dueAt` was consolidated
  to rule out.

  Scoped to the interaction, not to `edge`. Without `once` an unmeasured `edge` enter still
  fires exactly as before and still says so. With `once`, the deferral costs at most one
  commit phase, because anything whose trailing edge is inside the band is mounted and
  therefore measured at ref-attach — the doc comment's worry about an item that "never
  reports" does not describe a report that is one tick late.

  A `quiet` adoption is exempt, and has to be. The guard protects the one _report_; an
  adoption emits nothing, so there is no event for a consumer to filter and nothing to
  protect. Withholding it would actively break `quiet`, because `#started` latches on the
  first non-suppressed sample either way: hold the unmeasured one back and the measured
  sample that follows is no longer the first, so `quiet` would report precisely the rows it
  exists to swallow — the deep-linked reader's on-screen comments, all counted as freshly
  read. `quiet` therefore still adopts from the estimate, exactly as before.

  Emitting a second, measured `enter` instead was considered and rejected: it breaks what
  `once` says it does, which is report at most once per key, ever.

  No API surface changes. A consumer that does not use `once` is unaffected, as is one that
  pairs it with `quiet`; a consumer that uses `once` without filtering on `measured` sees
  its first batch arrive one commit later than before, carrying real geometry instead of
  estimates.

  Fixes #50.

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
