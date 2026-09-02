---
'virtual-anchor': minor
---

A programmatic scroll now updates the anchor where the move is made, instead of waiting for the browser to say it happened.

`scrollToKey` and `scrollToIndex` resolve on a synchronous fast path when every row is measured:
the write lands, `finish(true, 'converged')` runs inside the promise executor, and the caller gets
an honest `settled: true`. But the anchor was only ever derived in the **scroll handler**, and a
`scrollTop` write is synchronous while its `scroll` event is not. So for the length of one event
delivery the anchor still described where the view *was* — and `isScrolling()` was already false,
which is the one thing that had been suppressing a restore from it.

Any publish in that window therefore restored the pre-scroll position and teleported the view back,
undoing a landing that had already been reported as converged. A `ResizeObserver` callback fits
inside the window comfortably, so the trigger was ordinary: a measurement batch, a slot resize, a
model change.

Three lines that were each right on their own. The comment above the derivation even states the
invariant it was breaking — the anchor "follows every intentional move — the user's and the
scroller's alike" — and the `followOutput` branch a few hundred lines above had already met the
identical race and solved it by deriving synchronously after its own write.

The convergence path was never exposed: it keeps a scroll pending across frames, so the guard
covered it, and by the time it resolves its own scroll events have long since moved the anchor.
**Only the synchronous resolution was affected** — which is the path a fully measured list takes,
so a short list, or any list scrolled a second time. Chromium and WebKit both lose the race, on
different frames, which is why it was reported as "sometimes, in both browsers".

What it cost in the wild: a 13-comment forum thread opened on the reader's first unread comment.
The scrollport narrowed by 12px as the content began to overflow, the opening post re-wrapped from
232px to 253px, and the `scrollToKey` aimed at the cache still holding 232. The write landed, the
row really was at the top, and the promise was right. 18ms later the corrected measurement arrived,
the restore ran against the stale anchor, and the offset went to 0. The reader saw a thread that
did not scroll while the consumer's log said it landed perfectly. Nothing recovered it, either: the
now-meaningless scroll event derived the anchor from the restored 0, making the loss permanent
rather than transient.

A settled landing now tells the engine, which derives the anchor from the offset it just committed.
The scroll event still arrives afterwards and derives the same anchor from the same offset, so it
is a second no-op rather than a second correction — and deliberately *not* suppressed the way an
anchor-restore's read-back is, because this is a move and the anchor has to follow a move.

A cancelled or replaced scroll reports nothing: it leaves the view wherever it happens to be, and
an anchor for that position is the scroll handler's business as it always was. A **clamped** landing
does report — the view stopped somewhere real, and that somewhere needs an anchor as much as a
flush landing does.

`ScrollerOptions` gains an optional `onLanded?: () => void`, which is the channel. Optional, so a
consumer driving `createScroller` themselves has nothing to change; one who is keeping their own
record of scroll position will want it for the same reason the engine does. It carries no offset on
purpose — `getContentOffset` is already the caller's own reader, so the number would be handed back
to whoever computed it.

Fixes #115.
