---
'virtual-anchor': patch
---

Read the scrollport's height once per pass, instead of three times.

`getViewportSize` is three DOM reads on an element scroller — a `getBoundingClientRect` plus
`offsetHeight` and `clientHeight`, per `contentHeightOf` — and a publish reached it from three
places: `syncLeadingSpace` for the `alignToBottom` spacer, `computeRanges` through
`syncGeometry`, and the visibility sample through `syncGeometry` again.

The third one is the one that cost something. `sampleVisibility` is the last thing `publish`
does, so it runs **after** every mounted row's `top` and the paint offset have been written.
A read there is not a repeat, it is a forced synchronous layout — once per scroll event — to
re-answer a question the same pass had already answered. `engine.dom.test.ts` pins it: with the
old code the reads land at write-counts `[220, 220, 254]`, and that third entry is thirty-four
style writes after the pass began.

The pass now reads it once, before it writes anything, and hands it down. `syncGeometry` also
moves up to the pass rather than being called by each consumer, which removes a second
`listGeometry.update` with identical arguments in every path that existed.

Deliberately **not** a cache inside `Viewport`, which is the obvious alternative: it would need
an invalidation signal that does not exist. `observeSize` watches the *border* box, and a
horizontal scrollbar appearing changes `clientHeight` — and so the content height — without
moving that box at all. A cache keyed on that observer would go quietly stale by the
scrollbar's width. A parameter cannot.

One path still reads for itself, and should: the visibility deadline timer is not inside a
publish, so it has no pass to take the number from. It fires when nothing else is happening, so
the read is neither hot nor forced.

No behaviour changes. `getMaxScrollOffset` still reads the DOM after the content-size write,
because the extent is exactly what that write changed — deriving it from our own total is
TanStack #1001, which `viewport.ts` already warns against.
