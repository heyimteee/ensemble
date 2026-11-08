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
  assert.ok(has(app(), "paginateWorkGroups(grouped.active, width, body, now)"))
})

test("the Work pane pages its history view by its own body", () => {
  assert.ok(has(app(), "paginateWorkGroups(grouped.history, width, body, now)"))
})

test("the shell widths come from the one pane-width helper", () => {
  assert.ok(has(app(), "workspacePaneWidths(renderSize().width)"))
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
  assert.ok(has(app(), "visibleTasks()[taskCursorClamped()]"))
})

test("completed groups remain available to HISTORY", () => {
  assert.ok(has(app(), "views.history.groups"))
})

test("f toggles ACTIVE and HISTORY", () => {
  assert.ok(has(app(), '"work.filter"'))
})

test("focusing Work or approvals opens the drawer", () => {
  assert.ok(has(app(), "setWorkDrawerOpen(true)"))
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

test("card selection is independent of pane focus", () => {
  assert.ok(has(app(), "selected={selectedTask()?.id === card.id}"))
})

test("compact rows share the card focus identity", () => {
  assert.ok(has(app(), "selectedTask()?.id === task.id"))
})

test("the card border comes from the focus helper", () => {
  assert.ok(has(components(), "workCardBorderColor(props.colors, props.selected)"))
})

test("the pane border stays a separate focus state", () => {
  assert.ok(has(app(), "workOwnsFocus() ? colors.focus : colors.border"))
})

test("the sticky approvals section mounts in the Work pane", () => {
  assert.ok(has(app(), "<WorkApprovalsView"))
})

test("v focuses approvals", () => {
  assert.ok(has(app(), '"work.approvals"'))
})

test("V opens the overflow inbox", () => {
  assert.ok(has(app(), '"work.inbox"'))
})

test("Enter resolves the focused inline approval", () => {
  assert.ok(has(app(), '"workApprovals.resolve"'))
})

test("Esc returns from approvals to Work", () => {
  assert.ok(has(app(), 'focus: "work"'))
})

test("V is advertised only for overflow", () => {
  assert.ok(has(app(), "inlineApprovals().overflow === 0"))
})

test("an approval row click selects it", () => {
  assert.ok(has(app(), "onSelect={selectInlineApproval}"))
})

test("the approval view forwards row clicks", () => {
  assert.ok(has(components(), "props.onSelect(row.index, row.approval)"))
})

test("Tab cycles through the shared focus zones", () => {
  assert.ok(has(app(), "nextFocusZone("))
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
