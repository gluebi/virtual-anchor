---
'virtual-anchor': patch
---

The convergence loop's deadlines are budgets of frames given, not of wall clock.

`scrollToKey` resolved `{ settled: false, reason: 'deadline', iterations: 0 }` for scrolls that
were never given a single frame. The loop is driven by `requestAnimationFrame` and its deadlines
were measured against `now()`, so a main thread blocked across one — a phone parsing a page of
content between the call and the first frame, a long task, a backgrounded tab — spent the whole
budget while no frames were delivered. The first line of `step` to execute was then the
hard-deadline check, which is what `iterations: 0` was telling anyone who looked: the loop did not
run once. See #92.

`scroller.ts` had already drawn this conclusion for the gesture gate, and stated the invariant
outright — *"A scroll that is not allowed to move must not be allowed to time out either […] a
loop whose clock kept running through that would burn `SOFT_DEADLINE_MS` and resolve `deadline`
with a large deviation for a scroll that was never given a single chance to write."* A starved
main thread is exactly "never given a single chance to write". It just was not gated on
`gate.canWrite()`, so nothing suspended the clock for it.

### What it cost

`restrealitaet/rr-forum-frontend#508` — "scroll to comment when opening a thread does not work
reliably", reported only from a low-budget Android phone. A thread of 15,715 comments landing on
comment 8000: every open that got the loop even one frame landed flush, and every open that got
none landed 95px out, reporting `deviation: 0` for it. That list is windowed, so its first aim is
a sum of estimates and genuinely needs the correction the loop provides; 95px was the estimator's
error, left uncorrected because the loop that exists to correct it had already resolved.

Reproducible in the demo with no throttling of any kind, which is what the new e2e case does:
block the main thread for 5.5s immediately after `scrollToKey`, and comment 8000 lands **145px
short in all three engines** with the promise reporting a deviation of zero — the model and the
offset agreeing with each other while both disagree with the DOM.

### The fix

A gap between frames longer than a frame rate could explain is credited back to the clocks the
deadlines are measured from, instead of being charged to them:

```ts
const stalled = Math.max(sinceTick - MAX_FRAME_GAP_MS, 0)
const credit = blocked ? sinceTick : stalled
if (credit > 0) suspend(current, credit)
```

`MAX_FRAME_GAP_MS` is `MAX_STEP_MS` — not a second literal that happens to equal it, because the
equality is load-bearing and a relation kept only in prose is a relation nothing keeps. Every
credit leaves exactly that much of the gap charged, so `tick - lastStepAt` never falls below the
bound the smooth integrator clamps to, and crediting `lastStepAt` therefore cannot change a single
smooth step. It is also the one honest answer: "too long to be a frame" is one question, and that
constant already answered it. The debug analyzer's `FREEZE_MS` is 100ms as well.

Only the excess is credited, which is what keeps the deadlines meaning anything: a list that will
not hold still while frames arrive perfectly normally is the case they exist for, and it still
spends its 2s and 5s. What changes is that the budget now stretches over more wall clock as the
gaps grow — a device delivering four frames a second gets the same number of chances to converge
as one delivering ten.

### It completes the gate's suspension too

The same credit closes a hole in the suspension that was already there. The loop *parks* while
the gate is shut, so only the frame that noticed ever ran — and the parked span, park to
`gate.onOpen`, was charged in full to the first waking frame. A three-second fling therefore
handed the convergence loop a scroll with its soft budget already spent, and the first frame after
the gesture was also its last: `keeps the whole convergence budget for after the fling, not what
is left of one` measures **one** frame before the change and about 125 after it. Invisible
whenever the banked correction happens to land exactly, which is why no existing case caught it,
and costly precisely when the landing needs correcting — a windowed list whose measurements arrive
after the gesture, which is the ordinary case on the platform that file is about.

Collapsing the two carries into one `suspend` also dropped something from it: the gate's version
moved `lastModelChangeAt`, and it should not. That stamp is *pushed* rather than sampled —
`notifyModelChanged` arrives from a measurement or an insertion, and an insertion is consumer state
that a tab without frames still processes — so "the model has not moved" is an observation the loop
still holds after a stall, and carrying the stamp forward discarded it and made every stalled
scroll wait out a fresh `MODEL_QUIET_MS` for nothing. Two iOS cases that waited three extra frames
for that are what surfaced it. What keeps it safe is not the clock: the resuming frame re-resolves
its target from the live cache, so a model that *did* move is caught by `targetMoved` there.

### Two things deliberately not changed

**No new `ScrollEndReason`.** `iterations: 0` alongside `deadline` was the only way a caller could
tell "timed out having never run" from "timed out having tried", and naming it — `starved`, say —
was the obvious next step. It would name nothing: with the clock credited, that state is no longer
reachable, because a loop that has had no frames has not yet had its chance. The diagnosis moves
to a trace event instead.

**No absolute wall-clock ceiling.** The budget is frames, so a scroll in a tab without them stays
pending and resolves when they resume, rather than reporting a failure that did not happen.
`dispose()` still resolves `disposed`, so a torn-down list cannot hang a promise, and the README's
*Older Safari* note and `ScrollEndReason.deadline`'s own doc now say which of the two a caller is
promised.

Worth stating plainly, because it is the real cost of that choice: an unsettled result is now
bounded in *frames* and not in seconds, so on a device with 250ms gaps the 50 charged frames of
`HARD_DEADLINE_MS` are about 12 seconds rather than 5. While a programmatic scroll is in flight the
engine suppresses visibility sampling and refuses `onEdgeReached`, so a list that would otherwise
paginate at the edge waits that much longer in the worst case. Off iOS that window used to be
bounded at 5s; a parked fling has always had this property, and the trade is deliberate — a late
correct answer beats a prompt wrong one, and `cancel()`, user input and `dispose()` all still end
it immediately.

### What pins it

Four cases in `a main thread that stops delivering frames`: the issue's reproduction as a unit
test, including that the correction it names actually happens (`iterations > 0` and the offset at
150,000 rather than the first aim's 50,000); that a device with 250ms gaps gets as many frames as
one at the cap, over two and a half times the wall clock; that an ordinary 16ms frame rate is
still charged in full, so the deadline still bounds an unstable list; and the new `scroll.suspend`
trace, which reports `gap` and `credited` both because the ratio is the diagnosis.

Two iOS cases, one of them new, and the strengthened one now asserts the *result* where it only
ever asserted the offset — the landing was never the whole claim. Plus the browser reproduction in
`e2e/robustness.spec.ts`, and `covers all of the distance even at four frames a second`, which is
no longer "nearly all": at 4fps the smooth approach now lands exactly, where the hard deadline
used to take the last stretch.

All four size budgets still fit unchanged; the core entry measures 10.2kB and the React entry
12.55kB, and the README's advertised figures are the measured ones again.
