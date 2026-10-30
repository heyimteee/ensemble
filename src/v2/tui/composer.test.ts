import test from "node:test"
import assert from "node:assert/strict"
import { composerTrigger, insertAgentMention, insertFileReference, parseSlashCommand } from "./composer.ts"

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
