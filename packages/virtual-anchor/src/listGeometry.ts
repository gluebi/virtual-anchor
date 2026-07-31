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
  /**
   * In-flow content occupying scrollable space *after* the last item.
   *
   * **Read as a predicate, not as a quantity: do not subtract it.** The one
   * production caller asks only whether it is zero. A sticky footer is in-flow
   * content *and* overlapping chrome, so it is counted here *and* in
   * {@link scrollPaddingEnd}, and subtracting this from the browser's maximum
   * therefore takes it twice — which parks the last item one composer-height
   * too low, behind the composer. Measured at 80.25px out in all three engines
   * before the scroller stopped doing it.
   *
   * What it decides: the scroller's `align: 'end'` shortcut for the last item
   * asks the browser for its maximum scroll offset rather than trusting our own
   * arithmetic at the very end of the list. That is right when the trailing
   * space is unmeasurable — a border, padding on the scroller — and wrong when
   * it is a footer, because the maximum is then past the last item. Non-zero
   * here means the trailing space is known, so the shortcut is skipped and the
   * general alignment handles the item from exact offsets.
   *
   * Deliberately absent from {@link toList}, {@link toScroll} and
   * {@link visibleSizeOf}: content below every item cannot move where any of
   * them sits, and an anchor that shifted when a footer mounted would be a bug.
   */
  spaceAfter?: number
}

/**
 * The height genuinely available to items, for insets that have no geometry.
 *
 * A free function because the scroller holds raw `ListInsets` and had written
 * this subtraction out by hand — a second copy of the expression, in the file
 * that decides where a scroll lands. Sticky slots made that a live hazard
 * rather than a tidiness complaint: they feed `scrollPaddingStart`, and a copy
 * that forgot them would land every `align: 'end'` under the sticky footer.
 *
 * Floored at zero; see {@link ListGeometry.visibleSize}.
 */
export function visibleSizeOf(insets: ListInsets, viewportSize: number): number {
  return Math.max(
    0,
    viewportSize - (insets.scrollPaddingStart ?? 0) - (insets.scrollPaddingEnd ?? 0),
  )
}

/**
 * Measured chrome around the list, before it is mapped onto the insets.
 *
 * Every field is a height in px, and zero means "not present".
 */
export interface InsetContributions {
  /** In-flow content above the items that scrolls away with them. */
  header?: number
  /** Content above the items that also covers the top of the scrollport. */
  stickyHeader?: number
  /** In-flow content below the items that scrolls away with them. */
  footer?: number
  /** Content below the items that also covers the bottom of the scrollport. */
  stickyFooter?: number
  /**
   * Empty space held above the items, for `alignToBottom`.
   *
   * Not chrome — nothing is rendered in it — but it occupies the same channel
   * for the same reason: it is distance between the top of the scrollable
   * content and the start of the list, which is what `scrollMargin` means.
   */
  leadingSpace?: number
}

/**
 * Fold measured chrome into a consumer's own insets.
 *
 * Here rather than in the engine because this is a statement about what
 * `ListInsets` *fields mean*, and `ListInsets` could not be read correctly from
 * its own file without it. The engine owns the measurements; the mapping from a
 * measurement to a channel belongs with the channels.
 *
 * The rule that is easy to get wrong: a `position: sticky` slot occupies in-flow
 * space *and* covers part of the scrollport, so it counts **twice** — once
 * towards where the list begins, once towards how much of the scrollport the
 * items can use. react-virtuoso needed two separate measured values
 * (`headerHeight` and `fixedHeaderHeight`) for exactly this; TanStack conflated
 * them into `paddingStart` and had to add `scrollPaddingStart` afterwards.
 *
 * Returns `base` untouched when there is nothing to fold in, so a list with no
 * chrome allocates nothing and behaves exactly as it did before slots existed.
 */
export function composeInsets(base: ListInsets, chrome: InsetContributions): ListInsets {
  const header = chrome.header ?? 0
  const stickyHeader = chrome.stickyHeader ?? 0
  const footer = chrome.footer ?? 0
  const stickyFooter = chrome.stickyFooter ?? 0
  const leadingSpace = chrome.leadingSpace ?? 0
  if (header + stickyHeader + footer + stickyFooter + leadingSpace === 0) return base

  return {
    scrollMargin: (base.scrollMargin ?? 0) + leadingSpace + header + stickyHeader,
    scrollPaddingStart: (base.scrollPaddingStart ?? 0) + stickyHeader,
    scrollPaddingEnd: (base.scrollPaddingEnd ?? 0) + stickyFooter,
    spaceAfter: (base.spaceAfter ?? 0) + footer + stickyFooter,
  }
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

  // No `spaceAfter` getter on purpose. This class is the conversion, and
  // `spaceAfter` is deliberately not part of it — the scroller reads the raw
  // inset. A getter here would suggest the class owns a field it excludes from
  // every method it has.

  /**
   * The height genuinely available to items, once overlapping chrome is removed.
   *
   * Alignment maths is all expressed against this rather than the raw scrollport
   * height, so padding never has to be reasoned about twice.
   *
   * Floored at zero. Chrome taller than the scrollport is a real configuration —
   * a sticky composer on a short viewport, a phone in landscape — and a negative
   * height would invert `visibleBand`, which silently stops every visibility
   * event rather than reporting nothing visible. Nothing is visible; say so.
   */
  visibleSize(): number {
    return visibleSizeOf(this.#insets, this.#viewportSize)
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
