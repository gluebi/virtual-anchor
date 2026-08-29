---
'virtual-anchor': patch
---

The gesture fold now aims at where the content is, not at where `scrollTop` is, so an outstanding carry survives it.

`reconcileGestureShift` turns a banked gesture shift back into a real scroll offset when the
momentum gate reopens, and its whole promise is that nothing moves while it does: the content
jumps back by the shift as `scrollTop` moves forward by it. It built its target as
`scrollTop + shift` — from the raw offset, while the content was sitting a `carryBefore`
further on, because the visible position is `scrollTop` plus the paint offset and never
`scrollTop` alone. `commitScroll` then *replaces* the carry with its own truncation residual
rather than accumulating it, so nothing was left holding the difference and the reader saw the
content shift by up to a pixel exactly as a fling ended.

Only reachable on a platform that refuses fractional scroll offsets, which is the only platform
the fold runs on: WebKit truncates every write, so the carry is non-zero almost always, and
whether it was non-zero *at the moment the gate reopened* was the difference between a clean
fold and a visible one. That is why it sat undetected — it needs a fractional carry outstanding
when a fling ends, and the demo's geometry had to change before the e2e fold assertion started
landing in that state. It reported `before - after` of exactly 0.75, which is the dropped carry
and nothing else.

The fix is the read the anchor and the scroller's arrival test already use, for the same reason:
judging on the scroll offset where the content position was meant is the shape of #33.

The engine now folds to `contentOffset(from)`, so `from + shift + carryBefore` and
`applied + carryAfter` agree exactly rather than to within a carry.

Two things found alongside it. `contentOffset`'s own documentation says every read that compares
against an item offset goes through it, "the anchor" named first — and the scroll listener had
its body written out by hand, so a third compensation term would have missed the hottest anchor
derivation in the library. It now calls `contentOffset(offset)` with the offset it already read.
And `commitScroll` never said which coordinate space its argument is in, which is the ambiguity
that let a raw `scrollTop` in; it says so now.
