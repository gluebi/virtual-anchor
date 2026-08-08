# virtual-anchor

A virtual list for long, variable-height content — built for the case where "scroll to
comment #4211" has to land on comment #4211, and where loading older comments at the top
must not move the view by a single pixel.

```bash
pnpm add virtual-anchor
```

One package, two entry points:

```ts
import { createEngine } from 'virtual-anchor'          // framework-agnostic
import { VirtualList } from 'virtual-anchor/react'     // React 19 adapter
```

The React entry needs React 19; the core entry needs nothing. React is an *optional* peer
dependency, so using the core alone pulls in no framework and warns about none.

Minified and brotlied, including its one dependency: **9.38 kB** for the core entry, **11.65 kB**
if you import the React adapter (which contains the core — they share a chunk rather than
duplicating it). Both are enforced as budgets in CI, so this figure cannot drift from the
truth.

## Why another one

Because of one design decision, from which everything else follows.

Every existing virtual list models scroll position as **a pixel offset into an
index-addressed list**, and then bolts corrective heuristics on top. This one
stores position as **an anchor**:

```ts
{ key: 'comment-4211', offsetWithinItem: 37.5 }   // not scrollTop: 918342.5
```

`scrollTop` is *derived* from the anchor whenever the layout changes underneath.
That inversion is the whole library:

- **Prepending cannot move the view.** New comments above change the anchored
  item's offset, so the recomputed `scrollTop` differs — which is exactly what
  keeps the same pixel of the same comment under the same row of the screen. No
  `firstItemIndex` countdown, no positional shift flag, no index arithmetic in
  your code. You hand over a longer array.
- **A measurement landing above the viewport requires no decision.** There is no
  "should I compensate?" predicate, no scroll-direction check, no fold-spanning
  special case. The anchor did not change, so the view did not change. The class
  of bug those heuristics exist to patch is structurally absent.
- **`scrollToKey` is a fixed point, not a calculation.** "Landed" is a predicate —
  the anchor equals the target — so the scroller iterates to it instead of
  computing one offset and hoping the estimates held.

And three things no other virtual list offers at all:

- **Chrome that can resize without moving the view.** A `header` inside the
  scroller is measured, not declared — and when it grows, because an image
  decoded or a font swapped, the view does not move. Everywhere else this is
  either your number to keep in sync (virtua's `startMargin`, TanStack's
  `scrollMargin`) or measured without compensating, which is the jump behind
  virtua #458 and react-virtuoso #1245. Here the anchor absorbs it for the same
  reason it absorbs a prepend.

- **Per-item viewport events.** react-virtuoso's `rangeChanged` reports the
  *rendered* range with overscan folded in, so it calls items 600px off-screen
  visible; virtua removed its range event; TanStack's `VirtualItem` has no
  visibility field. Here every item reports its own enter and leave, with
  configurable thresholds, dwell time and fire-once semantics — including a
  trailing-edge rule, so "they read this" holds for a comment taller than the
  screen as well as a one-line one.
- **An honest settle signal.** `scrollToKey` returns a promise resolving with
  `{ settled, deviation, iterations, reason }`. When it could not get there, it
  says so — and says why.

## Quick start

```tsx
import { VirtualList, type VirtualListHandle } from 'virtual-anchor/react'
import { useRef } from 'react'

function Thread({ comments, totalCount, firstLoadedPosition }) {
  const list = useRef<VirtualListHandle>(null)

  return (
    <VirtualList
      items={comments}
      getItemKey={(comment) => comment.id}
      estimateSize={(comment) => 56 + comment.paragraphs * 53}
      gap={12}
      scrollPaddingStart={64}              // clear page chrome outside the list
      header={<ThreadDescription />}       // measured; resizing it cannot move the view
      stickyFooter={<Composer />}
      totalCount={totalCount}              // the whole thread, for aria-setsize
      firstItemPosition={firstLoadedPosition}
      ref={list}
      style={{ height: '100%' }}
      renderItem={(comment) => <Comment data={comment} />}
      visibility={{
        rule: { mode: 'fraction', of: 'item', fraction: 0.5 },
        dwellMs: 1000,
        once: true,
      }}
      onVisibilityChange={(events) => {
        for (const event of events) if (event.phase === 'enter') markRead(event.key)
      }}
    />
  )
}

// Deep-link, then highlight once motion has genuinely stopped.
const result = await list.current.scrollToKey('comment-4211', { align: 'start' })
if (result.settled) flash('comment-4211')
else console.warn('could not land:', result.reason, result.deviation)
```

The headless `useVirtualList` gives the same engine with your own markup, including
`headerRef`, `stickyHeaderRef`, `footerRef` and `stickyFooterRef` for the slots below —
attach them in that order around `containerRef`, since that is the layout their measured
heights are composed for.

## Four contracts worth reading before you start

**Item margins are not supported.** Use the `gap` option. No ResizeObserver box
includes margins, and margin collapsing between adjacent items is not observable
at all — so a margin is silently missing from every offset and the list drifts a
little further with each item. This is react-virtuoso's single largest support
burden. In development, a non-zero block margin on an item logs a warning naming
the offending key.

**Find-in-page cannot reach unmounted items, and nothing fixes that.**
<kbd>Ctrl</kbd>+<kbd>F</kbd> searches the DOM; virtualization means most of your
content isn't in it. `content-visibility: auto` keeps nodes findable but requires
rendering all of them, which defeats the purpose. What the library can do is make
jumping to a hit exact — build in-app search and use `scrollToKey`. The demo
shows this.

**Do not fetch a page while a programmatic scroll is in flight.** A prepend moves
every offset below it, so a page arriving mid-animation moves the target the
animation is chasing — and the newly inserted items are unmeasured, so it keeps
moving as they measure. The scroll still lands on the right *item* (the target is
tracked by key and re-resolved every frame), but convergence takes longer, and a
fetch on every scroll event can outrun it indefinitely.

Use `onEdgeReached`, which will not fire while one is:

```tsx
<VirtualList
  onEdgeReached={(edge) => { if (edge === 'start') void loadOlder() }}
  edgeReachedThreshold={600}
/>
```

The library still cannot decide *whether* to fetch — that is a product question — but it
can refuse to ask at the one moment the answer must be no, which is the half of this
contract that used to be yours to remember. If you are watching `onScroll` yourself
instead, `listRef.current?.isScrolling()` is the same guard by hand.

**The first aim at an unmeasured target is always a guess.** You cannot know the
height of something that has never been laid out. Error scales with
`|actual − estimate| × distance`. The convergence loop, synchronous measurement on
mount, the size snapshot and a good `estimateSize` all narrow it; the sub-pixel
carry makes the *final* landing exact. Nothing makes the *first* guess exact — so
supplying a decent `estimateSize` is the highest-leverage thing you can do.

## Sub-pixel accuracy, and why it needs a trick

Browsers snap scroll offsets to physical pixels, and WebKit truncates them to
integers outright. Writing 1204.5 gets you 1204. So exact landing is impossible
by writing `scrollTop` alone:

| engine | dPR | worst error, naive | worst error, with carry |
|---|---|---|---|
| Chromium 151 | 1 | 0.5px | **0** |
| WebKit 26.5 | 2 | 0.5px | **0** |
| Firefox 153 | 1 | 0.5px | **0** |

The fix is to write the integer part and carry the leftover fraction as a
sub-pixel offset on the item container, rather than re-writing `scrollTop` to
chase it. No other virtual list does this, which is why their best case is
0.5–1px. It is verified per-engine in `spike/` and asserted in the e2e suite.

## Accessibility

`VirtualList` implements the WAI-ARIA **feed** pattern, not a list — a list
cannot express "comment 4211 of 12000" while sixty items are mounted.

- `role="feed"` with `role="article"` items carrying `aria-posinset` and
  `aria-setsize` against the **whole** collection (hence `totalCount` and
  `firstItemPosition`), plus `aria-busy` while a page loads
- <kbd>PageUp</kbd>/<kbd>PageDown</kbd> move between articles and
  <kbd>Ctrl</kbd>+<kbd>Home</kbd>/<kbd>End</kbd> to the ends of what is loaded — all
  four move *focus*, not just the view, so a keyboard user is never left behind by the
  scroll they just asked for
- **Focus retention**: a focused item that scrolls out of the rendered range stays
  mounted, instead of dropping focus to `<body>` and losing a keyboard user's place.
  This holds for focus on something *inside* a row too — a permalink, a reply button —
  which is the case that matters for any row with interactive content
- `scrollToKey` moves focus to the target once the scroll settles, which is what
  makes a permalink work with a screen reader at all
- `prefers-reduced-motion: reduce` turns a smooth scroll into an instant jump

## Older Safari

Settle detection is driven by a `requestAnimationFrame` loop, which works
everywhere and is bounded by its own deadline, so a promise cannot hang. Where
`scrollend` exists it is used to corroborate that loop — once the platform says the
scrolling is over and the target is already still, there is nothing left to wait for,
so the promise resolves a little sooner. A measurement or a prepend arriving
afterwards invalidates it, because either one means the target may still be moving.

`scrollend` reached baseline with Safari 26.2. For better fidelity on older Safari,
install the optional peer and import it once in your app:

```ts
import 'scrollyfills'
```

Two caveats, stated because they are easy to be bitten by: it patches
`addEventListener` on `Element.prototype`, `window` and `document` as an import
side effect — which is why this library will not import it for you — and it tracks
touch pointers but not `wheel`, so on older desktop Safari with a trackpad its
debounce can still fire mid-gesture. It ships no types; add
`declare module 'scrollyfills'` if your build needs it.

## API

`virtual-anchor` is the framework-agnostic core; `virtual-anchor/react` is the React
adapter. Generated reference: `pnpm docs`.

Key options: `items`, `getItemKey`, `estimateSize`, `gap`, `buffer`,
`scrollPaddingStart`/`End`, `scrollMargin`, `keepMounted`, `visibility`,
`sizeSnapshot`, `windowScroller`, `onVisibleRangeChange`, `followOutput`,
`alignToBottom`, `atBottomThreshold`, `onAtBottomChange`, `onEdgeReached`,
`edgeReachedThreshold`, the four slots below, and on the component `scrollerRef`,
`onEngineReady` and `stableScrollbarGutter`.

`VirtualList` sets `scrollbar-gutter: stable` on the scrollport it creates. Not cosmetic:
a scrollbar appearing once the rows overflow narrows the scrollport, and a width change
invalidates every height measured before it — so the list discards them, correctly, and
the rows already scrolled past are never re-measured. They keep their estimate for good.
The symptom is a scrollbar slightly the wrong length and a `scrollToKey` that overshoots
on a cold list, which points nowhere near the cause. Opt out with
`stableScrollbarGutter={false}`; an explicit `style={{ scrollbarGutter: … }}` wins either
way. Under `windowScroller` nothing is written — the document's gutter is the host page's
decision, not a list's.

### Content around the list

Four slots hold content that shares the scroller with the items: `header` and
`footer` scroll away with the list, `stickyHeader` and `stickyFooter` pin to an edge.
They render in that order — header, stickyHeader, items, footer, stickyFooter — so a
filter bar pins once the description has scrolled out from under it, and an "end of
thread" note scrolls above a pinned composer.

**All four are measured, and this is the part no other virtual list does.** Everywhere
else the height of content above the list is a number you supply — virtua's
`startMargin`, TanStack's `scrollMargin` — and a number that disagrees with the DOM
puts every landing out by the difference, silently and permanently. react-virtuoso does
measure its `Header`, but does not compensate the scroll position when it changes, so a
header that loads an image shoves the view down mid-read.

Measuring is safe here for the same reason prepending is: the anchor names a comment,
not an offset. When a slot's height changes, the derived `scrollTop` changes by exactly
as much, and the same pixel of the same comment stays under the same row of the screen.
A header can decode an image, swap a font or take a late translation and the reader
sees nothing happen.

Style them through `[data-virtual-slot="header"]` and friends. Put no block margin on
your own content's outermost element — the wrapper establishes a block formatting
context so a margin cannot escape it, but a margin *on* the wrapper's child edge is the
one thing ResizeObserver cannot see, the same contract items have.

`scrollToKey(lastKey, { align: 'end' })` stops at the last comment rather than
scrolling on to the footer, and an item aligned to the end comes to rest above a sticky
footer rather than behind it.

### Following a list that is still growing

`followOutput` keeps the view pinned to the newest comment as the thread grows, and lets
go the moment the reader scrolls away — a chat, a log tail, a thread with a live reply
arriving. It comes back when they scroll back to the end.

```tsx
<VirtualList
  followOutput
  alignToBottom                                 // short threads sit at the bottom
  onAtBottomChange={(atBottom) => setShowJumpButton(!atBottom)}
  onEdgeReached={(edge) => { if (edge === 'start') void loadOlder() }}
/>
```

Pinning is an instant write rather than an animation, deliberately. The destination moves
on every append *and* on every measurement of a message still streaming in, and an
animation chasing that is the hazard the fetching contract above describes. It is also
what keeps `atBottom` honest: following goes to the scroller's true maximum, which is
exactly where being at the bottom is measured from.

"Scrolled away" means a wheel, a touch, a pointer or a key — never an offset the browser
moved on its own. The browser adjusts `scrollTop` more often than it looks, clamping it
when content shrinks and again when a window of items is replaced, and reading that as
intent would unpin a reader who touched nothing.

Letting go happens immediately, so the list never fights a reader trying to leave the
bottom. Taking hold again waits until their scrolling has actually stopped — a fling is
still in flight when its first scroll event arrives, and judging the position then would
decide "not at the end" and never revisit it.

**`onEdgeReached` does not fire while a programmatic scroll is in flight.** That is the
reason to prefer it over an `onScroll` handler: it is the one moment the contract above
says not to fetch, so the callback simply does not ask. What remains yours is the part
that is genuinely a product decision — whether there is more to load, and whether a fetch
is already running.

`scrollMargin` survives alongside them, and now means only what it always described:
how far the list sits down the *document*, which matters for `windowScroller` where
page chrome above the component is part of the scroll offset. Measure it rather than
assuming, since borders count. It composes with a measured header rather than being
replaced by it.

Handle: `scrollToKey`, `scrollToIndex`, `cancelScroll`, `isScrolling` (see the
fetching contract above — though `onEdgeReached` now answers it for you), `focusItem`,
`getAnchor`/`setAnchor` (persist a position
across navigation), `takeSizeSnapshot` (persist measurements; keyed to a layout
signature so a width or zoom change discards them rather than restoring lies).

The handle is the scroll *API*; `scrollerRef` is the *node*, for sharing the
scrollport with something else — pull-to-refresh, a scroll-linked gradient, a
third-party scroll library. Observe through the ref and move through the handle:
writing `scrollTop` yourself means fighting the convergence loop. With
`windowScroller` it resolves to whatever the document actually scrolls, which the
`Viewport` decides in one place — so the node you are handed is the same one the
library clamps and fingerprints against, in quirks mode as well as standards.

`onEngineReady` hands out the `Engine`, which is what `useItemVisibility(engine,
key)` wants — a callback rather than a handle field because that hook subscribes
through it, so it has to be reactive, and there is no engine until the scrollport
exists. It is called with `null` on teardown.

`onVisibleRangeChange` reports the on-screen index range, buffer excluded. A
notification rather than a value on purpose: a scroll that moves the range within the
mounted set triggers no React render at all, which is most scroll frames, so a field
fed from a render would sit still through exactly what it describes. When you need the
range *now* rather than on change — a keyboard handler, a fetch decision — the
headless hook's `getVisibleRange()` reads it live.

Visibility rules: `{ mode: 'any' }`, `{ mode: 'fraction', of: 'item' | 'viewport',
fraction }`, `{ mode: 'full' }`, `{ mode: 'edge', edge: 'start' | 'end', tolerancePx }`
— with `dwellMs` and `dwell: 'continuous' | 'cumulative'`, `once`, `quiet`,
`leaveDelayMs`, `rootMargin`. The MRC viewable-impression standard is
`{ rule: { mode: 'fraction', of: 'item', fraction: 0.5 }, dwellMs: 1000, dwell: 'continuous' }`.

`edge` is the rule for "the reader got to the end of this", and the only one that is
satisfiable whatever an item's height happens to be. Every fraction has a hole:
`of: 'item'` is unreachable above `viewport / fraction`, `of: 'viewport'` unreachable
below `fraction × viewport`, and `full` unreachable for anything taller than the
viewport at all. A thread with both one-liners and fourteen-paragraph essays in it has
no single correct fraction — one setting marks a long comment read with half of it
still below the fold, the other never marks it at all. `tolerancePx` absorbs sub-pixel
rounding at the boundary and defaults to 1; it stacks on `rootMargin`. Use
`of: 'viewport'` instead when you want "enough of this was on screen" rather than
"they reached its end".

A dwell completes on time rather than on activity: stop scrolling with a comment
half-read and it is still reported when its clock runs out. Events are suppressed
during a programmatic scroll, so `scrollToKey` across ten thousand comments reports
the destination and nothing it flew past.

Every event carries `measured`, saying whether the item's geometry was a real
measurement or an estimate. `fraction` and `full` never report an unmeasured item at
all — "half of it is showing" is a guess dressed as a fact — while `any` and `edge` do,
and say so. Under `once` they do not: that mode grants a key exactly one report and
there is no second one to correct it, so an unmeasured item is held back until it has
been measured. That is what makes filtering on `measured` safe rather than lossy.

## Debugging

The library can narrate its own decisions — every scroll event as it arrives, every attempt to
move the scroll offset and why it did or did not happen, anchor restores, measurement batches
with what they cost, visibility deadlines:

```ts
import { addTraceListener } from 'virtual-anchor/react'

const stop = addTraceListener(({ topic, data }) => { console.log(topic, data) })
```

`addTraceListener` returns an unsubscribe and composes: your listener and the debug overlay
below can both be attached at once. `setTraceSink` is still there and still replaces whatever
*it* installed last, which is what it always did — it simply no longer evicts listeners it did
not install. (That was not hypothetical. The demo installed a ring buffer and then replaced it
with a HUD that had to re-implement the buffer by hand, because installing the second silently
discarded the first.)

**Off by default, and genuinely absent rather than merely inert.** Nothing is computed with no
listener attached — payloads are built inside a thunk — and every call site sits behind a
build-time constant, so the default build contains no guards, no topic strings and no `trace`
function at all. `pnpm check:package` greps the published artifact for topic strings and fails
the build if any survive, because this package previously claimed the instrumentation was inert
while about 2 kB of it shipped. The claim was wrong for an interesting reason: esbuild's bundler
prints every top-level `const` as `var`, so what reached a consumer's minifier was not a
constant and could not be folded. The fold now happens in this package's own build, which is the
last place the `const` still exists.

### Turning it on

In development it is on already: with nothing configured the flag falls back to
`process.env.NODE_ENV !== 'production'`, exactly as before.

To keep it in a **production** build — which is what diagnosing a real device needs, because
dev-mode React and `StrictMode`'s double invoke are themselves a source of jank — resolve the
`development` export condition:

```ts
// vite.config.ts. This replaces Vite's default list, so respell the other two.
export default defineConfig({
  resolve: { conditions: ['module', 'browser', 'development'] },
})
```

```js
// webpack 5 / Next.js — a user value replaces rather than appends, so prepend.
config.resolve.conditionNames = ['development', ...config.resolve.conditionNames]
```

Your app stays a production build: React 19 ships no `development` condition, so nothing about
this flips React itself. Turbopack exposes no condition control; there, build this package from
source and define `__VIRTUAL_ANCHOR_DEBUG__` instead.

### The toolkit

Reading a few hundred raw events on a phone is not diagnosis. `virtual-anchor/debug` turns the
stream into a ranked answer:

```ts
import { installDebug } from 'virtual-anchor/debug'

installDebug({ target: '.my-scroller' })
```

That records into a ring buffer, watches frame timing, watches touches, prints a verdict to the
console when each gesture settles, and draws the same verdict on the page for a device with
nothing attached to it. `analyzeGestures(events)` is a pure function if you would rather have
the numbers — it runs in a test, in a worker, or over a trace someone emailed you.

The entry ships **only if you import it**, so the core entry's size is unchanged and CI enforces
that with a budget on each. The verdict names what it found and what it could not distinguish;
it says `RECORD TRUNCATED` and refuses to rank rather than drawing a conclusion from a buffer
that dropped the start of the gesture.

### Topics

| topic | when | key fields | volume |
|---|---|---|---|
| `scroll.sample` | every scroll event, stamped at delivery | `offset`, `carry`, `shift` | per frame |
| `anchor.derive` | the anchor re-read from an observed offset | `anchor`, `skipped` | per frame |
| `scroll.step` | one frame of a programmatic scroll | `target`, `remaining`, `arrived` | per frame |
| `scroll.write` | the engine attempting to move the offset | `reason`, `took`, `room`, `max`, `heldAfter` | per correction |
| `paint.offset` | the container's visual displacement changed | `px`, `carry`, `shift` | per correction |
| `scroll.commit` | the *scroller* writing, refused or taken | `refused`, `banked` | per frame while scrolling |
| `gesture.fold` | a banked correction becoming a real offset | `shift`, `clamped`, `carryBefore/After` | once per gesture |
| `scroll.gate` | the momentum gate changing state | `state`, `reason` | a few per gesture |
| `gate.attach` | once, at mount, before the off-iOS return | `ios` | once ever |
| `scroll.park` / `wake` / `flush` | the convergence loop sleeping and resuming | `banked`, `suspended` | once per gesture |
| `measure.batch` / `measure.done` | a ResizeObserver delivery, and what it cost | `count`, `invalidated`, `ms` | per batch |
| `layout.signature` | the fingerprint that invalidates measurements | `signature`, `previous`, `cleared` | rare |
| `frame.long` / `frame.summary` | from the toolkit's probe, not the core | `gap`, `longest` | outliers only |

`scroll.write`'s `reason` is the field worth knowing: `held` means the correction was banked and
nothing was written, `gate-open` an ordinary write, `model` a prepend deliberately overriding a
shut gate, and `no-room` a correction that had to be written because banking it would have
exceeded the scroll range on that side. On iOS that last one cancels the fling.

Three topics account for every `scrollTop` write the library makes: `scroll.write` from the engine,
`scroll.commit` from the scroller, and `gesture.fold` — the fold is a write too, and deliberately
not a `scroll.write`, because it converts a correction already taken rather than making a new one.

Payload shapes are declared in one place and `trace` is generic over the topic, so an emitter cannot
drift from what a reader expects — which matters because the analyzer reads by field name from
several modules away, where a rename would otherwise compile clean and report nothing.

### Diagnosing a fling on a phone

1. `pnpm --filter demo build:trace && pnpm --filter demo preview` — a production build with the
   instrumentation kept.
2. Open `?debug=1&quiet=1` on the device and fling the list, including *into* the end of it.
3. Read the verdict pane, or the console if the Web Inspector is attached.
4. Tap **save** to get the JSON off the device. Note that `navigator.clipboard` and
   `navigator.share` need a secure context, and a LAN dev server over plain http is not one — so
   the download and the on-screen textarea are the two mechanisms that actually work there.
5. Re-run **without** `quiet=1` and compare the longest frame. The difference is your app's own
   per-frame work; the residue is the library. That differential is the only honest way to tell
   them apart, which is why the analyzer will not guess at it from a single recording.
6. Re-run with `probe=0` to confirm any timing finding without the frame probe, which costs one
   main-thread wakeup per frame and so perturbs what it measures.

Every bug found in this library so far was found by measuring rather than by reasoning about the
code. This is that, made repeatable.

### The benchmark

The toolkit above answers *why this gesture misbehaved*. It cannot answer *how fast does this
scroll*, and deliberately so: it records only outlier frames, because a ring buffer that also held
the ordinary 16 ms case would push the gesture that matters out of it. A percentile needs the
frames it throws away.

For watching rather than measuring, the demo carries a live frame-rate readout in its corner —
current rate and the worst frame in the last quarter-second. It writes `textContent` on a node it
owns rather than re-rendering, because a meter that re-rendered the page every frame would cause
the jank it displays. `fps=0` turns it off: it still costs one `requestAnimationFrame` wakeup per
frame, the same price as `probe`, and the benchmark below passes it for that reason.

`pnpm perf` is the other question. It builds the demo **without** instrumentation — measuring
frame time on an instrumented build measures the instrumentation — serves it on its own port, and
drives it in headed Chromium with CDP-synthesized input at a stated speed:

```bash
pnpm perf                       # the whole thing, about four minutes
```

Three reports come out of `perf/`:

| spec | question |
|---|---|
| `scroll-fps.spec.ts` | frame rate and per-event handler cost, for wheel, `scrollToKey` and a fling, across three dataset sizes |
| `headroom.spec.ts` | how much slower the machine could be before frames start dropping |
| `blanking.spec.ts` | whether a hard fling outruns the mounted rows, and what it takes |

**It is not in CI, and must not be.** This repo settled that in `af282b8` — "stop asserting the
speed of the machine": a shared two-core runner produces gaps a laptop never will, and a threshold
there fails for the wrong reason. So the specs report and do not assert, exactly as
`ios-momentum.spec.ts` does. What they *do* assert is that the measurement happened — that the
gesture moved the scroller, that frames were recorded, that the recorder did not overflow, and
that the idle frame period is a plausible display period. That last one is not pedantry: an
occluded Chromium window throttles `requestAnimationFrame` to about 1 Hz, and every figure after
it would be catastrophic and meaningless.

Two things the harness had to learn the hard way, both preserved in the specs' comments because
they are easy to repeat. A per-frame count of *sample points with no row under them* measures the
demo's 12 px inter-item `gap`, not blanking, and reports a flat 7% at every speed from a crawl to
50,000 px/s. And a `requestAnimationFrame` probe cannot see blanking at all: it runs after the
scroll handler in the same frame, so it only ever observes a world the handler has already made
consistent. Blanking lives in the frames the compositor presented on its own, which takes a
screencast to see.

## Coming from another library

| | equivalent here |
|---|---|
| TanStack `scrollToIndex` + `scrollAdjustments` | `scrollToKey`; there is no adjustment concept to configure |
| TanStack `getItemKey` | `getItemKey` — but keys are load-bearing here, not an optimisation |
| TanStack `scrollMargin` for a header, plus your own ResizeObserver | `header`; it is measured for you |
| Virtuoso `components={{ Header, Footer }}` | `header` / `footer` as elements — no component types, so no remount-on-inline footgun |
| Virtuoso `headerFooterTag` | nothing; style the wrapper through `[data-virtual-slot]` |
| Virtuoso `topItemCount` / `TopItemList` | `stickyHeader`, which is measured into the visible area rather than pinning *items* |
| virtua `startMargin` | nothing; mount a `header` and it is measured |
| Virtuoso `followOutput` | `followOutput`, but boolean — pinning is always instant, because the destination moves every frame |
| Virtuoso `atBottomStateChange` / `atBottomThreshold` | `onAtBottomChange` / `atBottomThreshold` |
| Virtuoso `endReached` / `startReached` | `onEdgeReached('end' \| 'start')`, suppressed during a programmatic scroll |
| Virtuoso `alignToBottom` | `alignToBottom` |
| virtua `reverse` | `followOutput` with `alignToBottom` |
| Virtuoso `firstItemIndex` | nothing; just pass a longer array |
| Virtuoso `rangeChanged` | `onVisibleRangeChange` (excludes buffer) or per-item `onVisibilityChange` |
| Virtuoso `computeItemKey` | `getItemKey` |
| virtua `shift` | nothing; prepending is the default behaviour |
| react-window `useDynamicRowHeight` | automatic |
| an `IntersectionObserver` per row for "read" tracking | `{ mode: 'edge', edge: 'end' }` on the shared tracker — nothing else offers a rule that works for items taller than the viewport |

## Requirements

**ESM only.** There is no CommonJS build: a `require()` of this package will fail, and a
CJS consumer needs a dynamic `import()`. That is deliberate rather than lazy — a dual build
means two module instances, and this package holds module state (the trace sink), so a
`setTraceSink` call through one instance would silently miss the other's events. Vite, Next,
Rollup, esbuild and modern webpack are all fine; Jest needs its ESM support enabled.

React 19 for the `virtual-anchor/react` entry only — it is an *optional* peer, so using the
core entry pulls in no framework and warns about none.

A bundler (or Node) that defines `process.env.NODE_ENV`, which is the same assumption React
itself makes. The development warnings are keyed to it, and loading the build straight from a CDN
into a browser without substituting it will fail at module evaluation.

Tracing is no longer keyed to it. It has its own build-time flag, off in the published default
build and reachable through the `development` export condition, so that a *production* app can
carry an instrumented library — which is what diagnosing a real device requires. See
[Debugging](#debugging).

Client-only: there is no SSR path. A virtual list cannot render meaningfully on a server
that has no viewport, and pretending otherwise produces markup the client immediately
throws away.

## Development

```bash
pnpm install
pnpm dev           # the demos: a forum thread, and /pagination.html
pnpm test          # unit + property tests
pnpm test:coverage # the same, with the per-file floors enforced (what CI runs)
pnpm test:e2e      # accuracy across Chromium, WebKit and Firefox
pnpm size          # bundle budget
```

The thread demo can post comments above or below what you are reading, in any number, and
reports how far the view moved — which should be zero. The pagination page covers the two
collection changes the thread page does not: replacing every item (pages) and appending
(infinite scrolling), including the defer-while-scrolling protocol in action.

WebKit is not optional in the e2e matrix. Three separate bugs in this library
appeared only there, all downstream of its integer-only scroll offsets.

Coverage thresholds are per-file floors set at what the suite actually reaches, so
they cannot quietly slip. They were enforced on three files once, which is how the
integration layer and the whole React adapter came to sit at 0% behind a green build.

The `mobile-webkit` project runs the same WebKit behind an iPhone descriptor, so
`isIOSWebKit()` is genuinely true and the momentum write gate is live. That is what
verifies the gate's *wiring* — that no `scrollTop` write escapes while a gesture is in
flight, and that a prepend still writes anyway.

**Still not verified here:** that momentum itself survives. Playwright dispatches touch
events but produces no fling, and a simulator's scrolling does not reproduce WebKit's
deferred-write behaviour either — so the symptom needs a real device even though the
defect behind it no longer does.

## License

MIT. See [THIRD-PARTY.md](./THIRD-PARTY.md) for the prior art this design learned
from.
