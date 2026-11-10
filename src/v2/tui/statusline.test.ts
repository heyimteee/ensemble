import test from "node:test"
import assert from "node:assert/strict"
import {
  COMMAND_CARET,
  buildStatuslineSegments,
  commandCaretLayout,
  composerPosition,
  contextLabel,
  fitStatuslineSegments,
  formatStatuslineSegments,
  gitLabel,
  gitSegments,
  listPosition,
  modeChipRole,
  modeLabel,
  nativeSyncSegment,
  statuslineRow1,
  statuslineRow2,
  statuslineRow2Parts,
  statuslineRow2PromptParts,
  transcriptPosition,
} from "./statusline.ts"

test("mode chip names Normal, Insert, Command, and both Visual kinds in text", () => {
  assert.equal(modeLabel("normal"), "NORMAL")
  assert.equal(modeLabel("insert"), "INSERT")
  assert.equal(modeLabel("command"), "COMMAND")
  assert.equal(modeLabel("visual", "char"), "VISUAL")
  assert.equal(modeLabel("visual", "line"), "V-LINE")
})

test("each mode gets its own theme chip role, with a leader override", () => {
  assert.equal(modeChipRole("normal"), "muted")
  assert.equal(modeChipRole("insert"), "good")
  assert.equal(modeChipRole("visual"), "warn")
  assert.equal(modeChipRole("command"), "accent")
  assert.equal(modeChipRole("normal", true), "leader")
})

test("context names the active surface and overlay precedence", () => {
  assert.equal(contextLabel({ focus: "agents", overlay: "none", surface: "none" }), "Agents")
  assert.equal(contextLabel({ focus: "workspaces", overlay: "none", surface: "none" }), "Workspaces")
  assert.equal(contextLabel({ focus: "chat", overlay: "none", surface: "workspace" }), "Group chat")
  assert.equal(contextLabel({ focus: "work", overlay: "none", surface: "workspace" }), "Work list")
  assert.equal(contextLabel({ focus: "approvals", overlay: "none", surface: "workspace" }), "Work approvals", "inline approvals are their own Work zone")
  assert.equal(contextLabel({ focus: "approvals", overlay: "none", surface: "workspace", approvals: "split" }), "Work approvals")
  assert.equal(contextLabel({ focus: "approvals", overlay: "none", surface: "workspace", approvals: "full" }), "Approvals", "full approvals replace Work")
  assert.equal(contextLabel({ focus: "chat", overlay: "none", surface: "agent" }), "Direct conversation")
  assert.equal(contextLabel({ focus: "composer", overlay: "none", surface: "workspace" }), "COMPOSER │ Group chat")
  assert.equal(contextLabel({ focus: "composer", overlay: "none", surface: "agent" }), "COMPOSER │ Direct conversation")
  assert.equal(contextLabel({ focus: "chat", overlay: "settings", surface: "agent" }), "Settings")
  assert.equal(contextLabel({ focus: "chat", overlay: "wizard", surface: "workspace" }), "Wizard")
  assert.equal(contextLabel({ focus: "chat", overlay: "dialog", surface: "workspace" }), "Dialog")
  assert.equal(contextLabel({ focus: "chat", overlay: "help", surface: "workspace" }), "Help")
  assert.equal(contextLabel({ focus: "settings", overlay: "none", surface: "agent" }), "Settings")
  assert.equal(contextLabel({ focus: "wizard", overlay: "none", surface: "workspace" }), "Wizard")
})

test("git state renders branch, dirty mark, ahead, and behind", () => {
  assert.equal(gitLabel(null), "git:(-)")
  assert.equal(gitLabel({ branch: "main", dirty: false, ahead: 0, behind: 0 }), "git:(main)")
  assert.equal(gitLabel({ branch: "main", dirty: true, ahead: 2, behind: 3 }), "git:(main*) ↑2 ↓3")
})

test("git segments color the label, branch, dirty mark, ahead, and behind with distinct tones", () => {
  const segment = gitSegments({ branch: "main", dirty: true, ahead: 2, behind: 1 })
  assert.equal(segment.kind, "git")
  assert.deepEqual(
    segment.parts.map((part) => [part.text, part.tone]),
    [
      ["git", "muted"],
      [":", "faint"],
      ["(", "faint"],
      ["main", "info"],
      ["*", "warn"],
      [")", "faint"],
      [" ↑2", "good"],
      [" ↓1", "bad"],
    ],
  )
})

test("position names composer line:col and list row/total", () => {
  assert.equal(composerPosition("hello", 5), "1:6")
  assert.equal(composerPosition("hello\nworld", 8), "2:3")
  assert.equal(composerPosition("", 0), "1:1")
  assert.equal(listPosition(0, 4), "1/4")
  assert.equal(listPosition(9, 4), "4/4")
  assert.equal(listPosition(0, 0), "0/0")
})

test("row one always carries mode, context, git, position, chord, and hints", () => {
  const row = statuslineRow1({
    mode: "insert",
    context: "Composer │ Group chat",
    git: { branch: "main", dirty: true, ahead: 1, behind: 0 },
    position: "2:4",
    pendingChord: "g",
    hints: "enter send │ esc normal",
  })
  assert.equal(
    row,
    "INSERT │ Composer │ Group chat │ git:(main*) ↑1 │ 2:4 │ chord g │ enter send │ esc normal",
  )
  assert.ok(row.startsWith("INSERT"), "mode is the first visible segment")
})

test("row one omits empty optional segments but still names mode and context", () => {
  assert.equal(statuslineRow1({ mode: "normal", context: "Roster" }), "NORMAL │ Roster")
})

test("row one names the Visual kind and the selection size", () => {
  assert.equal(
    statuslineRow1({
      mode: "visual",
      visualKind: "line",
      context: "COMPOSER │ Group chat",
      position: "1:1",
      selectionSize: "2 lines",
    }),
    "V-LINE │ COMPOSER │ Group chat │ 2 lines │ 1:1",
  )
  assert.equal(
    statuslineRow1({ mode: "visual", visualKind: "char", context: "Settings", selectionSize: "5 chars" }),
    "VISUAL │ Settings │ 5 chars",
  )
})

test("typed segments color the mode chip, context, selection, position, chord, and hint parts", () => {
  const segments = buildStatuslineSegments({
    mode: "insert",
    context: "Roster",
    git: { branch: "main", dirty: false, ahead: 0, behind: 0 },
    position: "1:1",
    selectionSize: "3 chars",
    pendingChord: "g",
    hints: "enter send │ esc normal",
  })
  assert.deepEqual(segments.map((segment) => segment.kind), ["mode", "context", "selection", "git", "position", "chord", "hint", "hint"])
  assert.deepEqual(segments[0].parts, [{ text: "INSERT", tone: "chip", chip: "good", padding: 1 }])
  assert.deepEqual(segments[1].parts, [{ text: "Roster", tone: "muted" }])
  assert.deepEqual(segments[2].parts, [{ text: "3 chars", tone: "warn" }])
  assert.deepEqual(segments[4].parts, [{ text: "1:1", tone: "accent" }])
  assert.deepEqual(segments[5].parts, [{ text: "chord g", tone: "warn" }])
  assert.deepEqual(segments[6].parts, [
    { text: "enter", tone: "accent" },
    { text: " send", tone: "muted" },
  ])
  assert.deepEqual(segments[7].parts, [
    { text: "esc", tone: "accent" },
    { text: " normal", tone: "muted" },
  ])
})

test("a leader chip stays distinct from the persistent mode", () => {
  const segments = buildStatuslineSegments({ mode: "normal", context: "Roster", leader: true, hints: "j/k move" })
  assert.deepEqual(segments[0].parts, [{ text: "NORMAL", tone: "chip", chip: "leader", padding: 1 }])
})

test("an Insert-without-target notice keeps core status segments", () => {
  const segments = buildStatuslineSegments({
    mode: "insert",
    context: "Wizard",
    notice: "no text target",
    git: { branch: "main", dirty: false, ahead: 0, behind: 0 },
    position: "1/3",
    selectionSize: "2 chars",
    pendingChord: "g",
    hints: "Esc normal",
  })
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["mode", "context", "selection", "git", "position", "chord", "notice", "hint"],
  )
  assert.deepEqual(segments.find((segment) => segment.kind === "notice")?.parts, [{ text: "no text target", tone: "muted" }])
  assert.equal(formatStatuslineSegments(segments), "INSERT │ Wizard │ 2 chars │ git:(main) │ 1/3 │ chord g │ no text target │ Esc normal")
})

test("fitting drops hint segments from the right before any core segment", () => {
  const segments = buildStatuslineSegments({
    mode: "insert",
    context: "Roster",
    git: { branch: "main", dirty: false, ahead: 0, behind: 0 },
    position: "1:1",
    pendingChord: "g",
    hints: "j/k move │ enter open │ esc back",
  })
  const width = "INSERT │ Roster │ git:(main) │ 1:1 │ chord g │ j/k move".length + 2
  const fitted = fitStatuslineSegments(segments, width)
  assert.deepEqual(fitted.map((segment) => segment.kind), ["mode", "context", "git", "position", "chord", "hint"])
  assert.equal(formatStatuslineSegments(fitted), "INSERT │ Roster │ git:(main) │ 1:1 │ chord g │ j/k move")
})

test("the mode chip survives every width; optional core segments drop after hints", () => {
  const segments = buildStatuslineSegments({
    mode: "normal",
    context: "A very long context label",
    git: { branch: "main", dirty: false, ahead: 0, behind: 0 },
    position: "1:1",
    hints: "j/k move │ enter open",
  })
  assert.deepEqual(fitStatuslineSegments(segments, 40).map((segment) => segment.kind), ["mode", "context"])
  assert.deepEqual(fitStatuslineSegments(segments, 1).map((segment) => segment.kind), ["mode"])
})

test("zero and negative widths keep the mandatory mode chip instead of leaking every segment", () => {
  const segments = buildStatuslineSegments({
    mode: "insert",
    context: "Direct conversation",
    git: { branch: "main", dirty: false, ahead: 0, behind: 0 },
    position: "1:1",
    hints: "enter send",
  })
  for (const width of [0, -1, -100]) {
    const fitted = fitStatuslineSegments(segments, width)
    assert.deepEqual(fitted.map((segment) => segment.kind), ["mode"], `width ${width} keeps only the mode chip`)
  }
  assert.deepEqual(fitStatuslineSegments(segments, Number.NaN).map((segment) => segment.kind), segments.map((segment) => segment.kind), "an unknown width is not treated as zero")
})

test("row two renders the prompt, a visible line caret, else a transient message, else a reserved blank", () => {
  assert.equal(statuslineRow2({ prompt: ":", text: "", cursor: 0 }), `:${COMMAND_CARET}`, "an empty command line keeps its caret")
  assert.equal(statuslineRow2({ prompt: ":", text: "settings", cursor: 8 }), `:settings${COMMAND_CARET}`)
  assert.equal(statuslineRow2({ prompt: "/", text: "", cursor: 0 }), `/${COMMAND_CARET}`, "an empty search line keeps its caret")
  assert.equal(statuslineRow2({ prompt: "/", text: "agent", cursor: 5 }), `/agent${COMMAND_CARET}`)
  assert.equal(statuslineRow2({ prompt: "/", text: "agent", cursor: 2 }), `/ag${COMMAND_CARET}ent`, "the caret sits at the cursor")
  assert.equal(statuslineRow2({ message: "Message sent" }), "Message sent")
  assert.equal(statuslineRow2({}), " ")
  assert.equal(statuslineRow2({ prompt: null, message: "" }), " ", "an empty message keeps the reserved row")
})

test("the command prompt renders separately from the caret line and never truncates", () => {
  assert.deepEqual(statuslineRow2PromptParts({ prompt: ":", text: "settings", cursor: 8 }), [{ text: ":", tone: "accent" }])
  assert.deepEqual(statuslineRow2PromptParts({ prompt: "/", text: "agent", cursor: 5 }), [{ text: "/", tone: "accent" }])
  assert.deepEqual(statuslineRow2PromptParts({ message: "Saved" }), [])
})

test("row two colors the prompt and caret, and keeps the full input at any width", () => {
  const long = "a".repeat(300)
  assert.equal(statuslineRow2({ prompt: ":", text: long, cursor: long.length }), `:${long}${COMMAND_CARET}`)
  assert.deepEqual(statuslineRow2Parts({ prompt: ":", text: "settings", cursor: 8 }), [
    { text: "settings", tone: "text" },
    { text: COMMAND_CARET, tone: "accent" },
  ])
  assert.deepEqual(statuslineRow2Parts({ message: "Saved", tone: "success" }), [{ text: "Saved", tone: "good" }])
  assert.deepEqual(statuslineRow2Parts({ message: "Failed", tone: "error" }), [{ text: "Failed", tone: "bad" }])
  assert.deepEqual(statuslineRow2Parts({ message: "Note" }), [{ text: "Note", tone: "faint" }])
  assert.deepEqual(statuslineRow2Parts({}), [{ text: " ", tone: "faint" }])
})

test("command caret layout scrolls horizontally so the caret stays visible", () => {
  assert.deepEqual(commandCaretLayout("settings", 8, 20), { before: "settings", after: "", scrolled: false })
  assert.deepEqual(commandCaretLayout("abcdef", 4, 3), { before: "cd", after: "", scrolled: true })
  assert.deepEqual(commandCaretLayout("abc", 2, 1), { before: "", after: "", scrolled: true }, "a one-cell viewport still shows the caret")
  assert.deepEqual(commandCaretLayout("日x", 1, 3), { before: "日", after: "", scrolled: false }, "wide cells count as two columns")
  assert.deepEqual(commandCaretLayout("abcdef", 99, 4), { before: "def", after: "", scrolled: true }, "a stale cursor clamps before laying out")
  assert.deepEqual(commandCaretLayout("abc", 1, 20), { before: "a", after: "bc", scrolled: false })
})

test("transcript position is a real scroll percentage, not a boolean label", () => {
  assert.equal(transcriptPosition(0, 500, 100), "0%")
  assert.equal(transcriptPosition(200, 500, 100), "50%")
  assert.equal(transcriptPosition(400, 500, 100), "100%")
  assert.equal(transcriptPosition(999, 500, 100), "100%", "over-scroll clamps to the bottom")
  assert.equal(transcriptPosition(-10, 500, 100), "0%", "negative scroll clamps to the top")
  assert.equal(transcriptPosition(0, 80, 100), "100%", "content shorter than the viewport is fully visible")
  assert.equal(transcriptPosition(0, 0, 0), "100%")
})

test("ticket218: native sync shows live, reconciling, or degraded and never carries a reason", () => {
  assert.deepEqual(nativeSyncSegment("live").parts.map((part) => [part.text, part.tone]), [
    ["native", "muted"],
    [":", "faint"],
    ["live", "good"],
  ])
  assert.equal(nativeSyncSegment("reconciling").parts.at(-1)?.tone, "warn")
  assert.equal(nativeSyncSegment("degraded").parts.at(-1)?.tone, "bad")
  const segments = buildStatuslineSegments({ mode: "normal", context: "Roster", nativeSync: "degraded", git: null })
  assert.deepEqual(segments.map((segment) => segment.kind), ["mode", "context", "native", "git"])
  assert.equal(statuslineRow1({ mode: "normal", context: "Roster", nativeSync: "reconciling" }).includes("native:reconciling"), true)
  assert.deepEqual(buildStatuslineSegments({ mode: "normal", context: "Roster" }).map((segment) => segment.kind), ["mode", "context"])
})
