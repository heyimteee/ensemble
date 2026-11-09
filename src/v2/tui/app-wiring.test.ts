import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

/**
 * Narrow source-text wiring guards only.
 *
 * The TUI adapter is a Solid component without a mount harness here. Each
 * guard names one wiring fact in its narrowest owning file and points at the
 * pure seam or live check that covers the behavior. No test slices a whole
 * region, pins user-visible copy, or restates an implementation block.
 */

const app = () => readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
const components = () => readFileSync(new URL("./components.tsx", import.meta.url), "utf8")

const has = (source: string, value: string) => source.includes(value)

// ---- Transcript, composer, and feed ----

test("overlay transitions dispatch the interaction reducer", () => {
  assert.ok(has(app(), 'dispatchInteraction({ type: "overlay.set", overlay })'))
})

test("Insert without a text target leaves a notice", () => {
  assert.ok(has(app(), "insertWithoutTarget(interaction())"))
})

test("styled text rows set native content", () => {
  const source = components()
  assert.ok(has(source, "function StyledLineText"))
  assert.ok(has(source, "value.content = content()"))
})

test("composer submits through the shared skill/message plan", () => {
  assert.ok(has(app(), 'plan?.kind === "skills" ? "skill.send" : "message.send"'))
})

test("the composer has no legacy slash-command path", () => {
  assert.ok(!has(app(), "slashCommands"))
})

test("file completion opens and filters through one token scanner", () => {
  assert.ok(has(app(), "fileReferenceTokenAt(value, cursor)"))
})

test("file completion syncs the scanned token", () => {
  assert.ok(has(app(), "syncFileCompletion(value, cursor, current)"))
})

test("file selection replaces only the token range", () => {
  assert.ok(has(app(), "replaceFileReference(value, item.value, state.start, state.end)"))
})

test("file completion reads the cached index", () => {
  assert.ok(has(app(), "fileIndex.paths(workspace.id, workspace.directory)"))
})

test("file completion never spawns fd from the TUI", () => {
  assert.ok(!has(app(), 'execFileSync("fd", ["--type", "f"'))
})

test("the file index refreshes on workspace activation", () => {
  assert.ok(has(app(), "fileIndex.refresh("))
})

test("the file index refreshes on file events", () => {
  assert.ok(has(app(), 'type === "file.edited" || type === "filesystem.changed"'))
})

test("the file index refreshes per changed path", () => {
  assert.ok(has(app(), "refreshFileIndexForPath(file)"))
})

test("the file index exposes an explicit refresh command", () => {
  assert.ok(has(app(), '"ensemble.v2.completion.refresh"'))
})

test("the file index disposes with the app", () => {
  assert.ok(has(app(), "onCleanup(() => fileIndex.dispose())"))
})

test("the TUI reads durable state through the client store", () => {
  assert.ok(has(app(), "createClientStore()"))
})

test("an applied snapshot reaches the client store", () => {
  assert.ok(has(app(), "client.applySnapshot(next)"))
})

test("snapshot and chat refreshes share a single-flight coordinator", () => {
  assert.ok(has(app(), "createRefreshCoordinator("))
})

test("equal-version snapshots use the metadata-aware guard", () => {
  assert.ok(has(app(), "decideSnapshotApply(lastSnapshotMeta, nextMeta)"))
})

test("snapshot awaiters observe a queued dirty pass", () => {
  assert.ok(has(app(), "snapshotRefresh.whenIdle()"))
})

test("direct-chat awaiters observe a queued dirty pass", () => {
  assert.ok(has(app(), "chatRefresh.whenIdle()"))
})

test("the revision heartbeat polls the cheap revision RPC", () => {
  assert.ok(has(app(), 'callRpc<Revision>(context, "revision"'))
})

test("the heartbeat pauses full refresh while the route is hidden", () => {
  assert.ok(has(app(), "snapshotRefresh.setPaused(!visible)"))
})

test("a server schema reset reconnects the feed", () => {
  assert.ok(has(app(), 'if (type === "server.connected")'))
})

test("the patch feed handles the patches event", () => {
  assert.ok(has(app(), 'if (type === "rpc.ensemble.v2.patches")'))
})

test("a feed gap recovers through changes.since", () => {
  assert.ok(has(app(), 'callRpc<ChangesSince>(context, "changes.since"'))
})

test("a foreign-epoch patch is detected before feed reset", () => {
  assert.ok(has(app(), "isForeignEpochPatch(lastSnapshotMeta, payload?.epoch)"))
})

test("foreign-epoch recovery debounces through a coalescing coordinator", () => {
  assert.ok(has(app(), "createRefreshCoordinator({"))
})

test("foreign-epoch recovery requests the coalesced refresh", () => {
  assert.ok(has(app(), "foreignEpochRefresh.request()"))
})

test(":logs shows the feed-gap counter from logger stats", () => {
  assert.ok(has(app(), "feedGaps:"))
})

test("gap recovery records each outcome", () => {
  assert.ok(has(app(), "feedGapReporter.record({"))
})

test("gap recovery settles the coalesced reporter", () => {
  assert.ok(has(app(), "feedGapReporter.settle("))
})

test("the TUI log rows carry a per-mount identity", () => {
  assert.ok(has(app(), 'role: "tui"'))
})

test("the legacy changed event keeps the snapshot fallback", () => {
  assert.ok(has(app(), 'if (type === "rpc.ensemble.v2.changed")'))
})

test("the initial read tries the gated bootstrap RPC", () => {
  assert.ok(has(app(), 'callRpc<Snapshot>(context, "bootstrap"'))
})

test("a malformed Work-only patch repairs the Work scope", () => {
  assert.ok(has(app(), "isWorkOnlyPatch(payload)"))
})

test("scoped gap recovery requests the named scopes", () => {
  assert.ok(has(app(), 'callRpc<ScopedResync>(context, "resync"'))
})

test("older transcript paging calls the bounded window RPC", () => {
  assert.ok(has(app(), '"transcript.window"'))
})

test("an on-demand transcript result uses the message.get RPC", () => {
  assert.ok(has(app(), '"message.get"'))
})

test("workspace and direct-chat streams share one coalescer", () => {
  assert.ok(has(app(), "createStreamCoalescer"))
})

// ---- Three-pane shell, Work layout, and focus ----

test("the Work pane maps active tasks through the view filter", () => {
  assert.ok(has(app(), "workViewGroups(active"))
})

test("the Work pane receives the dispatch ledger", () => {
  assert.ok(has(app(), "dispatchGroups:"))
})

test("the Work pane pages its active view by its own body", () => {
  assert.ok(has(app(), "paginateWorkGroups(partition.active, width, body, partition.now)"))
})

test("the Work pane pages its history view by its own body", () => {
  assert.ok(has(app(), "paginateWorkGroups(historyPaneRows(), width, body, partition.now)"))
})

test("the shell widths come from the one pane-width helper", () => {
  assert.ok(has(app(), "workspacePaneWidths(renderSize().width, paneSides())"))
})

test("entering a rail pane claims the row cursor for that section", () => {
  assert.match(
    app(),
    /const ensureRailSectionCursor[\s\S]*?railCursorMoved = true[\s\S]*?setRailCursor\(start \+ local\)/,
  )
})

test("the transcript width follows the Work pane state", () => {
  assert.ok(has(app(), "panes().chatContentWidth"))
  assert.ok(has(app(), "panes().chatOnlyContentWidth"))
})

test("the Work layout reads the pane content width", () => {
  assert.ok(has(app(), "panes().workContentWidth"))
})

test("the Work pane mounts card sections", () => {
  assert.ok(has(app(), "<WorkCardView"))
})

test("the Work pane mounts compact row sections", () => {
  assert.ok(has(app(), "<WorkCompactRowView"))
})

test("the Work cursor reads rendered card rectangles", () => {
  assert.ok(has(app(), "workLayoutRects(workViews()[workView()].layout)"))
})

test("the Work cursor settles by task identity and position", () => {
  assert.ok(has(app(), "settleWorkFocusByPosition(pages, lastWorkFocus, workFocusIntent)"))
})

test("Work actions target the focused visible task", () => {
  assert.ok(has(app(), "tasks.find((task) => task.id === id)"))
})

test("ticket187: native subagent records join the Work view model", () => {
  assert.ok(has(app(), "nativeSubagentRuns()"))
  assert.ok(has(app(), "workViewGroups(activeTasks(), state()?.subtasks ?? {}, {"))
})

test("ticket187: native cards render through the same card and compact views", () => {
  const source = app()
  assert.ok(has(source, "workCardForNativeSubagentCached(workCardCache"))
  assert.ok(has(source, "workCompactRowForNativeSubagent("))
  assert.ok(has(source, "section.items"))
})

test("ticket187: native focus opens the child session and offers no task actions", () => {
  const source = app()
  assert.ok(has(source, "selectedNativeSubagent()"))
  assert.ok(has(source, "nativeSubagentFocusChild("))
  assert.ok(has(source, "childSessionID"))
  assert.ok(has(source, "nativeSubagentActions()"))
})

test("ticket184: HISTORY groups carry task-level rollup state", () => {
  assert.ok(has(app(), "historyPaneGroups("))
  assert.ok(has(app(), "reconcileHistoryView("))
})

test("ticket184: Enter toggles a focused history group", () => {
  assert.ok(has(app(), "toggleFocusedHistoryGroup()"))
})

test("ticket184: x dismisses a focused history group", () => {
  assert.ok(has(app(), "dismissFocusedHistoryGroup()"))
})

test("ticket184: D clears the history view with confirmation", () => {
  assert.ok(has(app(), '"work.history.clear"'))
  assert.ok(has(app(), "clearHistoryView()"))
})

test("ticket184: dismissed history groups hydrate and persist as UI state", () => {
  assert.ok(has(app(), "dismissedHistoryGroups"))
  assert.ok(has(app(), "historyDismissedKey"))
})

test("ticket184: rolled-up history rows reuse the Work row design", () => {
  assert.ok(has(app(), "<WorkHistoryRowView"))
  assert.ok(has(components(), "export function WorkHistoryRowView"))
})

test("completed groups remain available to HISTORY", () => {
  assert.ok(has(app(), "views.history.groups"))
})

test("f toggles ACTIVE and HISTORY", () => {
  assert.ok(has(app(), '"work.filter"'))
})

test("ticket183: the right pane visibility is the one drawer switch", () => {
  assert.ok(has(app(), "paneSides().right && (surface()?.kind === \"workspace\" || approvalsMode() === \"full\")"))
  assert.ok(has(app(), "<Show when={paneSides().left}>"), "the rail renders only while the left switch is on")
  assert.ok(!has(app(), "workDrawerOpen"), "no second drawer state exists")
})

test("ticket183: Space b l/r run one focus-recovering toggle", () => {
  const source = app()
  assert.ok(has(source, '"leader.pane.left": () => togglePane("left")'))
  assert.ok(has(source, '"leader.pane.right": () => togglePane("right")'))
  assert.ok(has(source, "togglePaneSide(paneSides(), side)"))
  assert.ok(has(source, "focusForPaneToggle(current, side, visibility)"))
  assert.ok(has(source, "if (focus.pane !== current.pane || focus.mode !== current.mode)"), "an unchanged focus never blurs the composer")
})

test("ticket183: pane visibility persists through the UI RPC and hydrates", () => {
  const source = app()
  assert.ok(has(source, 'invoke(context, "ui.save", { paneVisibility: next })'))
  assert.ok(has(source, "paneSideVisibility(stored)"))
  assert.ok(has(source, "const [paneSides, setPaneSides]"))
})

test("ticket183: F3 is gone from the global layer", () => {
  const source = app()
  assert.ok(!has(source, "global.work"))
  assert.ok(!has(source, "toggleWorkDrawer"))
  assert.ok(!has(source, "F3"))
})

test("the Work page previous control pages", () => {
  assert.ok(has(app(), "selectWorkPage(workPane().page - 1)"))
})

test("the Work page next control pages", () => {
  assert.ok(has(app(), "selectWorkPage(workPane().page + 1)"))
})

test("a card click selects that card", () => {
  assert.ok(has(app(), "selectWorkCard(card.id)"))
})

test("a compact row click selects that task", () => {
  assert.ok(has(app(), "selectWorkCard(task.id)"))
})

test("the Work down key uses the spatial navigator", () => {
  assert.ok(has(app(), "moveTask(1)"))
})

test("the Work up key uses the spatial navigator", () => {
  assert.ok(has(app(), "moveTask(-1)"))
})

test("the Work left key moves one column", () => {
  assert.ok(has(app(), "moveTaskColumn(-1)"))
})

test("the Work right key moves one column", () => {
  assert.ok(has(app(), "moveTaskColumn(1)"))
})

test("gg focuses the first Work card", () => {
  assert.ok(has(app(), "focusFirstWork()"))
})

test("G focuses the last Work card", () => {
  assert.ok(has(app(), "focusLastWork()"))
})

test("Ctrl+d uses the half-page navigator", () => {
  assert.ok(has(app(), "moveTaskHalf(1)"))
})

test("Ctrl+u uses the half-page navigator", () => {
  assert.ok(has(app(), "moveTaskHalf(-1)"))
})

test("hjkl navigation runs through the pure spatial navigator", () => {
  assert.ok(has(app(), "navigateWorkFocus(workFocusPages()"))
})

test("half-page navigation runs through the pure spatial navigator", () => {
  assert.ok(has(app(), "halfPageWorkFocus(workFocusPages()"))
})

test("Work card actions are advertised only when valid", () => {
  assert.ok(has(app(), "workTaskActions(selectedTask(), Date.now())"))
})

test("the statusline gates each Work action through the same policy", () => {
  assert.ok(has(app(), "selectedTaskActions().has(entry.id)"))
})

test("retry targets the focused card", () => {
  assert.ok(has(app(), "selectedActionTask(\"work.retry\")"))
})

test("cancel targets the focused card", () => {
  assert.ok(has(app(), "selectedActionTask(\"work.cancel\")"))
})

test("the pending label settles on the durable update", () => {
  assert.ok(has(app(), "pendingWorkSettled(pending"))
})

test("card selection is gated by Work interaction, not pane selection", () => {
  assert.ok(has(app(), "workCardsFocused(paneState()) && (workFocusID() === card.id"))
})

test("compact rows share the card focus identity and interaction gate", () => {
  assert.ok(has(app(), "workCardsFocused(paneState()) && selectedTask()?.id === task.id"))
})

test("the card border comes from the focus helper", () => {
  assert.ok(has(components(), "workCardBorderColor(props.colors, props.selected)"))
})

test("the pane border stays a separate focus state", () => {
  assert.ok(has(app(), "workOwnsFocus() ? colors.focus : colors.border"))
})

test("ticket185: the small approvals summary mounts at the bottom of Work", () => {
  const source = app()
  assert.ok(has(source, "<WorkApprovalsView"))
  assert.ok(has(source, "section={inlineApprovals()}"))
})

test("ticket185: the full approvals inbox mounts in the same right column", () => {
  const source = app()
  const right = source.indexOf("<Show when={showWorkPane()}>")
  const full = source.indexOf("<FullApprovalsView", right)
  assert.ok(right >= 0 && full > right, "full approvals render inside the right-pane column, not a chat modal")
  assert.ok(has(source, 'approvalsMode() === "full"'))
})

test("ticket185: v opens full approvals from every pane", () => {
  const source = app()
  for (const binding of ['"pane.approvals": () => openApprovalsFull()', 'approvals: () => openApprovalsFull()', '"chat.approvals": () => openApprovalsFull()', '"work.approvals": () => openApprovalsFull()', '"leader.approvals": () => openApprovalsFull()']) {
    assert.ok(has(source, binding), `${binding} opens the one approvals surface`)
  }
})

test("ticket185: v opens the right column first when it is closed", () => {
  const source = app()
  assert.ok(has(source, "if (!paneSides().right)"), "the open path checks the column switch")
  assert.ok(has(source, "persistPaneSides({ ...paneSides(), right: true })"))
  assert.ok(has(source, "setApprovalsFull(openFullApprovals({ full: approvalsFull() }).full)"))
})

test("ticket185: Enter from the small approvals selection opens full approvals", () => {
  const source = app()
  const enter = source.indexOf("const enterSelectedPane = () => {")
  const guard = source.indexOf('if (paneState().pane === "approvals")', enter)
  assert.ok(enter >= 0 && guard > enter)
  assert.ok(has(source, "openApprovalsFull()"))
})

test("ticket185: Esc returns full approvals to split", () => {
  const source = app()
  assert.ok(has(source, '"approvals.close": () => closeApprovalsFull()'))
  assert.ok(has(source, "setApprovalsFull(false)"))
  assert.ok(has(source, 'setPaneFocus("approvals", "select")'), "the small pane remains selected at the bottom")
})

test("ticket185: the full inbox reuses the existing resolution flow", () => {
  const source = app()
  assert.ok(has(source, '"approvals.resolve": () => resolveFocusedApproval()'))
  assert.ok(has(source, "await invoke(context, \"approval.resolve\""))
})

test("ticket185: the full inbox moves its one cursor with j/k, arrows, gg, and G", () => {
  const source = app()
  assert.ok(has(source, '"approvals.down": () => moveApprovalCursor(1)'))
  assert.ok(has(source, '"approvals.down.arrow": () => moveApprovalCursor(1)'))
  assert.ok(has(source, '"approvals.up": () => moveApprovalCursor(-1)'))
  assert.ok(has(source, '"approvals.top": () => setApprovalCursor(0)'))
  assert.ok(has(source, '"approvals.bottom": () => setApprovalCursor(Math.max(0, pendingApprovals().length - 1))'))
})

test("ticket185: the chat approvals modal and V are retired", () => {
  const source = app()
  assert.ok(!has(source, "approvalsOpen"))
  assert.ok(!has(source, "ApprovalList"))
  assert.ok(!has(source, '"work.inbox"'))
  assert.ok(!has(source, "openApprovalsOverflow"))
  assert.ok(!has(source, "approvals.inbox"), "no second inbox action survives")
})

test("ticket185: the left rail no longer renders approvals or its hint", () => {
  const source = components()
  assert.ok(!has(source, "APPROVALS"))
  assert.ok(!has(source, "v opens inbox"))
  assert.ok(!has(source, "pendingApprovals"))
  assert.ok(!has(app(), "pendingApprovals={pendingApprovals().length}"))
})

test("an approval row click opens the full inbox at that row", () => {
  assert.ok(has(app(), "onOpen={openApprovalsAt}"))
  assert.ok(has(components(), "props.onOpen(row.index)"))
})

test("Tab cycles the visible panes through the pure pane machine", () => {
  assert.ok(has(app(), "cyclePaneFocus(paneState()"))
})

test("ticket180: chat l selects Work through the pure pane transition", () => {
  const source = app()
  assert.ok(has(source, "pane.right"))
  assert.ok(has(source, 'moveSelectedPane("right")'))
})

test("ticket180: chat h selects Agents and Agents j selects Workspaces", () => {
  const source = app()
  assert.ok(has(source, 'moveSelectedPane("left")'))
  assert.ok(has(source, 'moveSelectedPane("down")'))
  assert.ok(has(source, "pane.left"))
})

test("ticket180: Work j at the last card selects Approvals", () => {
  assert.ok(has(app(), 'setPaneFocus("approvals", "select")'))
})

test("ticket180: Approvals up at the first row returns Work selection", () => {
  assert.ok(has(app(), 'moveSelectedPane("up")'))
})

test("ticket180: Enter enters the selected pane without starting card navigation in select mode", () => {
  const source = app()
  assert.ok(has(source, "enterPane(paneState())"))
  assert.ok(has(source, "if (next.pane === \"work\" && workFocusID() === undefined) focusFirstWork()"))
})

test("ticket180: pane Esc returns to select through the interaction reducer", () => {
  assert.ok(has(app(), 'dispatchInteraction({ type: "escape" })'))
})

test("ticket180: chat i is the only composer path", () => {
  assert.ok(has(app(), "composeFromPaneFocus"))
  assert.ok(has(app(), "if (interaction().pane !== \"chat\") return"))
})

test("ticket180: the rail receives its focused sub-pane", () => {
  assert.ok(has(app(), 'focusedSection={railSectionFocused(paneState(), "agents")'))
})

test("ticket180: the chat border and heading are white when chat is selected", () => {
  const source = app()
  assert.ok(has(source, "chatOwnsFocus() ? colors.focus : colors.border"))
  assert.ok(has(source, "chatOwnsFocus() || composerActive() ? colors.focus : colors.muted"))
})

test("ticket180: the Work border and heading are white when Work or Approvals is selected", () => {
  const source = app()
  assert.ok(has(source, "workOwnsFocus() ? colors.focus : colors.border"))
  assert.ok(has(source, "workOwnsFocus() ? colors.focus : colors.muted"))
})

test("ticket183: which-key/statusline read the pending leader submenu", () => {
  const source = app()
  assert.ok(has(source, "leaderMenuEntries(leaderKeys())"))
  assert.ok(has(source, "leaderHints(leaderKeys())"))
})

test("ticket183: a closed or absent pane recovers selection to chat", () => {
  assert.ok(has(app(), 'dispatchInteraction({ type: "pane.recover", visible })'))
})

test("ticket180: the rail section border and heading follow the focused sub-pane", () => {
  const source = components()
  assert.ok(has(source, "sectionFocused(section.id) ? props.colors.focus : props.colors.faint"))
  assert.ok(has(source, "sectionBorder(section.id)"))
})

test("ticket180: the rail row cursor stays inside the focused sub-pane", () => {
  assert.ok(has(components(), "sectionFocused(section.id) && props.cursor === index()"))
})

test("ticket185: the small approvals summary is white when its pane is selected", () => {
  const source = app()
  assert.ok(has(source, 'focused={paneOwnsFocus(paneState(), "approvals")'))
  assert.ok(has(components(), "props.focused ? props.colors.focus : props.colors.muted"))
})

test("approvals join the focus cycle only while pending", () => {
  assert.ok(has(app(), "pendingApprovals().length > 0"))
})

test("Work cards own a stable tide assignment", () => {
  assert.ok(has(app(), "createTideAssignments()"))
})

test("Work cards read static data through the identity cache", () => {
  assert.ok(has(app(), "workCardForTaskCached(workCardCache"))
})

// ---- Rail ----

test("the rail renders the pure Agents and Workspaces sections", () => {
  assert.ok(has(app(), "sections={railModel().sections}"))
})

test("the rail component renders section rows", () => {
  assert.ok(has(components(), "section.heading"))
})

test("z toggles the rail group", () => {
  assert.ok(has(app(), '"rail.collapse"'))
})

test("a rail group header toggles by mouse", () => {
  assert.ok(has(components(), "onToggleGroup(row.id)"))
})

test("the rail cursor traverses visible rows", () => {
  assert.ok(has(app(), "railVisibleRows()"))
})

test("the initial rail cursor skips a leading header", () => {
  assert.ok(has(app(), "firstSelectableRailRow(rows)"))
})

test("rail collapse state persists to durable UI state", () => {
  assert.ok(has(app(), "collapsedRailGroups:"))
})

test("rail collapse saves through the UI RPC", () => {
  assert.ok(has(app(), '"ui.save"'))
})

test("rail collapse hydrates from durable UI state", () => {
  assert.ok(has(app(), "collapsedRailGroups"))
})

// ---- Native picker and alignment ----

test("every native key routes through one surface-aware decision", () => {
  assert.ok(has(app(), "nativeSessionRoute({"))
})

test("group-chat native routing opens the picker", () => {
  assert.ok(has(app(), 'openPicker("native")'))
})

test("the native picker reads workspace-member candidates", () => {
  assert.ok(has(app(), "nativePickerCandidates("))
})

test("the native picker renders shared candidate rows", () => {
  assert.ok(has(app(), "pickerCandidateRows("))
})

test("a missing native binding follows the missing route", () => {
  assert.ok(has(app(), 'route.kind === "missing"'))
})

test("a missing native binding reports a clear message", () => {
  assert.ok(has(app(), "missingNativeSessionMessage("))
})

test("list rows share the aligned column helper", () => {
  assert.ok(has(app(), "alignedDetailRows("))
})

test("the member wizard renders aligned labels", () => {
  assert.ok(has(app(), "wizardRowLabels()"))
})

test("picker rows keep one name column", () => {
  assert.ok(has(app(), "maxWidth: pickerDetailWidth()"))
})

// ---- Settings, limits, and activity ----

test("chat renders one aggregate activity summary line", () => {
  const source = app()
  assert.ok(has(source, "activitySummary("))
  assert.ok(has(source, "text={liveActivity().text}"))
})

test("per-agent activity rows are gone", () => {
  const source = app()
  assert.ok(!has(source, "liveActivity().shown"))
  assert.ok(!has(source, "liveActivity().queued"))
  assert.ok(!has(source, "<For each={liveActivity()}"))
  assert.ok(!has(source, "activityFrameForKind(entry.kind"))
})

test("carded work is not suppressed from the summary", () => {
  const source = app()
  assert.ok(!has(source, "suppressCardedActivity("))
  assert.ok(!has(source, "cardedTaskIDs"))
})

test("the activity summary is not gated on the Work pane", () => {
  const source = app()
  const start = source.indexOf("const liveActivity = createMemo(")
  const end = source.indexOf("const hasChatContent", start)
  assert.ok(start >= 0 && end > start, "activity summary memo exists")
  const memo = source.slice(start, end)
  assert.ok(!has(memo, "showWorkPane"), "the summary ignores Work-pane visibility")
  assert.ok(!has(memo, "cardedTaskIDs"), "the summary ignores card suppression")
  const render = source.indexOf("text={liveActivity().text}")
  const workPane = source.indexOf("<Show when={showWorkPane()}>")
  assert.ok(render >= 0 && workPane > render, "the summary renders in chat before the Work pane sibling")
})

test("the System Agent init guard runs before slash-command fallthrough", () => {
  const source = app()
  const guard = source.indexOf("const initIssue = initComposerIssue(text)")
  const command = source.indexOf("parseSlashCommand(text)", guard)
  assert.ok(guard >= 0 && command > guard)
})

test("the workspace Limits panel opens from the command line", () => {
  assert.ok(has(app(), "openLimits()"))
})

test("saving Limits invokes settings.update with the validated patch", () => {
  assert.ok(has(app(), '"settings.update"'))
})

test("closing settings restores the prior pane select/interact mode", () => {
  assert.match(app(), /isPaneFocus\(target\)[\s\S]*?setPaneFocus\(target, settingsReturnPaneMode\)/)
})

test("the Limits key trap owns keys before page handlers", () => {
  assert.ok(has(app(), "handleLimitsKey(event)"))
})

test("Work cards read each task's ledger budget", () => {
  assert.ok(has(app(), "dispatchBudgetForTask(task)"))
})

test("native Work activity arrives as a dedicated event", () => {
  assert.ok(has(app(), '"rpc.ensemble.v2.work.activity"'))
})

test("native Work activity applies to the task map", () => {
  assert.ok(has(app(), "applyWorkActivity(current, payload)"))
})

test("native Work activity labels card detail", () => {
  assert.ok(has(app(), "workActivityLabel(activities, item.id, now)"))
})

test("native Work activity clears when its session ends", () => {
  assert.ok(has(app(), "clearWorkActivitiesForSession"))
})

test("the host toast is a fallback only", () => {
  assert.ok(has(app(), "showHostToast(input)"))
})

test("overlay presence stays one-shot", () => {
  assert.ok(has(app(), "overlayPresenceOpacity(elapsed)"))
})

test("approvals receive one-shot arrival and resolution motion", () => {
  assert.ok(has(app(), "updateApprovalInboxMotion(approvalTrack"))
})

test("rail and approvals share the Braille motion tick", () => {
  assert.ok(has(components(), "railBusyMark("))
  assert.ok(has(components(), "approvalResolvingSuffix("))
})

test("the init row reads durable jobs on the shared motion tick", () => {
  assert.ok(has(app(), "initRowForJob(job, motionFrame(), process.env)"))
})
