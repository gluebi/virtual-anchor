export type {
  Anchor,
  AnchorGeometry,
  /**
   * Needed here because `useItemVisibility` takes one and `VirtualList` hands one out. Without
   * this a consumer of the React entry could hold an engine but not name its type.
   */
  Engine,
  ItemKey,
  ItemVisibility,
  ScrollAlign,
  ScrollEndReason,
  ScrollResult,
  ScrollToOptions,
  SizeSnapshot,
  /**
   * The component and the hook name their slots individually, so this is not
   * needed for either — it is here for the `Engine` handed out by
   * `onEngineReady`, whose `slotRef` and `observeSlot` do take one.
   */
  SlotName,
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
