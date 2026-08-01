---
'virtual-anchor': minor
---

`VirtualList` now sets `scrollbar-gutter: stable` on the scrollport it creates. Opt out with
`stableScrollbarGutter={false}`; an explicit `style={{ scrollbarGutter: … }}` still wins, and
nothing is written under `windowScroller`.

**Changed, not fixed** — a list that never passed the style gets a reserved gutter it did not have
before. Visually that is a narrow strip on the right of a list short enough not to overflow.
Functionally it is the fix.

**The failure it prevents is internal to the component, which is why it is the default.** The list
mounts and measures its first rows against a scrollport with no scrollbar. Enough of them are
measured that the content overflows, the browser inserts a scrollbar, and the scrollport gets
narrower — so text wraps differently and every height taken before that moment is now wrong. The
list correctly throws all of them away. But those rows are outside the window by then and nothing
will re-measure them: they keep their estimate for good, and every offset derived from them is out
by the difference. What a consumer sees is a scrollbar slightly the wrong length and a
`scrollToKey` that overshoots on a cold list, neither of which points back at a scrollbar that
appeared once, seconds ago.

Nothing in that reasoning is application-specific. It holds for any virtualiser that measures
variable-height rows in a scroller it owns, which is exactly what this component is — so a setting
every correct call site must pass, for a reason the caller cannot see, is the component's default
rather than the caller's responsibility. Without it, the fourth list someone adds is silently
wrong until somebody notices.

The counter-argument is that a library should not impose layout, and it is thin here: the gutter is
reserved only on a scrollport the library itself created, it is the width the scrollbar was going
to take anyway, and it is one prop to turn off.

**Ignored under `windowScroller`** whatever the prop says, because there the page is the scroller.
Reserving a gutter on the document is the host page's decision, and a list is not entitled to make
it.

**`both-edges` is deliberately not a value.** It is a layout preference rather than a correctness
one, and `style` already reaches this element — so a consumer who wants it, or who wants `auto`
back, has one without the prop growing a third state.

Consumers already passing `style={{ scrollbarGutter: 'stable' }}` by hand see no change: same
computed value, and the merge order keeps their declaration winning either way. That line can go
whenever it suits, and nothing breaks if it never does.

The React entry's size budget moves from 11.7 kB to 11.95 kB, against an actual of 11704 B. Both
this and the deferred notifications fit under the old ceiling on their own and are 4 bytes over it
together, which is the ceiling behaving exactly as intended — and also the shape of budget that
stops being a budget: with 46 bytes of headroom the next change is discussed on its file size
rather than on its merits, and the one after that gets the ceiling raised in a hurry by whoever
happens to be holding it. 250 bytes is enough room to have the argument properly. The core entry
is untouched at 9.38 kB against 9.5 kB, and the gap between the two entries stays ~2.3 kB — the
figure worth watching, because it says the React layer is still a translation rather than a second
implementation.
