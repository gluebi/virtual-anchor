---
'virtual-anchor': minor
---

Stop a hard fling putting blank frames on screen.

The symptom, reported from use and then reproduced: scroll fast enough and the content
disappears — empty space where rows should be, filling in once the gesture slows. The mechanism
is a race that is always present and only sometimes visible. The browser scrolls on the
**compositor** thread; the mounted range is recomputed on the **main** thread from a scroll
event. Overscan buys the main thread time, and it was a fixed 400 px, so at 60 Hz a scroll of
24,000 px/s spent the entire buffer within a single frame of latency. Past that the compositor is
presenting a region no row has been mounted for.

**The default buffer is now 2500 px, and the number is measured rather than argued.**
`perf/blanking.spec.ts` counts blank composited frames directly — through a screencast, because
the obvious instrument cannot see this at all. A `requestAnimationFrame` probe runs *after* the
scroll handler in the same frame, so it only ever observes a world the handler has already made
consistent; it reports ~2% for gestures that visibly blank. On the demo at 40,000 px/s:

| buffer | blank frames at 20x CPU | headroom at 20x CPU |
| --- | --- | --- |
| 400 | 13 of 79 | 42 fps, 8.2 ms per scroll event |
| 1200 | 11 of 81 | 33 fps, 12.7 ms |
| 2500 | 3 of 78 | 32 fps, 14.3 ms |

1200 is dominated — nearly all of the cost, almost none of the benefit. At 1x and 6x emulated CPU
2500 costs nothing measurable (60 fps, 0.2 ms per scroll event) and removes the blanking; the
headroom it spends appears only past 10x, where frames are being dropped regardless. `buffer` is
still yours to set if you want the old trade.

Mounting is now also **asymmetric**: the band extends further in the direction of travel, by the
distance the content will cover in the next 50 ms, capped at 2000 px and decaying to nothing once
scrolling stops. It costs no rows at rest.

Worth recording that this second part is *not* what fixed the blanking, because the obvious story
about it is wrong. Every blank frame lands in the first few per cent of a gesture — at onset,
where two samples have not yet arrived and the velocity is therefore zero. A lookahead derived
from velocity is necessarily nothing at exactly the moment it is wanted, and switching it on alone
changed the count not at all: 13 blank frames of 79 at a 20x slowdown, before and after. What
fixed it was having the rows *already mounted* before the finger moved, which only a larger
resting buffer can do. The lookahead is kept because it is cheap where the buffer is expensive —
on top of it, the 20x count went from 5 to 3 and the 1x count from 1 to 0.

Measured after the change: 9.97 kB for the core entry and 12.24 kB with the React adapter,
minified and brotlied. Both size budgets move up to match. The README's stated figures were
already behind the budgets they claim cannot drift — 9.38 and 11.65 against limits of 9.9 and
12.2 — so they now say what the build actually produces rather than what it produced some
releases ago.
