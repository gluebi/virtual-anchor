---
'virtual-anchor': patch
---

Drop the `subscribeWithSelector` middleware, and make an unchanged index range publish the same tuple.

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
