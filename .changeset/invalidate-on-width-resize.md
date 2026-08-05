---
'virtual-anchor': patch
---

Invalidate measurements when the scrollport changes width without changing height.

The size cache is keyed on a layout signature — `w=<clientWidth>|f=<rootFontSize>|dpr=<dpr>`,
the same key a `sizeSnapshot` is trusted against — because a row height measured at a
different container width is not stale, it is *wrong*. The scrollport's width is in that key
for the only reason that matters: it is what decides where text wraps.

Only one thing re-read that key at runtime, and it was reached from exactly one place:
`viewport.observeSize`. For an element scroller that callback compared the delivered **block**
size against the last one and returned early when they matched — so a `ResizeObserver`
delivery reporting a new width and the same height stopped there.
`observe(element, { box: 'border-box' })` does fire for a width-only change; the callback
simply discarded it, the signature was never re-read, and nothing was invalidated. The irony
is that the consumer's own comment says "the *height* of the scrollport reflows nothing", and
a height change was the only thing that could reach it.

What that produced downstream is rows drawn overlapping or with gaps, rather than a wrong
scroll extent. The rows inside the mounted window are re-measured by the item observer as
soon as the reflow changes their height, so they heal on their own; the rows outside it keep
the height they were measured at under the old width, because nothing mounts them and nothing
cleared them. The prefix sum then mixes current and stale heights and places rows at offsets
that do not match their real heights. Scrolling such a row out of the window and back in
unmounts, re-mounts and re-measures it, which fixes that one row — the "scroll it away and
back and it's fine" symptom, reported against 0.5.0 on a desktop forum thread list where a
responsive column narrowed without the list's height moving.

`createElementViewport().observeSize` now remembers the last border box on both axes and
forwards a delivery when either one moved. The callback still carries the block size, so the
`Viewport` interface is unchanged. A forwarded delivery that turns out to change nothing
material costs one `layoutSignatureFor`, a string compare that `setLayoutSignature` no-ops on,
and the same non-invalidating `publish` any height resize already performs — so a width the
signature rounds to the same integer is cheap rather than free. A height-only resize still
keeps every measurement, which is the case that
distinction exists for: a mobile URL bar hiding, devtools opening, a soft keyboard appearing
or a vertical window drag reflow nothing, and discarding the cache for them is wasteful and —
against a restored snapshot — destructive.

The first delivery is still forwarded, as it always was. `observe()` synthesises one for a
newly observed element, and not reading *that* one as a change is the consumer's job: the
engine learns the signature on the first observation and only compares from the second. Which
is why the regression test has to deliver the scrollport's starting box before the width
change — without it the width change is a first delivery, reports either way, and the test
passes against the defect.

`createWindowViewport` needed no change, and there is now a test saying so rather than a
claim: its `observeSize` deduplicates nothing at all, reporting `view.innerHeight` on every
`resize` and `visualViewport` resize, and the engine discards the number and re-reads the
signature itself. So a horizontal window resize — the ordinary way a `windowScroller` list's
scrollport changes width — already invalidated correctly.

One hole in the same class remains, and this does not close it: the signature is only ever
re-read on a resize, so a `devicePixelRatio` change with no box change (a window dragged to a
display with a different scale factor) or a root-font-size change that alters no CSS box
notifies nothing at all. Both are in the key and neither has an observer behind it.
