---
'virtual-anchor': minor
---

`Surface` gains `setTrailingSpace`, and `setContentSize` goes back to meaning what it says.

#82's sticky-footer fix needed empty space below the items — space that carries a `stickyFooter`
down to the bottom edge on a list too short to fill the scrollport, because `position: sticky;
bottom: 0` lifts a box to an edge and can never push one down to one. It took that space out of
the only write that could already produce it, `setContentSize`, by padding the sizer:

```ts
surface.setContentSize(contentSizeFor(totalSize, viewportSize))
```

Which made the interface's own documentation false. `setContentSize` is *"Total scrollable content
size"*, and it is the write every scroll write is ordered against. After that change it meant the
items' total most of the time, and the items padded out to the scrollport when a sticky footer sat
under short content — with nothing at the call boundary saying which. Meanwhile `store.totalSize`
kept publishing the honest number, so the model and the DOM disagreed by up to a scrollport in
exactly one configuration. Harmless, because the padding stops *at* the scrollport and the
browser's maximum stays 0, but `totalSize` is public API — it comes out of `useVirtualList` — and
anything comparing it against DOM extent had a several-hundred-pixel discrepancy and no signal
that it was expected.

The space is now its own write:

```ts
surface.setLeadingSpace(leadingSpace)
surface.setTrailingSpace(trailingSpaceFor(totalSize, viewportSize))
surface.setContentSize(totalSize)          // literally true again
```

Computed and handed straight to the surface, where its counterpart `leadingSpace` is engine state.
The asymmetry is not an oversight: `leadingSpace` is a contribution to the composed insets, so it
has to be state the composition can read, while this is computed *from* the composition and
contributing to it would be self-referential. Nothing else reads it, and nothing could — it is
only ever positive where the scroll range is 0.

### Padding, not a margin

`setLeadingSpace` writes `marginTop`, so the symmetric write would be `marginBottom`. It is
`paddingBottom` instead, and the reason is a real defect the margin would have carried: the sticky
footer slot is the container's immediately following sibling, and adjacent siblings' margins
collapse. A consumer styling `[data-virtual-slot="stickyFooter"]` with a `margin-top` would get
the max of the two rather than the sum, leaving the composer short of the edge by their margin.
Padding cannot collapse with anything. It is safe for the items because they are absolutely
positioned against the container's *padding* box, whose top edge `padding-bottom` does not move.

Which is also the answer to the obvious follow-up — why `setLeadingSpace` does not get the same
treatment, since it has the identical exposure to a preceding slot's margin. That same fact runs
the other way at the top: `padding-top` does not move the padding box's top edge either, so it
would grow the container without moving a single item, which is the whole of what leading space is
for. One edge wants the items to move and the other wants them not to; that is what picks the
property, not symmetry.

`padding-bottom` in turn requires `box-sizing: content-box`, or the `* { box-sizing: border-box }`
reset almost every app carries — the demo included — absorbs it into the height and the footer
does not move a pixel. `a composer on a short thread still sits on the bottom edge` fails in
Chromium without it, which is how that was confirmed rather than assumed; jsdom cannot answer it,
since laying out `position: sticky` is exactly what jsdom does not do. It is written once on first
sight of the container, beside the height, rather than when a composer arrives: a box model that
flipped mid-life would reinterpret the `height` already written — and `width: 100%` with it — at
that instant, for every list that has one.

### What pins it

Seven cases in `createDomSurface trailing space` mirror the five `setLeadingSpace` cases and add
two the box model needs — `adds to the written height rather than coming out of it` and `settles
the box model before the height, not when a composer arrives`. The ten cases in `engine trailing
space` moved off the sizer and onto the new write, and got stronger doing it: where they used to
assert the sizer grew to 500 and shrank back, they now assert the space goes `[0, 200, 0]` **and**
that the sizer never leaves `[300]` — `leaves the sizer at the items’ own total` is the case that
would have caught the seam in the first place.

The browser case is unchanged and untouched, which is the point: the composer is still on the
bottom edge and the short thread still has no scroll range, by a different mechanism.

### Breaking

`Surface` gains a required method:

```ts
setTrailingSpace(px: number): void
```

Only an implementor of the interface is affected — the same scope as #29's `Surface.setCarry` to
`setPaintOffset` rename and #37's `Viewport.observeSize` change. Consumers of `VirtualList`,
`useVirtualList` or `createEngine` are not, and neither is anyone using `createDomSurface` or
`createNullSurface`, which are the two implementations this repo ships. If you hand-rolled a
`Surface`, add a method that holds `px` of empty space below the item container — a
`padding-bottom` on the same node whose height your `setContentSize` writes, with
`box-sizing: content-box` on that node so it adds rather than absorbs.

Three size limits move by 0.1kB: the core entry 10.14 → 10.19kB, the React entry 12.45 → 12.48,
the instrumented core 11.05 → 11.12. All three still fit their old budgets locally, but CI
measures ~0.03kB higher, and this repo has twice now found sub-0.1kB headroom to be noise between
toolchains rather than margin. The README's advertised figures were two bumps stale and are now
the measured ones.
