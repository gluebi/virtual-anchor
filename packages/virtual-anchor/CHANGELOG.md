# virtual-anchor

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
