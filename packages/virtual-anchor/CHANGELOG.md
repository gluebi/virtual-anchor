# virtual-anchor

## 0.1.0

### Minor Changes

- da2b802: Initial release.

  A virtual list that models scroll position as an anchor — "this pixel of this item" — rather
  than a pixel offset into an index-addressed list. Prepending cannot move the view,
  measurements landing above the viewport need no compensation heuristic, and `scrollToKey`
  converges to a fixed point instead of computing one offset and hoping.

  Two entry points from one package: `virtual-anchor` is framework-agnostic, and
  `virtual-anchor/react` is a React 19 adapter. React is an optional peer, so the core entry
  pulls in no framework.

  Also two things no existing virtual list offers: per-item viewport events with configurable
  threshold, dwell and fire-once semantics, and a settle promise that reports honestly when it
  could not get there, with a reason.

  Sub-pixel landing verified on Chromium, WebKit and Firefox across alignments, scroll padding,
  a list sharing its scroller with other content, and the window scroller — with the whole
  12,000-comment thread loaded, so the distances and the offset tree are real.

  Not verified on real iOS hardware: the momentum-deferral path is written from the spec and
  exercised only in a desktop WebKit build.
