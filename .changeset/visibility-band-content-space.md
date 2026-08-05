---
'virtual-anchor': patch
---

Report visibility against where the content is, not where the scrollbar is.

While a correction is held as a paint offset on iOS, `scrollTop` and the content disagree by
exactly the held amount — that is what holding it *means*. The anchor and the rendered range
were converted to read the content's position when the gesture compensation landed; the
visibility band was named as the third such reader and was not. It kept taking a scroll
offset as a parameter, and both callers kept handing it the raw one.

The band is the wrong place for that mismatch to hide. It is built by converting an offset
into list coordinates, and it is then compared against candidate items whose bounds come
straight from the size cache — which is content space, and always was. Two coordinate spaces
in one overlap calculation makes the answer meaningless rather than approximate: with a
correction wider than the viewport, the band and the candidates do not intersect at all, so
the sample reports every row currently on screen as having *left* and reports nothing in its
place. A smaller correction is worse to diagnose, not better: the two windows partly overlap
and the events are plausible but wrong.

Two call sites, and they were wrong in different ways. The publish path already computed the
content position for the rendered range one line above and passed the raw offset to the band
anyway, so the candidate range and the band it was measured against disagreed by the shift.
The visibility deadline timer — the re-sample that exists because dwell and leave delays are
measured in time rather than in events — read the raw offset for *both*, so its candidates
and its band agreed with each other and both described a strip of the list the reader was
not looking at. That is also the sample most likely to be the only one taken during a hold:
it fires when nothing else is happening, which is precisely the reader who has stopped
scrolling to read a comment.

Both now take the content position from the same helper the anchor and the rendered range
read, and both parameters that carry it are named for the space they are in rather than for
the scroller — the name is what made two callers pass the wrong number, and the range's own
parameter carried the same wrong hint one line away.

Nothing painted wrong before this, and that is why it survived a release: the rendered range
was computed correctly, so no row was ever missing from the DOM and no blank space ever
appeared. Only the reporting was wrong — `onVisibilityChange`, the per-item visibility a
component renders from, and anything a consumer drives from them: read receipts, impression
counts, lazy-loading of media. For the duration of a held correction those described the
wrong comments, and a hold lasts as long as an iOS fling does.

Three reads deliberately stay in scroll space, and the split is now stated once where the
two offsets are taken: the offset published to consumers, `atBottom`, and the edge callbacks
that drive pagination. All three are about the scrollbar, and the scrollbar is the one part
of the view a held correction is deliberately hiding from — it has not moved with the
content, and these three are asking where it is.

iOS-only, since nothing else holds a correction. Off iOS the write is taken and the two
spaces coincide, which is asserted directly rather than assumed.

New coverage drives a correction of a viewport and a half, so the row at the raw offset and
the row the content is showing are provably different rows — with a smaller one the two
windows overlap and an assertion passes either way. It then asserts that the row the shift
is holding under the viewport top is still reported visible and that nothing reported a
leave, where reading the band in scroll space reports all eight visible rows as having left;
and that a dwell deadline elapsing mid-hold reports that row, where reading the band in
scroll space restarts the dwell on the scrollbar's rows and reports nothing at all. Both
rows are derived from the size cache rather than named, so neither assertion survives the
arithmetic drifting out from under it.
