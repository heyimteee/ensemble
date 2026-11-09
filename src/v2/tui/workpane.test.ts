import test from "node:test"
import assert from "node:assert/strict"
import type { Subtask } from "../types.ts"
import { WORK_CARD_GAP_COLS, WORK_CARD_HORIZONTAL_CHROME, WORK_CARD_MIN_WIDTH, WORK_CARD_ROWS } from "./workrows.ts"
import {
  paginateWorkGroups,
  settleWorkFocus,
  workPaneBodyHeight,
  workPaneColumns,
  workPaneHeader,
  workTaskPage,
  workViewGroups,
  workspacePaneWidths,
} from "./workpane.ts"

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

/**
 * Ticket #172: the shell has one pane-width source of truth. The chat, the
 * Work pane, and hit-testing all consume this function, so the breakpoints
 * and the exact right edge cannot drift.
 */
test("ticket172: pane widths switch at 118 and 96 terminal columns", () => {
  assert.equal(workspacePaneWidths(95).mode, "drawer")
  assert.equal(workspacePaneWidths(96).mode, "compact")
  assert.equal(workspacePaneWidths(117).mode, "compact")
  assert.equal(workspacePaneWidths(118).mode, "three")
  assert.equal(workspacePaneWidths(160).mode, "three")
})

test("ticket172: three-pane widths tile the view exactly and keep a usable chat", () => {
  for (const terminalWidth of [96, 100, 117, 118, 120, 140, 160, 200]) {
    const panes = workspacePaneWidths(terminalWidth)
    assert.equal(
      panes.railWidth + panes.chatWidth + panes.workWidth + panes.gap * 2,
      panes.viewWidth,
      `${terminalWidth} columns fill the view exactly`,
    )
    assert.ok(panes.chatWidth >= 30, `${terminalWidth} keeps a usable chat column`)
    assert.ok(panes.chatOnlyContentWidth >= panes.chatContentWidth, "a narrower three-pane row never widens a DM")
    assert.equal(panes.railWidth, Math.max(26, Math.min(34, Math.floor(panes.viewWidth * 0.26))))
  }
})

test("ticket172: the drawer overlays the chat and leaves its right edge exact", () => {
  const panes = workspacePaneWidths(80)
  assert.equal(panes.mode, "drawer")
  assert.equal(panes.railWidth + panes.chatWidth + panes.gap, panes.viewWidth)
  assert.ok(panes.workWidth >= 30 && panes.workWidth <= 48)
  assert.ok(panes.workWidth < panes.chatWidth, "the drawer never claims the whole chat")
})

test("ticket172: work content width adapts from compact rows to three card columns", () => {
  assert.equal(workPaneColumns(workspacePaneWidths(120).workContentWidth), 1)
  assert.equal(workPaneColumns(workspacePaneWidths(140).workContentWidth), 2)
  assert.equal(workPaneColumns(workspacePaneWidths(200).workContentWidth), 3)
  for (const terminalWidth of [80, 96, 100, 120, 140, 160, 200]) {
    const panes = workspacePaneWidths(terminalWidth)
    assert.equal(panes.workContentWidth, panes.workWidth - panes.workChrome)
    assert.ok(panes.workContentWidth >= WORK_CARD_MIN_WIDTH - WORK_CARD_HORIZONTAL_CHROME, "the pane keeps a legible card width")
  }
})

test("ticket172: the card grid keeps an exact right edge at every pane width", () => {
  for (const terminalWidth of [96, 100, 117, 118, 120, 140, 160, 200]) {
    const panes = workspacePaneWidths(terminalWidth)
    const columns = workPaneColumns(panes.workContentWidth)
    const cardWidths = columns > 1
      ? Math.floor((panes.workContentWidth - WORK_CARD_GAP_COLS * (columns - 1)) / columns)
      : panes.workContentWidth
    const used = cardWidths * columns + WORK_CARD_GAP_COLS * Math.max(0, columns - 1)
    assert.ok(used <= panes.workContentWidth, `${terminalWidth}: the grid never exceeds the pane`)
    assert.ok(panes.workContentWidth - used < (columns > 1 ? WORK_CARD_GAP_COLS + columns : 1), `${terminalWidth}: the grid ends at the right edge`)
  }
})

test("ticket183: the one width memo consumes both durable side switches", () => {
  const full = workspacePaneWidths(160)
  assert.equal(full.railWidth + full.chatWidth + full.workWidth + full.gap * 2, full.viewWidth, "default tiles three panes")

  const leftHidden = workspacePaneWidths(160, { left: false })
  assert.equal(leftHidden.railWidth, 0, "a hidden left column claims no width")
  assert.equal(leftHidden.chatWidth + leftHidden.workWidth + leftHidden.gap, leftHidden.viewWidth, "chat and Work tile the reclaimed row")
  assert.equal(leftHidden.workWidth, full.workWidth, "the right pane keeps its readable share")
  assert.ok(leftHidden.chatContentWidth > full.chatContentWidth, "chat expands into reclaimed rail width")

  const rightHidden = workspacePaneWidths(160, { right: false })
  assert.equal(rightHidden.railWidth, full.railWidth)
  assert.equal(rightHidden.railWidth + rightHidden.chatWidth + rightHidden.gap, rightHidden.viewWidth, "chat reclaims the whole right column")
  assert.equal(rightHidden.chatContentWidth, rightHidden.chatOnlyContentWidth, "no unused three-pane transcript width remains")
  assert.ok(rightHidden.chatContentWidth > full.chatContentWidth, "chat expands into reclaimed Work width")

  const bothHidden = workspacePaneWidths(160, { left: false, right: false })
  assert.equal(bothHidden.railWidth, 0)
  assert.equal(bothHidden.chatWidth, bothHidden.viewWidth, "chat owns the whole row")
  assert.equal(bothHidden.chatContentWidth, bothHidden.chatOnlyContentWidth)
})

test("ticket183: the narrow drawer uses the same right switch without shrinking chat", () => {
  const open = workspacePaneWidths(80)
  const closed = workspacePaneWidths(80, { right: false })
  const leftHidden = workspacePaneWidths(80, { left: false })
  assert.equal(closed.mode, "drawer")
  assert.equal(closed.chatWidth, open.chatWidth, "the drawer overlays chat; closing it never changes the chat column")
  assert.equal(closed.chatContentWidth, open.chatContentWidth)
  assert.equal(leftHidden.railWidth, 0)
  assert.equal(leftHidden.chatWidth, leftHidden.viewWidth, "closing the left column widens the drawer-mode chat")
})

test("ticket172: the size matrix reserves a non-empty Work body", () => {
  const matrix: Array<[number, number]> = [[80, 24], [100, 30], [120, 40], [160, 50]]
  for (const [width, height] of matrix) {
    assert.ok(workspacePaneWidths(width).workContentWidth > 0)
    const body = workPaneBodyHeight(height)
    assert.ok(body >= 10, `${width}x${height} has ${body} body rows`)
    assert.ok(body < height, `${width}x${height} leaves shell chrome above the body`)
  }
})

/**
 * Ticket #172: ACTIVE is the default view. It hides every terminal card, even
 * when its dispatch group still has live work. HISTORY is terminal-only and
 * ordered by the group's latest finish time, newest first.
 */
test("ticket172: ACTIVE hides terminal cards inside an otherwise active group", () => {
  const items = [
    working({ id: "live", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    replied({ id: "done", dispatchGroupID: "dispatch_1", createdAt: 2 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 5_000 })
  assert.equal(views.active.length, 1)
  assert.deepEqual(views.active[0]?.tasks.map((item) => item.id), ["live"])
  assert.equal(views.active[0]?.active, 1)
  assert.equal(views.active[0]?.done, 1, "the group still counts its hidden terminal member")
  assert.equal(views.history.length, 0, "a group with live work never appears in HISTORY")
})

test("ticket172: HISTORY holds terminal-only groups and both views never share a group", () => {
  const items = [
    working({ id: "live", dispatchGroupID: "dispatch_live", createdAt: 1 }),
    replied({ id: "done", dispatchGroupID: "dispatch_done", createdAt: 2, finishedAt: 2_000, repliedAt: 2_000 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 9_999_999 })
  assert.deepEqual(views.active.map((group) => group.id), ["dispatch_live"])
  assert.deepEqual(views.history.map((group) => group.id), ["dispatch_done"])
  assert.equal(views.history[0]?.active, 0)
  assert.equal(views.history[0]?.done, 1)
})

test("ticket172: HISTORY orders groups by latest finish descending", () => {
  const items = [
    replied({ id: "old", dispatchGroupID: "dispatch_old", createdAt: 1, finishedAt: 1_000, repliedAt: 1_000 }),
    replied({ id: "new", dispatchGroupID: "dispatch_new", createdAt: 2, finishedAt: 5_000, repliedAt: 5_000 }),
    replied({ id: "mid", dispatchGroupID: "dispatch_mid", createdAt: 3, finishedAt: 3_000, repliedAt: 3_000 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 9_999_999 })
  assert.deepEqual(views.history.map((group) => group.id), ["dispatch_new", "dispatch_mid", "dispatch_old"])
})

test("ticket172: HISTORY keeps tasks chronological inside a group", () => {
  const items = [
    replied({ id: "late", dispatchGroupID: "dispatch_1", createdAt: 30, finishedAt: 4_000, repliedAt: 4_000 }),
    replied({ id: "early", dispatchGroupID: "dispatch_1", createdAt: 10, finishedAt: 5_000, repliedAt: 5_000 }),
    replied({ id: "middle", dispatchGroupID: "dispatch_1", createdAt: 20, finishedAt: 6_000, repliedAt: 6_000 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 9_999_999 })
  assert.deepEqual(views.history[0]?.tasks.map((item) => item.id), ["early", "middle", "late"])
})

test("ticket172: a completed group leaves ACTIVE immediately and stays in HISTORY after the hold", () => {
  const items = [replied({ id: "done", dispatchGroupID: "dispatch_1", finishedAt: 1_000, repliedAt: 1_000 })]
  const atHold = workViewGroups(items, record(...items), { now: 1_500 })
  const afterHold = workViewGroups(items, record(...items), { now: 9_999_999 })
  assert.equal(atHold.active.length, 0)
  assert.deepEqual(atHold.history.map((group) => group.id), ["dispatch_1"])
  assert.deepEqual(afterHold.history.map((group) => group.id), ["dispatch_1"], "the pane retains finished groups")
})

/** Ticket #172: the pane pages by body height, not by the whole terminal. */
test("ticket172: card mode fits whole group rows and pages the next group", () => {
  const items = [
    working({ id: "a1", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    working({ id: "a2", dispatchGroupID: "dispatch_1", createdAt: 2 }),
    working({ id: "b1", dispatchGroupID: "dispatch_2", createdAt: 3 }),
    working({ id: "b2", dispatchGroupID: "dispatch_2", createdAt: 4 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 5_000 })
  const layout = paginateWorkGroups(views.active, 59, WORK_CARD_ROWS + 2, 5_000)
  assert.equal(layout.mode, "cards")
  assert.equal(layout.columns, 2)
  assert.equal(layout.pages.length, 2)
  assert.equal(layout.pages[0]?.sections.length, 1)
  assert.equal(layout.pages[0]?.sections[0]?.groupID, "dispatch_1")
  assert.equal(layout.pages[0]?.sections[0]?.label, "GROUP 1 · 2 active · 0 done")
  assert.equal(layout.pages[0]?.sections[0]?.gapBefore, false)
  assert.equal(layout.pages[1]?.sections[0]?.groupID, "dispatch_2")
  assert.equal(layout.pages[1]?.sections[0]?.label, "GROUP 2 · 2 active · 0 done", "a new page never calls a fresh group continued")
  assert.equal(layout.pages[1]?.sections[0]?.continued, false)
})

test("ticket172: a group split across pages repeats its header with cont.", () => {
  const items = [
    working({ id: "a1", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    working({ id: "a2", dispatchGroupID: "dispatch_1", createdAt: 2 }),
    working({ id: "a3", dispatchGroupID: "dispatch_1", createdAt: 3 }),
    working({ id: "a4", dispatchGroupID: "dispatch_1", createdAt: 4 }),
    working({ id: "a5", dispatchGroupID: "dispatch_1", createdAt: 5 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 5_000 })
  const layout = paginateWorkGroups(views.active, 59, WORK_CARD_ROWS * 2 + 2, 5_000)
  assert.equal(layout.mode, "cards")
  assert.equal(layout.pages.length, 2)
  const continued = layout.pages[1]?.sections[0]
  assert.equal(continued?.groupID, "dispatch_1")
  assert.equal(continued?.continued, true)
  assert.match(continued?.label ?? "", /cont\./)
  assert.match(continued?.label ?? "", /GROUP 1/, "the continued header keeps the group identity")
  assert.deepEqual(layout.pages[1]?.sections[0]?.tasks.map((item) => item.id), ["a5"])
  assert.deepEqual(layout.tasks.map((item) => item.id), ["a1", "a2", "a3", "a4", "a5"], "every task is reachable across pages")
})

test("ticket172: compact pages split a long group and repeat cont.", () => {
  const items = [
    working({ id: "a1", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    working({ id: "a2", dispatchGroupID: "dispatch_1", createdAt: 2 }),
    working({ id: "a3", dispatchGroupID: "dispatch_1", createdAt: 3 }),
    working({ id: "a4", dispatchGroupID: "dispatch_1", createdAt: 4 }),
    working({ id: "a5", dispatchGroupID: "dispatch_1", createdAt: 5 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 5_000 })
  const layout = paginateWorkGroups(views.active, 36, 4, 5_000)
  assert.equal(layout.mode, "compact")
  assert.equal(layout.columns, 0)
  assert.equal(layout.pages.length, 2)
  assert.equal(layout.pages[0]?.sections[0]?.label, "GROUP 1 · 5 active · 0 done")
  assert.deepEqual(layout.pages[0]?.sections.flatMap((section) => section.tasks.map((item) => item.id)), ["a1", "a2", "a3"])
  assert.equal(layout.pages[1]?.sections[0]?.continued, true)
  assert.match(layout.pages[1]?.sections[0]?.label ?? "", /cont\./)
  assert.deepEqual(layout.pages[1]?.sections.flatMap((section) => section.tasks.map((item) => item.id)), ["a4", "a5"])
})

test("ticket172: pages never exceed the body and empty work is one empty page", () => {
  const items = [
    working({ id: "a1", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    working({ id: "b1", dispatchGroupID: "dispatch_2", createdAt: 2 }),
    working({ id: "c1", dispatchGroupID: "dispatch_3", createdAt: 3 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 5_000 })
  for (const bodyHeight of [2, 4, 8, 16, 26]) {
    const layout = paginateWorkGroups(views.active, 40, bodyHeight, 5_000)
    for (const page of layout.pages) {
      assert.ok(page.height <= bodyHeight, `page ${page.number} stays within ${bodyHeight} rows`)
    }
  }
  const empty = paginateWorkGroups([], 40, 10)
  assert.equal(empty.pages.length, 1)
  assert.equal(empty.pages[0]?.sections.length, 0)
  assert.equal(empty.tasks.length, 0)
})

test("ticket172: card pages keep the exact right edge at pane widths", () => {
  const items = [
    working({ id: "a1", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    working({ id: "b1", dispatchGroupID: "dispatch_2", createdAt: 2 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 5_000 })
  for (const terminalWidth of [140, 160, 200]) {
    const panes = workspacePaneWidths(terminalWidth)
    const layout = paginateWorkGroups(views.active, panes.workContentWidth, workPaneBodyHeight(50), 5_000)
    assert.equal(layout.mode, "cards")
    assert.ok(layout.cardWidth > 0)
    const used = layout.cardWidth * layout.columns + WORK_CARD_GAP_COLS * (layout.columns - 1)
    assert.ok(used <= panes.workContentWidth)
    assert.ok(panes.workContentWidth - used < layout.columns + WORK_CARD_GAP_COLS)
    assert.equal(layout.cardContentWidth, layout.cardWidth - WORK_CARD_HORIZONTAL_CHROME)
  }
})

/** Ticket #172: focus follows task identity, then falls back predictably. */
test("ticket172: switching views keeps the focused task when it exists", () => {
  const items = [
    replied({ id: "done-1", dispatchGroupID: "dispatch_1", finishedAt: 2_000 }),
    replied({ id: "done-2", dispatchGroupID: "dispatch_1", finishedAt: 1_000 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 9_999_999 })
  const layout = paginateWorkGroups(views.history, 36, 16, 9_999_999)
  const keep = settleWorkFocus(views.history[0]!.tasks, "done-2", 0, "first")
  assert.equal(keep.id, "done-2")
  assert.equal(keep.index, 1)
  const missing = settleWorkFocus(views.history[0]!.tasks, "active-task", 0, "first")
  assert.equal(missing.id, "done-1", "a missing task falls back to the first card")
  assert.equal(missing.index, 0)
  assert.equal(workTaskPage(layout, "done-1"), 1)
  assert.equal(workTaskPage(layout, "missing"), undefined)
})

test("ticket172: a finished focused card moves to the nearest remaining card", () => {
  const remaining = [task({ id: "a" }), task({ id: "b" }), task({ id: "c" })]
  const nearest = settleWorkFocus(remaining, "gone", 1, "nearest")
  assert.equal(nearest.id, "b", "the same index keeps the spatial neighbourhood")
  const tail = settleWorkFocus(remaining, "gone", 9, "nearest")
  assert.equal(tail.id, "c", "an out-of-range index clamps to the last card")
  const none = settleWorkFocus([], "gone", 2, "nearest")
  assert.equal(none.id, undefined)
  assert.equal(none.index, 0)
})

test("ticket172: the Work header names the view, counts, and page", () => {
  assert.equal(workPaneHeader("active", 2, 3, 1, 1, 2), "WORK ACTIVE │ 2 groups · 3 active · 1 done │ page 1/2")
  assert.equal(workPaneHeader("history", 1, 0, 5, 2, 2), "WORK HISTORY │ 1 group · 0 active · 5 done │ page 2/2")
  assert.equal(workPaneHeader("active", 0, 0, 0, 1, 1), "WORK ACTIVE │ none yet │ page 1/1")
})

/** Ticket #172: the supported size matrix exercises every breakpoint. */
test("ticket172: the 80x24/100x30/120x40/160x50 matrix picks a valid pane and layout", () => {
  const items = [
    working({ id: "a1", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    working({ id: "a2", dispatchGroupID: "dispatch_1", createdAt: 2 }),
    working({ id: "b1", dispatchGroupID: "dispatch_2", createdAt: 3 }),
    working({ id: "b2", dispatchGroupID: "dispatch_2", createdAt: 4 }),
    working({ id: "c1", dispatchGroupID: "dispatch_3", createdAt: 5 }),
    working({ id: "c2", dispatchGroupID: "dispatch_3", createdAt: 6 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 5_000 })
  const matrix: Array<[number, number, "three" | "compact" | "drawer", "cards" | "compact"]> = [
    [80, 24, "drawer", "compact"],
    [100, 30, "compact", "compact"],
    [120, 40, "three", "compact"],
    [160, 50, "three", "cards"],
  ]
  for (const [width, height, paneMode, layoutMode] of matrix) {
    const panes = workspacePaneWidths(width)
    const body = workPaneBodyHeight(height)
    const layout = paginateWorkGroups(views.active, panes.workContentWidth, body, 5_000)
    assert.equal(panes.mode, paneMode, `${width}x${height} pane mode`)
    assert.equal(layout.mode, layoutMode, `${width}x${height} work layout`)
    assert.ok(layout.pages.length >= 1)
    for (const page of layout.pages) {
      assert.ok(page.height <= body, `${width}x${height} page ${page.number} fits ${body} rows`)
    }
    assert.deepEqual(layout.tasks.map((item) => item.id), items.map((item) => item.id), `${width}x${height} keeps every task reachable`)
  }
})
