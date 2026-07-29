---
'virtual-anchor': minor
---

One answer to "what does the page scroll", and one mechanism for `scrollerRef`.

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
