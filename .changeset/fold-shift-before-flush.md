---
'virtual-anchor': patch
---

Fold the gesture shift into `scrollTop` before any other write-gate listener runs.

`ScrollWriteGate.onOpen` fires its listeners in **registration order** — it is a `Set`,
iterated in insertion order — and `engine.mount()` registered the engine's own listener
*after* `scroller.attach()` had registered the scroller's. So on the one event that ends a
gesture, the scroller went first and the engine second, which is exactly backwards: the
engine's listener is the one that turns the outstanding paint offset back into a real scroll
offset, and everything else waiting on that event reads `scrollTop`.

Two listeners want the same reopening, for two different reasons, and neither of them is
optional. The scroller banks a *delta* when the gate refuses a write — how far the view
needed to move, not where it needed to end up, because a fling has carried the scroller
somewhere else entirely by the time the delta can be applied — and it replays that delta
against `viewport.getScrollOffset()` when the gate reopens. The engine holds the gesture
shift: the whole of a correction that was never written at all, standing in for `scrollTop`
as a paint offset on the item container, and folded back into `scrollTop` in one task once
the platform will take the write. Run the flush first and it replays its delta from an
offset the shift is still standing in for; the fold then adds the shift on top. The
correction is applied twice, and the scroller's `finish()` measures its deviation against
the post-fold offset and reports ≈0 — so nothing in the library notices.

The fix is the registration order: the `writeGate.onOpen(...)` call moves above
`scroller.attach()`. Nothing else moves with it. `onOpen` only adds to a set, and nothing
can fire it until `gate.attach()` — reached from inside `scroller.attach()` — binds the DOM
listeners that drive the state machine, so the ordering constraint that put
`scroller.attach()` first (the gate's `touchstart`/`touchend`/`scroll` listeners must
precede the engine's own scroll and settle handlers, so that both of those see an
already-transitioned gate) is about DOM listeners and is untouched. The teardown order is
unchanged: the `onOpen` unsubscribe was already the first entry in `cleanups`, and the gate
itself is deliberately disposed with the scroller rather than on unmount.

What this restores is an invariant the engine's own docs already assert and rely on:
**nothing is held while the gate is open.** `commitScroll` says so, and the offset
arithmetic elsewhere in the file rests on it — but it was false for the duration of the
first listener, which is precisely where a second consumer of `scrollTop` was running. The
fold now happens before any other listener, so the invariant holds for *every* one of them:
the scroller's banked-correction flush, the convergence loop parked on the same event, and
anything registered later. The comment in `mount()` says that, and says what a re-order
silently costs, so the ordering is load-bearing rather than incidental.

Two regression tests pin it, both of which need a shift held *and* a correction banked at
the same moment — a deferred measurement establishes the first, a `scrollToIndex` the shut
gate refuses banks the second. One asserts the sequence directly, by reading the paint
offset in effect at each `scrollTop` write: exactly one write on reopen is made with the
content held away from `scrollTop`, and it is the fold. The other asserts the fold moves
`scrollTop` by the shift alone rather than by the shift on top of a delta already replayed.
Both fail against the old order.

This is the ordering half of a two-part problem. The scroller also compares content-space
destinations against the raw scroll offset, which is a separate bug in `scroller.ts` and is
what decides whether the landing is *right*; this change decides only that the shift is
folded once, and first.
