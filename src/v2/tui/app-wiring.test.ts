import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

/**
 * The TUI adapter is a Solid component without a mount harness here, so these
 * static checks pin the two review-fix wirings that pure reducer tests cannot
 * observe: the overlay effect must apply reducer intents (focus restore), and
 * the statusline must keep core segments when Insert has no text target.
 */
test("the overlay effect applies reducer intents instead of dropping focus restore", () => {
  const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  const marker = "if (interaction().overlay === overlay) return"
  const start = source.indexOf(marker)
  assert.ok(start >= 0, "the overlay effect is present")
  const body = source.slice(start, start + 300)
  assert.ok(
    body.includes('dispatchInteraction({ type: "overlay.set", overlay })'),
    "overlay transitions go through dispatchInteraction so focus-editor intents run",
  )
  assert.ok(
    !body.includes('interactionReducer(state, { type: "overlay.set", overlay }).state'),
    "the effect no longer keeps only the reducer state",
  )
})

test("Insert without a target keeps git, position, selection, and chord segments", () => {
  const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  assert.ok(!source.includes("insertWithoutTarget(interaction()) ? undefined"), "no status segment is suppressed by Insert without a target")
  for (const line of [
    "git: gitState()",
    "position: statusPosition()",
    "selectionSize: statusSelectionSize()",
    "pendingChord: interaction().pendingChord",
    'notice: insertWithoutTarget(interaction()) ? "no text target" : undefined',
  ]) {
    assert.ok(source.includes(line), `statusSegments keeps: ${line}`)
  }
  assert.ok(source.includes('if (insertWithoutTarget(interaction())) return "Esc normal"'), "only the typing hint becomes the Esc notice")
})

test("statusline and chrome render StyledText through the native content setter", () => {
  const source = readFileSync(new URL("./components.tsx", import.meta.url), "utf8")
  assert.ok(!source.includes("InlineSpan"), "no nested span styling helper")
  assert.ok(!source.includes("<span"), "no inline span children whose fg/bg are dropped")
  assert.ok(source.includes("function StyledLineText"), "the styled-line component exists")
  assert.ok(source.includes("value.content = content()"), "StyledText is assigned through the ref, not the JSX content prop")
})

test("the rail stays transparent and renders the leader as inline colored text", () => {
  const components = readFileSync(new URL("./components.tsx", import.meta.url), "utf8")
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  const rail = components.slice(components.indexOf("export function Rail"), components.indexOf("export function ApprovalList"))
  assert.ok(!rail.includes("backgroundColor={props.surface}"), "the rail no longer paints the opaque cutout surface")
  assert.ok(rail.includes("backgroundColor={props.colors.bg}"), "the rail uses the transparent theme background")
  assert.ok(!rail.includes("props.badge"), "the leader badge is not a boxed cutout")
  assert.ok(rail.includes("{chromeSeparator()}"), "the name and LEADER label share the chrome separator")
  assert.ok(rail.includes("fg={props.colors.leader}"), "the LEADER label uses the leader color")
  assert.ok(!app.includes("leaderBadge"), "the app no longer computes badge background/foreground pairs")
  assert.ok(rail.includes("const selected = () => props.cursor === index()"), "the rail cursor stays reactive between snapshot polls")
  assert.ok(!rail.includes("const selected = props.cursor === index()"), "the cursor is not captured as a one-time boolean")
})

test("ticket114: rail busy and resolving approvals render the shared Braille motion frame", () => {
  const components = readFileSync(new URL("./components.tsx", import.meta.url), "utf8")
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  const rail = components.slice(components.indexOf("export function Rail"), components.indexOf("export function ApprovalList"))
  const approvals = components.slice(components.indexOf("export function ApprovalList"))
  assert.ok(rail.includes("railBusyMark(busy, props.motionTick ?? 0, process.env)"), "rail busy uses the shared Braille marker")
  assert.ok(!rail.includes("◐"), "rail busy no longer draws a circle-family glyph")
  assert.ok(approvals.includes("approvalResolvingSuffix(props.resolvingID === approval.id, props.motionTick ?? 0, process.env)"), "resolving approvals pass the motion tick")
  assert.ok(app.includes("motionTick={motionFrame()}"), "the app threads the shared motion tick into chrome")
  assert.ok(app.includes("resolvingApprovalID() !== null"), "an in-flight approval keeps the motion clock running")
})

test("ticket101: the composer submits through the shared skill planner", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  assert.ok(app.includes('from "../skill-invocation.ts"'), "the TUI imports the shared planner")
  assert.ok(app.includes("commandPaletteCompletion(value, cursor)"), "the palette follows the caret")
  assert.ok(app.includes('const action = plan?.kind === "skills" ? "skill.send" : "message.send"'), "skill messages use the deliberate delivery action")
  assert.ok(app.includes('plan?.kind === "command" || plan?.kind === "init"'), "known commands still execute before send")
  assert.ok(!app.includes("slashCommands"), "one shared command catalog replaces the private palette list")
})

test("ticket115: Work renders active subtasks as cards with a full-width tide row", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  const components = readFileSync(new URL("./components.tsx", import.meta.url), "utf8")
  assert.ok(app.includes("workCardsForTasks(active, (item) => agentName(state(), item.assigneeID)"), "cards map the active subtask list")
  assert.ok(app.includes("workCardLayout(viewHeight(), cards.length)"), "card count follows the terminal height")
  assert.ok(app.includes("<WorkCardView"), "the app renders the shared card view")
  assert.ok(app.includes('workCards().layout.mode === "cards"'), "card mode is explicit")
  assert.ok(app.includes("orderedTasks().slice(0, workCards().layout.limit)"), "compact rows stay active-only and height-capped")
  assert.ok(app.includes("workCards().cards.slice(0, workCards().layout.limit)"), "cards stay active-only and height-capped")
  assert.ok(app.includes('selected={taskCursor() === index() && interaction().focus === "work"}'), "the existing work cursor selects card index")
  assert.ok(app.includes("motionFrame()"), "cards receive the shared motion tick")
  const workBlock = app.slice(app.indexOf("<Show when={showWorkBlock()}>"), app.indexOf("<Show when={!atBottom()}>"))
  assert.ok(workBlock.length > 0, "the Work block is present")
  assert.ok(!workBlock.includes("% complete") && !workBlock.includes("% done"), "cards never display a percentage")
  assert.ok(components.includes("export function WorkCardView"), "the card view lives in the shared component seam")
  assert.ok(components.includes("props.card.tideLevels.map"), "the tide strip colors one sample at a time")
  assert.ok(components.includes("TIDE_GLYPHS[level].repeat(2)"), "each tide sample covers two cells")
  assert.ok(!components.includes("<span"), "the tide strip is one styled line, not nested spans")
})

test("ticket116: Work cards use stable tide assignments and a gated 10 fps work clock", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  const tide = readFileSync(new URL("./tide.ts", import.meta.url), "utf8")
  assert.ok(app.includes("createTideAssignments()"), "one UI-local assignment state lives with the app")
  assert.ok(
    app.includes("variantFor: (item) => tideVariantFor(tideAssignments, item.id, now)"),
    "cards draw a stable variant from the assignment state",
  )
  assert.ok(app.includes("pruneTideAssignments(tideAssignments, now)"), "assignments are pruned after the retention window")
  assert.ok(app.includes("tideTick: workFrame()"), "the tide runs on the dedicated work clock")
  assert.ok(app.includes("shouldRunWorkClock("), "the work clock is gated by working cards and motion policy")
  assert.ok(app.includes("WORK_CLOCK_INTERVAL_MS"), "the work clock uses the approved 10 fps cadence")
  assert.ok(app.includes("setWorkFrame"), "the work clock owns its own tick signal")
  assert.ok(tide.includes("shuffleTideDeck"), "assignment uses a shuffled deck")
})

test("ticket120: every shell overlay fades in once without owning focus", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  const overlays = readFileSync(new URL("./overlays.ts", import.meta.url), "utf8")
  assert.ok(overlays.includes("export function overlayPresenceOpacity"), "the one-shot presence curve lives in the overlay helper seam")

  const effectStart = app.indexOf("let overlayPresenceTimer")
  const effectEnd = app.indexOf("const overlayOpacity", effectStart)
  assert.ok(effectStart >= 0 && effectEnd > effectStart, "the presence effect and opacity accessor are present")
  const effect = app.slice(effectStart, effectEnd)
  assert.ok(effect.includes("setInterval"), "the settle advances on a timer")
  assert.ok(effect.includes("clearInterval"), "the timer stops instead of looping")
  assert.ok(effect.includes("isReducedMotion"), "reduced motion skips the ramp")
  assert.ok(!effect.includes("dispatchInteraction"), "presence never changes focus, mode, overlay ownership, or keys")

  const panelKeyStart = app.indexOf("const overlayPanelKey = ()")
  const panelKeyEnd = app.indexOf("let overlayPresenceTimer", panelKeyStart)
  assert.ok(panelKeyStart >= 0 && panelKeyEnd > panelKeyStart, "the presence panel key is present")
  const panelKey = app.slice(panelKeyStart, panelKeyEnd)
  for (const panel of ["helpOpen()", "approvalsOpen()", "leaderPopup()"]) {
    assert.ok(panelKey.includes(panel), `the presence key includes ${panel}`)
  }
  assert.equal(
    (app.match(/opacity=\{overlayOpacity\(\)\}/g) ?? []).length,
    8,
    "picker, prompt, confirm, result, wizard, help, approvals, and leader which-key share the settle",
  )
  assert.ok(app.includes('if (key === "none") return 1'), "closing restores full opacity immediately")
  assert.equal(
    (app.match(/opacity=\{overlayOpen\(\) \? 0\.35 : 1\}/g) ?? []).length,
    3,
    "the background panes stay dimmed while an overlay is open",
  )
})

test("ticket121: rail attention pulses once and settles without owning focus", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  const components = readFileSync(new URL("./components.tsx", import.meta.url), "utf8")
  const rail = components.slice(components.indexOf("export function Rail"), components.indexOf("export function ApprovalList"))

  const effectStart = app.indexOf("const railAttentionInput")
  const effectEnd = app.indexOf("const commandTarget", effectStart)
  assert.ok(effectStart >= 0 && effectEnd > effectStart, "the rail attention effect is present")
  const effect = app.slice(effectStart, effectEnd)
  assert.ok(effect.includes("observeRailAttention"), "transitions come from the pure rail seam")
  assert.ok(effect.includes("railEmphasisAt"), "active emphasis is resolved from one-shot starts")
  assert.ok(effect.includes("setInterval"), "pulses advance on a timer")
  assert.ok(effect.includes("clearInterval"), "the pulse timer stops when the window closes")
  assert.ok(effect.includes("isReducedMotion"), "reduced motion never starts a pulse")
  assert.ok(!effect.includes("dispatchInteraction"), "rail attention never changes focus, mode, or key routing")
  assert.ok(app.includes("emphasis={railEmphasis()}"), "the app threads one-shot emphasis into the rail")

  assert.ok(rail.includes("props.emphasis?.unread.has(item.id)"), "unread growth pulses the count")
  assert.ok(rail.includes("props.emphasis?.approval"), "the approval count pulses")
  assert.ok(rail.includes("props.emphasis?.arrivals.has(railRowKey(item.kind, item.id))"), "new rows use the quiet arrival set")
  assert.ok(rail.includes("const rowTone = () => selected() ? props.colors.good"), "selection wins over arrival emphasis")
  assert.ok(rail.includes("const selected = () => props.cursor === index()"), "the rail cursor stays reactive between polls")
  assert.equal((rail.match(/borderColor=/g) ?? []).length, 1, "the rail keeps one focus border")
  assert.ok(rail.includes("railBusyMark(busy, props.motionTick ?? 0, process.env)"), "the Braille busy count is unchanged")
})

test("ticket126: approvals render arrival emphasis, Braille resolving, and a one-shot resolution settle", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  const components = readFileSync(new URL("./components.tsx", import.meta.url), "utf8")
  const approvals = components.slice(components.indexOf("export function ApprovalList"))

  assert.ok(app.includes("updateApprovalInboxMotion("), "the app tracks approval arrivals and resolutions")
  assert.ok(app.includes("approvalMotion().emphasized"), "the inbox receives the one-shot arrival set")
  assert.ok(app.includes("approvalMotion().resolved"), "the inbox receives the recent resolution settle")
  assert.ok(app.includes("motionTick={motionFrame()}"), "the Braille resolve frame keeps the shared motion tick")

  assert.ok(approvals.includes("props.emphasized.has(approval.id)"), "a newly arrived approval gets the one-shot emphasis")
  assert.ok(approvals.includes("approvalResolvingSuffix("), "the resolving row keeps its Braille state")
  assert.ok(approvals.includes("approvalResolvedLine("), "resolved rows render their settle line")
  assert.ok(approvals.includes("approvalResolvedTone("), "resolved rows settle their tone once")
  assert.ok(approvals.includes("props.resolved"), "the inbox renders recent resolved rows")
})

test("System Agent rows use one attribution source and never fall through to native /init", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  assert.ok(app.includes("author: message.displayAuthor ?? "), "the transcript maps the display author into the one rendered author")
  const guard = app.indexOf("const initIssue = initComposerIssue(text)")
  const command = app.indexOf("parseSlashCommand(text)")
  assert.ok(guard >= 0 && command > guard, "the composer rejects mixed init text before slash-command fallthrough")
  assert.ok(app.includes('invoke(context, "workspace.init", { id: workspace.id, text: "/init" })'), "every trigger sends the normalized /init audit text")
  assert.ok(!app.includes('"AGENTS.md initialized in '), "init no longer claims completion before the System Agent job finishes")
})

test("ticket103: General triage, owner choice, and direct rejection stay on the shared planner", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  assert.ok(app.includes("directSkillIssue("), "direct conversations reject General skills through the shared helper")
  assert.ok(app.includes("const directSurface = surface()?.kind === \"agent\""), "Direct slash tokens are validated as skills, not unknown commands")
  assert.ok(app.includes('await openChoice(\n          `Owner for /${choice.skillID}`'), "the TUI offers the owner picker before sending")
  assert.ok(app.includes("ownerSelections"), "the chosen owner is sent to the server authoritative re-plan")
  assert.ok(app.includes('row.executor === "init" ? "init"'), "the built-in init row runs the System Agent init job")
})

test("ticket119: app feedback paints the app toast and host toast is fallback-only", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  const components = readFileSync(new URL("./components.tsx", import.meta.url), "utf8")
  assert.equal((app.match(/context\.ui\.toast\.show/g) ?? []).length, 1, "one host-toast call site remains")
  const fallback = app.indexOf("const showHostToast")
  assert.ok(fallback >= 0 && app.indexOf("context.ui.toast.show") > fallback, "the host toast lives in the fallback helper")
  assert.ok(app.includes('if (!isOurRoute()) { showHostToast(input); return }'), "the host fallback only runs when the app surface is not visible")
  assert.ok(app.includes('feedbackChannel(isToastModal()) === "statusline"'), "modal feedback goes to the statusline")
  assert.ok(app.includes("pushToast(state, input, Date.now())"), "app feedback enters the bounded queue")
  assert.ok(app.includes("expireToasts(state, Date.now())"), "the one visible toast expires through the pure model")
  assert.ok(app.includes("toastPlacement(viewWidth())"), "the app anchors the toast with the bounded geometry helper")
  assert.ok(app.includes("initToast(job.state, job.error)"), "terminal init jobs report through the app toast")
  assert.ok(app.includes("describeGitChange(gitState(), next)"), "git changes report through the app toast")
  assert.ok(components.includes("export function ToastOverlay"), "the app-owned toast component exists")
  assert.ok(components.includes("borderColor={accent()}"), "the toast tone owns its border color")
  assert.ok(components.includes("zIndex={80}"), "the toast stays below dialogs and the leader popup")
  assert.ok(components.includes("createSignal(isReducedMotion())"), "reduced motion mounts the toast at its final state")
  assert.ok(components.includes("opacity={settled() ? 1 : 0.72}"), "the presence settle is a single opacity change")
  const toastView = components.slice(components.indexOf("export function ToastOverlay"), components.indexOf("export function Rail"))
  assert.ok(!toastView.includes("textarea") && !toastView.includes("onKey"), "the toast mounts no editor and owns no keys")
})

test("ticket123: composer validation is non-destructive and clears on input or success", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")

  const command = app.slice(app.indexOf("const runSlashCommand"), app.indexOf("const handleComposerInput"))
  const unknownGuard = command.indexOf("if (!known)")
  assert.ok(unknownGuard >= 0, "the command dispatcher validates the command name first")
  assert.ok(unknownGuard < command.indexOf("resetComposer()"), "an invalid command returns before the consuming reset, preserving the draft")
  assert.ok(command.includes("markComposerInvalid(message)"), "an invalid command starts the one-shot bad-border state")

  const input = app.slice(app.indexOf("const handleComposerInput"), app.indexOf("const moveCompletion"))
  assert.ok(input.includes("clearComposerValidation()"), "typing clears the validation state")

  const submit = app.slice(app.indexOf("const submitComposer"), app.indexOf("const handleComposerKey"))
  assert.ok(submit.includes("markComposerInvalid(initIssue)"), "rejected init text keeps the draft and shows the bad border")
  assert.ok(submit.includes("send(text, undefined, markComposerInvalid)"), "send validation failures show the bad border")
  assert.ok(submit.includes('clearComposerValidation("send-success")'), "a successful send clears the validation state")

  assert.ok(app.includes("borderColor={composerBorderColor()}"), "the composer border consumes the validation role")
  assert.ok(app.includes('if (role === "bad") return colors.bad'), "the bad role uses the theme error color")
  assert.ok(app.includes("height={composerHeight()}"), "the composer height path is unchanged")
  assert.ok(app.includes('{ name: "return", action: "submit" }'), "Enter still submits through the textarea binding")
})
