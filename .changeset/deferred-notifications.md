---
'virtual-anchor': patch
---

`onVisibleRangeChange`, `onAtBottomChange` and `onEdgeReached` are handed to the consumer a
microtask after the publish that caused them, instead of synchronously from inside it. Setting
state from any of the three is now safe.

**The bug was that a publish is not always post-commit.** Options are pushed into the engine
*during* render — deliberately, so a prepend is positioned in the very commit that renders it — and
`setOptions` publishes. Anything called synchronously from that publish therefore runs inside
React's render phase, and a consumer's `setState` there is the cross-component update React
refuses:

    Cannot update a component (`Thread`) while rendering a different component (`VirtualList`).

The stack trace points at the consumer's `setState`, so the callback reads as the thing doing
something wrong. Nothing at the call site says otherwise: a callback named `onVisibleRangeChange`
is indistinguishable from a post-commit one until it isn't.

**The hazard was already understood in this file, and only half of it was guarded.** The re-render
subscription has hopped a microtask since it was written, with a comment explaining exactly this;
the notification subscription immediately above it did not. One of two subscribers to the same
store was safe and its sibling was not, for no reason anyone had decided.

`onEdgeReached` was the worst of the three and the last to be noticed, because it needs no
interaction at all to reach. A list that opens at the top is already at its start edge, and the
publish that notices sits in the same render that hands the engine its options — so *"where you
load the next page"*, which is a `setState` by definition, ran during render on mount for every
consumer following the documentation.

**What is decided at the emission stays at the emission; only the hand-off moves.** The
de-duplication refs are still written synchronously, so the comparison happens in publish order and
each notification carries the value that caused it rather than re-reading a ref that has since
moved on — a burst inside one tick is delivered as the sequence of ranges that actually occurred.
`onEdgeReached`'s latch and its suppression during a programmatic scroll also stay where they were,
in the engine, so the suppression still reads the scroll state as it was rather than as it is a
microtask later.

**Nothing cancels a scheduled hand-off when the subscription ends**, which is a decision rather than
an omission and is now pinned by a test. StrictMode runs the effect's cleanup *before* the queued
microtask, while the reported-value refs deliberately live outside the effect — so a `disposed`
guard would drop the opening report, and the remount pass, finding it already reported, would queue
nothing to replace it. Consumers would learn where the list started in production and not in
development. What not guarding costs is one late call when a publish and an unmount land in the same
tick, which React absorbs.

**The one visible timing change**: the first range and the first at-bottom state now arrive one
microtask after mount rather than inside the mounting effect. Both were already post-commit, so
neither was unsafe — they are deferred anyway so the callback has one timing contract instead of a
contract that depends on which publish it came from. If you depended on the opening report landing
before your own first post-mount effect, that is the line to read twice.

Two paths are deliberately **not** changed: `onVisibilityChange` and `useItemVisibility`'s
subscription are reachable from the same `publish`, but neither could be driven during a render in
jsdom — visibility needs real layout and a real IntersectionObserver — and a fix nothing can
demonstrate is a fix nobody can keep.
