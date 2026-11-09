import test from "node:test"
import assert from "node:assert/strict"
import type { NativeSubagentRun, Subtask } from "../types.ts"
import { WORK_CARD_GAP_COLS, WORK_CARD_HORIZONTAL_CHROME, WORK_CARD_MIN_WIDTH, WORK_CARD_ROWS } from "./workrows.ts"
import {
  emptyHistoryViewState,
  historyGroupFocusID,
  historyPaneGroups,
  paginateWorkGroups,
  reconcileHistoryView,
  settleWorkFocus,
  toggleHistoryView,
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
 * Ticket #184: ACTIVE and HISTORY partition tasks, not groups. ACTIVE keeps
 * non-terminal cards; HISTORY keeps terminal cards even while their group still
 * has live work. Both views can hold the same group with disjoint cards.
 */
test("ticket184: ACTIVE and HISTORY split a mixed group into disjoint cards", () => {
  const items = [
    working({ id: "live-1", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    replied({ id: "done-1", dispatchGroupID: "dispatch_1", createdAt: 2, finishedAt: 1_000, repliedAt: 1_000 }),
    working({ id: "live-2", dispatchGroupID: "dispatch_1", createdAt: 3 }),
    replied({ id: "done-2", dispatchGroupID: "dispatch_1", createdAt: 4, finishedAt: 2_000, repliedAt: 2_000 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 5_000 })
  assert.deepEqual(views.active.map((group) => group.id), ["dispatch_1"])
  assert.deepEqual(views.active[0]?.tasks.map((item) => item.id), ["live-1", "live-2"])
  assert.equal(views.active[0]?.active, 2)
  assert.equal(views.active[0]?.done, 2, "the active label still counts the group's finished work")
  assert.deepEqual(views.history.map((group) => group.id), ["dispatch_1"])
  assert.deepEqual(views.history[0]?.tasks.map((item) => item.id), ["done-2", "done-1"], "history cards order by finish, newest first")
  assert.equal(views.history[0]?.active, 2, "the history rollup knows the group still has live work")
  assert.equal(views.history[0]?.done, 2)
  const activeIDs = new Set(views.active.flatMap((group) => group.tasks.map((item) => item.id)))
  const historyIDs = new Set(views.history.flatMap((group) => group.tasks.map((item) => item.id)))
  assert.equal([...activeIDs].some((id) => historyIDs.has(id)), false, "the two views never duplicate a card")
})

test("ticket184: HISTORY updates card by card while the group stays active", () => {
  const live = working({ id: "live", dispatchGroupID: "dispatch_1", createdAt: 1 })
  const firstDone = replied({ id: "done-1", dispatchGroupID: "dispatch_1", createdAt: 2, finishedAt: 1_000, repliedAt: 1_000 })
  const secondDone = replied({ id: "done-2", dispatchGroupID: "dispatch_1", createdAt: 3, finishedAt: 2_000, repliedAt: 2_000 })
  const none = workViewGroups([live], record(live), { now: 5_000 })
  const one = workViewGroups([live, firstDone], record(live, firstDone), { now: 5_000 })
  const two = workViewGroups([live, firstDone, secondDone], record(live, firstDone, secondDone), { now: 5_000 })
  assert.equal(none.history.length, 0)
  assert.deepEqual(one.history[0]?.tasks.map((item) => item.id), ["done-1"])
  assert.deepEqual(two.history[0]?.tasks.map((item) => item.id), ["done-2", "done-1"], "each finish appears without waiting for the group")
  assert.deepEqual(two.active[0]?.tasks.map((item) => item.id), ["live"])
})

test("ticket172/ticket184: a group with live work appears in both views", () => {
  const items = [
    working({ id: "live", dispatchGroupID: "dispatch_live", createdAt: 1 }),
    replied({ id: "done", dispatchGroupID: "dispatch_live", createdAt: 2, finishedAt: 2_000, repliedAt: 2_000 }),
    replied({ id: "closed", dispatchGroupID: "dispatch_closed", createdAt: 3, finishedAt: 3_000, repliedAt: 3_000 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 9_999_999 })
  assert.deepEqual(views.active.map((group) => group.id), ["dispatch_live"])
  assert.deepEqual(views.active[0]?.tasks.map((item) => item.id), ["live"])
  assert.deepEqual(views.history.map((group) => group.id), ["dispatch_closed", "dispatch_live"])
  assert.deepEqual(views.history.find((group) => group.id === "dispatch_live")?.tasks.map((item) => item.id), ["done"])
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

test("ticket184: a mixed group sorts by its latest finish, not its active work", () => {
  const items = [
    working({ id: "live", dispatchGroupID: "dispatch_mixed", createdAt: 1 }),
    replied({ id: "late", dispatchGroupID: "dispatch_mixed", createdAt: 2, finishedAt: 5_000, repliedAt: 5_000 }),
    replied({ id: "other", dispatchGroupID: "dispatch_other", createdAt: 3, finishedAt: 3_000, repliedAt: 3_000 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 9_999_999 })
  assert.deepEqual(views.history.map((group) => group.id), ["dispatch_mixed", "dispatch_other"])
})

test("ticket184: HISTORY cards order by finish, newest first", () => {
  const items = [
    replied({ id: "late", dispatchGroupID: "dispatch_1", createdAt: 30, finishedAt: 4_000, repliedAt: 4_000 }),
    replied({ id: "early", dispatchGroupID: "dispatch_1", createdAt: 10, finishedAt: 5_000, repliedAt: 5_000 }),
    replied({ id: "middle", dispatchGroupID: "dispatch_1", createdAt: 20, finishedAt: 6_000, repliedAt: 6_000 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 9_999_999 })
  assert.deepEqual(views.history[0]?.tasks.map((item) => item.id), ["middle", "early", "late"])
})

test("ticket184: the newest history group expands and older groups roll up", () => {
  const items = [
    replied({ id: "old", dispatchGroupID: "dispatch_old", createdAt: 1, finishedAt: 1_000, repliedAt: 1_000 }),
    replied({ id: "new", dispatchGroupID: "dispatch_new", createdAt: 2, finishedAt: 5_000, repliedAt: 5_000 }),
    replied({ id: "mid", dispatchGroupID: "dispatch_mid", createdAt: 3, finishedAt: 3_000, repliedAt: 3_000 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 6_000 })
  const state = reconcileHistoryView(views.history, emptyHistoryViewState())
  assert.equal(state.expanded.dispatch_new, true)
  assert.equal(state.expanded.dispatch_mid, false)
  assert.equal(state.expanded.dispatch_old, false)
  const rows = historyPaneGroups(views.history, state)
  assert.deepEqual(rows.map((group) => [group.id, group.collapsed]), [
    ["dispatch_new", false],
    ["dispatch_mid", true],
    ["dispatch_old", true],
  ])
})

test("ticket184: Enter toggles one history group and keeps the others", () => {
  const items = [
    replied({ id: "a", dispatchGroupID: "dispatch_a", createdAt: 1, finishedAt: 1_000, repliedAt: 1_000 }),
    replied({ id: "b", dispatchGroupID: "dispatch_b", createdAt: 2, finishedAt: 2_000, repliedAt: 2_000 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 6_000 })
  const initial = reconcileHistoryView(views.history, emptyHistoryViewState())
  const expanded = toggleHistoryView(initial, "dispatch_a")
  assert.equal(expanded.expanded.dispatch_a, true, "an older rolled-up group expands")
  assert.equal(expanded.expanded.dispatch_b, true, "the newest group keeps its state")
  const collapsed = toggleHistoryView(expanded, "dispatch_b")
  assert.equal(collapsed.expanded.dispatch_b, false, "the newest group collapses")
  assert.equal(collapsed.expanded.dispatch_a, true)
})

test("ticket184: a finish in a collapsed group updates its count and marks it without expanding", () => {
  const newest = [
    replied({ id: "a", dispatchGroupID: "dispatch_a", createdAt: 1, finishedAt: 5_000, repliedAt: 5_000 }),
    replied({ id: "b1", dispatchGroupID: "dispatch_b", createdAt: 2, finishedAt: 1_000, repliedAt: 1_000 }),
  ]
  const initial = reconcileHistoryView(
    workViewGroups(newest, record(...newest), { now: 6_000 }).history,
    emptyHistoryViewState(),
  )
  const later = [
    ...newest,
    replied({ id: "b2", dispatchGroupID: "dispatch_b", createdAt: 3, finishedAt: 7_000, repliedAt: 7_000 }),
  ]
  const groups = workViewGroups(later, record(...later), { now: 8_000 }).history
  const next = reconcileHistoryView(groups, initial)
  assert.equal(next.expanded.dispatch_b, false, "the collapsed group stays collapsed")
  assert.equal(next.done.dispatch_b, 2, "its done count follows the new finish")
  assert.equal(next.fresh.dispatch_b, true, "the collapsed group carries a new marker")
  assert.equal(next.expanded.dispatch_a, true, "the previously expanded group is not disturbed")
  const rows = historyPaneGroups(groups, next)
  assert.deepEqual(rows.map((group) => [group.id, group.collapsed, group.fresh]), [
    ["dispatch_b", true, true],
    ["dispatch_a", false, false],
  ])
  assert.equal(reconcileHistoryView(groups, next), next, "an unchanged reconcile keeps the same state")
})

test("ticket184: dismissed history groups leave the view but keep their data", () => {
  const items = [
    replied({ id: "a", dispatchGroupID: "dispatch_a", createdAt: 1, finishedAt: 2_000, repliedAt: 2_000 }),
    replied({ id: "b", dispatchGroupID: "dispatch_b", createdAt: 2, finishedAt: 1_000, repliedAt: 1_000 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 5_000 })
  const state = reconcileHistoryView(views.history, emptyHistoryViewState())
  const rows = historyPaneGroups(views.history, state, new Set(["dispatch_b"]))
  assert.deepEqual(rows.map((group) => group.id), ["dispatch_a"])
  assert.deepEqual(views.history.map((group) => group.tasks.map((item) => item.id)), [["a"], ["b"]], "the partition still holds the dismissed cards")
})

test("ticket184: history pagination gives every group a focusable row", () => {
  const items = [
    replied({ id: "old-1", dispatchGroupID: "dispatch_old", createdAt: 1, finishedAt: 1_000, repliedAt: 1_000 }),
    replied({ id: "old-2", dispatchGroupID: "dispatch_old", createdAt: 2, finishedAt: 1_500, repliedAt: 1_500 }),
    replied({ id: "new-1", dispatchGroupID: "dispatch_new", createdAt: 3, finishedAt: 5_000, repliedAt: 5_000 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 6_000 })
  const state = reconcileHistoryView(views.history, emptyHistoryViewState())
  const layout = paginateWorkGroups(historyPaneGroups(views.history, state), 59, 40, 6_000)
  assert.deepEqual(layout.pages.flatMap((page) => page.sections.map((section) => section.mode)), ["rollup", "cards", "rollup"])
  const header = layout.pages[0]?.sections[0]
  assert.equal(header?.rollup?.collapsed, false)
  assert.equal(header?.rollup?.done, 1)
  const rollup = layout.pages[0]?.sections[2]
  assert.equal(rollup?.groupID, "dispatch_old")
  assert.equal(rollup?.rollup?.collapsed, true)
  assert.equal(rollup?.rollup?.done, 2)
  assert.match(rollup?.rollup?.label ?? "", /2 done/)
  assert.deepEqual(layout.tasks.map((task) => task.id), ["new-1"], "collapsed groups contribute no cards")
  assert.equal(historyGroupFocusID("dispatch_old"), "history:dispatch_old")
})

test("ticket184: a history group that still has active work shows that count on its row", () => {
  const items = [
    working({ id: "live", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    replied({ id: "done", dispatchGroupID: "dispatch_1", createdAt: 2, finishedAt: 1_000, repliedAt: 1_000 }),
  ]
  const views = workViewGroups(items, record(...items), { now: 6_000 })
  const state = reconcileHistoryView(views.history, emptyHistoryViewState())
  const layout = paginateWorkGroups(historyPaneGroups(views.history, state), 59, 40, 6_000)
  const row = layout.pages[0]?.sections[0]?.rollup
  assert.equal(row?.done, 1)
  assert.equal(row?.active, 1)
  assert.match(row?.label ?? "", /1 done · 1 active/)
})


test("ticket184: a completed group leaves ACTIVE immediately and stays in HISTORY after the hold", () => {
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

/**
 * Ticket #187: a native subagent run is durable Work but not a Subtask. It
 * joins its parent dispatch group, contributes to that group's active/done
 * counts, and partitions into ACTIVE or HISTORY by its own state.
 */
test("ticket187: native subagent runs join the parent group and its counts", () => {
  const parent = working({ id: "parent", dispatchGroupID: "dispatch_1", createdAt: 1 })
  const liveChild = nativeRun({ childSessionID: "child_live", startedAt: 3 })
  const doneChild = nativeRun({ childSessionID: "child_done", state: "replied", startedAt: 2, finishedAt: 1_000 })
  const views = workViewGroups([parent], record(parent), { now: 5_000 }, [liveChild, doneChild])

  assert.deepEqual(views.active.map((group) => group.id), ["dispatch_1"])
  assert.deepEqual(views.active[0]?.tasks.map((item) => item.id), ["parent"], "the parent task card coexists")
  assert.deepEqual(views.active[0]?.native?.map((item) => item.childSessionID), ["child_live"])
  assert.equal(views.active[0]?.active, 2, "the live child is active work")
  assert.equal(views.active[0]?.done, 1, "the finished child is done work")
  assert.deepEqual(views.history.map((group) => group.id), ["dispatch_1"], "a terminal child is history")
  assert.deepEqual(views.history[0]?.tasks, [], "the group's task subset remains task-only")
  assert.deepEqual(views.history[0]?.native?.map((item) => item.childSessionID), ["child_done"])
  assert.equal(views.history[0]?.active, 2, "the history rollup sees the still-active group")
  assert.equal(views.history[0]?.done, 1)
})

test("ticket187: a finished parent and a live child appear in different views", () => {
  const parent = replied({ id: "parent", dispatchGroupID: "dispatch_1", createdAt: 1, finishedAt: 2_000, repliedAt: 2_000 })
  const liveChild = nativeRun({ childSessionID: "child_live", startedAt: 1_500 })
  const views = workViewGroups([parent], record(parent), { now: 5_000 }, [liveChild])

  assert.deepEqual(views.active.map((group) => group.id), ["dispatch_1"], "the live child keeps the group active")
  assert.deepEqual(views.active[0]?.tasks, [], "the parent task has already left ACTIVE")
  assert.deepEqual(views.active[0]?.native?.map((item) => item.childSessionID), ["child_live"])
  assert.deepEqual(views.history[0]?.tasks.map((item) => item.id), ["parent"])
  assert.deepEqual(views.history[0]?.native, [], "the live child never duplicates into history")
  assert.equal(views.history[0]?.active, 1)
  assert.equal(views.history[0]?.done, 1)
})

test("ticket187: a native run uses its stored group when the parent task is already gone", () => {
  const parent = working({ id: "parent", dispatchGroupID: "dispatch_1", createdAt: 1 })
  const detached = nativeRun({ childSessionID: "child_detached", parentTaskID: "missing" })
  const views = workViewGroups([parent], record(parent), { now: 5_000 }, [detached])
  assert.deepEqual(views.active[0]?.native?.map((item) => item.childSessionID), ["child_detached"])
  assert.equal(views.active[0]?.active, 2)
})

test("ticket187: native runs with no resolvable group are not cards", () => {
  const parent = working({ id: "parent", dispatchGroupID: "dispatch_1", createdAt: 1 })
  const orphan = nativeRun({ childSessionID: "child_orphan", parentTaskID: "missing", dispatchGroupID: "dispatch_unknown" })
  const views = workViewGroups([parent], record(parent), { now: 5_000 }, [orphan])
  assert.deepEqual(views.active[0]?.native, [])
  assert.equal(views.active[0]?.active, 1, "an orphaned record cannot inflate a group")
})

test("ticket187: native cards join pagination without changing task reachability", () => {
  const parent = working({ id: "parent", dispatchGroupID: "dispatch_1", createdAt: 1 })
  const liveChild = nativeRun({ childSessionID: "child_live", startedAt: 3 })
  const views = workViewGroups([parent], record(parent), { now: 5_000 }, [liveChild])
  const layout = paginateWorkGroups(views.active, 59, 40, 5_000)
  assert.deepEqual(layout.tasks.map((item) => item.id), ["parent"])
  assert.deepEqual(layout.native.map((item) => item.childSessionID), ["child_live"])
  assert.deepEqual(layout.items.map((item) => item.kind === "task" ? item.task.id : item.run.childSessionID), ["parent", "child_live"])
  assert.equal(layout.pages[0]?.sections[0]?.tasks.length, 1)
  assert.equal(layout.pages[0]?.sections[0]?.native?.length, 1)
})

test("ticket187: native cards page like task cards without duplicating", () => {
  const parent = working({ id: "parent", dispatchGroupID: "dispatch_1", createdAt: 1 })
  const children = [2, 3, 4, 5, 6].map((startedAt) =>
    nativeRun({ childSessionID: `child_${startedAt}`, startedAt }),
  )
  const views = workViewGroups([parent], record(parent), { now: 5_000 }, children)
  const body = WORK_CARD_ROWS + 2
  const layout = paginateWorkGroups(views.active, 59, body, 5_000)
  assert.equal(layout.mode, "cards")
  assert.ok(layout.pages.length > 1, "the group spreads across pages")
  assert.deepEqual(
    layout.native.map((run) => run.childSessionID),
    children.map((run) => run.childSessionID),
    "every native card stays reachable exactly once",
  )
  assert.equal(layout.items.length, 6)
  for (const page of layout.pages) assert.ok(page.height <= body, `page ${page.number} fits`)
})

test("ticket187: native cards never become task rows or consume hop budget", () => {
  const parent = working({ id: "parent", dispatchGroupID: "dispatch_1", createdAt: 1 })
  const ledger = {
    dispatch_1: {
      id: "dispatch_1",
      workspaceID: "w",
      rootID: "dispatch_1",
      continuationIndex: 0,
      maxHops: 8,
      usedHops: 2,
      depthMax: 3,
      createdAt: 1,
    },
  }
  const child = nativeRun({ childSessionID: "child_live", startedAt: 3 })
  const views = workViewGroups([parent], record(parent), { now: 5_000, dispatchGroups: ledger }, [child])
  assert.deepEqual(views.active[0]?.tasks.map((item) => item.id), ["parent"], "the child is not a queue row")
  assert.equal(ledger.dispatch_1.usedHops, 2, "native work consumes no hop budget")
  assert.equal(views.active[0]?.budget?.usedHops, 2)
})

test("ticket187: the work header counts native subagents", () => {
  const parent = working({ id: "parent", dispatchGroupID: "dispatch_1", createdAt: 1 })
  const liveChild = nativeRun({ childSessionID: "child_live", startedAt: 3 })
  const doneChild = nativeRun({ childSessionID: "child_done", state: "failed", startedAt: 2, finishedAt: 1_000 })
  const views = workViewGroups([parent], record(parent), { now: 5_000 }, [liveChild, doneChild])
  const counts = views.active[0]!
  const header = workPaneHeader("active", views.active.length, counts.active, counts.done, 1, 1)
  assert.match(header, /2 active · 1 done/, "native work is visible in the pane header counts")
})
