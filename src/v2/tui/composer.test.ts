import test from "node:test"
import assert from "node:assert/strict"
import {
  COMPOSER_VALIDATION_MS,
  composerHeight,
  composerTrigger,
  composerValidationBorder,
  composerValidationReducer,
  insertAgentMention,
  insertFileReference,
  fileReferenceTokenAt,
  paletteRowTitle,
  parseSlashCommand,
  replaceFileReference,
} from "./composer.ts"
import { fuzzyMatch } from "./format.ts"

test("composer triggers only at the start of a token", () => {
  assert.equal(composerTrigger("/"), "command")
  assert.equal(composerTrigger("/workspace"), undefined)
  assert.equal(composerTrigger("$"), "agent")
  assert.equal(composerTrigger("hello $"), "agent")
  assert.equal(composerTrigger("hello$"), undefined)
  assert.equal(composerTrigger("@"), "file")
  assert.equal(composerTrigger("read @"), "file")
  assert.equal(composerTrigger("@handover.md"), "file")
  assert.equal(composerTrigger("read @my\\ notes.md"), "file")
  assert.equal(composerTrigger("mail@example.com"), undefined)
  assert.equal(composerTrigger("plain"), undefined)
})

test("mention and file insertion preserve existing text", () => {
  assert.equal(insertAgentMention("", "Nova"), "$Nova ")
  assert.equal(insertAgentMention("hello $", "Nova"), "hello $Nova ")
  assert.equal(insertFileReference("", "src/app.ts"), "@src/app.ts ")
  assert.equal(insertFileReference("read @", "src/app.ts"), "read @src/app.ts ")
})

test("slash commands parse name and arguments", () => {
  assert.deepEqual(parseSlashCommand("/workspace"), { command: "workspace", args: [] })
  assert.deepEqual(parseSlashCommand("  /agent Nova  "), { command: "agent", args: ["Nova"] })
  assert.equal(parseSlashCommand("/"), undefined)
  assert.equal(parseSlashCommand("hello"), undefined)
  assert.equal(parseSlashCommand(" / "), undefined)
})

test("composer height follows wrapping and newlines but caps growth", () => {
  assert.equal(composerHeight("", 20), 1)
  assert.equal(composerHeight("short", 20), 1)
  assert.equal(composerHeight("one two three four five six", 10), 3)
  assert.equal(composerHeight("a\nb\nc", 20), 3)
  assert.equal(composerHeight("x".repeat(200), 20), 8)
})

test("invalid input starts one bad-border signal and keeps its message", () => {
  const state = composerValidationReducer(null, { type: "invalid", message: "Unknown command: /nope", at: 1_000 })
  assert.equal(state?.message, "Unknown command: /nope")
  assert.equal(state?.startedAt, 1_000)
  assert.equal(composerValidationBorder(state, 1_000), "bad")
  assert.equal(composerValidationBorder(null, 1_000), undefined)
})

test("typing clears the composer validation signal", () => {
  const invalid = composerValidationReducer(null, { type: "invalid", message: "Unknown command: /nope", at: 1_000 })
  assert.equal(composerValidationReducer(invalid, { type: "input" }), null)
})

test("a successful send clears the composer validation signal", () => {
  const invalid = composerValidationReducer(null, { type: "invalid", message: "Unknown skill: /nope.", at: 1_000 })
  assert.equal(composerValidationReducer(invalid, { type: "send-success" }), null)
})

test("the validation signal expires after one short window and never loops", () => {
  const invalid = composerValidationReducer(null, { type: "invalid", message: "Unknown command: /nope", at: 1_000 })
  const atExpiry = 1_000 + COMPOSER_VALIDATION_MS
  assert.equal(composerValidationReducer(invalid, { type: "tick", at: atExpiry - 1 }), invalid)
  assert.equal(composerValidationReducer(invalid, { type: "tick", at: atExpiry }), null)
  assert.equal(composerValidationBorder(invalid, atExpiry), undefined)
  assert.equal(composerValidationBorder(invalid, atExpiry + COMPOSER_VALIDATION_MS * 10), undefined)
})

test("motion shows one bounded bad-to-default pulse, then the border settles", () => {
  const invalid = composerValidationReducer(null, { type: "invalid", message: "Unknown command: /nope", at: 1_000 })
  assert.deepEqual(
    [
      composerValidationBorder(invalid, 1_000),
      composerValidationBorder(invalid, 1_000 + COMPOSER_VALIDATION_MS / 2 - 1),
      composerValidationBorder(invalid, 1_000 + COMPOSER_VALIDATION_MS / 2),
      composerValidationBorder(invalid, 1_000 + COMPOSER_VALIDATION_MS - 1),
      composerValidationBorder(invalid, 1_000 + COMPOSER_VALIDATION_MS),
    ],
    ["bad", "bad", "default", "default", undefined],
  )
})

test("reduced motion keeps the bad border color without any pulse", () => {
  const invalid = composerValidationReducer(null, { type: "invalid", message: "Unknown command: /nope", at: 1_000 })
  const roles: Array<string | undefined> = []
  for (let elapsed = 0; elapsed < COMPOSER_VALIDATION_MS; elapsed += 100) {
    roles.push(composerValidationBorder(invalid, 1_000 + elapsed, true))
  }
  assert.ok(roles.length > 0)
  assert.deepEqual(new Set(roles), new Set(["bad"]))
  assert.equal(composerValidationBorder(invalid, 1_000 + COMPOSER_VALIDATION_MS, true), undefined)
})

test("file completion queries only the bounded token and keeps the sentence", () => {
  const text = "read @hand the git log"
  const token = fileReferenceTokenAt(text, "read @hand".length)
  assert.ok(token)
  assert.deepEqual({ start: token.start, end: token.end, path: token.path }, { start: 5, end: 10, path: "hand" })

  const files = ["handover.md", "handbook.md", "notes.md"]
  const matches = files.filter((file) => fuzzyMatch(token.path, file))
  assert.deepEqual(matches, ["handover.md", "handbook.md"])
  assert.deepEqual(replaceFileReference(text, matches[0], token.start, token.end), {
    text: "read @handover.md the git log",
    cursor: "read @handover.md ".length,
  })
})

test("a space closes file completion and cursor moves outside close it", () => {
  assert.equal(fileReferenceTokenAt("read @hand ", "read @hand ".length), undefined)
  assert.equal(fileReferenceTokenAt("read @hand the git log", "read @hand the git log".length), undefined)
  assert.ok(fileReferenceTokenAt("read @hand the git log", "read @hand".length))
})

test("palette rows lead with their flag so a narrow chat cell keeps the owner", () => {
  const title = paletteRowTitle("ensemble-live-skill — Deterministic Ensemble live skill for multi-anchor routing.", "Skill | FakeAgent")
  assert.ok(title.startsWith("Skill | FakeAgent"), title)
  assert.match(title, /ensemble-live-skill/, "the skill name follows the flag")
  assert.equal(paletteRowTitle("restart", "Command"), "Command │ restart")
})

test("escaped-space paths complete and reinsert without losing the suffix", () => {
  const text = "read @my\\ notes.md and the rest"
  const cursor = "read @my\\ notes.md".length
  const token = fileReferenceTokenAt(text, cursor)
  assert.ok(token)
  assert.equal(token.path, "my notes.md")
  assert.deepEqual(replaceFileReference(text, "my notes v2.md", token.start, token.end), {
    text: "read @my\\ notes\\ v2.md and the rest",
    cursor: "read @my\\ notes\\ v2.md ".length,
  })
})
