export type {
  Anchor,
  ItemKey,
  ScrollAlign,
  ScrollEndReason,
  ScrollResult,
  ScrollToOptions,
  SlotName,
} from './types.js'

export { SizeCache } from './sizeCache.js'
export type { ResolvedItem, SizeCacheOptions, SizeSnapshot } from './sizeCache.js'

export { ListGeometry } from './listGeometry.js'
export type { Band, ListInsets } from './listGeometry.js'

export {
  carryFor,
  convergenceTolerance,
  deriveAnchor,
  isSelfWrite,
  MAX_CARRY,
  offsetForIndex,
  resolveAnchorOffset,
  SELF_WRITE_TOLERANCE,
  snapToDevicePixels,
} from './anchor.js'
export type { AnchorGeometry } from './anchor.js'

export { createElementViewport, createWindowViewport, documentScrollElement } from './viewport.js'
export type { Viewport } from './viewport.js'

export { createResizer } from './resizer.js'
export type { Resizer, ResizeBatch, ResizerOptions, SlotResizeBatch } from './resizer.js'

export {
  devicePixelRatioOf,
  isIOSWebKit,
  prefersReducedMotion,
  supportsScrollEnd,
} from './env.js'

export { VisibilityTracker } from './visibility.js'
export type {
  ItemVisibility,
  VisibilityCandidate,
  VisibilityEvent,
  VisibilityOptions,
  VisibilityRule,
  VisibilitySample,
} from './visibility.js'

export { createScrollerGate } from './gate.js'
export type { ScrollerGate, ScrollerGateOptions } from './gate.js'

export { createScroller } from './scroller.js'
export type { Scroller, ScrollerOptions } from './scroller.js'

export { onScrollSettled } from './settle.js'

export { createVirtualStore, EMPTY_RANGE, EMPTY_STATE, needsRerender } from './store.js'
export type { VirtualItem, VirtualState, VirtualStore } from './store.js'

export { createDomSurface, createNullSurface } from './surface.js'
export type { DomSurfaceOptions, Surface } from './surface.js'

export { createEngine, layoutSignatureFor } from './engine.js'
export type { Engine, EngineOptions } from './engine.js'

// `TRACING` keeps its published name while the value moves to its own module, and the alias
// lives here rather than in `trace.ts` because this is an export list — nothing guards on it,
// so no optimizer has to see through the rename to fold a call site.
export { DEBUG as TRACING } from './debugFlag.js'
export { addTraceListener, isTracing, setTraceSink } from './trace.js'
export type { TraceEvent, TraceSink } from './trace.js'
