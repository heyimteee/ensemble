import test from "node:test"
import assert from "node:assert/strict"
import { COMMANDS, commandCompletions, completeCommand, parseCommandLine } from "./commands.ts"

test("the command set is navigation and state only, never destructive or selectable actions", () => {
  assert.deepEqual(
    COMMANDS.map((command) => command.name),
    [
      "settings",
      "approvals",
      "workspace",
      "agent",
      "new-agent",
      "new-workspace",
      "edit-workspace",
      "pause",
      "resume",
      "init",
      "native",
      "logs",
      "help",
      "q",
    ],
  )
  for (const forbidden of ["delete", "archive", "reset", "cancel", "delegate", "reassign", "retry", "restart"]) {
    assert.equal(COMMANDS.some((command) => command.name === forbidden), false, `${forbidden} stays on keys/leader`)
  }
})

test("command parsing accepts the leading colon and surrounding whitespace", () => {
  assert.deepEqual(parseCommandLine(":settings"), { name: "settings" })
  assert.deepEqual(parseCommandLine("  :pause  "), { name: "pause" })
  assert.deepEqual(parseCommandLine("settings"), { name: "settings" })
  assert.deepEqual(parseCommandLine(":agent Nova"), { name: "agent" }, "extra words are ignored; commands take no arguments")
  assert.deepEqual(parseCommandLine(":logs"), { name: "logs", args: [] })
  assert.deepEqual(parseCommandLine(":logs failures"), { name: "logs", args: ["failures"] })
  assert.deepEqual(parseCommandLine(":logs task t_123"), { name: "logs", args: ["task", "t_123"] })
})

test("command parsing rejects empty and unknown commands", () => {
  assert.equal(parseCommandLine(""), null)
  assert.equal(parseCommandLine(":"), null)
  assert.equal(parseCommandLine(":nope"), null)
  assert.equal(parseCommandLine(":delete-workspace"), null)
})

test("completion offers matching command names and descriptions", () => {
  assert.deepEqual(commandCompletions(":set").map((command) => command.name), ["settings"])
  assert.deepEqual(commandCompletions(":new").map((command) => command.name), ["new-agent", "new-workspace"])
  assert.deepEqual(commandCompletions(":").map((command) => command.name), COMMANDS.map((command) => command.name))
  assert.equal(commandCompletions(":agent Nova").length, 0, "arguments do not offer command completions")
  assert.equal(commandCompletions(":zzz").length, 0)
})

test("Tab completion returns the first matching command name", () => {
  assert.equal(completeCommand(":set"), "settings")
  assert.equal(completeCommand(":new"), "new-agent")
  assert.equal(completeCommand(":zzz"), undefined)
})
