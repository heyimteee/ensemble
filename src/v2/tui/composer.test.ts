import test from "node:test"
import assert from "node:assert/strict"
import { composerHeight, composerTrigger, insertAgentMention, insertFileReference, parseSlashCommand } from "./composer.ts"

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
