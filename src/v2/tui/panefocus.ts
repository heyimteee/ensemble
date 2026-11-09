/**
 * Ticket #180: one pure pane select/interact state machine.
 *
 * The shell has five panes. Select mode chooses where the keyboard is; interact
 * mode acts inside that pane. Movement never enters a pane, Enter never starts
 * card navigation in select mode, and Esc always returns one level. Visibility
 * is a plain input so a closed pane is skipped now and #183 can persist the
 * left/right toggles without a second focus model.
 */

export type PaneID = "agents" | "workspaces" | "chat" | "work" | "approvals"

export type PaneMode = "select" | "interact"

export type PaneFocus = { pane: PaneID; mode: PaneMode }

/** Rendering order: left stack, transcript, right stack. */
export const PANE_ORDER: readonly PaneID[] = ["agents", "workspaces", "chat", "work", "approvals"]

export type PaneVisibility = Partial<Record<PaneID, boolean>>

/** Ticket #183: two durable column switches behind every pane transition. */
export type PaneSide = "left" | "right"

export type PaneSideVisibility = { left: boolean; right: boolean }

/** The stored value may come from an older snapshot; both columns default open. */
export function paneSideVisibility(input?: Partial<Record<PaneSide, boolean>> | null): PaneSideVisibility {
  return { left: input?.left !== false, right: input?.right !== false }
}

/**
 * Expand the two column switches into the per-pane map the focus machine
 * reads. `available` carries surface facts the layout cannot know: a DM has no
 * Work pane and an empty approvals list has no approvals sub-pane.
 */
export function paneVisibilityFor(
  sides: PaneSideVisibility,
  available: { work?: boolean; approvals?: boolean } = {},
): PaneVisibility {
  const work = sides.right && available.work !== false
  return {
    agents: sides.left,
    workspaces: sides.left,
    chat: true,
    work,
    approvals: work && available.approvals !== false,
  }
}

/** Flip one column; the other and the chat always stay as they were. */
export function togglePaneSide(sides: PaneSideVisibility, side: PaneSide): PaneSideVisibility {
  return { ...sides, [side]: !sides[side] }
}

/**
 * Focus after a `Space b l` / `Space b r` toggle. Closing the focused column
 * returns to chat selection; reopening selects the column's first pane in
 * select mode, never inside its content. A column with no visible pane (a DM's
 * right column) never steals focus.
 */
export function focusForPaneToggle(
  state: PaneFocus,
  side: PaneSide,
  visible: PaneVisibility,
): PaneFocus {
  const first: PaneID = side === "left" ? "agents" : "work"
  if (paneIsVisible(first, visible)) return { pane: first, mode: "select" }
  const currentSide = side === "left"
    ? state.pane === "agents" || state.pane === "workspaces"
    : state.pane === "work" || state.pane === "approvals"
  return currentSide ? { pane: "chat", mode: "select" } : state
}

export type PaneMove = "left" | "right" | "up" | "down"

export type PaneTransitionInput = {
  /** Absent panes are skipped; every pane defaults to visible. */
  visible?: PaneVisibility
  /** Work interact `down` was pressed while the last card owned focus. */
  workAtLast?: boolean
  /** Approvals interact `up` was pressed while the first row owned focus. */
  approvalsAtFirst?: boolean
}

export function paneIsVisible(pane: PaneID, visible: PaneVisibility = {}): boolean {
  return visible[pane] !== false
}

export function visiblePanes(visible: PaneVisibility = {}): PaneID[] {
  return PANE_ORDER.filter((pane) => paneIsVisible(pane, visible))
}

/** Closed focus falls back to chat selection, never to a stale hidden pane. */
export function recoverPaneFocus(state: PaneFocus, visible: PaneVisibility = {}): PaneFocus {
  return paneIsVisible(state.pane, visible) ? state : { pane: "chat", mode: "select" }
}

/**
 * Select mode: h/l move columns, j/k move the stacked panes. The first
 * available left pane is Agents, then Workspaces; the right column is Work on
 * top and Approvals beneath it. Moving into a pane never enters it.
 */
function moveSelect(state: PaneFocus, direction: PaneMove, input: PaneTransitionInput): PaneFocus {
  const visible = input.visible ?? {}
  const stay = (): PaneFocus => state
  switch (direction) {
    case "left":
      if (state.pane === "agents") return stay()
      if (state.pane === "workspaces") {
        return paneIsVisible("agents", visible) ? { pane: "agents", mode: "select" } : state
      }
      if (state.pane === "chat") {
        if (paneIsVisible("agents", visible)) return { pane: "agents", mode: "select" }
        if (paneIsVisible("workspaces", visible)) return { pane: "workspaces", mode: "select" }
        return state
      }
      return paneIsVisible("chat", visible) ? { pane: "chat", mode: "select" } : state
    case "right":
      if (state.pane === "agents" || state.pane === "workspaces") {
        return paneIsVisible("chat", visible) ? { pane: "chat", mode: "select" } : state
      }
      if (state.pane === "chat") {
        return paneIsVisible("work", visible) ? { pane: "work", mode: "select" } : state
      }
      return stay()
    case "up":
      if (state.pane === "workspaces") {
        return paneIsVisible("agents", visible) ? { pane: "agents", mode: "select" } : state
      }
      if (state.pane === "approvals") {
        return paneIsVisible("work", visible) ? { pane: "work", mode: "select" } : state
      }
      return stay()
    case "down":
      if (state.pane === "agents") {
        if (paneIsVisible("workspaces", visible)) return { pane: "workspaces", mode: "select" }
        return paneIsVisible("chat", visible) ? { pane: "chat", mode: "select" } : state
      }
      if (state.pane === "work") {
        return paneIsVisible("approvals", visible) ? { pane: "approvals", mode: "select" } : state
      }
      return stay()
  }
}

/**
 * Interact mode keeps content navigation inside the pane except at the two
 * stacked edges: Work down on the last card and Approvals up on the first row
 * hand focus back to the neighbouring pane in select mode.
 */
function moveInteract(state: PaneFocus, direction: PaneMove, input: PaneTransitionInput): PaneFocus {
  const visible = input.visible ?? {}
  if (direction === "down" && state.pane === "work" && input.workAtLast && paneIsVisible("approvals", visible)) {
    return { pane: "approvals", mode: "select" }
  }
  if (direction === "up" && state.pane === "approvals" && input.approvalsAtFirst && paneIsVisible("work", visible)) {
    return { pane: "work", mode: "select" }
  }
  return state
}

export function movePaneFocus(state: PaneFocus, direction: PaneMove, input: PaneTransitionInput = {}): PaneFocus {
  const recovered = recoverPaneFocus(state, input.visible)
  if (recovered !== state) return recovered
  return state.mode === "interact"
    ? moveInteract(state, direction, input)
    : moveSelect(state, direction, input)
}

export function enterPane(state: PaneFocus): PaneFocus {
  return { pane: state.pane, mode: "interact" }
}

export function leavePaneInteraction(state: PaneFocus): PaneFocus {
  return state.mode === "interact" ? { pane: state.pane, mode: "select" } : state
}

/**
 * `i` is chat-only. It always lands in chat interaction with the composer
 * owning the caret; every other pane ignores it.
 */
export function composeFromPane(state: PaneFocus): { state: PaneFocus; composer: boolean } {
  if (state.pane !== "chat") return { state, composer: false }
  return { state: { pane: "chat", mode: "interact" }, composer: true }
}

/** Leaving the composer returns to chat interaction, then Esc returns to select. */
export function leaveComposerToPane(): PaneFocus {
  return { pane: "chat", mode: "interact" }
}

/** Tab/Shift+Tab cycle visible panes and always land in select mode. */
export function cyclePaneFocus(state: PaneFocus, direction: 1 | -1, visible: PaneVisibility = {}): PaneFocus {
  const panes = visiblePanes(visible)
  if (panes.length === 0) return { pane: "chat", mode: "select" }
  const panes_ = new Set(panes)
  const current = state.pane
  if (panes_.has(current)) {
    const index = panes.indexOf(current)
    return { pane: panes[(index + direction + panes.length) % panes.length]!, mode: "select" }
  }
  // The current pane vanished: take the nearest visible pane in the direction
  // of travel without wrapping through the whole shell.
  const order = PANE_ORDER.indexOf(current)
  if (direction === 1) {
    for (let index = order + 1; index < PANE_ORDER.length; index++) {
      const pane = PANE_ORDER[index]!
      if (panes_.has(pane)) return { pane, mode: "select" }
    }
    return { pane: panes[0]!, mode: "select" }
  }
  for (let index = order - 1; index >= 0; index--) {
    const pane = PANE_ORDER[index]!
    if (panes_.has(pane)) return { pane, mode: "select" }
  }
  return { pane: panes[panes.length - 1]!, mode: "select" }
}

export function paneOwnsFocus(state: PaneFocus, pane: PaneID): boolean {
  return state.pane === pane
}

/** `AGENTS`/`WORKSPACES` is white only for its own selected sub-pane. */
export function railSectionFocused(state: PaneFocus, section: "agents" | "workspaces"): boolean {
  return state.pane === section
}

export function chatPaneFocused(state: PaneFocus): boolean {
  return state.pane === "chat"
}

/** The right column (Work plus the inline approvals section) is one border. */
export function workPaneFocused(state: PaneFocus): boolean {
  return state.pane === "work" || state.pane === "approvals"
}

/** Work cards gain their white border only while Work owns interaction. */
export function workCardsFocused(state: PaneFocus): boolean {
  return state.pane === "work" && state.mode === "interact"
}
