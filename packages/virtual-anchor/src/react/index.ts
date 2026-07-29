export type {
  Anchor,
  AnchorGeometry,
  ItemKey,
  ItemVisibility,
  ScrollAlign,
  ScrollEndReason,
  ScrollResult,
  ScrollToOptions,
  SizeSnapshot,
  TraceEvent,
  TraceSink,
  VirtualItem,
  VisibilityEvent,
  VisibilityOptions,
  VisibilityRule,
} from '../index.js'

export { useVirtualList } from './useVirtualList.js'
export type {
  RenderedItem,
  UseVirtualListOptions,
  UseVirtualListResult,
} from './useVirtualList.js'

export { useItemVisibility } from './useItemVisibility.js'

export { VirtualList } from './VirtualList.js'
export type { VirtualListHandle, VirtualListProps } from './VirtualList.js'

/**
 * Tracing, re-exported so an app that only depends on the React package can turn it on.
 * Inert in a production build — see the core's `trace` module.
 */
export { isTracing, setTraceSink, TRACING } from '../index.js'
