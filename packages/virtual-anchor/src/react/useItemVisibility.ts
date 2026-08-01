import type { Engine, ItemKey, ItemVisibility } from '../index.js'
import { useCallback, useSyncExternalStore } from 'react'

const NOT_VISIBLE: ItemVisibility = {
  visible: false,
  itemFraction: 0,
  viewportFraction: 0,
  hasBeenSeen: false,
}

/**
 * Subscribe to one item's visibility.
 *
 * Narrow by design: a component using this re-renders only when *its own* item
 * changes state, not when any item does. That matters because the alternative —
 * one callback per item calling `setState` — is what makes an
 * observer-per-element approach expensive. Measured on 1,000 rows in Angular, a
 * shared observer took ~30ms against ~250ms for one-per-item, and the difference
 * was attributed to framework change detection rather than observer internals.
 *
 * The state lives in the engine rather than in an effect, so virtualization's
 * unmount/remount and StrictMode's double invocation cannot double-count.
 */
export function useItemVisibility(engine: Engine | null, key: ItemKey): ItemVisibility {
  /**
   * Wake React a microtask after the engine says this item's visibility moved.
   *
   * The engine notifies these listeners from the end of a publish, and a publish can happen
   * during React's render phase — options are pushed into the engine during render, so a
   * prepend positions itself in the same commit that renders it. A store telling React to
   * re-render from inside another component's render is the update React refuses, and the
   * component named in the warning would be whichever row happened to be subscribed.
   *
   * The same hop `useVirtualList`'s own `useSyncExternalStore` has always had, for the same
   * reason and at the same cost of nothing: React re-reads the snapshot for the render in
   * progress, and a microtask still runs before paint.
   */
  const subscribe = useCallback(
    (onChange: () => void) =>
      engine?.subscribeVisibility(key, () => {
        queueMicrotask(onChange)
      }) ?? (() => {}),
    [engine, key],
  )

  const getSnapshot = useCallback(
    () => engine?.getVisibility(key) ?? NOT_VISIBLE,
    [engine, key],
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
