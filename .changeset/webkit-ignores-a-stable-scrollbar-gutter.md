---
'virtual-anchor': patch
---

Documented that `scrollbar-gutter: stable` does not hold on WebKit when the scrollbar has been given a width, and warn in development when the scrollport narrows anyway.

`stableScrollbarGutter` is on by default and was documented as taking the scrollbar's width out of
the equation — the argument for making it a default at all, and what lets a consumer stop
hand-copying the property at every call site. It does not hold on **WebKit** for a scroller whose
scrollbar has been given a width, which is every consumer that styles its scrollbars.

Measured on a 400×300 scroller with the property set, before and after its content starts to
overflow:

| engine   | `::-webkit-scrollbar` width | `clientWidth` before → after |             |
| -------- | --------------------------- | ---------------------------- | ----------- |
| chromium | 12px                        | 388 → 388                    | stable      |
| chromium | none                        | 400 → 400                    | stable      |
| webkit   | **12px**                    | **400 → 388**                | **narrows** |
| webkit   | none                        | 400 → 400                    | stable      |
| firefox  | 12px                        | 400 → 400                    | stable      |

So WebKit reserves nothing until the scrollbar exists, but only once a custom width has opted the
scroller out of overlay scrollbars. Without one there is no space to reserve and the property is
moot — which means the one configuration where WebKit could honour the declaration is the one where
it has nothing to do. `scrollbar-gutter: stable` is specified to reserve the space whether or not a
scrollbar is currently present, so this reads as a conformance bug; either way it is live behaviour
a consumer meets today.

Nothing in this package can fix it. The property is set correctly, `getComputedStyle` reads back
`stable`, and the platform ignores it — so there is not even anything to feature-detect. But the
promise was this package's to make, and the failure lands on the geometry this package owns: the
scrollport narrows the moment the rows overflow, and every row measured before that is wrong by a
re-wrap.

The list does recover — a width change invalidates the size cache and the rows still on screen are
re-measured — but recovery means every mounted row measuring again and every offset below it moving
one frame after a landing. That is the re-entrant correction the width-keyed cache was introduced to
avoid, and on 0.10.0 it is also what triggered the stale-anchor restore fixed separately as #115.

What changed:

- The README and the `stableScrollbarGutter` doc now say what actually happens, and name the fix:
  a consumer styling `::-webkit-scrollbar` has to reserve the width in that stylesheet, or leave
  `::-webkit-scrollbar` alone and keep the overlay scrollbars that take no space to begin with.
- A development build warns **once** when the scrollport is narrowed while the computed
  `scrollbar-gutter` is `stable` — the moment the promise breaks, and the consumer's only signal
  that it did. Read off the element rather than from the React prop, so it also covers a core
  consumer who set the property by hand because the documentation told them to.

  Narrowed, not merely changed: a scrollbar appearing takes its width out of `clientWidth` and
  leaves `offsetWidth` exactly where it was, while a window resize, a flex sibling growing or a
  media query moves both. The gutter promises nothing about those, so warning on any width change
  would mean a list in a resizable layout complaining on every drag — which is how a development
  warning gets tuned out rather than read. Once per engine for the same reason: this reports a
  stylesheet rather than an event.

Nothing is warned about in a production build, and there is no behaviour change in one. Both
shipping budgets are unchanged to the byte, which is the check that the guard really does drop the
message; the development bundle grows by the length of the sentence and its budget by 0.1 kB.

Fixes #116.
