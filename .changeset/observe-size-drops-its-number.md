---
'virtual-anchor': minor
---

`Viewport.observeSize`'s callback no longer receives a size.

The parameter dates from a time when a scrollport resize *was* a height change: the callback
reported the new block size, and reporting it was the point. Nothing has read that number for
some time. The engine — the only consumer — subscribed with a closure whose entire body was to
throw the argument away:

```ts
viewport.observeSize(() => {
  onViewportResize()
})
```

and `onViewportResize()` takes no parameter at all. It re-reads the layout signature from
`viewport.getScrollportElement()` and asks `viewport.getViewportSize()` for the scrolling axis,
because both of those are questions about *now*, and a number captured when the observer fired
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
