import test from "node:test"
import assert from "node:assert/strict"
import {
  composerPosition,
  contextLabel,
  gitLabel,
  listPosition,
  modeLabel,
  statuslineRow1,
  statuslineRow2,
} from "./statusline.ts"

test("mode chip names Normal, Insert, and Command in text, never color alone", () => {
  assert.equal(modeLabel("normal"), "NORMAL")
  assert.equal(modeLabel("insert"), "INSERT")
  assert.equal(modeLabel("command"), "COMMAND")
})

test("context names the active surface and overlay precedence", () => {
  assert.equal(contextLabel({ focus: "rail", overlay: "none", surface: "none" }), "Roster")
  assert.equal(contextLabel({ focus: "chat", overlay: "none", surface: "workspace" }), "Group chat")
  assert.equal(contextLabel({ focus: "work", overlay: "none", surface: "workspace" }), "Work list")
  assert.equal(contextLabel({ focus: "chat", overlay: "none", surface: "agent" }), "Direct conversation")
  assert.equal(contextLabel({ focus: "composer", overlay: "none", surface: "workspace" }), "COMPOSER · Group chat")
  assert.equal(contextLabel({ focus: "composer", overlay: "none", surface: "agent" }), "COMPOSER · Direct conversation")
  assert.equal(contextLabel({ focus: "chat", overlay: "settings", surface: "agent" }), "Settings")
  assert.equal(contextLabel({ focus: "chat", overlay: "wizard", surface: "workspace" }), "Wizard")
  assert.equal(contextLabel({ focus: "chat", overlay: "dialog", surface: "workspace" }), "Dialog")
  assert.equal(contextLabel({ focus: "chat", overlay: "approvals", surface: "workspace" }), "Approvals")
  assert.equal(contextLabel({ focus: "chat", overlay: "help", surface: "workspace" }), "Help")
  assert.equal(contextLabel({ focus: "settings", overlay: "none", surface: "agent" }), "Settings")
  assert.equal(contextLabel({ focus: "wizard", overlay: "none", surface: "workspace" }), "Wizard")
})

test("git state renders branch, dirty mark, ahead, and behind", () => {
  assert.equal(gitLabel(null), "git:(-)")
  assert.equal(gitLabel({ branch: "main", dirty: false, ahead: 0, behind: 0 }), "git:(main)")
  assert.equal(gitLabel({ branch: "main", dirty: true, ahead: 2, behind: 3 }), "git:(main*) ↑2 ↓3")
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
    context: "Composer · Group chat",
    git: { branch: "main", dirty: true, ahead: 1, behind: 0 },
    position: "2:4",
    pendingChord: "g",
    hints: "enter send · esc normal",
  })
  assert.equal(
    row,
    "INSERT · Composer · Group chat · git:(main*) ↑1 · 2:4 · chord g · enter send · esc normal",
  )
  assert.ok(row.startsWith("INSERT"), "mode is the first visible segment")
})

test("row one omits empty optional segments but still names mode and context", () => {
  assert.equal(statuslineRow1({ mode: "normal", context: "Roster" }), "NORMAL · Roster")
})

test("row two renders command input, else a transient message, else a reserved blank", () => {
  assert.equal(statuslineRow2({ command: { kind: ":", text: "" } }), ":", "an empty command line stays visible")
  assert.equal(statuslineRow2({ command: { kind: ":", text: "settings" } }), ":settings")
  assert.equal(statuslineRow2({ command: { kind: "/", text: "" } }), "/", "an empty search line stays visible")
  assert.equal(statuslineRow2({ command: { kind: "/", text: "agent" } }), "/agent")
  assert.equal(statuslineRow2({ message: "Message sent" }), "Message sent")
  assert.equal(statuslineRow2({}), " ")
  assert.equal(statuslineRow2({ command: null, message: "" }), " ", "an empty message keeps the reserved row")
})
