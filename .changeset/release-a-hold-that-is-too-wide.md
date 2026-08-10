---
"virtual-anchor": patch
---

fix: release a held range that is too wide, not only one that is too narrow

The range hold added in #73 was one-sided. `computeRanges` revisited a hold that failed to cover
the buffered band, and nothing revisited one that covered far more than it — so a hold computed
against a geometry the list no longer has was kept for as long as its two keys resolved.

A list momentarily shorter than its own buffered band computes exactly such a hold: the band spans
everything, so the hold is the whole list, and the keys it pins are the list's first and last. That
is not a contrived shape. A thread view mounts its opener and its footer row before any comments
have arrived — two rows against an 800px scrollport and a 2500px buffer — and those two keys stay
first and last for the life of the list. Every comment that arrived afterwards was mounted and
stayed mounted.

Measured in the consumer that reported it (restrealitaet/rr-forum-frontend#483), on an 11,398
comment thread opened at its read position: **1,501 rows resident where 38 covered the scrollport**,
constant across thirty scroll steps. Not a slower virtual list — an unwindowed one. It cost 11.4s
behind the open placeholders against 3.7s on 0.7.0, and every subsequent scroll frame carried
fifteen hundred rows of React reconciliation, which is what the report describes as new comments
taking "ages" to appear. Linking this build into that app takes it to 39 rows and 3.3s.

An over-wide hold is now released the way an unresolvable key already was — as nothing held — so
the recompute below it, and the slack it grants on both edges, are reached unchanged.
`MAX_HOLD_DRIFT_SLACKS` is 2 because that is the most a live hold can exceed the band by: a
recompute grants one slack past the band at the edge that ran out, and the reader travels one more
before the coverage test fires at the other edge. The test is guarded on coverage, so the two extra
`indexAt` lifts stay off the frames the hold exists to make cheap.

Coverage is untouched in both directions: the trigger stays at the buffered band, and
`blanking.spec.ts`'s calibrated distance is unchanged. The bound `MAX_DEFAULT_BUFFER_ROWS` argues
for is also unchanged — this bounds a hold's *displacement* from the moving band, not its span.

One case pins it: `drops a hold computed while the list was shorter than its own band` grows a
two-row list to 1,502 and asserts the mounted range is the band around a reader at 75,000px, asked
of the cache rather than written as a row count. Against the old code it reports "mounted 1502 of
1502 rows".

All three affected size limits move by 0.1kB to fit it. The core entry needed it too: 10.11kB
against a 10.1kB limit, where the same source measures 10.08kB locally — 0.02kB of headroom on that
budget is noise between toolchains, not margin.
