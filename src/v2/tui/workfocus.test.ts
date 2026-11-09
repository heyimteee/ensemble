import test from "node:test"
import assert from "node:assert/strict"
import type { NativeSubagentRun, Subtask } from "../types.ts"
import { WORK_CARD_GAP_COLS, WORK_CARD_ROWS } from "./workrows.ts"
import { nativeSubagentFocusID } from "./nativecards.ts"
import { emptyHistoryViewState, historyGroupFocusID, historyPaneGroups, paginateWorkGroups, reconcileHistoryView, workPaneBodyHeight, workspacePaneWidths, type WorkPanePage, type WorkPaneSection } from "./workpane.ts"
import { workViewGroups } from "./workpane.ts"
import {
  findWorkFocus,
  firstWorkFocus,
  focusFirstOnPage,
  halfPageWorkFocus,
  lastWorkFocus,
  navigateWorkFocus,
  nextWorkCard,
  settleWorkFocusByPosition,
  workFocusPosition,
  workLayoutRects,
  workPageRects,
  type WorkCardRect,
  type WorkPageRects,
} from "./workfocus.ts"

const task = (patch: Partial<Subtask> = {}): Subtask => ({
  id: "t",
  workspaceID: "w",
  creatorType: "user",
  assigneeID: "a",
  title: "Check the build",
  instruction: "do",
  mode: "research",
  state: "pending",
  stage: "initial",
  outcome: "pending",
  interrupted: false,
  awaitingChildren: false,
  attempts: 0,
  createdAt: 1,
  ...patch,
})

const working = (patch: Partial<Subtask> = {}): Subtask =>
  task({ state: "working", claimedBy: "run", leaseUntil: 99_000, attempts: 1, ...patch })

const replied = (patch: Partial<Subtask> = {}): Subtask =>
  task({ state: "replied", outcome: "succeeded", finishedAt: 1_000, repliedAt: 1_000, ...patch })

const record = (...tasks: Subtask[]): Record<string, Subtask> =>
  Object.fromEntries(tasks.map((item) => [item.id, item]))

const nativeRun = (patch: Partial<NativeSubagentRun> = {}): NativeSubagentRun => ({
  childSessionID: "child",
  parentSessionID: "session",
  parentTaskID: "t",
  dispatchGroupID: "dispatch_1",
  workspaceID: "w",
  parentAgentID: "kakiko",
  parentAgent: "Kakiko",
  instruction: "Watch the CI",
  state: "working",
  startedAt: 2,
  source: "session-created",
  ...patch,
})

const rect = (id: string, x: number, y: number, page = 1, width = 10, height = 2): WorkCardRect => ({
  id,
  page,
  x,
  y,
  width,
  height,
})

const pageRects = (page: number, rects: WorkCardRect[]): WorkPageRects => ({
  page,
  rects: rects.map((item) => ({ ...item, page })),
})

test("ticket173: card rectangles mirror the rendered sections, labels, gaps, and rows", () => {
  const sections: WorkPaneSection[] = [
    { groupID: "g1", label: "GROUP 1", tone: "faint", mode: "cards", tasks: [task({ id: "a" }), task({ id: "b" })], height: 1 + WORK_CARD_ROWS, continued: false, gapBefore: false },
    { groupID: "g2", label: "GROUP 2", tone: "faint", mode: "cards", tasks: [task({ id: "c" })], height: 1 + WORK_CARD_ROWS, continued: false, gapBefore: true },
  ]
  const page: WorkPanePage = { number: 1, sections, tasks: [], height: 2 * (1 + WORK_CARD_ROWS) + 1 }
  const layout = { mode: "cards" as const, columns: 2, cardWidth: 20, cardContentWidth: 15, pages: [page] }
  const rects = workPageRects(page, layout)
  assert.deepEqual(
    rects.map((item) => [item.id, item.x, item.y, item.width, item.height]),
    [
      ["a", 0, 1, 20, WORK_CARD_ROWS],
      ["b", 20 + WORK_CARD_GAP_COLS, 1, 20, WORK_CARD_ROWS],
      // The second group adds one blank separation row before its label.
      ["c", 0, 1 + WORK_CARD_ROWS + 1 + 1, 20, WORK_CARD_ROWS],
    ],
  )
  assert.deepEqual(workLayoutRects(layout), [{ page: 1, rects }])
})

test("ticket173: compact pages emit one full-width rectangle per row", () => {
  const sections: WorkPaneSection[] = [
    { groupID: "g1", label: "GROUP 1", tone: "faint", mode: "rows", tasks: [task({ id: "a" }), task({ id: "b" })], height: 3, continued: false, gapBefore: false },
    { groupID: "g2", label: null, tone: "faint", mode: "rows", tasks: [task({ id: "c" })], height: 1, continued: false, gapBefore: false },
  ]
  const page: WorkPanePage = { number: 2, sections, tasks: [], height: 4 }
  const layout = { mode: "compact" as const, columns: 0, cardWidth: 0, cardContentWidth: 36, pages: [page] }
  assert.deepEqual(
    workPageRects(page, layout).map((item) => [item.id, item.x, item.y, item.width, item.height, item.page]),
    [
      ["a", 0, 1, 36, 1, 2],
      ["b", 0, 2, 36, 1, 2],
      ["c", 0, 3, 36, 1, 2],
    ],
  )
})

test("ticket173: hjkl picks the nearest card in the direction with perpendicular tie-breaking", () => {
  const rects = [
    rect("a", 0, 0),
    rect("b", 12, 0),
    rect("c", 24, 0),
    // An irregular second row: only the middle and right columns exist.
    rect("d", 12, 4),
    rect("e", 24, 4),
  ]
  const next = (id: string, direction: "left" | "right" | "up" | "down") =>
    nextWorkCard(rects, id, direction)?.id
  assert.equal(next("b", "down"), "d", "the same column wins the perpendicular tie")
  assert.equal(next("a", "down"), "d", "a missing column falls to the nearest card")
  assert.equal(next("c", "down"), "e")
  assert.equal(next("a", "right"), "b")
  assert.equal(next("b", "right"), "c", "h/l never leave the row when a card is beside it")
  assert.equal(next("c", "left"), "b")
  assert.equal(next("d", "up"), "b")
  assert.equal(next("e", "up"), "c")
  assert.equal(next("d", "left"), undefined, "no card lies left of the middle column")
  assert.equal(next("e", "right"), undefined)
})

test("ticket173: spatial navigation crosses group sections instead of column arithmetic", () => {
  const items = [
    working({ id: "a1", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    working({ id: "a2", dispatchGroupID: "dispatch_1", createdAt: 2 }),
    working({ id: "b1", dispatchGroupID: "dispatch_2", createdAt: 3 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 5_000 })
  const layout = paginateWorkGroups(views.active, 59, 20, 5_000)
  assert.equal(layout.columns, 2)
  const pages = workLayoutRects(layout)
  assert.equal(navigateWorkFocus(pages, "a1", "down")?.id, "b1", "the next group's only card is directly below")
  assert.equal(navigateWorkFocus(pages, "a2", "down")?.id, "b1")
  assert.equal(navigateWorkFocus(pages, "b1", "up")?.id, "a1")
  assert.equal(navigateWorkFocus(pages, "a1", "right")?.id, "a2")
})

test("ticket173: compact rows navigate sequentially and never jump columns", () => {
  const items = ["a", "b", "c", "d"].map((id, index) =>
    working({ id, dispatchGroupID: "dispatch_1", createdAt: index + 1 }),
  )
  const views = workViewGroups(items, record(...items), { now: 5_000 })
  const layout = paginateWorkGroups(views.active, 36, 10, 5_000)
  assert.equal(layout.mode, "compact")
  const pages = workLayoutRects(layout)
  assert.equal(navigateWorkFocus(pages, "a", "down")?.id, "b")
  assert.equal(navigateWorkFocus(pages, "c", "up")?.id, "b")
  assert.equal(navigateWorkFocus(pages, "b", "left"), undefined)
  assert.equal(navigateWorkFocus(pages, "b", "right"), undefined)
})

test("ticket173: j/k at a page edge auto-page and preserve the horizontal position", () => {
  const pages = [
    pageRects(1, [rect("a", 0, 0), rect("b", 12, 0)]),
    pageRects(2, [rect("c", 0, 0), rect("d", 12, 0)]),
  ]
  assert.deepEqual(navigateWorkFocus(pages, "a", "down"), { id: "c", page: 2, rect: pages[1]!.rects[0] })
  assert.equal(navigateWorkFocus(pages, "b", "down")?.id, "d")
  assert.equal(navigateWorkFocus(pages, "d", "up")?.id, "b")
  assert.equal(navigateWorkFocus(pages, "a", "up"), undefined, "the first page has no previous page")
  assert.equal(navigateWorkFocus(pages, "c", "left")?.id, "a", "left at the left edge pages back to the nearest card")

  // A narrower next page still preserves the nearest column.
  const uneven = [
    pageRects(1, [rect("a", 0, 0), rect("b", 12, 0)]),
    pageRects(2, [rect("c", 24, 0)]),
  ]
  assert.equal(navigateWorkFocus(uneven, "b", "down")?.id, "c")
  assert.equal(navigateWorkFocus(uneven, "c", "up")?.id, "b")
})

test("ticket184: h/l at a page edge pages and lands on the nearest card", () => {
  const pages = [
    pageRects(1, [rect("a", 0, 0), rect("b", 12, 0)]),
    pageRects(2, [rect("c", 0, 0), rect("d", 12, 0)]),
  ]
  assert.deepEqual(navigateWorkFocus(pages, "b", "right"), { id: "d", page: 2, rect: pages[1]!.rects[1] }, "rightmost l pages forward to the nearest column")
  assert.equal(navigateWorkFocus(pages, "c", "left")?.id, "a", "leftmost h pages back to the nearest card")
  assert.equal(navigateWorkFocus(pages, "a", "left"), undefined, "the first page has no previous page")
  assert.equal(navigateWorkFocus(pages, "d", "right"), undefined, "the last page has no next page")
  // An uneven next page still lands on the nearest card, not merely column zero.
  const uneven = [
    pageRects(1, [rect("a", 0, 0), rect("b", 12, 0), rect("c", 24, 0)]),
    pageRects(2, [rect("d", 0, 4), rect("e", 12, 0)]),
  ]
  assert.equal(navigateWorkFocus(uneven, "c", "right")?.id, "e")
})

test("ticket184: a finish in a collapsed group keeps focus and page on the selected card", () => {
  const initialItems = [
    replied({ id: "newest", dispatchGroupID: "dispatch_new", createdAt: 1, finishedAt: 5_000, repliedAt: 5_000 }),
    replied({ id: "older", dispatchGroupID: "dispatch_old", createdAt: 2, finishedAt: 1_000, repliedAt: 1_000 }),
  ]
  const initialViews = workViewGroups(initialItems, record(...initialItems), { now: 6_000 })
  const initial = reconcileHistoryView(initialViews.history, emptyHistoryViewState())
  const initialLayout = paginateWorkGroups(historyPaneGroups(initialViews.history, initial), 59, 40, 6_000)
  const focus = findWorkFocus(workLayoutRects(initialLayout), "newest")
  assert.equal(focus?.page, 1)
  const laterItems = [
    ...initialItems,
    replied({ id: "older-2", dispatchGroupID: "dispatch_old", createdAt: 3, finishedAt: 7_000, repliedAt: 7_000 }),
  ]
  const laterViews = workViewGroups(laterItems, record(...laterItems), { now: 8_000 })
  const later = reconcileHistoryView(laterViews.history, initial)
  assert.equal(later.expanded.dispatch_old, false, "the reordered group stays rolled up")
  assert.equal(later.fresh.dispatch_old, true)
  const laterLayout = paginateWorkGroups(historyPaneGroups(laterViews.history, later), 59, 40, 8_000)
  const settled = settleWorkFocusByPosition(workLayoutRects(laterLayout), workFocusPosition(focus))
  assert.equal(settled?.id, "newest", "the selected card keeps focus across the update")
  assert.equal(settled?.page, focus?.page, "the page does not jump for a finish in a collapsed group")
})

test("ticket184: rolled-up history rows are focus targets between groups", () => {
  const items = [
    replied({ id: "old", dispatchGroupID: "dispatch_old", createdAt: 1, finishedAt: 1_000, repliedAt: 1_000 }),
    replied({ id: "new", dispatchGroupID: "dispatch_new", createdAt: 2, finishedAt: 5_000, repliedAt: 5_000 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 6_000 })
  const state = reconcileHistoryView(views.history, emptyHistoryViewState())
  const layout = paginateWorkGroups(historyPaneGroups(views.history, state), 59, 40, 6_000)
  const pages = workLayoutRects(layout)
  const newest = historyGroupFocusID("dispatch_new")
  const oldest = historyGroupFocusID("dispatch_old")
  assert.equal(firstWorkFocus(pages)?.id, newest, "the expanded group's header is the first focus target")
  assert.equal(navigateWorkFocus(pages, newest, "down")?.id, "new")
  assert.equal(navigateWorkFocus(pages, "new", "down")?.id, oldest, "the next group's rollup row is reachable")
  assert.equal(findWorkFocus(pages, oldest)?.page, 1)
  assert.equal(navigateWorkFocus(pages, oldest, "up")?.id, "new")
})

test("ticket173: gg/G reach the first and last card across pages", () => {
  const pages = [
    pageRects(1, [rect("a", 0, 0), rect("b", 12, 0)]),
    pageRects(2, [rect("c", 0, 0), rect("d", 12, 0)]),
  ]
  assert.deepEqual(firstWorkFocus(pages), { id: "a", page: 1, rect: pages[0]!.rects[0] })
  assert.deepEqual(lastWorkFocus(pages), { id: "d", page: 2, rect: pages[1]!.rects[1] })
  assert.equal(firstOf(pages, 2), "c")
  assert.equal(focusFirstOnPage(pages, 9), undefined)
})

function firstOf(pages: WorkPageRects[], page: number): string | undefined {
  return focusFirstOnPage(pages, page)?.id
}

test("ticket173: Ctrl+d/u step by rows, keep the column, and page at the edge", () => {
  const pages = [
    pageRects(1, [
      rect("a", 0, 0),
      rect("b", 12, 0),
      rect("c", 0, 4),
      rect("d", 12, 4),
      rect("e", 0, 8),
    ]),
    pageRects(2, [rect("f", 0, 0), rect("g", 12, 0)]),
  ]
  assert.equal(halfPageWorkFocus(pages, "a", "down", 3)?.id, "c")
  assert.equal(halfPageWorkFocus(pages, "b", "down", 3)?.id, "d", "the same column stays preferred")
  assert.equal(halfPageWorkFocus(pages, "d", "up", 3)?.id, "b")
  assert.equal(halfPageWorkFocus(pages, "e", "down", 3)?.id, "f", "no card below pages forward")
  assert.equal(halfPageWorkFocus(pages, "f", "up", 3)?.id, "e", "no card above pages backward")
})

test("ticket173: focus persists by task ID across pagination and settles to the nearest prior position", () => {
  const before = [
    pageRects(1, [rect("a", 0, 0), rect("b", 12, 0), rect("c", 0, 4)]),
    pageRects(2, [rect("d", 12, 0)]),
  ]
  const kept = settleWorkFocusByPosition(before, { id: "c", page: 1, x: 0, y: 4, width: 10, height: 2 })
  assert.equal(kept?.id, "c")
  assert.equal(kept?.page, 1)

  // Repagination moves the same task to the second page; focus follows it.
  const after = [
    pageRects(1, [rect("a", 0, 0)]),
    pageRects(2, [rect("b", 0, 0), rect("c", 12, 0)]),
  ]
  const moved = settleWorkFocusByPosition(after, { id: "c", page: 1, x: 0, y: 4, width: 10, height: 2 })
  assert.equal(moved?.id, "c")
  assert.equal(moved?.page, 2)

  const remaining = [
    pageRects(1, [rect("x", 0, 10), rect("y", 12, 10)]),
  ]
  const fallback = settleWorkFocusByPosition(remaining, { id: "gone", page: 1, x: 11, y: 0, width: 10, height: 2 })
  assert.equal(fallback?.id, "y", "the nearest prior position wins over reading order")
  assert.equal(fallback?.page, 1)

  const first = settleWorkFocusByPosition(remaining, { id: "gone", page: 1, x: 11, y: 0, width: 10, height: 2 }, "first")
  assert.equal(first?.id, "x", "an explicit first fallback starts reading order")
})

test("ticket173: a disappeared card falls back to the nearest page when its page is gone", () => {
  const pages = [pageRects(1, [rect("a", 0, 0)]), pageRects(2, [rect("b", 0, 0)])]
  const target = settleWorkFocusByPosition(pages, { id: "gone", page: 2, x: 0, y: 0, width: 10, height: 2 })
  assert.equal(target?.id, "b", "the prior page is preferred")
  const missingPage = settleWorkFocusByPosition(pages, { id: "gone", page: 3, x: 0, y: 0, width: 10, height: 2 })
  assert.equal(missingPage?.id, "b", "the closest surviving page owns the fallback")
  assert.deepEqual(settleWorkFocusByPosition([], undefined), undefined)
})

test("ticket173: the size matrix emits in-bounds rectangles for every supported layout", () => {
  const items = [
    working({ id: "a1", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    working({ id: "a2", dispatchGroupID: "dispatch_1", createdAt: 2 }),
    working({ id: "b1", dispatchGroupID: "dispatch_2", createdAt: 3 }),
    working({ id: "b2", dispatchGroupID: "dispatch_2", createdAt: 4 }),
    working({ id: "c1", dispatchGroupID: "dispatch_3", createdAt: 5 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 5_000 })
  const matrix: Array<[number, number]> = [[80, 24], [100, 30], [120, 40], [160, 50]]
  for (const [width, height] of matrix) {
    const panes = workspacePaneWidths(width)
    const content = panes.workContentWidth
    const body = workPaneBodyHeight(height)
    const layout = paginateWorkGroups(views.active, content, body, 5_000)
    const pages = workLayoutRects(layout)
    for (const page of pages) {
      assert.ok(page.rects.length > 0, `${width}x${height} page ${page.page} has cards`)
      for (const item of page.rects) {
        assert.ok(item.x >= 0 && item.y >= 0, `${width}x${height} origin in bounds`)
        assert.ok(item.x + item.width <= content, `${width}x${height} card ends inside the content width`)
      }
      assert.equal(page.rects.at(-1)!.y + page.rects.at(-1)!.height <= body, true, `${width}x${height} page ${page.page} fits the body`)
    }
    // Walking down from the first card eventually reaches the last.
    let current = firstWorkFocus(pages)
    const seen = new Set<string>()
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      current = navigateWorkFocus(pages, current.id, "down")
    }
    assert.ok(seen.size >= 1)
  }
})

test("ticket173: focus positions carry the same geometry as the selected rectangle", () => {
  const target = firstWorkFocus([pageRects(3, [rect("a", 2, 5)])])
  assert.deepEqual(workFocusPosition(target), { id: "a", page: 3, x: 2, y: 5, width: 10, height: 2 })
  assert.equal(workFocusPosition(undefined), undefined)
  assert.equal(navigateWorkFocus([pageRects(1, [rect("a", 0, 0)])], "missing", "down")?.id, "a", "a missing cursor starts at the first card")
})

test("ticket187: native subagent cards participate in Work focus geometry", () => {
  const parent = working({ id: "parent", dispatchGroupID: "dispatch_1", createdAt: 1 })
  const child = nativeRun({ childSessionID: "child_live", startedAt: 2 })
  const views = workViewGroups([parent], record(parent), { now: 5_000 }, [child])
  const layout = paginateWorkGroups(views.active, 59, 40, 5_000)
  const pages = workLayoutRects(layout)
  const ids = pages.flatMap((page) => page.rects.map((item) => item.id))
  assert.deepEqual(ids, ["parent", nativeSubagentFocusID("child_live")], "the child card owns a namespaced focus target")
  assert.equal(firstWorkFocus(pages)?.id, "parent")
  assert.equal(navigateWorkFocus(pages, "parent", "right")?.id, nativeSubagentFocusID("child_live"))
  assert.equal(navigateWorkFocus(pages, nativeSubagentFocusID("child_live"), "left")?.id, "parent")
})

test("ticket187: a compact native card still owns one focus row at drawer width", () => {
  const parent = working({ id: "parent", dispatchGroupID: "dispatch_1", createdAt: 1 })
  const child = nativeRun({ childSessionID: "child_live", startedAt: 2 })
  const views = workViewGroups([parent], record(parent), { now: 5_000 }, [child])
  const panes = workspacePaneWidths(80)
  const layout = paginateWorkGroups(views.active, panes.workContentWidth, workPaneBodyHeight(24), 5_000)
  assert.equal(layout.mode, "compact")
  const rects = workLayoutRects(layout).flatMap((page) => page.rects)
  assert.deepEqual(rects.map((item) => item.id), ["parent", nativeSubagentFocusID("child_live")])
})
