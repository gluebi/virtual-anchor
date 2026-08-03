---
'virtual-anchor': patch
---

Stop cancelling iOS momentum scrolling from `engine.publish()`.

Writing `scrollTop` during a fling cancels it on iOS WebKit. The library guarded against
that, but the guard lived inside the scroller and only `scroller.write()` consulted it —
while `engine.publish()` wrote scroll offsets directly, from two places, gated only on
`!scroller.isScrolling()`. That flag is about *programmatic* scrolls, so a user's momentum
fling was precisely the state in which it let the write through. In a list with
variable-height rows, every row measured on mount mid-fling took that path, which is very
nearly all of them: momentum died on the first frame after the finger lifted. A list with
uniform rows and an accurate estimate produced no correction, no write, and no symptom,
which is why this went unnoticed.

The decision now lives in one place — an internal `ScrollWriteGate` — and the engine's two
writes consult the same answer. An eslint rule fails the build on a third ungated
`setScrollOffset` call, since two releases of exactly that is how this arrived.

Two further fixes fall out of it:

- **The grace period never bounded a fling.** `IOS_TOUCH_GRACE_MS` is 150ms and iOS
  momentum runs for one to three seconds, so the old guard reopened mid-flight and the
  next banked correction killed the scroll anyway. The gate is now a state machine —
  `idle → touching → grace → momentum` — that stays shut until the platform reports the
  scrolling over, via `scrollend` where available and the settle helper's scroll debounce
  where not. The 150ms timer keeps its real job of bridging `touchend` to the first
  momentum event, and two escape hatches guarantee the gate cannot wedge shut: a
  `touchend` that never scrolls reopens on that timer, and a fling that never settles
  reopens at a 3s cap.
- **A `scrollToIndex` issued mid-fling no longer spends its deadline while refused.** With
  the closed window now measured in seconds rather than milliseconds, the convergence loop
  would otherwise burn `SOFT_DEADLINE_MS` and resolve `deadline` with a large deviation for
  a scroll never given a chance to write.

A prepend still writes through a shut gate, deliberately: deferring a *model* change would
move the reader by the whole inserted height, which is the one thing an anchored list
promises cannot happen. Only *measurement* corrections are postponed, and they are
re-applied in a single publish when the gate reopens. `publish`'s parameter changes from a
boolean to `'none' | 'measure' | 'model'` to carry that distinction by cause rather than by
a size threshold, which this file has never had.

Nothing changes off iOS: the gate binds no listeners, arms no timers, and `canWrite()` is a
constant `true` on Chromium, Firefox and desktop WebKit.

Verification is still partly manual. A new `mobile-webkit` Playwright project runs real
WebKit behind an iPhone descriptor, so the gate is live and the suite can prove no write
escapes a gesture — but Playwright produces no actual momentum, so that momentum *survives*
remains a real-device check. New `momentum.dom.test.ts`, `settle.dom.test.ts` and
`engine.ios.dom.test.ts` cover the rest; the last of those is the first engine-level iOS
coverage this package has had, and its absence is the reason the bypass survived.
