# Third-party notices and prior art

## Bundled dependencies

**[zustand](https://github.com/pmndrs/zustand)** — MIT, © 2019 Paul Henschel.
Used by `virtual-anchor` as the store transport (`zustand/vanilla` plus
`subscribeWithSelector`).

## Optional peer dependency

**[scrollyfills](https://github.com/argyleink/scrollyfills)** — ISC,
© Adam Argyle. Not imported by this library; see the README for why, and for how to
opt in.

## Prior art

This library is a clean-room implementation, but its design was informed by reading
the source of four existing virtual scrollers. Algorithms, data structures and API
shapes are not copyrightable, and nothing here is copied — but the debt is real and
worth recording, not least because several decisions in this codebase exist
*because* of a bug one of these projects had already found and fixed.

All four are MIT licensed.

### [react-virtuoso](https://github.com/petyosi/react-virtuoso) — © Petyo Ivanov

The most accurate `scrollToIndex` of the four, and the source of several ideas:

- terminating a convergence loop on **150ms of measurement quiet** rather than a
  frame or attempt count (virtua arrived at the same 150ms independently, which is
  decent evidence it is the right number)
- clamping a scroll target *before* writing it, so the loop cannot chase an
  unreachable offset
- synthesising a completion when a write is a no-op — the classic hang in
  hand-rolled implementations
- the `calculateViewLocation` + `done` pairing for `scrollIntoView`, which returns
  `null` when an item is already visible so that no scroll happens at all
- separating `overscan` (directional), `increaseViewportBy` (symmetric) and
  `minOverscanItemCount` as genuinely distinct knobs

Its AA-tree of size *ranges* was evaluated and deliberately not adopted: it scales
with the number of distinct size classes, which is ideal for uniform rows and
actively worse than a Fenwick tree for prose, where nearly every height differs.

Its `rangeChanged` reporting the rendered range rather than the visible one, and
its documented difficulty with item margins, are the two problems this library set
out to avoid.

### [virtua](https://github.com/inokawa/virtua) — © 2022 inokawa

The cleanest architecture of the four — a framework-free imperative core with thin
adapters — and the shape this library follows. Directly adopted:

- **median-based** size estimation rather than a mean, so one enormous item cannot
  skew every unmeasured offset
- one shared ResizeObserver constructed lazily from the element's own
  `ownerDocument.defaultView`
- `overflow-anchor: none` on the scroller, so the browser's own scroll anchoring
  cannot fight ours
- the `isJustJumped` idea: recognising the echo of your own scroll write, and
  allowing a pixel of slack because `scrollTop` writes lose sub-pixel precision
- pre-measuring a frozen destination range before a smooth scroll
- iOS WebKit momentum deferral, including the observation that iOS fires touch
  events only at the *start* of momentum, so `touchend` needs a grace period

Its index-keyed size cache and positional `shift` prop are what the key-based anchor
model here replaces.

### [TanStack Virtual](https://github.com/TanStack/virtual) — © Tanner Linsley

The most instructive to read, because its comments document why each guard exists:

- `_intendedScrollOffset`: tracking what you *meant* to write, separately from the
  integer the browser reports back
- the two-tolerance landing — converge loosely, then commit the exact float — and
  the changelog note naming virtuoso's 0px accuracy as the benchmark
- bounding a convergence loop by **wall clock** rather than attempt count, and
  always rescheduling so the valve can fire
- clamping against the browser's real scroll extent, never an estimated total
  (issue #1001)
- writing item positions directly to the DOM (`directDomUpdates`) and the
  explanation of the one-frame jump that motivates it (issue #1227)
- growing the sizer *before* writing `scrollTop`, or the write is clamped against
  a stale height
- reverse-looking-up a cache entry by node identity on disconnect, because an index
  may be stale by the time a ResizeObserver callback arrives (issue #1148)
- the three-way `defaultShouldAdjust` predicate, whose existence is the clearest
  argument for not modelling position as an offset in the first place

Also the source of the plainest statement of the underlying problem, from a user
rather than a maintainer, on issue #216:

> I guess the only real way to solve this issue is to use scroll "anchoring"
> instead of one "scrollToIndex" call. You should maintain scroll position and
> automatically readjust it in case items or parent container resize. […] Using
> timeouts or 2+ requestAnimationFrame to wait for something is just unreliable.

That comment is effectively this library's design brief.

### [react-window](https://github.com/bvaughn/react-window) — © Brian Vaughn

v2's `useDynamicRowHeight` has the best consumer ergonomics of the four — no `ref`,
no `data-index` in user code — which this library matches. Its `onRowsRendered`
correctly separating *visible* from *overscan* ranges is the distinction the
`visibleRange` / `renderedRange` split here comes from.

Its `itemCount × runningAverage` total is a documented anti-pattern that shaped a
decision here: bvaughn's own analysis of issue #863 explains how a changing average
moves every unmeasured offset and therefore the view. Sizes here are exact prefix
sums for that reason.

## Standards and specifications

Behavioural details follow published specifications rather than observed
convenience: the [WAI-ARIA feed
pattern](https://www.w3.org/WAI/ARIA/apg/patterns/feed/) for the accessibility
layer, [Resize Observer](https://drafts.csswg.org/resize-observer-1/) for why the
total-height write must not touch an ancestor of an observed element, [CSS Scroll
Anchoring](https://www.w3.org/TR/css-scroll-anchoring-1/) for why the browser's own
anchoring is opted out of, and the [MRC Viewable Ad Impression
guidelines](https://www.iab.com/wp-content/uploads/2015/06/MRC-Viewable-Ad-Impression-Measurement-Guideline.pdf)
for the default impression semantics (≥50% for ≥1 continuous second) rather than
invented thresholds.
