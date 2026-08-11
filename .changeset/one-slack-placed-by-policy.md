---
'virtual-anchor': patch
---

fix: hold short content against the bottom of the *scroller*, not of the list

`alignToBottom` pads above the items so a thread too short to fill the scrollport sits at the
bottom of it. The padding was computed against everything the library measures for itself — the
four slots and the items — and against nothing the consumer declares. So `geometry.scrollMargin`,
which is page content above the list and the one inset that is routinely non-zero under
`windowScroller`, was not subtracted, and the spacer came out that much too tall. The same
omission applied to `geometry.spaceAfter` below the list.

The result is the opposite of what the option is for: on a document-scrolled page with 200px above
a three-comment thread in an 800px window, the spacer was 500px where 300px is the room, so the
content was pushed 200px past the bottom of the window and the page gained a scrollbar. A list
that fits, made to scroll, by the option whose whole job is to place a list that fits.

Both terms are now in the sum. `holds short content against the bottom of the scroller, not of the
list` and `counts the consumer’s own trailing space too` pin the two halves; both fail against the
previous build.

### One slack, computed once

The fix fell out of merging two functions that had been computing the same quantity.

There is exactly one such quantity — how much of the scrollport the content fails to fill — and
two things that want it. `alignToBottom` wants it above the items. A `stickyFooter` wants it below
them, because `position: sticky; bottom: 0` lifts a box to an edge and can never push one down to
one. They were separate functions deriving it separately, and they avoided spending the same
pixels twice only by accident of composition: `syncLeadingSpace` wrote `leadingSpace`,
`composeInsets` folded it into `scrollMargin`, and `trailingSpaceFor` subtracted `scrollMargin`.
Three hops, an ordering constraint spelled out in prose at three separate sites, and a test whose
entire job was to prove the collision did not happen.

`syncSlack` subtracts once and routes the answer to one end or the other as exclusive branches of
a single decision, so spending it twice is not expressible. The ordering constraint *between the
two halves* is gone with it — the one between the leading spacer and `syncGeometry` remains,
because `composeInsets` still folds it in. The trailing half also stops going through `geometry()`
and reads the consumer's insets directly, which is a coupling removed rather than a cost: that
call was always a memo hit, and it is what hid the two missing terms.

A test proving two mechanisms do not collide is a reasonable sign they want to be one; `spends the
slack once under alignToBottom` stays anyway, because the bug it describes is worth naming even
once it is unreachable. Worth saying plainly, since the arrangement reads like arbitration: under
`alignToBottom` the footer loses nothing. It is in flow and in the sum, so pushing the whole block
down lands it on the bottom edge regardless — leading placement satisfies both promises at once.

The gate still reads `slotSizes.stickyFooter` rather than `spaceAfter`, and now does so from the
one place where that is the natural thing to read. The insets cannot answer it — `composeInsets`
merges `footer` and `stickyFooter` into `spaceAfter` on purpose — and the distinction is the whole
of the trailing branch: a plain `footer` is in-flow content belonging under the last item, and
pushing *it* down an unfilled scrollport would be a different library.

No size limit moves.
