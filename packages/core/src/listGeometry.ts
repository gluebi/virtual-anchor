/**
 * Where the list sits inside its scroller, and what overlaps it.
 *
 * Three numbers, and between them the entire conversion from the scroller's
 * coordinate space into the list's own. Every offset comparison in the library has
 * to be explicit about which space it is in — mixing them is the whole of TanStack
 * #1001, where clamping in the wrong space made the error grow with the list's
 * distance from the top of the page.
 */
export interface ListInsets {
  /**
   * Height of sticky or fixed chrome overlapping the top of the scrollport.
   * The visible area starts *below* it, not underneath it.
   */
  scrollPaddingStart?: number
  /** Height of chrome overlapping the *bottom* of the scrollport. */
  scrollPaddingEnd?: number
  /**
   * Distance from the top of the scrollable content to the start of the list.
   * Non-zero when the page itself scrolls and there is content above the list.
   */
  scrollMargin?: number
}

/** A range of list coordinates. */
export interface Band {
  readonly start: number
  readonly end: number
}

/**
 * The one place that converts between scroller space and list space.
 *
 * This exists because the conversion `scrollOffset - scrollMargin +
 * scrollPaddingStart` had been written out in seven places: three times in the
 * anchor module, twice while computing the rendered range, twice more while
 * sampling visibility, and once in the scroller's own visible-extent maths. Four
 * separate consumers each re-derived it, which is what you would expect when a
 * concept is named after one of them rather than after itself.
 *
 * That duplication was not merely untidy — it produced a real bug. The visibility
 * band was assembled from two half-conversions in two different files, so for a
 * document scroller (where an intersection rect's `top` already carries `-scrollY`)
 * the scroll offset was added twice and the band inverted past one viewport of
 * scrolling, silently stopping every visibility event. With one owner of the
 * conversion, that class of mistake has nowhere to live.
 */
export class ListGeometry {
  #insets: ListInsets
  #viewportSize: number

  constructor(insets: ListInsets = {}, viewportSize = 0) {
    this.#insets = insets
    this.#viewportSize = viewportSize
  }

  update(insets: ListInsets, viewportSize: number): void {
    this.#insets = insets
    this.#viewportSize = viewportSize
  }

  get paddingStart(): number {
    return this.#insets.scrollPaddingStart ?? 0
  }

  get paddingEnd(): number {
    return this.#insets.scrollPaddingEnd ?? 0
  }

  get margin(): number {
    return this.#insets.scrollMargin ?? 0
  }

  /**
   * The height genuinely available to items, once overlapping chrome is removed.
   *
   * Alignment maths is all expressed against this rather than the raw scrollport
   * height, so padding never has to be reasoned about twice.
   */
  visibleSize(): number {
    return this.#viewportSize - this.paddingStart - this.paddingEnd
  }

  /**
   * Scroller offset → list coordinate.
   *
   * Answers "which pixel of the list is at the top of the *visible* area", which is
   * the point the anchor is defined against.
   */
  toList(scrollOffset: number): number {
    return scrollOffset - this.margin + this.paddingStart
  }

  /** List coordinate → scroller offset. The exact inverse of {@link toList}. */
  toScroll(listOffset: number): number {
    return listOffset + this.margin - this.paddingStart
  }

  /**
   * The visible area, in list coordinates.
   *
   * One expression, one owner. Previously the rendered range and the visibility
   * sample each computed this independently and had to be kept in step by hand.
   */
  visibleBand(scrollOffset: number): Band {
    const start = this.toList(scrollOffset)
    return { start, end: start + this.visibleSize() }
  }

  /** {@link visibleBand} grown by `buffer` px in each direction, for mounting. */
  bufferedBand(scrollOffset: number, buffer: number): Band {
    const band = this.visibleBand(scrollOffset)
    return { start: band.start - buffer, end: band.end + buffer }
  }

  /**
   * The list coordinate at a given y within the scrollport.
   *
   * Scrollport y is measured from the scrollport's top *edge*, so y = 0 is above
   * any sticky header — which is why this is not simply `toList`. `toList` answers
   * for the top of the visible area, i.e. y = `paddingStart`.
   */
  listCoordAt(scrollOffset: number, scrollportY: number): number {
    return scrollOffset - this.margin + scrollportY
  }

  /**
   * Narrow a band to the part of the scrollport actually on screen.
   *
   * `onScreen` is expressed in scrollport-relative px, which is the one coordinate
   * space a gate observing the scroller can report without knowing anything about
   * the list. Converting it here, once, against the current scroll offset, is what
   * keeps a document scroller — whose intersection rect already carries `-scrollY`
   * — from having its scroll offset applied twice.
   *
   * Returns `null` for an empty intersection: nothing is on screen, which is a
   * different statement from "the whole band is".
   */
  clampToOnScreen(scrollOffset: number, band: Band, onScreen: Band | null): Band | null {
    if (onScreen === null) return null

    const start = Math.max(band.start, this.listCoordAt(scrollOffset, onScreen.start))
    const end = Math.min(band.end, this.listCoordAt(scrollOffset, onScreen.end))
    return start < end ? { start, end } : null
  }
}
