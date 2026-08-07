---
'virtual-anchor': patch
---

Stop the momentum gate cutting off flings longer than three seconds.

`MOMENTUM_MAX_MS` was armed once at momentum onset and fired 3000ms later regardless of what
else had happened. Its own doc called it "a safety valve, not a duration" — but on a
twelve-thousand-row thread it was not a safety valve, it was the common case. Measured on an
iPhone, the correlation with fling duration is exact:

| fling | outcome |
| --- | --- |
| 837ms, 2266ms | settled |
| 3032, 3251, 3782, 4504, 4721, 8467ms | **cap** |

And firing mid-fling does precisely what the gate exists to prevent. `canWrite()` starts
answering `true` again with the fling still running, the next measurement writes `scrollTop`,
and WebKit cancels the momentum — which is the "stops abruptly, sometimes" the whole mechanism
was built for. On the worst recordings three or four writes landed in the moments after the
cap fired.

The timer is now re-armed by every scroll event during momentum, making it an inactivity
watchdog — and inactivity is the right predicate for the thing it actually guards against. A
fling still delivering two hundred scroll events is self-evidently not a wedged gate; three
seconds of silence is. Renamed `MOMENTUM_IDLE_MS`, because a constant that changes meaning
while keeping its name is a trap.

Three seconds of *silence* rather than something tighter, because a blocked main thread can
stop delivering scroll events without the fling being over: the worst gaps measured were 205ms
on a device and 202ms on a simulator. The window has to clear that comfortably or the watchdog
re-creates the bug it fixes.

The old note that this sat "deliberately below the scroller's `HARD_DEADLINE_MS` of 5000" no
longer applies, and was already obsolete before this change: the convergence loop suspends its
deadline clock while parked, so a longer gate-shut window costs a programmatic scroll nothing.

Verified on a device — the same upward flings that previously reported `cap` at 3032ms now run
to `settled` at 3354ms and 3355ms with no suspect at all, folding 1044px and 1178px of banked
correction cleanly at the end. Covered by three unit tests (an eight-second fling is not
capped; a fling that goes quiet still reopens the gate; a 250ms stall does not trip it) and an
end-to-end test in real WebKit.

Fixes #53. Found with `virtual-anchor/debug`.
