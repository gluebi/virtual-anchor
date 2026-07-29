---
'virtual-anchor': minor
---

Four additions for consumers, and one removal.

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
`renderedRange` stays a field, and the asymmetry is the point: that one *is* part of
`needsRerender`, so a render always sees a current one. The notification comes from a store
subscription and costs no renders of its own.

The component's own keyboard paging was affected and is fixed with it: with nothing focused,
PageDown started from the snapshot's range, which could be a whole buffer out of date.

The README's migration table offered `visibleRange` as the answer to Virtuoso's `rangeChanged`,
which no `VirtualList` consumer could reach at all. That path now exists.
