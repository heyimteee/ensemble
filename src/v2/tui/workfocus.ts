import { WORK_CARD_ROWS } from "./workrows.ts"
import { historyGroupFocusID, type WorkPaneItem, type WorkPaneLayout, type WorkPanePage } from "./workpane.ts"
import { nativeSubagentFocusID } from "./nativecards.ts"

/**
 * Ticket #173: spatial Work-card focus.
 *
 * The rendered layout, not a fixed column count, owns the geometry. Every card
 * on a page emits one rectangle; `hjkl` picks the nearest rectangle in that
 * direction with perpendicular tie-breaking. A page boundary is a navigation
 * edge for `j/k` (auto-page) but not for `h/l`. Focus is stored by task id and
 * reconciled against these rectangles after every update, so streaming,
 * filter switches, and repagination never move the cursor by accident.
 */

export type WorkCardRect = {
  id: string
  page: number
  /** Left column inside the Work content width. */
  x: number
  /** Top row inside the page body. */
  y: number
  width: number
  height: number
}

export type WorkPageRects = { page: number; rects: WorkCardRect[] }

export type WorkDirection = "left" | "right" | "up" | "down"

export type WorkFocusTarget = { id: string; page: number; rect: WorkCardRect }

/** A remembered rectangle, independent of whether the task still exists. */
export type WorkFocusPosition = {
  id?: string
  page: number
  x: number
  y: number
  width: number
  height: number
}

type WorkPageGeometry = Pick<WorkPaneLayout, "mode" | "cardWidth" | "cardContentWidth">

/**
 * Lay one paginated page into rectangles. The walk mirrors the renderer:
 * `gapBefore` is one blank row, a label is one row, a card section is one
 * `WORK_CARD_ROWS` row of cards, and compact sections are one row per task.
 */
export function workPageRects(page: WorkPanePage, layout: WorkPageGeometry): WorkCardRect[] {
  const rects: WorkCardRect[] = []
  let y = 0
  for (const section of page.sections) {
    if (section.gapBefore) y += 1
    if (section.mode === "rollup") {
      rects.push({
        id: historyGroupFocusID(section.groupID),
        page: page.number,
        x: 0,
        y,
        width: Math.max(1, layout.cardContentWidth),
        height: 1,
      })
      y += 1
      continue
    }
    if (section.label !== null) y += 1
    const items: WorkPaneItem[] = section.items
      ?? section.tasks.map((task): WorkPaneItem => ({ kind: "task", task }))
    if (section.mode === "cards") {
      // Ticket #239: every card section is one full-width card, so its
      // rectangle starts at the content's left edge and spans its width.
      const item = items[0]
      if (item) {
        rects.push({
          id: workItemFocusID(item),
          page: page.number,
          x: 0,
          y,
          width: Math.max(1, layout.cardWidth),
          height: WORK_CARD_ROWS,
        })
      }
      y += WORK_CARD_ROWS
      continue
    }
    for (const item of items) {
      rects.push({
        id: workItemFocusID(item),
        page: page.number,
        x: 0,
        y,
        width: Math.max(1, layout.cardContentWidth),
        height: 1,
      })
      y += 1
    }
  }
  return rects
}

/** One focus id per renderable Work item; native child sessions stay namespaced. */
function workItemFocusID(item: WorkPaneItem): string {
  return item.kind === "task" ? item.task.id : nativeSubagentFocusID(item.run.childSessionID)
}

/** Every page's rectangles in page order. */
export function workLayoutRects(layout: Pick<WorkPaneLayout, "mode" | "cardWidth" | "cardContentWidth" | "pages">): WorkPageRects[] {
  return layout.pages.map((page) => ({ page: page.number, rects: workPageRects(page, layout) }))
}

/** Doubled center so comparisons stay integer and tie-free. */
function centers(rect: Pick<WorkCardRect, "x" | "y" | "width" | "height">): { x: number; y: number } {
  return { x: rect.x * 2 + rect.width, y: rect.y * 2 + rect.height }
}

function readingOrder(left: WorkCardRect, right: WorkCardRect): number {
  return left.y - right.y || left.x - right.x || left.id.localeCompare(right.id)
}

function readingOrderRects(rects: readonly WorkCardRect[]): WorkCardRect[] {
  return [...rects].sort(readingOrder)
}

function targetOf(rect: WorkCardRect, page: number = rect.page): WorkFocusTarget {
  return { id: rect.id, page, rect }
}

/** True when two rectangles share a visual row band. */
function sameRow(left: Pick<WorkCardRect, "y" | "height">, right: Pick<WorkCardRect, "y" | "height">): boolean {
  return left.y < right.y + right.height && right.y < left.y + left.height
}

/**
 * The nearest card in `direction` from the focused card. A missing focus
 * starts at the first card in reading order. Perpendicular distance breaks a
 * equal-primary tie, then reading order makes the result deterministic.
 */
export function nextWorkCard(
  rects: readonly WorkCardRect[],
  focusedID: string | undefined,
  direction: WorkDirection,
): WorkCardRect | undefined {
  if (rects.length === 0) return undefined
  const current = focusedID === undefined ? undefined : rects.find((rect) => rect.id === focusedID)
  if (!current) return readingOrderRects(rects)[0]
  const origin = centers(current)
  let best: WorkCardRect | undefined
  let bestPrimary = Number.POSITIVE_INFINITY
  let bestPerpendicular = Number.POSITIVE_INFINITY
  for (const candidate of rects) {
    if (candidate.id === current.id) continue
    const point = centers(candidate)
    const dx = point.x - origin.x
    const dy = point.y - origin.y
    let primary: number
    let perpendicular: number
    if (direction === "left") {
      if (dx >= 0 || !sameRow(candidate, current)) continue
      primary = -dx
      perpendicular = Math.abs(dy)
    } else if (direction === "right") {
      if (dx <= 0 || !sameRow(candidate, current)) continue
      primary = dx
      perpendicular = Math.abs(dy)
    } else if (direction === "up") {
      if (dy >= 0) continue
      primary = -dy
      perpendicular = Math.abs(dx)
    } else {
      if (dy <= 0) continue
      primary = dy
      perpendicular = Math.abs(dx)
    }
    const better =
      primary < bestPrimary ||
      (primary === bestPrimary &&
        (perpendicular < bestPerpendicular ||
          (perpendicular === bestPerpendicular && (best === undefined || readingOrder(candidate, best) < 0))))
    if (better) {
      best = candidate
      bestPrimary = primary
      bestPerpendicular = perpendicular
    }
  }
  return best
}

export function findWorkFocus(pages: readonly WorkPageRects[], id: string | undefined): WorkFocusTarget | undefined {
  if (id === undefined) return undefined
  for (const page of pages) {
    const rect = page.rects.find((candidate) => candidate.id === id)
    if (rect) return targetOf(rect, page.page)
  }
  return undefined
}

export function firstWorkFocus(pages: readonly WorkPageRects[]): WorkFocusTarget | undefined {
  for (const page of [...pages].sort((left, right) => left.page - right.page)) {
    const rect = readingOrderRects(page.rects)[0]
    if (rect) return targetOf(rect, page.page)
  }
  return undefined
}

export function lastWorkFocus(pages: readonly WorkPageRects[]): WorkFocusTarget | undefined {
  for (const page of [...pages].sort((left, right) => right.page - left.page)) {
    const rect = readingOrderRects(page.rects).at(-1)
    if (rect) return targetOf(rect, page.page)
  }
  return undefined
}

export function focusFirstOnPage(pages: readonly WorkPageRects[], pageNumber: number): WorkFocusTarget | undefined {
  const page = pages.find((candidate) => candidate.page === pageNumber)
  const rect = page ? readingOrderRects(page.rects)[0] : undefined
  return page && rect ? targetOf(rect, page.page) : undefined
}

function nearestToPosition(rects: readonly WorkCardRect[], position: WorkFocusPosition): WorkCardRect | undefined {
  const origin = centers(position)
  let best: WorkCardRect | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of rects) {
    const point = centers(candidate)
    const dx = point.x - origin.x
    const dy = point.y - origin.y
    const distance = dx * dx + dy * dy
    if (
      distance < bestDistance ||
      (distance === bestDistance && (best === undefined || readingOrder(candidate, best) < 0))
    ) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/**
 * Reconcile focus after a layout, page, or filter change.
 *
 * - A still-visible task keeps focus and moves to its current page.
 * - An explicit `first` fallback starts at the first card.
 * - A disappeared card falls back to the nearest card by its prior rectangle,
 *   preferring the same page and then the closest surviving page.
 */
export function settleWorkFocusByPosition(
  pages: readonly WorkPageRects[],
  previous: WorkFocusPosition | undefined,
  fallback: "first" | "nearest" = "nearest",
): WorkFocusTarget | undefined {
  if (pages.every((page) => page.rects.length === 0)) return undefined
  const kept = findWorkFocus(pages, previous?.id)
  if (kept) return kept
  if (fallback === "first" || previous === undefined) return firstWorkFocus(pages)
  const samePage = pages.find((page) => page.page === previous.page)
  if (samePage && samePage.rects.length > 0) {
    const nearest = nearestToPosition(samePage.rects, previous)
    if (nearest) return targetOf(nearest, samePage.page)
  }
  const nearestPage = [...pages]
    .filter((page) => page.rects.length > 0)
    .sort((left, right) => Math.abs(left.page - previous.page) - Math.abs(right.page - previous.page) || left.page - right.page)[0]
  if (!nearestPage) return undefined
  const rect = nearestToPosition(nearestPage.rects, { ...previous, page: nearestPage.page })
  return rect ? targetOf(rect, nearestPage.page) : undefined
}

/** The first card on a page, retaining the nearest column to `origin`. */
function nearestAtEdge(page: WorkPageRects, origin: WorkCardRect, direction: "up" | "down"): WorkFocusTarget | undefined {
  const point = centers(origin)
  let best: WorkCardRect | undefined
  let bestPerpendicular = Number.POSITIVE_INFINITY
  let bestEdge = Number.POSITIVE_INFINITY
  for (const candidate of page.rects) {
    const current = centers(candidate)
    const perpendicular = Math.abs(current.x - point.x)
    // Down prefers the top row; up prefers the bottom row.
    const edge = direction === "down" ? candidate.y : -candidate.y
    if (
      perpendicular < bestPerpendicular ||
      (perpendicular === bestPerpendicular &&
        (edge < bestEdge ||
          (edge === bestEdge && (best === undefined || readingOrder(candidate, best) < 0))))
    ) {
      best = candidate
      bestPerpendicular = perpendicular
      bestEdge = edge
    }
  }
  return best ? targetOf(best, page.page) : undefined
}

/**
 * `hjkl` movement. `j/k` cross a page edge to the adjacent page and pick the
 * card closest to the prior column. Ticket #184 also pages with `h/l` at the
 * row's left/right edge, landing on the nearest card on the adjacent page so
 * the pager and focus stay continuous.
 */
export function navigateWorkFocus(
  pages: readonly WorkPageRects[],
  focusedID: string | undefined,
  direction: WorkDirection,
): WorkFocusTarget | undefined {
  const current = findWorkFocus(pages, focusedID)
  if (!current) return firstWorkFocus(pages)
  const page = pages.find((candidate) => candidate.page === current.page)
  const within = page ? nextWorkCard(page.rects, focusedID, direction) : undefined
  if (within) return targetOf(within, current.page)
  const step = direction === "down" || direction === "right" ? 1 : -1
  const adjacent = pages.find((candidate) => candidate.page === current.page + step)
  if (!adjacent || adjacent.rects.length === 0) return undefined
  if (direction === "left" || direction === "right") {
    const rect = nearestToPosition(adjacent.rects, current.rect)
    return rect ? targetOf(rect, adjacent.page) : undefined
  }
  return nearestAtEdge(adjacent, current.rect, direction)
}

/**
 * `Ctrl+d/u`: move toward a half-page row target, keeping the column. When
 * no card remains in that direction, the adjacent page owns the target.
 */
export function halfPageWorkFocus(
  pages: readonly WorkPageRects[],
  focusedID: string | undefined,
  direction: "up" | "down",
  rows: number,
): WorkFocusTarget | undefined {
  const current = findWorkFocus(pages, focusedID)
  if (!current) return firstWorkFocus(pages)
  const page = pages.find((candidate) => candidate.page === current.page)
  const step = Math.max(1, Math.floor(rows))
  const point = centers(current.rect)
  const targetY = point.y + (direction === "down" ? step * 2 : -step * 2)
  let best: WorkCardRect | undefined
  let bestDelta = Number.POSITIVE_INFINITY
  let bestPerpendicular = Number.POSITIVE_INFINITY
  for (const candidate of page?.rects ?? []) {
    if (candidate.id === current.id) continue
    const currentPoint = centers(candidate)
    const delta = direction === "down" ? currentPoint.y - point.y : point.y - currentPoint.y
    if (delta <= 0) continue
    const distance = Math.abs(currentPoint.y - targetY)
    const perpendicular = Math.abs(currentPoint.x - point.x)
    if (
      distance < bestDelta ||
      (distance === bestDelta &&
        (perpendicular < bestPerpendicular ||
          (perpendicular === bestPerpendicular && (best === undefined || readingOrder(candidate, best) < 0))))
    ) {
      best = candidate
      bestDelta = distance
      bestPerpendicular = perpendicular
    }
  }
  if (best) return targetOf(best, current.page)
  const adjacent = pages.find(
    (candidate) => candidate.page === current.page + (direction === "down" ? 1 : -1),
  )
  if (!adjacent || adjacent.rects.length === 0) return undefined
  return nearestAtEdge(adjacent, current.rect, direction)
}

/** The rectangle an app stores as the prior focus position. */
export function workFocusPosition(target: WorkFocusTarget | undefined): WorkFocusPosition | undefined {
  if (!target) return undefined
  return {
    id: target.id,
    page: target.page,
    x: target.rect.x,
    y: target.rect.y,
    width: target.rect.width,
    height: target.rect.height,
  }
}
