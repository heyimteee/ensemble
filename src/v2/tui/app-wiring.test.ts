import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

/**
 * Narrow source-text wiring guards only.
 *
 * The TUI adapter is a Solid component without a mount harness here. Each
 * guard names one wiring fact in its narrowest owning file and points at the
 * pure seam or fake-live assertion that covers the behavior. No test slices a
 * whole region, pins surrounding copy, or restates an implementation.
 */

const app = () => readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
const components = () => readFileSync(new URL("./components.tsx", import.meta.url), "utf8")

test("overlay transitions dispatch the reducer so focus-restore intents run", () => {
  // Behavior: interaction.test.ts overlay and field transitions.
  assert.ok(app().includes('dispatchInteraction({ type: "overlay.set", overlay })'))
})

test("Insert without a text target keeps the core statusline segments", () => {
  // Behavior: the fake live scenario asserts the list-step statusline.
  const source = app()
  assert.ok(source.includes('notice: insertWithoutTarget(interaction()) ? "no text target" : undefined'))
  assert.ok(source.includes('if (insertWithoutTarget(interaction())) return "Esc normal"'))
})

test("styled text rows set native content instead of nested spans", () => {
  // Behavior: the fake live scenario inspects statusline and chrome colors.
  const source = components()
  assert.ok(source.includes("function StyledLineText"))
  assert.ok(source.includes("value.content = content()"))
})

test("the composer submits through the shared plan and catalog", () => {
  // Behavior: skill-invocation.test.ts, composer.test.ts, and the live planner checks.
  const source = app()
  assert.ok(source.includes('plan?.kind === "skills" ? "skill.send" : "message.send"'))
  assert.ok(!source.includes("slashCommands"))
})

test("file completion opens, filters, and inserts through one token scanner", () => {
  // Behavior: file-reference.test.ts and composer.test.ts cover the pure seams.
  const source = app()
  assert.ok(source.includes("const token = fileReferenceTokenAt(value, cursor)"))
  assert.ok(source.includes("syncFileCompletion(value, cursor, current)"))
  assert.ok(source.includes("replaceFileReference(value, item.value, state.start, state.end)"))
})

test("file completion filters the cached index instead of spawning fd", () => {
  // Behavior: file-index.test.ts cache hits and bounded refresh rate.
  const source = app()
  assert.ok(source.includes('import { createFileIndex, discoverWorkspaceFiles } from "./file-index.ts"'))
  assert.ok(source.includes("fileIndex.paths(workspace.id, workspace.directory)"))
  assert.ok(!source.includes('execFileSync("fd", ["--type", "f"'))
  assert.ok(!source.includes('"--max-depth", "4", ".", workspace.directory'))
})

test("the file index refreshes on activation, file events, and explicit refresh", () => {
  // Behavior: file-index.test.ts stale-while-refresh and refresh coalescing.
  const source = app()
  assert.ok(source.includes("fileIndex.refresh(root.slice(0, separator), root.slice(separator + 1))"))
  assert.ok(source.includes('type === "file.edited" || type === "filesystem.changed"'))
  assert.ok(source.includes("refreshFileIndexForPath(file)"))
  assert.ok(source.includes('id: "ensemble.v2.completion.refresh"'))
  assert.ok(source.includes("onCleanup(() => fileIndex.dispose())"))
})

test("the Work pane maps active tasks through dispatch groups", () => {
  // Behavior: workgroups.test.ts group visibility and layout.
  assert.ok(app().includes("workGroupsForTasks(active, state()?.subtasks"))
})

test("the Work pane lays groups out for the current size", () => {
  // Behavior: workgroups.test.ts card and compact layouts.
  assert.ok(app().includes("workGroupLayout(groups, workContentWidth(), viewHeight(), now)"))
})

test("the Work pane renders card sections with their card models", () => {
  // Behavior: workgroups.test.ts card sections; the live Work checks.
  assert.ok(app().includes("section.mode === \"cards\""))
})

test("the Work cursor reads the layout's selectable task list", () => {
  // Behavior: workgroups.test.ts selectable tasks; the live Work checks.
  assert.ok(app().includes("workPane().layout.selectableTasks"))
})

test("Work actions target the cursor-clamped visible task", () => {
  // Behavior: workgroups.test.ts cursor clamping; the live Work checks.
  assert.ok(app().includes("visibleTasks()[taskCursorClamped()]"))
})

test("dispatch-group Work cards stay mounted through the shared hold", () => {
  // Behavior: workgroups.test.ts 1.2 s shared hold; the live group-removal check.
  assert.ok(app().includes("workPane().groups.length > 0"))
})

test("the TUI reads durable state through the fine-grained client store", () => {
  // Behavior: client-store.test.ts loading, replacement, and entity isolation.
  assert.ok(app().includes("const client = createClientStore()"))
})

test("an applied snapshot reaches the client store", () => {
  // Behavior: client-store.test.ts snapshot replacement.
  assert.ok(app().includes("client.applySnapshot(next)"))
})

test("snapshot and direct-chat refreshes use the single-flight coordinator", () => {
  // Behavior: refresh-coordinator.test.ts bursts, slow fetches, and pauses.
  assert.ok(app().includes("createRefreshCoordinator("))
})

test("equal-version snapshots are decided by the metadata-aware guard", () => {
  // Behavior: refresh-coordinator.test.ts version and metadata decisions.
  assert.ok(app().includes("decideSnapshotApply(lastSnapshotMeta, nextMeta)"))
})

test("snapshot refresh awaiters observe the queued dirty pass", () => {
  // Behavior: refresh-coordinator.test.ts whenIdle waits for a settled pass.
  assert.ok(app().includes("snapshotRefresh.whenIdle()"))
})

test("direct-chat refresh awaiters observe the queued dirty pass", () => {
  // Behavior: refresh-coordinator.test.ts whenIdle waits for a settled pass.
  assert.ok(app().includes("chatRefresh.whenIdle()"))
})

test("the revision heartbeat polls the cheap revision RPC", () => {
  // Behavior: refresh-coordinator.test.ts revision and cadence helpers.
  assert.ok(app().includes('callRpc<Revision>(context, "revision"'))
})

test("the heartbeat pauses full refresh while the route is hidden", () => {
  // Behavior: refresh-coordinator.test.ts paused surfaces.
  assert.ok(app().includes("snapshotRefresh.setPaused(!visible)"))
})

test("a server schema reset reconnects the feed", () => {
  // Behavior: change-feed.test.ts epoch and reset recovery.
  assert.ok(app().includes('if (type === "server.connected")'))
})

test("the patch feed handles the patches event", () => {
  // Behavior: change-feed.test.ts batch validation and application.
  assert.ok(app().includes('if (type === "rpc.ensemble.v2.patches")'))
})

test("a feed gap recovers through changes.since", () => {
  // Behavior: change-feed.test.ts recovery decisions.
  assert.ok(app().includes('callRpc<ChangesSince>(context, "changes.since"'))
})

test("a foreign-epoch patch is detected before feed reset", () => {
  // Behavior: refresh-coordinator.test.ts foreign-epoch detection.
  assert.ok(app().includes("if (isForeignEpochPatch(lastSnapshotMeta, payload?.epoch))"))
})

test("foreign-epoch recovery debounces through a coalescing coordinator", () => {
  // Behavior: refresh-coordinator.test.ts delayed coalescing.
  const source = app()
  assert.ok(source.includes("const foreignEpochRefresh = createRefreshCoordinator({"))
  assert.ok(source.includes("delayMs: 200"))
})

test("a foreign-epoch patch requests the coalesced refresh", () => {
  // Behavior: refresh-coordinator.test.ts coalesced request.
  assert.ok(app().includes("foreignEpochRefresh.request()"))
})

test(":logs shows the feed-gap counter from logger stats", () => {
  // Behavior: logging.test.ts gap counting and logs.test.ts formatting.
  const source = app()
  assert.ok(source.includes("feedGaps: (result?.stats?.feedGaps ?? 0) + logger.stats().feedGaps"))
})

test("gap recovery is built on the coalesced reporter", () => {
  // Behavior: feed-gaps.test.ts recovery summaries.
  assert.ok(app().includes("createFeedGapReporter({"))
})

test("gap recovery records each outcome", () => {
  // Behavior: feed-gaps.test.ts recovery summaries and fallback warnings.
  assert.ok(app().includes("feedGapReporter.record({"))
})

test("gap recovery settles the coalesced reporter with its outcome", () => {
  // Behavior: feed-gaps.test.ts recovery summaries.
  const source = app()
  assert.ok(source.includes('void recoverFeed((outcome) => feedGapReporter.settle(outcome))'))
  assert.ok(source.includes('feedGapReporter.settle("full")'))
})

test("the TUI log rows carry a per-mount identity", () => {
  // Behavior: logging.test.ts base attribution fields.
  assert.ok(app().includes('createLogger({ role: "tui", instanceID: randomUUID() })'))
})

test("the legacy changed event keeps the snapshot fallback", () => {
  // Behavior: app.tsx loadData falls back to loadSnapshot when scoped reads fail.
  assert.ok(app().includes('if (type === "rpc.ensemble.v2.changed")'))
})

test("the initial read tries the gated bootstrap RPC", () => {
  // Behavior: scoped-read-service.test.ts gated bootstrap.
  assert.ok(app().includes('callRpc<Snapshot>(context, "bootstrap"'))
})

test("bootstrap follows the measured scoped gate", () => {
  // Behavior: scoped-read-service.test.ts measured gate upgrade.
  assert.ok(app().includes("next.scoped === true || next.gate?.enabled === true"))
})

test("a malformed Work-only patch repairs the Work scope", () => {
  // Behavior: refresh-coordinator.test.ts isWorkOnlyPatch; scoped-read-service.test.ts resync.
  assert.ok(app().includes("isWorkOnlyPatch(payload)"))
})

test("a paged transcript releases its anchor at the bottom", () => {
  // Behavior: client-store.test.ts older-page retention.
  assert.ok(app().includes("client.transcriptAnchored(target)"))
})

test("scoped gap recovery requests the named scopes", () => {
  // Behavior: scoped-read-service.test.ts resync scopes; scoped-read.test.ts scopesToResync.
  assert.ok(app().includes('callRpc<ScopedResync>(context, "resync"'))
})

test("older transcript paging calls the bounded window RPC", () => {
  // Behavior: scoped-read.test.ts windows; client-store.test.ts older-page merge.
  assert.ok(app().includes('callRpc<TranscriptWindow & { version: number; epoch: number }>(context, "transcript.window"'))
})

test("an on-demand transcript result uses the message.get RPC", () => {
  // Behavior: scoped-read-service.test.ts message.get outside the loaded window.
  assert.ok(app().includes('callRpc<{ found: boolean; message?: Message }>(context, "message.get"'))
})

test("workspace and direct-chat streams share one coalescer", () => {
  // Behavior: stream-coalescer.test.ts burst coalescing; client-store.test.ts
  // live overlay/final replacement; service.test.ts ephemeral stream events.
  assert.ok(app().includes("createStreamCoalescer"))
})

test("the init row reads durable jobs on the shared motion tick", () => {
  // Behavior: initrow.test.ts labels, stages, and phases; the live init check.
  assert.ok(app().includes("initRowForJob(job, motionFrame(), process.env)"))
})

test("Work cards own a stable tide assignment", () => {
  // Behavior: tide.test.ts stable assignments; the live reduced-motion check.
  assert.ok(app().includes("createTideAssignments()"))
})

test("Work cards read static data through the identity cache", () => {
  // Behavior: workrows.test.ts referential stability; workgroups.test.ts expiry targets.
  assert.ok(app().includes("workCardForTaskCached(workCardCache"))
})

test("the app toast is app-owned and the host toast is fallback-only", () => {
  // Behavior: toast.test.ts lifecycle; the live toast placement check.
  const source = app()
  assert.equal((source.match(/context\.ui\.toast\.show/g) ?? []).length, 1)
  assert.ok(source.includes("if (!isOurRoute()) { showHostToast(input); return }"))
})

test("overlay presence is one-shot and never dispatches interaction", () => {
  // Behavior: overlays.test.ts presence curve; the live overlay open/close checks.
  assert.ok(app().includes("overlayPresenceOpacity(elapsed)"))
})

test("approvals inbox receives one-shot arrival and resolution motion", () => {
  // Behavior: approvals.test.ts transition windows; the live approvals check.
  const source = app()
  assert.ok(source.includes("updateApprovalInboxMotion(approvalTrack"))
  assert.ok(source.includes("approvalMotion().resolved"))
})

test("rail and approvals share the Braille motion tick", () => {
  // Behavior: chrome.test.ts Braille marks; the live reduced-motion check.
  const source = components()
  assert.ok(source.includes("railBusyMark(row.busy, props.motionTick ?? 0, process.env)"))
  assert.ok(source.includes("approvalResolvingSuffix(props.resolvingID === approval.id, props.motionTick ?? 0, process.env)"))
})

test("the System Agent init guard runs before slash-command fallthrough", () => {
  // Behavior: system-agent.test.ts init composer rules; the live /init checks.
  const source = app()
  const guard = source.indexOf("const initIssue = initComposerIssue(text)")
  const command = source.indexOf("parseSlashCommand(text)", guard)
  assert.ok(guard >= 0 && command > guard)
})

test("ticket160: the workspace Limits panel opens from the command line", () => {
  // Behavior: limits.test.ts rows/validation; dispatch-group-service.test.ts settings.update.
  assert.ok(app().includes('case "limits": openLimits()'))
})

test("ticket160: the leader menu opens the workspace Limits panel", () => {
  // Behavior: limits.test.ts rows/validation; dispatch-group-service.test.ts settings.update.
  assert.ok(app().includes('"leader.limits": () => openLimits()'))
})

test("ticket160: the app mounts the Limits view", () => {
  // Behavior: limits.test.ts panel model.
  assert.ok(app().includes("<LimitsView"))
})

test("ticket160: saving Limits invokes settings.update with the validated patch", () => {
  // Behavior: dispatch-group-service.test.ts settings.update; limits.test.ts limitsSave.
  assert.ok(app().includes("await invoke(context, \"settings.update\", result.patch)"))
})

test("ticket160: the Limits key trap owns keys before the page handlers", () => {
  // Behavior: limits.test.ts row cycling; the live Limits panel check.
  assert.ok(app().includes("if (limitsOpen()) { handleLimitsKey(event); return }"))
})

test("ticket160: Work cards receive the dispatch ledger", () => {
  // Behavior: workgroups.test.ts group budgets.
  const source = app()
  assert.ok(source.includes("dispatchGroups: ledger"))
  assert.ok(source.includes("budgetFor,"))
})

test("ticket160: Work cards read each task's ledger budget", () => {
  // Behavior: workrows.test.ts budget labels.
  assert.ok(app().includes("dispatchBudgetForTask(task)"))
})

test("native Work activity arrives as a dedicated event", () => {
  // Behavior: work-activity.test.ts event mapping.
  assert.ok(app().includes('if (type === "rpc.ensemble.v2.work.activity")'))
})

test("native Work activity applies to the task map", () => {
  // Behavior: work-activity.test.ts apply mapping.
  assert.ok(app().includes("applyWorkActivity(current, payload)"))
})

test("native Work activity labels card detail", () => {
  // Behavior: work-activity.test.ts label precedence.
  assert.ok(app().includes("workActivityLabel(activities, item.id, now)"))
})

test("native Work activity clears when its session ends", () => {
  // Behavior: work-activity.test.ts clear behavior.
  assert.ok(app().includes("clearWorkActivitiesForSession"))
})

test("ticket171: the rail renders the pure Agents and Workspaces sections", () => {
  // Behavior: railmodel.test.ts grouping, ordering, collapse, and visible rows.
  const source = app()
  assert.ok(source.includes("sections={railModel().sections}"))
  assert.ok(components().includes("<For each={props.sections}>"))
  assert.ok(components().includes("section.heading"))
})

test("ticket171: rail group headers toggle collapse by key and mouse", () => {
  // Behavior: railmodel.test.ts collapse targets and toggling; keymap.test.ts roster z.
  const source = app()
  assert.ok(source.includes('"rail.collapse": () => toggleRailGroup()'))
  assert.ok(components().includes("onToggleGroup(row.id)"))
  assert.ok(components().includes("onMouseDown"))
})

test("ticket171: the rail cursor traverses the pure visible rows", () => {
  // Behavior: railmodel.test.ts collapsed rows and visible row order.
  const source = app()
  assert.ok(source.includes("railVisibleRows().length"))
  assert.ok(source.includes("const row = railVisibleRows()[railCursor()]"))
  assert.ok(source.includes("firstSelectableRailRow(rows)"), "the initial cursor skips a leading group header")
})

test("ticket171: rail collapse state persists through durable UI state", () => {
  // Behavior: store.test.ts UI reload; the app hydrates and saves collapsedRailGroups.
  const source = app()
  assert.ok(source.includes("collapsedRailGroups: next"))
  assert.ok(source.includes('"ui.save"'))
  assert.ok(source.includes("state()?.ui.collapsedRailGroups"))
})

test("ticket174: every native key routes through one surface-aware decision", () => {
  // Behavior: picker.test.ts native routing by surface and focus.
  const source = app()
  assert.ok(source.includes("nativeSessionRoute({"))
  assert.ok(source.includes('"chat.native": () => openNative()'))
  assert.ok(source.includes('"work.native": () => openNative()'))
  assert.ok(source.includes('"leader.native": () => openNative()'))
})

test("ticket174: group-chat chat focus opens the workspace-member picker", () => {
  // Behavior: picker.test.ts native candidates, filtering, and selection.
  const source = app()
  assert.ok(source.includes('openPicker("native")'))
  assert.ok(source.includes("nativePickerCandidates("))
  assert.ok(source.includes("pickerCandidateRows("))
})

test("ticket174: a missing native binding toasts instead of returning silently", () => {
  // Behavior: picker.test.ts missing-binding routes and messages.
  const source = app()
  assert.ok(source.includes('route.kind === "missing"'))
  assert.ok(source.includes("missingNativeSessionMessage(agentName(state(), agentID))"))
})

test("ticket174: label/detail list rows share the aligned column helper", () => {
  // Behavior: format.test.ts aligned rows across widths, separators, and long names.
  const source = app()
  assert.ok(source.includes("alignedDetailRows("))
  assert.ok(source.includes("wizardRowLabels()"), "wizard rows render the aligned labels")
  assert.ok(source.includes("maxWidth: pickerDetailWidth()"), "picker rows keep one name column")
})
