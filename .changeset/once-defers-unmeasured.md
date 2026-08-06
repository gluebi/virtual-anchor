---
'virtual-anchor': patch
---

Under `once`, hold an unmeasured item back instead of reporting it.

`once` and the `measured` flag were individually sound and jointly broken. `satisfies`
lets an `edge` rule through unmeasured on purpose, and says why: gating it "would mean
an item never reports until measured — which for read tracking reads as 'not read yet'
rather than 'not sure yet'. The event carries `measured` truthfully, so a consumer
wanting only confirmed geometry can filter on it." Add `once` to that and the advice
becomes a trap: the filtered event is also the only one that key will ever get.

The first sample of a list's life is guaranteed to be the unmeasured one, and the
ordering runs the wrong way to fix by waiting. `useVirtualList` pushes options into the
engine from the **render body** — deliberately, so a prepend lands in the same commit
that renders it — `setOptions` ends in `publish`, and `publish` ends in a visibility
sample. `observeItem`'s synchronous `getBoundingClientRect` is a *commit-phase* ref
callback, so it has not run yet. Neither suppression path intervenes either: `gate` is
still `null` at that point, so `gated` defaults to `true`, and nothing is scrolling. With
`dwellMs` unset, `#dueAt` returns `passingSince + 0` and every in-band candidate reports
on that sample with `measured: false` — then sets `hasBeenSeen`, after which `#dueAt`
returns `null` for the key forever.

The visible symptom was total on short lists and invisible on long ones. Rows below the
fold mount inside the overscan buffer, are measured at ref-attach, and only cross the
band on a later scroll sample, so they report `measured: true` and a read marker
advances off them quite happily. Only the rows in the band *at mount* are poisoned — so
on a forum thread short enough to fit the viewport, every row is, every event is
discarded, and the thread can never be marked read at all. There is no scroll left to
recover from it.

`#dueAt` now returns `null` for an unmeasured item under `once`, so it neither reports
nor latches, and reports on the first sample where it both passes and is measured.
`null` rather than a deadline is the load-bearing part: what unblocks the item is a
measurement, and a measurement always publishes. A deadline would fire, find `sample`
still declining to report, and re-arm at delay zero — the spin `#dueAt` was consolidated
to rule out.

Scoped to the interaction, not to `edge`. Without `once` an unmeasured `edge` enter still
fires exactly as before and still says so. With `once`, the deferral costs at most one
commit phase, because anything whose trailing edge is inside the band is mounted and
therefore measured at ref-attach — the doc comment's worry about an item that "never
reports" does not describe a report that is one tick late.

A `quiet` adoption is exempt, and has to be. The guard protects the one *report*; an
adoption emits nothing, so there is no event for a consumer to filter and nothing to
protect. Withholding it would actively break `quiet`, because `#started` latches on the
first non-suppressed sample either way: hold the unmeasured one back and the measured
sample that follows is no longer the first, so `quiet` would report precisely the rows it
exists to swallow — the deep-linked reader's on-screen comments, all counted as freshly
read. `quiet` therefore still adopts from the estimate, exactly as before.

Emitting a second, measured `enter` instead was considered and rejected: it breaks what
`once` says it does, which is report at most once per key, ever.

No API surface changes. A consumer that does not use `once` is unaffected, as is one that
pairs it with `quiet`; a consumer that uses `once` without filtering on `measured` sees
its first batch arrive one commit later than before, carrying real geometry instead of
estimates.

Fixes #50.
