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

test("a foreign-epoch patch coalesces one snapshot instead of resetting the feed", () => {
  // Behavior: refresh-coordinator.test.ts foreign-epoch detection and coalescing.
  const source = app()
  assert.ok(source.includes("if (isForeignEpochPatch(lastSnapshotMeta, payload?.epoch))"))
  assert.ok(source.includes("createForeignEpochCoalescer({"))
  assert.ok(source.includes("foreignEpochRefresh.request()"))
  assert.ok(source.includes("count: feedGapCount"))
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
