# virtual-anchor

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
