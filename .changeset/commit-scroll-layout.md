---
'virtual-anchor': patch
---

Make the committed scroll write honour the ordering the banked one already did.

`publish` writes the paint offset once, last, and after every read. Its own comment says so, and
the *banked* branch of `writeScroll` honoured it explicitly — "Deliberately not written yet …
A style write here would force a second synchronous layout on the hottest path in the file."
The **committed** branch did not. `commitScroll` drew the carry itself, through `applyCarry`,
and it sits between the `scrollTop` write and this pass's final two reads of `scrollTop` — so
that draw turned both into a forced synchronous layout.

**It does not show on the benchmark, and this is not sold as a speed-up.** Measured back to
back against the change below it on a quiet machine, `perf/headroom.spec.ts` moves in both
directions and by less than its own run-to-run spread: at 6× CPU the handler p50 goes 0.40ms to
0.20ms, at 10× it goes 0.30ms to 0.90ms, at 20× the dropped-frame share goes 9.8% to 8.1% while
the p95 goes 5.90ms to 6.10ms. There is no signal there. The reason is the two changes below
this one: holding the mounted range made publishes that *commit* a scroll much rarer, so the
layout this removes now fires seldom on the wheel scenario the harness drives.

What is not in doubt is that the layout was being forced, because a unit test discriminates
deterministically — the paint offset lands at write index 3 with a scroll read at 4, and after
the change the last read is at 3 with the paint at 48. And on WebKit it is *every* commit rather
than an occasional one: it truncates a written offset to an integer, so the carry always moves
and the write is never deduped away.

So this is filed as restoring an invariant the file already states rather than as a measured
win. A reader deciding whether it is worth carrying should know both halves.

The carry is now recorded at the two call sites inside `publish` and drawn only by `publish`'s
terminal flush. `reconcileGestureShift` still draws on its own next line, because it runs from
the gate's `onOpen` with no publish behind it and needs both halves in one task; the scroller
keeps the drawing `applyCarry`, because its frame loop is outside a publish too.

The `follow` branch gains the same thing incidentally: its `contentOffset()` read used to sit
behind an `applyCarry(0)`.

Pinned by a case that fails against the old code — the paint offset lands at write index 3 with
a scroll read at 4, where it should be the other way round. Modelling the carry at all needed
the test harness to truncate written offsets the way WebKit does, which it now does under the
same option name and in the same order as the iOS harness that already had one.
