---
"virtual-anchor": patch
---

fix: reach the bottom edge with a sticky footer, not the end of the last item

`stickyFooter` is documented as "content inside the scroller, below the list, pinned to the bottom
edge", and the README repeats it — "`stickyHeader` and `stickyFooter` pin to an edge". That held
only while the content overflowed. On a list shorter than its scrollport the slot rested wherever
the last item ended, halfway up the box with the app's background beneath it.

`position: sticky; bottom: 0` can lift a box but never push one down. The slot is the last flow
child of the scrollport, so its static position is the end of the sizer — and the sizer's height
was `cache.totalSize()`, the items and nothing else. `spaceAfter`, which `composeInsets` already
grows by the measured sticky footer, feeds the scroller's arithmetic and was never written to the
DOM. The gap was exactly `viewportSize − totalSize − stickyFooter`, less any other chrome.

| content vs scrollport | where the slot rested |
| --- | --- |
| items + slot taller than the scrollport | at the bottom edge — sticky lifts it there from anywhere below |
| items + slot shorter than the scrollport | at its static position, i.e. under the last item |

Reported from a thread view whose comment composer sat directly under the last comment on a short
thread (restrealitaet/rr-forum-frontend#487), and reachable there without a contrived list: the
comment list always ends in a ~240px clearance row, the opener is a few hundred more, and a desktop
scrollport with the composer open lands close to the boundary already — so a one-to-three-comment
thread on a tall window is enough. The shape generalises past that consumer to any list with a
composer, an action bar or a "N new comments" pill: an empty state, a filter that matched nothing,
or the first render before a single row has measured.

The sizer is now filled to whatever the chrome leaves, so the slot's static position lands on the
bottom edge and the slack falls **between the last item and the footer** — the items stay at the
top, which is what separates this from `syncLeadingSpace`, whose job is the mirror image of moving
short content *down* under `alignToBottom`. Measured in a real browser on a three-comment thread
with an 80px composer: **259.5px above the bottom edge before, on it after**.

Four properties keep it narrow, and each has a case:

- **It only ever grows, and only where there is no scroll range.** Once the content reaches the
  scrollport the expression is `totalSize` exactly, so no anchor, offset, band or alignment can
  observe it. Padding *to* the scrollport rather than past it keeps the browser's maximum at 0 —
  a short list gains no scrollbar. The published `totalSize` is still the items' own, so nothing
  reading the snapshot sees the fill either.
- **The fill is released** when the viewport shrinks under the content, when the composer
  unmounts, and when the items grow past the scrollport.
- **It is gated on a *sticky* footer.** A plain `footer` is in-flow content belonging under the
  last item; pushing it down an unfilled scrollport would be a different library.
- **`alignToBottom` cannot spend the same slack twice.** `syncLeadingSpace` has already taken it
  from above, so the composed `scrollMargin` carries it and the expression collapses to
  `totalSize`. Short content held against the bottom *and* padded away from it would be the bug
  this must not introduce.

`contentSizeFor` subtracts the *composed insets* — `scrollMargin` and `spaceAfter` — rather than a
sum of the four slot heights. Those are already the two quantities wanted, everything scrollable
above the sizer and everything below it, so the fill makes `margin + content + spaceAfter` equal
the scrollport exactly. It also picks up a consumer's own `scrollMargin`, which is page content
above a window-scrolled list that no sum of *our* slots can see; filling past it would have given
the page a scroll range it did not have.

That makes a second reader of `spaceAfter`, whose doc said not to subtract it at all. The warning
was really about one space: a sticky footer counts in `spaceAfter` *and* in `scrollPaddingEnd`, so
taking it off the browser's maximum takes it twice and parks the last item one composer-height too
low — 80.25px out in all three engines before the scroller stopped doing it. In content space
nothing consults `scrollPaddingEnd` and the double count cannot arise, so the doc now says which
space each reader is in rather than forbidding the subtraction outright.

Ten cases pin it, in `engine sticky footer fill`. Seven fail against the old code; the three that
pass are the negative controls — `adds nothing once the items fill the scrollport`, `leaves the
sizer alone for a footer that merely scrolls away` and `spends the slack once under alignToBottom`
— which is what a gate's tests should do. One more runs in
chromium, webkit and firefox, because `position: sticky` is precisely what jsdom does not
implement: `a composer on a short thread still sits on the bottom edge` asks the browser where the
composer's box actually is, and asserts the scroller still has no range to scroll.

Three size limits move by 0.1kB to fit it. The change itself is 0.03kB on each of the three
affected budgets — 10.11 → 10.14kB on the core entry, 12.42 → 12.45 on the React one, 11.02 →
11.05 on the instrumented core — which fits every current limit locally. The bump is for the gap
between toolchains rather than for the code: #79 measured the same source at 10.11kB in CI against
10.08 locally, so 0.06kB of local headroom is not margin, it is one CI run away from red.
