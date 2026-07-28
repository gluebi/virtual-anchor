export type {
  Anchor,
  ItemKey,
  ScrollAlign,
  ScrollResult,
  ScrollToOptions,
} from './types.js'

export { SizeCache } from './sizeCache.js'
export type { ResolvedItem, SizeCacheOptions, SizeSnapshot } from './sizeCache.js'

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

export { createElementViewport, createWindowViewport } from './viewport.js'
export type { Viewport } from './viewport.js'

export { createResizer } from './resizer.js'
export type { Resizer, ResizeBatch, ResizerOptions } from './resizer.js'

export {
  devicePixelRatioOf,
  isIOSWebKit,
  prefersReducedMotion,
  supportsScrollEnd,
} from './env.js'
