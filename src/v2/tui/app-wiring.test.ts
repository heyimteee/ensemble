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

test("System Agent display authors render as left bubbles and never fall through to native /init", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  const components = readFileSync(new URL("./components.tsx", import.meta.url), "utf8")
  assert.ok(components.includes("displayAuthor?: string"), "ChatLine carries a non-roster display author")
  assert.ok(app.includes("message.displayAuthor ?? "), "the transcript prefers the display author over roster lookup")
  assert.ok(app.includes("displayAuthor: message.displayAuthor"), "the display author survives into the rendered line")
  assert.ok(
    app.includes("authorColor({ agentID: message.agentID, author: message.author, displayAuthor: message.displayAuthor, role: message.role })"),
    "the System Agent keeps its information author color",
  )
  const guard = app.indexOf("const initIssue = initComposerIssue(text)")
  const command = app.indexOf("if (parseSlashCommand(text))")
  assert.ok(guard >= 0 && command > guard, "the composer rejects mixed init text before slash-command fallthrough")
  assert.ok(app.includes('invoke(context, "workspace.init", { id: workspace.id, text: "/init" })'), "every trigger sends the normalized /init audit text")
  assert.ok(!app.includes('"AGENTS.md initialized in '), "init no longer claims completion before the System Agent job finishes")
})


