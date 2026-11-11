import test from "node:test"
import assert from "node:assert/strict"
import { COMMANDS, commandCompletions, completeCommand, nativeFirstCommand, parseCommandLine, toolsCommand } from "./commands.ts"

test("the command set is navigation and state only, never destructive or selectable actions", () => {
  assert.deepEqual(
    COMMANDS.map((command) => command.name),
    [
      "settings",
      "limits",
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
      "native-first",
      "tools",
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

test("ticket241: command arity lives on the one catalog", () => {
  const withArgs = Object.fromEntries(COMMANDS.filter((command) => command.args).map((command) => [command.name, command.args]))
  assert.deepEqual(withArgs, { "native-first": true, tools: true, logs: true })
  assert.deepEqual(parseCommandLine(":logs"), { name: "logs", args: [] })
  assert.deepEqual(parseCommandLine(":native-first off"), { name: "native-first", args: ["off"] })
  assert.deepEqual(parseCommandLine(":tools legacy"), { name: "tools", args: ["legacy"] })
  assert.deepEqual(parseCommandLine(":settings extra"), { name: "settings" }, "no-argument commands still ignore words")
})

test("ticket240: native-first and tools commands parse their required argument", () => {
  assert.deepEqual(parseCommandLine(":native-first on"), { name: "native-first", args: ["on"] })
  assert.deepEqual(parseCommandLine(":native-first off"), { name: "native-first", args: ["off"] })
  assert.deepEqual(parseCommandLine(":native-first shadow"), { name: "native-first", args: ["shadow"] })
  assert.deepEqual(parseCommandLine(":tools native"), { name: "tools", args: ["native"] })
  assert.deepEqual(parseCommandLine(":tools legacy"), { name: "tools", args: ["legacy"] })
  assert.deepEqual(parseCommandLine(":native-first"), { name: "native-first", args: [] })
  assert.deepEqual(parseCommandLine(":tools"), { name: "tools", args: [] })
})

test("ticket240: native-first command validates on, off, and shadow", () => {
  const on = nativeFirstCommand(["on"])
  assert.equal(on.ok, true)
  if (on.ok) {
    assert.deepEqual(on.patch, { nativeFirst: "on" }, "the mode command never rewrites an explicit tool-surface choice")
    assert.match(on.message, /:tools native/)
  }
  const off = nativeFirstCommand(["off"])
  assert.equal(off.ok, true)
  if (off.ok) assert.deepEqual(off.patch, { nativeFirst: "off" })
  const shadow = nativeFirstCommand(["shadow"])
  assert.equal(shadow.ok, true)
  if (shadow.ok) assert.deepEqual(shadow.patch, { nativeFirst: "shadow" })

  for (const invalid of [nativeFirstCommand([]), nativeFirstCommand(["sometimes"]), nativeFirstCommand(["on", "extra"])]) {
    assert.equal(invalid.ok, false)
    if (!invalid.ok) assert.ok(invalid.error.length > 0)
  }
})

test("ticket240: tools command validates native and legacy", () => {
  const native = toolsCommand(["native"])
  assert.equal(native.ok, true)
  if (native.ok) {
    assert.deepEqual(native.patch, { toolSurface: "native" })
    assert.ok(native.message.length > 0)
  }
  const legacy = toolsCommand(["legacy"])
  assert.equal(legacy.ok, true)
  if (legacy.ok) assert.deepEqual(legacy.patch, { toolSurface: "legacy" })

  for (const invalid of [toolsCommand([]), toolsCommand(["sometimes"]), toolsCommand(["native", "extra"])]) {
    assert.equal(invalid.ok, false)
    if (!invalid.ok) assert.ok(invalid.error.length > 0)
  }
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
