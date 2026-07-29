---
'virtual-anchor': minor
---

`estimateSize` and `defaultEstimate` now work when set through `useVirtualList` or `VirtualList`.
Until this release they were accepted and silently dropped: `estimateSize` was called zero times, and
every unmeasured item was laid out at the internal 120px default no matter what you supplied.

`SizeCache` read both options in its constructor only, and `engine.setOptions` never forwarded
them — while the React adapter supplies options exclusively that way, because the engine is derived
from a scroll element that does not exist on the first render. So the wrapper the adapter builds to
map a key back to an item was unreachable code. It was found by driving that file's coverage to 100%
and noticing the wrapper had never executed.

`SizeCache` gains `setEstimateSize` and `setDefaultEstimate`, both following `setKeys`: a reference
check, then a full rebuild of the offset tree. The rebuild is not an optimisation to skip. `setSize`
folds a first measurement in incrementally, as `size - (previous ?? estimateFor(index, key))`, so a
slot built with one estimate and adjusted against another is wrong by the difference — permanently,
because nothing recomputes it. There is a test that measures an item after changing the estimator and
asserts offsets are still exactly invertible.

A changed estimate moves every unmeasured item, so `setOptions` now treats it like a prepend: the
anchor is re-applied and any in-flight programmatic scroll is re-aimed. Because the anchor names a
key rather than an offset, the view does not move — which is the property that makes re-estimating
safe at all, and is what react-window's #863 is about.

Two smaller changes come with it:

- `estimateSize` may now return `undefined`, meaning "no opinion about this item", which falls
  through to `defaultEstimate` and then to the learned median. The React adapter uses this for a key
  it cannot resolve to data, instead of reproducing the fallback itself.
- `defaultEstimate` is tracked separately from the estimate actually in use. They shared one field,
  and a caller passing a constant every render would have compared it against a median the estimator
  had since learned, found them different, and overwritten the better number — rebuilding the tree
  each time.

**This changes item placement** for anyone passing `estimateSize`, which is the point: you now get
what you asked for rather than a median of what happened to be measured. Note the corollary — a
caller-supplied estimator disables the median estimator, as documented, so a *bad* estimate is now
genuinely worse than none. The demo's own estimate was wrong by 270px at the long end and has been
refitted against measured heights; it had never mattered before.
