---
'virtual-anchor': patch
---

The last two notifications the React adapter forwards — `onVisibilityChange`, and the
subscription behind `useItemVisibility` — are handed over a microtask, the same way the other
three now are. Every callback this adapter routes to a consumer, and every wake-up it gives React,
now has one timing contract: after the publish that caused it, never inside it.

**These two have no crash behind them, which is the honest reason to say so here.** `publish`
samples visibility at its end, so they sit on exactly the stack that made
`onVisibleRangeChange` and `onEdgeReached` fail, and `useItemVisibility` is a store waking React
from a subscription — the same shape the hook's own `useSyncExternalStore` subscription has always
deferred. But nothing drives them during a render in practice. A rule with a `dwellMs` reports
`enter` from a timer rather than from the sample, and every attempt to force one produced events
only after the commit: in jsdom against a stubbed observer, and against the demo in a real browser
with the dwell taken down to zero.

So this is uniformity rather than a fix, and it is worth the bytes because the alternative is what
the previous release was: one hand-off guarded, its neighbour not, for a reason nobody had written
down. The next person to add a rule that emits from a sample should not have to rediscover it.

Each visibility event still carries an `at` stamped where it was sampled, so a batch describes when
it was taken rather than when it arrived — dwell arithmetic downstream is unaffected.
