import test from "node:test"
import assert from "node:assert/strict"
import {
  PANE_ORDER,
  chatPaneFocused,
  composeFromPane,
  cyclePaneFocus,
  enterPane,
  focusForPaneToggle,
  leaveComposerToPane,
  leavePaneInteraction,
  movePaneFocus,
  paneOwnsFocus,
  paneSideVisibility,
  paneVisibilityFor,
  railSectionFocused,
  recoverPaneFocus,
  togglePaneSide,
  visiblePanes,
  workCardsFocused,
  workPaneFocused,
  type PaneFocus,
  type PaneID,
  type PaneMode,
} from "./panefocus.ts"

const focus = (pane: PaneID, mode: PaneMode = "select"): PaneFocus => ({ pane, mode })

test("ticket180: focus-state matrix covers every pane, mode, and visibility", () => {
  for (const pane of PANE_ORDER) {
    for (const mode of ["select", "interact"] as const) {
      const state = focus(pane, mode)
      for (const other of PANE_ORDER) {
        assert.equal(paneOwnsFocus(state, other), other === pane, `${pane}/${mode} owns ${other}`)
      }
      assert.equal(railSectionFocused(state, "agents"), pane === "agents")
      assert.equal(railSectionFocused(state, "workspaces"), pane === "workspaces")
      assert.equal(chatPaneFocused(state), pane === "chat")
      assert.equal(workPaneFocused(state), pane === "work" || pane === "approvals")
      assert.equal(workCardsFocused(state), pane === "work" && mode === "interact")

      const visible = Object.fromEntries(PANE_ORDER.map((id) => [id, id !== pane])) as Record<PaneID, boolean>
      assert.deepEqual(recoverPaneFocus(state, visible), { pane: "chat", mode: "select" }, `closed ${pane} recovers to chat select`)
    }
  }
})

test("ticket180: select mode moves by column and by the stacked left and right panes", () => {
  assert.deepEqual(movePaneFocus(focus("chat"), "left"), focus("agents"), "chat h selects Agents first")
  assert.deepEqual(movePaneFocus(focus("chat"), "right"), focus("work"), "chat l selects Work")
  assert.deepEqual(movePaneFocus(focus("work"), "left"), focus("chat"))
  assert.deepEqual(movePaneFocus(focus("agents"), "right"), focus("chat"))
  assert.deepEqual(movePaneFocus(focus("workspaces"), "left"), focus("agents"))
  assert.deepEqual(movePaneFocus(focus("workspaces"), "right"), focus("chat"))

  assert.deepEqual(movePaneFocus(focus("agents"), "down"), focus("workspaces"), "agents j selects Workspaces")
  assert.deepEqual(movePaneFocus(focus("workspaces"), "up"), focus("agents"), "workspaces k selects Agents")
  assert.deepEqual(movePaneFocus(focus("work"), "down"), focus("approvals"), "work j selects Approvals")
  assert.deepEqual(movePaneFocus(focus("approvals"), "up"), focus("work"), "approvals k selects Work")

  assert.deepEqual(movePaneFocus(focus("work"), "right"), focus("work"), "the right column has no pane to its right")
  assert.deepEqual(movePaneFocus(focus("chat"), "down"), focus("chat"), "chat has no stacked pane")
})

test("ticket180: closed panes are skipped by select-mode movement", () => {
  assert.deepEqual(movePaneFocus(focus("chat"), "left", { visible: { agents: false } }), focus("workspaces"))
  assert.deepEqual(movePaneFocus(focus("chat"), "left", { visible: { agents: false, workspaces: false } }), focus("chat"))
  assert.deepEqual(movePaneFocus(focus("chat"), "right", { visible: { work: false } }), focus("chat"))
  assert.deepEqual(movePaneFocus(focus("work"), "down", { visible: { approvals: false } }), focus("work"))
  assert.deepEqual(movePaneFocus(focus("agents"), "down", { visible: { workspaces: false } }), focus("chat"))
  assert.deepEqual(movePaneFocus(focus("workspaces"), "right", { visible: { chat: false } }), focus("workspaces"))
  assert.deepEqual(movePaneFocus(focus("workspaces"), "up", { visible: { agents: false } }), focus("workspaces"))
})

test("ticket180: Enter enters the selected pane and Esc returns to select", () => {
  for (const pane of PANE_ORDER) {
    assert.deepEqual(enterPane(focus(pane)), focus(pane, "interact"), `Enter enters ${pane}`)
    assert.deepEqual(enterPane(focus(pane, "interact")), focus(pane, "interact"), "Enter inside a pane never leaves it")
    assert.deepEqual(leavePaneInteraction(focus(pane, "interact")), focus(pane, "select"), `Esc returns ${pane} to select`)
    assert.deepEqual(leavePaneInteraction(focus(pane)), focus(pane), "select-mode Esc is a no-op")
  }
})

test("ticket180: chat composes deliberately and always returns to chat interaction", () => {
  assert.deepEqual(composeFromPane(focus("chat")), { state: focus("chat", "interact"), composer: true })
  assert.deepEqual(composeFromPane(focus("chat", "interact")), { state: focus("chat", "interact"), composer: true })
  for (const pane of ["agents", "workspaces", "work", "approvals"] as const) {
    assert.deepEqual(composeFromPane(focus(pane)), { state: focus(pane), composer: false }, `i never composes from ${pane}`)
  }
  assert.deepEqual(leaveComposerToPane(), focus("chat", "interact"), "the composer returns to chat interaction, not select")
})

test("ticket180: Work down on the last card and Approvals up on the first row leave interaction", () => {
  assert.deepEqual(
    movePaneFocus(focus("work", "interact"), "down", { workAtLast: true }),
    focus("approvals"),
    "the last Work card moves to Approvals select",
  )
  assert.deepEqual(movePaneFocus(focus("work", "interact"), "down"), focus("work", "interact"))
  assert.deepEqual(
    movePaneFocus(focus("work", "interact"), "down", { workAtLast: true, visible: { approvals: false } }),
    focus("work", "interact"),
    "a closed Approvals pane never traps the last card",
  )
  assert.deepEqual(
    movePaneFocus(focus("approvals", "interact"), "up", { approvalsAtFirst: true }),
    focus("work"),
    "the first approval moves to Work select",
  )
  assert.deepEqual(movePaneFocus(focus("approvals", "interact"), "up"), focus("approvals", "interact"))
  assert.deepEqual(
    movePaneFocus(focus("approvals", "interact"), "up", { approvalsAtFirst: true, visible: { work: false } }),
    focus("approvals", "interact"),
  )
})

test("ticket180: Tab cycles only visible panes and always lands in select mode", () => {
  assert.deepEqual(cyclePaneFocus(focus("chat"), 1), focus("work"))
  assert.deepEqual(cyclePaneFocus(focus("approvals"), 1), focus("agents"), "forward wraps")
  assert.deepEqual(cyclePaneFocus(focus("chat"), -1), focus("workspaces"), "reverse follows the stack")
  assert.deepEqual(cyclePaneFocus(focus("agents", "interact"), 1), focus("workspaces"), "cycling never keeps interaction")
  assert.deepEqual(cyclePaneFocus(focus("chat"), 1, { work: false, approvals: false }), focus("agents"))
  assert.deepEqual(cyclePaneFocus(focus("work"), 1, { work: false }), focus("approvals"), "a closed current pane is skipped")
  assert.deepEqual(visiblePanes({ work: false, approvals: false }), ["agents", "workspaces", "chat"])
  assert.deepEqual(visiblePanes(), PANE_ORDER)
})

test("ticket180: the visible pane order matches the rendered shell", () => {
  assert.deepEqual(PANE_ORDER, ["agents", "workspaces", "chat", "work", "approvals"])
})

test("ticket180: Work cards are white only while interacting, never for pane selection", () => {
  assert.equal(workPaneFocused(focus("work")), true)
  assert.equal(workCardsFocused(focus("work")), false, "Work select shows a white pane border and grey cards")
  assert.equal(workCardsFocused(focus("work", "interact")), true)
  assert.equal(workCardsFocused(focus("approvals", "interact")), false)
})

test("ticket180: rail headings and chat border follow their own pane", () => {
  assert.equal(railSectionFocused(focus("agents"), "agents"), true)
  assert.equal(railSectionFocused(focus("agents"), "workspaces"), false, "only the focused sub-pane is white")
  assert.equal(railSectionFocused(focus("workspaces", "interact"), "workspaces"), true)
  assert.equal(chatPaneFocused(focus("chat")), true)
  assert.equal(chatPaneFocused(focus("chat", "interact")), true)
  assert.equal(chatPaneFocused(focus("work")), false)
})

test("ticket183: durable side switches derive one per-pane visibility map", () => {
  assert.deepEqual(paneSideVisibility(), { left: true, right: true }, "both columns open by default")
  assert.deepEqual(paneSideVisibility({ left: false }), { left: false, right: true })
  assert.deepEqual(paneSideVisibility({ right: false }), { left: true, right: false })
  assert.deepEqual(
    paneVisibilityFor({ left: true, right: true }),
    { agents: true, workspaces: true, chat: true, work: true, approvals: true },
  )
  assert.deepEqual(
    paneVisibilityFor({ left: false, right: true }),
    { agents: false, workspaces: false, chat: true, work: true, approvals: true },
    "the left switch closes both stacked sub-panes",
  )
  assert.deepEqual(
    paneVisibilityFor({ left: true, right: false }),
    { agents: true, workspaces: true, chat: true, work: false, approvals: false },
    "the right switch closes Work and Approvals together",
  )
  assert.deepEqual(
    paneVisibilityFor({ left: true, right: true }, { work: false }),
    { agents: true, workspaces: true, chat: true, work: false, approvals: false },
    "a DM keeps the right column state but has no Work pane",
  )
  assert.deepEqual(
    paneVisibilityFor({ left: true, right: true }, { approvals: false }),
    { agents: true, workspaces: true, chat: true, work: true, approvals: false },
    "empty approvals close only the approvals sub-pane",
  )
})

test("ticket185: full approvals hide Work while keeping the approvals pane visible", () => {
  const visible = paneVisibilityFor(
    { left: true, right: true },
    { work: true, approvals: true, fullApprovals: true },
  )
  assert.deepEqual(visible, { agents: true, workspaces: true, chat: true, work: false, approvals: true })
  assert.deepEqual(visiblePanes(visible), ["agents", "workspaces", "chat", "approvals"], "Tab skips hidden Work")
})

test("ticket185: a closed right column hides full approvals too", () => {
  const visible = paneVisibilityFor(
    { left: false, right: false },
    { work: true, approvals: true, fullApprovals: true },
  )
  assert.deepEqual(visible, { agents: false, workspaces: false, chat: true, work: false, approvals: false })
  assert.deepEqual(visiblePanes(visible), ["chat"])
})

test("ticket183: toggling a side flips exactly one column", () => {
  assert.deepEqual(togglePaneSide({ left: true, right: true }, "left"), { left: false, right: true })
  assert.deepEqual(togglePaneSide({ left: false, right: true }, "left"), { left: true, right: true })
  assert.deepEqual(togglePaneSide({ left: true, right: true }, "right"), { left: true, right: false })
  assert.deepEqual(togglePaneSide({ left: true, right: false }, "right"), { left: true, right: true })
})

test("ticket183: closing a focused pane returns to chat, reopening selects the column", () => {
  const leftClosed = paneVisibilityFor({ left: false, right: true })
  assert.deepEqual(focusForPaneToggle(focus("agents", "interact"), "left", leftClosed), focus("chat"), "closing focused Agents returns to chat select")
  assert.deepEqual(focusForPaneToggle(focus("workspaces"), "left", leftClosed), focus("chat"), "closing focused Workspaces returns to chat select")
  assert.deepEqual(focusForPaneToggle(focus("chat"), "left", leftClosed), focus("chat"), "closing an unfocused side leaves chat alone")

  const rightClosed = paneVisibilityFor({ left: true, right: false })
  assert.deepEqual(focusForPaneToggle(focus("work", "interact"), "right", rightClosed), focus("chat"), "closing focused Work returns to chat select")
  assert.deepEqual(focusForPaneToggle(focus("approvals"), "right", rightClosed), focus("chat"), "closing focused Approvals returns to chat select")
  assert.deepEqual(focusForPaneToggle(focus("agents"), "right", rightClosed), focus("agents"), "closing the right side never moves the left focus")

  assert.deepEqual(focusForPaneToggle(focus("chat"), "left", paneVisibilityFor({ left: true, right: true })), focus("agents"), "reopening the left selects Agents")
  assert.deepEqual(focusForPaneToggle(focus("work"), "right", paneVisibilityFor({ left: true, right: true })), focus("work"), "reopening the right selects Work")
  assert.deepEqual(focusForPaneToggle(focus("chat"), "right", paneVisibilityFor({ left: true, right: true })), focus("work"), "reopening the right selects Work")
  assert.deepEqual(
    focusForPaneToggle(focus("chat"), "right", paneVisibilityFor({ left: true, right: true }, { work: false })),
    focus("chat"),
    "a right column with no visible pane never steals focus",
  )
})

test("ticket183: closed columns are skipped by movement and Tab cycles", () => {
  const leftClosed = paneVisibilityFor({ left: false, right: true })
  const rightClosed = paneVisibilityFor({ left: true, right: false })
  const bothClosed = paneVisibilityFor({ left: false, right: false })
  assert.deepEqual(movePaneFocus(focus("chat"), "left", { visible: leftClosed }), focus("chat"), "no left column to select")
  assert.deepEqual(movePaneFocus(focus("chat"), "right", { visible: rightClosed }), focus("chat"), "no right column to select")
  assert.deepEqual(cyclePaneFocus(focus("chat"), 1, leftClosed), focus("work"), "Tab skips closed Agents and Workspaces")
  assert.deepEqual(cyclePaneFocus(focus("work"), 1, rightClosed), focus("agents"), "Tab skips a closed right column and wraps")
  assert.deepEqual(cyclePaneFocus(focus("chat"), 1, bothClosed), focus("chat"), "only chat remains visible")
  assert.deepEqual(visiblePanes(bothClosed), ["chat"])
  assert.deepEqual(recoverPaneFocus(focus("work"), rightClosed), focus("chat"), "a hidden focused pane recovers to chat")
})
