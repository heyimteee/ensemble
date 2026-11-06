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
  parseSlashCommand,
} from "./composer.ts"

test("composer triggers only at the start of a token", () => {
  assert.equal(composerTrigger("/"), "command")
  assert.equal(composerTrigger("/workspace"), undefined)
  assert.equal(composerTrigger("$"), "agent")
  assert.equal(composerTrigger("hello $"), "agent")
  assert.equal(composerTrigger("hello$"), undefined)
  assert.equal(composerTrigger("@"), "file")
  assert.equal(composerTrigger("read @"), "file")
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
