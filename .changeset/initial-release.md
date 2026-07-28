---
'virtual-anchor': minor
'react-virtual-anchor': minor
---

Initial release.

A React virtual list that models scroll position as an anchor — "this pixel of this
item" — rather than a pixel offset into an index-addressed list. Prepending cannot
move the view, measurements landing above the viewport need no compensation
heuristic, and `scrollToKey` converges to a fixed point instead of computing one
offset and hoping.

Also two things no existing virtual list offers: per-item viewport events with
configurable threshold, dwell and fire-once semantics, and a settle promise that
reports honestly when it could not get there, with a reason.

Sub-pixel landing verified on Chromium, WebKit and Firefox.
