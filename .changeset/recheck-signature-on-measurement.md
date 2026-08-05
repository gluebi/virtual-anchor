---
'virtual-anchor': patch
---

Discard stale measurements when the root font size changes, not only when the scrollport does.

The size cache is keyed on a layout signature — `w=<clientWidth>|f=<rootFontSize>|dpr=<dpr>` — and
each of those three terms is in the key because changing it makes a measured row height *wrong*
rather than merely old. But only one thing re-read that key at runtime, and it was reachable from
exactly one place: `viewport.observeSize`. So runtime invalidation covered whatever a scrollport
resize reports, which after the width fix is the width, and nothing else.

A root font size change is the term with a real defect behind it. Raising a browser's default text
size, or flipping an app's own accessibility toggle, re-wraps every line of every row — and moves
the scrollport not at all. Nothing was delivered, the signature was never re-read, and every
measured height stayed keyed to a layout that had stopped existing. The rows still mounted are
re-measured by the item observer and heal; the rest keep a height taken under the old font and are
placed by a prefix sum that mixes the two, which is the same end state as the width bug and the
same symptom — rows drawn overlapping or with gaps, fixing themselves when scrolled out of the
mounted window and back in.

What closes it is not a new observer. The signal was already arriving: a font size change re-lays-out
every mounted row, so the shared `ResizeObserver` fires for all of them. Nothing was asking the
question. The signature check moves out of the resize handler into one helper, and the item batch
asks it too — so a resize is now simply the trigger that happens to catch the width term, rather
than the only trigger there is.

Three details, since none of them is arbitrary:

- **The read happens before the batch is applied.** A `ResizeObserver` callback runs after layout, so
  reading a computed style there forces no reflow — but the same callback goes on to write styles
  through `publish`, and a read after that would. It also has to precede the batch because a
  signature change clears the cache, and those measurements are the only ones in the list taken
  under the new layout.
- **It is rate-limited to once every 250ms.** The top of that callback is the hot path — every row
  measured during a fling — and a `getComputedStyle` per row is not acceptable there. A limit rather
  than a threshold: it decides nothing about the content, only how often the question is asked. The
  cause is a human action that takes about a second, so a quarter of a second of latency is not
  perceptible, and it bounds the reads through a three-second fling to a dozen.
- **An invalidation publishes as a model change, not a measurement.** Discarding every measurement
  moves every offset below the first item, and a correction that large cannot wait for a gesture to
  end without teleporting the reader — the same reasoning the resize path already applies.

The mount path is deliberately untouched: `observeItem` measures each row synchronously as it
attaches, and putting a computed-style read there would pay it per row for the whole of a scroll.
A font size change while nothing is mounted is caught by the first batch after it, which is the
first moment there is anything to be wrong about.

The device pixel ratio term still has no runtime trigger. That is not an oversight and not the same
problem: CSS-pixel layout is largely independent of it, so a change may not alter a single row
height, in which case invalidating would discard a whole cache for nothing. It is being settled by
measurement separately.
