---
'virtual-anchor': patch
---

Discard stale measurements when the device pixel ratio changes.

This is the last of the three terms in the layout signature to get a runtime trigger, and the
only one whose answer was not obvious in advance. The width is caught by a scrollport resize.
The root font size is caught by rows re-laying-out. A device pixel ratio change need not do
either: it can leave the scrollport exactly as it was and re-lay-out nothing, so neither
existing trigger can see it.

The question worth asking first was whether it should be caught at all. CSS pixel layout is
*nominally* independent of the ratio, and if that held then a change would alter no row height,
the term would not belong in the key, and invalidating on it would discard a whole cache for
nothing — a window dragged between two displays would throw away every measurement in a long
thread and re-estimate it. Deleting the term would then have been the fix.

It does not hold. Measured on the demo at a fixed 1280px viewport, first six rows:

| ratio   | Chromium | Firefox | WebKit        |
| ------- | -------- | ------- | ------------- |
| 1, 2, 3 | 277.25   | 277.25  | 277.25        |
| 1.25    | 277.25   | 277.25  | **276.84375** |

On WebKit at a *fractional* ratio every row is 0.40625px shorter, uniformly. Integer ratios
agree exactly on all three engines, and Chromium and Firefox agree everywhere. Per row that
difference is invisible; across a few thousand rows it is a wrong scroll extent and a landing
that misses by more than a screen, which is the failure this library exists to prevent. And
fractional ratios are not exotic — browser page zoom is how most people produce one.

So the term stays and gets an observer. There is no event for `devicePixelRatio`, so
`observeResolution` uses the standard trick: a `(resolution: Xdppx)` media query matches only
the ratio it names and stops matching the moment the ratio moves. That means it has to be
re-armed against the new value on every change, because one query cannot answer "has this
changed" twice — miss that and the first zoom is the only one ever noticed. It reuses the
`matchMedia` guard `prefersReducedMotion` already established, so a host without it gets an
inert unsubscribe rather than a crash.

The callback goes straight to the existing resize handler, which re-reads the signature and
publishes accordingly. That is the whole of what is wanted, and it is only reusable because the
handler takes no arguments — its name is about its first caller rather than its job.
