---
'virtual-anchor': minor
---

`VirtualList` gains four measured slots for content that shares the scroller with the list —
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

**Two channels, not one.** A `position: sticky` slot occupies in-flow space *and* covers part
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
footer is in-flow content *and* overlapping chrome, so it lands in `spaceAfter` *and* in
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
maximum double-counts a sticky footer, which is in-flow content *and* overlapping chrome, so
it lands the last comment exactly one composer-height too low — behind the composer, at
80.25px out in all three engines. Correcting for that lands Chromium and WebKit exactly and
Firefox 0.55px short, which is `getMaxScrollOffset` being built from an integer
`clientHeight`. So the shortcut is now taken only when `spaceAfter` is zero: it exists for
trailing space that *cannot* be measured, and once the trailing space is known, our own exact
float offsets are the better answer and the general alignment already computes them.

Bundle size moves from 8.45 kB to 8.96 kB for the core entry and 10.35 kB to 11.08 kB for the
React one, minified and brotlied, and the figures the README quotes move with them. The core
budget is unchanged at 9 kB; the React one goes from 11 kB to 11.2 kB, because four named slot
refs cost the ~70 bytes of headroom that were left and then eleven more. That is the trade the
API is worth: `ref={list.headerRef}` reads as markup where `ref={list.slotRef('header')}` reads
as a lookup, and the set of slots is closed at four so there is nothing to parameterise over.
