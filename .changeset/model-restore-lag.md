---
'virtual-anchor': patch
---

Stop a model change during momentum writing the fling's own lag.

A `'model'` restore — `setOptions` with new keys, a gap, an estimate or geometry — overrides
the write gate, which is right for a prepend and wrong for anything that leaves the reader
where they are. When one landed during an iOS fling, the engine wrote `scrollTop` even though
the change had displaced nothing, and what it wrote was not a correction at all: it was the
distance the fling had travelled since the last scroll event.

The cause is a coordinate-space mismatch between two lines. `resolveAnchorOffset(anchor, …)`
answers *where the content was at the last scroll event*, because that is when the anchor was
last derived. `writeScroll` compares it against `contentOffset()` read *now*. During momentum
those are never equal, so

```
delta = (what the model change displaced) − (travel since the last scroll event)
```

On the device recording that found this, the first term was zero — 500 items appended *below*
the reader, `firstKey` unchanged, the anchor byte-identical before and after — and the second
was 7px. So `-7` was written, clearing the `0.01` no-op guard, nudging the reader backwards to
a stale offset and cancelling a fling with about a second and 250px of travel still in it.

Now the displacement is taken where it is knowable — the anchor's resolved offset before the
change versus after it, captured at the top of `setOptions` before the merge and before any
cache mutation — and applied to wherever the content has since got to:

```ts
target = contentOffset() + (restored - priorAnchorOffset)
```

Both terms of the subtraction are content-space, so an outstanding carry or paint offset
cancels out rather than having to be reasoned about. When the content is still the anchor is in
sync, `contentOffset() === priorAnchorOffset`, and the target is bit-identical to before — the
two forms diverge only while the content is moving under the write, which is the case being
fixed. A displacement of zero then falls inside the existing no-op threshold, so "changed
nothing, wrote nothing" needs no branch of its own. Cost is one Fenwick prefix sum per
`setOptions`, O(log n).

This also fixes a case the report predicted but could not observe: a real prepend landing
mid-fling was writing `inserted height − travel`. Measured in a unit test, a 1000px prepend
with 7px of lag wrote **993**; it now writes 1000, and the same prepend with and without lag
produces an identical correction.

Covered by unit tests for the append (writes nothing), the prepend (writes its real height,
twice, with and without lag), an outstanding banked paint offset, an anchored key the change
removes, and the off-iOS path where the gate is inert and nothing should change. Plus an
end-to-end test in real WebKit that pages 200 items in mid-fling and asserts no write and that
scroll events keep arriving — which fails without the fix.

Fixes #54. Reported against the unreleased instrumentation branch by a consumer, diagnosed from a
`virtual-anchor/debug` recording, and confirmed by reverting the fix under both suites.

Uncovered by #53: under the old momentum ceiling the same fling was already being killed 326ms
earlier, so this never got the chance to show.
