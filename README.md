# react-virtual-anchor

A React virtual list for long, variable-height content — built for the case where
"scroll to comment #4211" has to land on comment #4211, and where loading older
comments at the top must not move the view by a single pixel.

```bash
pnpm add react-virtual-anchor
```

Requires React 19.

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

And two things no other virtual list offers at all:

- **Per-item viewport events.** react-virtuoso's `rangeChanged` reports the
  *rendered* range with overscan folded in, so it calls items 600px off-screen
  visible; virtua removed its range event; TanStack's `VirtualItem` has no
  visibility field. Here every item reports its own enter and leave, with
  configurable thresholds, dwell time and fire-once semantics.
- **An honest settle signal.** `scrollToKey` returns a promise resolving with
  `{ settled, deviation, iterations, reason }`. When it could not get there, it
  says so — and says why.

## Quick start

```tsx
import { VirtualList, type VirtualListHandle } from 'react-virtual-anchor'
import { useRef } from 'react'

function Thread({ comments, totalCount, firstLoadedPosition }) {
  const list = useRef<VirtualListHandle>(null)

  return (
    <VirtualList
      items={comments}
      getItemKey={(comment) => comment.id}
      estimateSize={(comment) => 90 + comment.paragraphs * 70}
      gap={12}
      scrollPaddingStart={64}              // clear a sticky header
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

The headless `useVirtualList` gives the same engine with your own markup.

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
fetch on every scroll event can outrun it indefinitely. Ask before you fetch:

```tsx
const onScroll = () => {
  if (listRef.current?.isScrolling() === true) return
  if (nearTop()) void loadOlder()
}
```

The library cannot make this decision — when to fetch is a product question — but it
will tell you when not to.

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

`virtual-anchor` (the framework-agnostic core) and `react-virtual-anchor` (this
package). Generated reference: `pnpm docs`.

Key options: `items`, `getItemKey`, `estimateSize`, `gap`, `buffer`,
`scrollPaddingStart`/`End`, `scrollMargin`, `keepMounted`, `visibility`,
`sizeSnapshot`, `windowScroller`, `before`.

`scrollMargin` is how much content precedes the list *inside the same scroller*, and
`before` is where you put that content — a description, a filter bar. Their heights
have to agree. With `windowScroller`, the scroller is the page, so `scrollMargin` is
the list's offset within the document: measure it rather than assuming, since page
chrome and its borders count.

Handle: `scrollToKey`, `scrollToIndex`, `cancelScroll`, `isScrolling` (see the
fetching contract above), `focusItem`, `getAnchor`/`setAnchor` (persist a position
across navigation), `takeSizeSnapshot` (persist measurements; keyed to a layout
signature so a width or zoom change discards them rather than restoring lies).

Visibility rules: `{ mode: 'any' }`, `{ mode: 'fraction', of: 'item' | 'viewport',
fraction }`, `{ mode: 'full' }` — with `dwellMs` and `dwell: 'continuous' |
'cumulative'`, `once`, `quiet`, `leaveDelayMs`, `rootMargin`. Use `of: 'viewport'`
for items that can exceed the viewport, where a fraction *of the item* is
unreachable. The MRC viewable-impression standard is
`{ rule: { mode: 'fraction', of: 'item', fraction: 0.5 }, dwellMs: 1000, dwell: 'continuous' }`.

A dwell completes on time rather than on activity: stop scrolling with a comment
half-read and it is still reported when its clock runs out. Events are suppressed
during a programmatic scroll, so `scrollToKey` across ten thousand comments reports
the destination and nothing it flew past.

## Debugging

The library can narrate its own decisions — scroll convergence frame by frame, anchor
restores, measurement batches, visibility deadlines:

```ts
import { setTraceSink } from 'react-virtual-anchor'

setTraceSink(({ topic, data }) => { console.log(topic, data) })
```

Off unless you install a sink, and inert in a production build: payloads are built
inside a thunk so nothing is computed with no sink attached, and `setTraceSink` refuses
to install one at all once `NODE_ENV` is inlined (it returns `false`, so you can tell).
It costs a few hundred bytes of unreachable strings rather than nothing — minifiers do
not propagate the constant across modules, which is measured, not assumed. The demo
keeps the last 3,000 events in a ring buffer behind `?trace=1`, readable as
`__trace('scroll.')`.

Every bug found in this library so far was found by measuring rather than by
reasoning about the code. This is that, made repeatable.

## Coming from another library

| | equivalent here |
|---|---|
| TanStack `scrollToIndex` + `scrollAdjustments` | `scrollToKey`; there is no adjustment concept to configure |
| TanStack `getItemKey` | `getItemKey` — but keys are load-bearing here, not an optimisation |
| Virtuoso `firstItemIndex` | nothing; just pass a longer array |
| Virtuoso `rangeChanged` | `visibleRange` (excludes buffer) or per-item `onVisibilityChange` |
| Virtuoso `computeItemKey` | `getItemKey` |
| virtua `shift` | nothing; prepending is the default behaviour |
| react-window `useDynamicRowHeight` | automatic |

## Requirements

React 19, and a bundler (or Node) that defines `process.env.NODE_ENV` — the same
assumption React itself makes. Development warnings and tracing are keyed to it, and
loading the ESM build straight from a CDN into a browser without substituting it will fail
at module evaluation.

Client-only: there is no SSR path. A virtual list cannot render meaningfully on a server
that has no viewport, and pretending otherwise produces markup the client immediately
throws away.

## Development

```bash
pnpm install
pnpm dev           # the forum-thread demo
pnpm test          # unit + property tests
pnpm test:coverage # the same, with the per-file floors enforced (what CI runs)
pnpm test:e2e      # accuracy across Chromium, WebKit and Firefox
pnpm size          # bundle budget
```

WebKit is not optional in the e2e matrix. Three separate bugs in this library
appeared only there, all downstream of its integer-only scroll offsets.

Coverage thresholds are per-file floors set at what the suite actually reaches, so
they cannot quietly slip. They were enforced on three files once, which is how the
integration layer and the whole React adapter came to sit at 0% behind a green build.

**Not verified here:** the iOS momentum path, which needs a real device — a
simulator's scrolling does not reproduce WebKit's deferred-write behaviour.

## License

MIT. See [THIRD-PARTY.md](./THIRD-PARTY.md) for the prior art this design learned
from.
