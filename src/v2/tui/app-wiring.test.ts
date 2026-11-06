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
