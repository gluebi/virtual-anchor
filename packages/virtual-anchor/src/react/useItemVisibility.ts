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
  const subscribe = useCallback(
    (onChange: () => void) => engine?.subscribeVisibility(key, onChange) ?? (() => {}),
    [engine, key],
  )

  const getSnapshot = useCallback(
    () => engine?.getVisibility(key) ?? NOT_VISIBLE,
    [engine, key],
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
