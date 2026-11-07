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

test("the Work pane renders dispatch-group sections and caps the compact fallback by height", () => {
  // Behavior: workgroups.test.ts group visibility and layout.
  const source = app()
  assert.ok(source.includes("workGroupsForTasks(active, state()?.subtasks"))
  assert.ok(source.includes("workGroupLayout(groups, workContentWidth(), viewHeight(), now)"))
  assert.ok(source.includes("section.mode === \"cards\""))
})

test("the Work cursor and actions only walk visible non-terminal cards", () => {
  // Behavior: workgroups.test.ts selectable tasks; the live Work checks.
  const source = app()
  assert.ok(source.includes("workPane().layout.selectableTasks"))
  assert.ok(source.includes("visibleTasks()[taskCursorClamped()]"))
  assert.ok(!source.includes("hasRecentWork"))
})

test("dispatch-group Work cards stay mounted through the shared hold", () => {
  // Behavior: workgroups.test.ts 1.2 s shared hold; the live group-removal check.
  const source = app()
  assert.ok(source.includes("workGroupsForTasks("))
  assert.ok(source.includes("workPane().groups.length > 0"))
})

test("the TUI reads durable state through the fine-grained client store", () => {
  // Behavior: client-store.test.ts loading, replacement, and entity isolation.
  const source = app()
  assert.ok(source.includes("const client = createClientStore()"))
  assert.ok(source.includes("client.applySnapshot(next)"))
})

test("snapshot and direct-chat refreshes use the single-flight coordinators", () => {
  // Behavior: refresh-coordinator.test.ts bursts, slow fetches, pauses, and versions.
  const source = app()
  assert.ok(source.includes("createRefreshCoordinator("))
  assert.ok(source.includes("decideSnapshotApply(lastSnapshotMeta, nextMeta)"))
  assert.ok(source.includes("client.applyMetadata(next)"))
  assert.ok(!source.includes("refreshSeq") && !source.includes("chatSeq"))
  assert.ok(source.includes("snapshotRefresh.whenIdle()"))
  assert.ok(source.includes("chatRefresh.whenIdle()"))
})

test("the revision heartbeat is cheap, version-aware, paused off-route, and reconnects", () => {
  // Behavior: refresh-coordinator.test.ts revision and cadence helpers.
  const source = app()
  assert.ok(source.includes('callRpc<Revision>(context, "revision"'))
  assert.ok(source.includes("heartbeatDelay(active)"))
  assert.ok(source.includes("revisionChanged(cursor, revision)"))
  assert.ok(source.includes("snapshotRefresh.setPaused(!visible)"))
  assert.ok(source.includes('if (type === "server.connected")'))
  assert.ok(!source.includes("refresh().then(() => syncTranscriptScroll())"))
})

test("the patch feed applies shell entity changes and recovers through changes.since", () => {
  // Behavior: change-feed.test.ts batch validation, store upserts, and resets.
  const source = app()
  assert.ok(source.includes('if (type === "rpc.ensemble.v2.patches")'))
  assert.ok(source.includes('callRpc<ChangesSince>(context, "changes.since"'))
  assert.ok(source.includes("client.applyChanges(decision.changes, decision.version, decision.meta)"))
  assert.ok(source.includes("mergeFeedMeta("))
  assert.ok(source.includes("decidePatchApply(lastSnapshotMeta, payload)"))
  assert.ok(source.includes("decideChangesSince(cursor, result)"))
  assert.ok(source.includes("recoverFeed()"))
  // A malformed shell batch repairs through the full durable snapshot.
  assert.ok(source.includes("void refreshFull().catch(() => undefined)"))
  // The legacy changed event and snapshot path remain for older servers.
  assert.ok(source.includes('if (type === "rpc.ensemble.v2.changed")'))
})

test("workspace streams and direct chats share the coalesced client update path", () => {
  // Behavior: stream-coalescer.test.ts burst coalescing; client-store.test.ts
  // live overlay/final replacement; service.test.ts ephemeral stream events.
  const source = app()
  assert.ok(source.includes("createStreamCoalescer"))
  assert.ok(source.includes('if (type === "rpc.ensemble.v2.stream")'))
  assert.ok(source.includes("client.applyStream("))
  assert.ok(source.includes("dmStream.push("), "the existing direct-chat stream shares the coalescer")
})

test("the init row reads durable jobs and advances on the shared motion tick", () => {
  // Behavior: initrow.test.ts labels, stages, and phases; the live init check.
  const source = app()
  assert.ok(source.includes("activeInitJobs(state()?.initJobs"))
  assert.ok(source.includes("initRowForJob(job, motionFrame(), process.env)"))
})

test("Work cards own stable tide assignments, freeze frames, and a gated clock", () => {
  // Behavior: tide.test.ts assignments/freezes and motion.test.ts clock gate.
  const source = app()
  assert.ok(source.includes("createTideAssignments()") && source.includes("createTideFreezeState()"))
  assert.ok(source.includes("shouldRunWorkClock(") && source.includes("WORK_CLOCK_INTERVAL_MS"))
})

test("ticket142: Work cards split static data from the two animation clocks", () => {
  // Behavior: workrows.test.ts referential stability and independent
  // glyph/tide clocks; workgroups.test.ts expiry timer targets.
  const source = app()
  assert.ok(source.includes("workCardForTaskCached(workCardCache"))
  assert.ok(source.includes("workCardGlyph(card, motionFrame(), process.env)"))
  assert.ok(source.includes("workCardTide(card, {"))
  assert.ok(source.includes("tideTick: workFrame()"))
  assert.ok(source.includes("nextWorkInvalidation(activeTasks(), workPane().groups, now)"))
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
  assert.ok(source.includes("railBusyMark(busy, props.motionTick ?? 0, process.env)"))
  assert.ok(source.includes("approvalResolvingSuffix(props.resolvingID === approval.id, props.motionTick ?? 0, process.env)"))
})

test("the System Agent init guard runs before slash-command fallthrough", () => {
  // Behavior: system-agent.test.ts init composer rules; the live /init checks.
  const source = app()
  const guard = source.indexOf("const initIssue = initComposerIssue(text)")
  const command = source.indexOf("parseSlashCommand(text)", guard)
  assert.ok(guard >= 0 && command > guard)
})
