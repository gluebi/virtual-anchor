---
'virtual-anchor': minor
---

Following the output of a list that is still growing: `followOutput`, `alignToBottom`,
`onAtBottomChange` with `atBottomThreshold`, and `onEdgeReached` with
`edgeReachedThreshold`. A chat, a log tail, a thread with a live reply arriving.

**Following is a mode, not an anchor value**, and that is the design decision the rest
follows from. The tempting implementation is to name the last key with an offset past its
own end and let the existing restore path do the scrolling — it does not survive contact
with the platform. `resolveAnchorOffset` happily returns an offset past the reachable
maximum, the browser clamps the write, `carryFor` discards the excess as too large to
carry, and the clamped read-back then fails `isSelfWrite`'s 1.5px tolerance — so the
scroll listener re-derives the anchor from wherever it actually landed. The pin is
destroyed on every publish while content grows, which is precisely when following
matters. So the bottom is asked of the browser, the way `align: 'end'` already asks for
the last item, and for the same reason: at the very end our own arithmetic is not what
the scroller will accept.

**It writes, but it does not suppress the anchor.** The engine keeps two self-write
queues that look interchangeable and are not: the scroller's says "this offset is mine,
do not read it as the user grabbing the scrollbar", and the engine's `restoreIntents`
says "do not re-derive the anchor from this", which is right for a correction whose
read-back may be pixel-snapped and wrong for a move. Following is a move. Pushing to both
left the anchor describing wherever the reader was before they were pinned, so the moment
following stopped — the option flipping off, the reader scrolling back — the next publish
restored that stale position and the view jumped backwards. Found by the test for exactly
that, which is the case a consumer hits by toggling a prop.

**Instant, not animated.** The API is `followOutput?: boolean` rather than virtuoso's
`false | 'auto' | 'smooth'`, and dropping the third value was deliberate rather than
lazy. Smooth following has to reach the same place instant following does, or `atBottom`
reports `false` while the list is actively following itself; but the scroller's only
entry point is `scrollToIndex`, which with a footer present stops at the last *item*,
short of the true bottom by the footer's height. Reaching the true bottom smoothly would
mean a second entry point in the file that decides where every scroll lands. It is not
worth it for a behaviour whose own documentation would have to warn against using it:
under rapid appends the destination moves every frame, and an animation chasing that is
the hazard the README's fetching contract already describes.

**`atBottom` is measured against the viewport, twice from the same source.** Not
`totalSize - scrollOffset - viewportSize`: `getMaxScrollOffset` derives from an integer
`clientHeight` while `getViewportSize` uses the exact float content height, so a
predicate straddling the two flickers on the sub-pixel difference. Nor
`visibleRange[1] === count - 1`, which `indexAt`'s clamping makes true for any list
shorter than the viewport at any scroll position at all. A list with no scroll range is
at its bottom, because its end is on screen.

**Letting go uses input as the gate and position as the test.** `ScrollerOptions` gains
`onUserInput`, fired from the listener that already cancels an in-flight scroll on a
wheel, touch, pointer or key. A scroll with no input behind it decides nothing, because
the browser moves `scrollTop` by itself when content shrinks and when a window of items is
replaced — and reading that as intent would unpin a reader who touched nothing. The
scroller's own comment already argued this for cancellation; it is the same argument.

**Letting go is immediate; taking hold again waits for the scrolling to stop**, and the
asymmetry is load-bearing in both directions. Unpinning cannot wait: following writes the
bottom on every publish, so staying pinned for even a few frames while the reader scrolls
away drags them back under their own hands. Re-pinning cannot be decided on the same
event: the first scroll after a wheel routinely arrives while the scrolling is still in
flight — momentum, an engine that scrolls asynchronously, or simply a loaded machine — so
the position is not yet at the end, following stays off, and the settle that follows
carries no input to reconsider it. A reader who scrolled back to the newest message never
got re-pinned. Found on WebKit, then reproduced on Chromium under load.

The re-pin is therefore decided on a 150ms quiet window after input-driven scrolling, with
`scrollend` short-circuiting it where the platform sends one. `scrollend` alone was tried
and is not enough, which is measurable rather than defensive: `supportsScrollEnd()` only
asks whether the property exists, and Firefox has the property while firing **zero** events
across a 700ms wait for a sequence of wheel deltas — the exact gesture this feature is
about. That is the same relationship the scroller already has with the event: corroboration
for latency, never the mechanism.

**`onEdgeReached` is suppressed while a programmatic scroll is in flight.** This is the
point of it existing rather than being left to `onScroll`. The README tells consumers not
to fetch during a programmatic scroll and both demos hand-rolled the guard; owning the
callback makes the mistake unavailable instead of merely documented. What remains the
consumer's is the part that is genuinely a product decision — whether there is more to
load and whether a fetch is already running. It is latched per crossing rather than
deduped by identity, because reaching an edge is an event and not a value.

**`alignToBottom` is a fifth contribution to the slot composition**, not a mechanism of
its own: space above the items is what `scrollMargin` has always meant, so it composes
into the same inset the measured slots feed. Written as a margin on the item container
rather than a spacer element — the container is already a node the surface owns and whose
height it already writes, where a spacer would need a node in every adapter and a ref to
reach it. Margins are refused on *items* because no ResizeObserver box includes them;
that argument does not apply to a box whose size is written rather than measured. It is
computed before the anchor is derived at mount, because an anchor taken against an origin
of zero and then resolved against the real one is wrong by the whole spacer.

Smaller changes:

- `cancelScroll` reaches the React layers. It has been on the engine since the engine
  existed and was exposed by neither the hook nor the component, so every consumer that
  did not build its own engine could start a smooth scroll and had no way to stop it.
- `VirtualState` gains `atBottom`, deliberately absent from `needsRerender` — a scroll
  that merely reaches the end within the mounted set still costs no React work, and
  `onAtBottomChange` is fed from a store subscription in the same shape as
  `onVisibleRangeChange`. Its ref seeds to `null` rather than to the empty state, whose
  `atBottom` is `true`: seeding from that would swallow the opening report of every list
  that starts pinned, which is the one report a chat cares about.
- Both demos lost their hand-rolled distance-to-bottom arithmetic. The thread demo had
  *two* copies — an `onScroll` handler reading `scrollTop`/`clientHeight`/`scrollHeight`
  off the element, and a `window` listener doing the same against
  `scrollY`/`innerHeight`/`documentElement`, because the host's `onScroll` never fires
  when the page is what scrolls. The library knows which one it is.

The size budgets move with it, which is a decision rather than an accident: 9 kB → 9.5 kB
for the core entry and 11 kB → 11.7 kB for the React one, against actuals of 9.38 kB and
11.65 kB. Two features have landed on top of the 8.45 kB those ceilings were set around,
both of them in the core so that a Vue or Svelte adapter would inherit them. The previous
ceiling left 70 bytes of headroom, which is not a budget so much as a tripwire; ~250
bytes is enough for the next change to be discussed on its merits. The gap between the
two entries is unchanged at ~2.2 kB, which is the figure worth watching — it says the
React layer is still a translation and not a second implementation.
