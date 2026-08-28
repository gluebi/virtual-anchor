---
'virtual-anchor': minor
---

`deviation` is now measured against the offset the caller asked for, and a new `clamped` flag on `ScrollResult` says when that offset was outside the scroller's range.

It was documented as "signed px between where the target landed and where it was asked to
land", and it was not that number whenever the request fell outside `[0, maxScrollOffset]`.
There it was zero by construction, and every other field agreed the scroll had succeeded.
`targetFor` clamped its answer, arrival was judged against the clamped target, and `finish`
recomputed the deviation by calling `targetFor` again — subtracting the clamp from an offset
already sitting at the clamp. The request was discarded before anything could compare
against it.

On the demo, a 720px scrollport over 1392px of content, so an offset that stops at 672:

| target | item top | final `scrollTop` | gap from the top | reported |
| --- | --- | --- | --- | --- |
| comment-5 | 608.75 | 609 | 0 | `settled:true deviation:0 converged` |
| comment-6 | 898 | 672 | 226 | `settled:true deviation:0 converged` |
| comment-7 | 1017.75 | 672 | 345.75 | `settled:true deviation:0 converged` |

Byte-identical in chromium, webkit and firefox — arithmetic, not a platform. The third row
now reports `deviation: 345.75, clamped: true`, and the first still reports `0, false`.

The condition for a target to be reachable at `align: 'start'` is that it has a scrollport's
worth of content below it. A short thread does not, so a reader deep-linked to their first
unread comment is left partway down the screen — correct behaviour from the scroller, and
previously indistinguishable from a flush landing. The band scales with the viewport, which
is why it is roughly twice as wide on a desktop window as on a phone, and why it read twice
as a timing problem.

The clamp itself is right and is kept. `arrived` still judges against the clamped target: a
convergence loop chasing an offset the platform refuses would run to its deadline instead of
resolving. No scroll moves differently for it — this is a reporting change.

`settled` and `reason` keep their meanings. `settled` answers "did motion stop with the
target holding still", which it did, so a clamped landing normally resolves `settled: true`
and `converged`. `clamped` is a separate axis rather than a new `ScrollEndReason` precisely
because the two are independent: a list that keeps resizing while its target is also out of
reach reports `deadline` and `clamped: true` both, where a single slot would have had to
pick one. It also cannot be re-derived by a consumer, which is the argument for the flag
over the number alone — that needs `maxScrollOffset` and the target's own content offset,
and `deviation` on its own cannot be told apart from a scroll that merely ran out of frames.

One behaviour does change. The `align: 'end'` shortcut for the last item returned the
browser's maximum and dropped the `offset` option on the floor, so an `offset` passed with
that alignment on that item did nothing at all — and reported `deviation: 0` while doing it.
It now applies, which is what lifting the last comment clear of a footer asks for. With no
`offset` the shortcut returns the maximum exactly as before, so the alignment that
legitimately coincides with the clamp still reports `deviation: 0, clamped: false`.

`align: 'auto'` returns the current offset for an item that is already fully visible. That
is not a clamp and does not report as one.

Fixes #101.
