import test from "node:test"
import assert from "node:assert/strict"
import {
  KEYMAP_CATALOG,
  duplicateBindings,
  keyChordLabel,
  keyLabel,
  layerEntries,
  leaderEntries,
  leaderLayerEntries,
  normalEntries,
  normalizeKeyToken,
  resolveLeaderKey,
  resolveNormalKey,
  statuslineHints,
  whichKeyLines,
  type KeyContext,
} from "./keymap.ts"

const keysFor = (context: KeyContext) => normalEntries(context).map((entry) => entry.keys.join(" "))

type KeyResult = ReturnType<typeof resolveNormalKey>
const actionId = (result: KeyResult): string | undefined => result.type === "action" ? result.entry.id : undefined

function entryId(context: KeyContext, keys: string): string | undefined {
  return normalEntries(context).find((entry) => entry.keys.join(" ") === keys)?.id
}

test("roster Normal grammar carries navigation, opening, actions, filter, and leader", () => {
  const keys = keysFor("roster")
  for (const sequence of ["j", "k", "g g", "shift+g", "h", "l", "enter", "tab", "/", "a", "e", "s", "x", "shift+x", "space"]) {
    assert.ok(keys.includes(sequence), `roster keeps ${sequence}`)
  }
  assert.equal(entryId("roster", "enter"), "open")
})

test("group chat and direct conversation scroll the transcript and never expose a message cursor", () => {
  const keys = keysFor("chat")
  for (const sequence of ["j", "k", "g g", "shift+g", "ctrl+d", "ctrl+u", "enter", "i", "tab", "/", "space"]) {
    assert.ok(keys.includes(sequence), `chat keeps ${sequence}`)
  }
  assert.equal(entryId("chat", "j"), "chat.scroll.down")
  assert.equal(entryId("chat", "k"), "chat.scroll.up")
  assert.equal(entryId("chat", "enter"), "compose")
  assert.equal(entryId("chat", "i"), "compose.alt")
  assert.ok(
    normalEntries("chat").every((entry) => !/message[ ._-]?cursor/i.test(`${entry.id} ${entry.title}`)),
    "chat entries never name a message cursor",
  )
})

test("settings share the Normal grammar: h/l tabs, j/k rows, Enter, a/e/x, Space, s, /, Esc", () => {
  const keys = keysFor("settings")
  for (const sequence of ["h", "l", "tab", "shift+tab", "j", "k", "g g", "shift+g", "enter", "a", "e", "x", "space", "s", "/", "escape", "p", "shift+j", "shift+k"]) {
    assert.ok(keys.includes(sequence), `settings keeps ${sequence}`)
  }
  assert.equal(entryId("settings", "h"), "settings.tab.prev")
  assert.equal(entryId("settings", "l"), "settings.tab.next")
  assert.equal(entryId("settings", "tab"), "settings.tab.cycle")
  assert.equal(entryId("settings", "j"), "settings.down")
  assert.equal(entryId("settings", "k"), "settings.up")
  assert.equal(entryId("settings", "enter"), "settings.edit")
  assert.equal(entryId("settings", "a"), "settings.add")
  assert.equal(entryId("settings", "x"), "settings.delete")
  assert.equal(entryId("settings", "space"), "settings.toggle")
  assert.equal(entryId("settings", "s"), "settings.save")
  assert.equal(entryId("settings", "/"), "settings.filter")
  assert.equal(entryId("settings", "escape"), "settings.escape")
  assert.equal(entryId("settings", "p"), "settings.promote", "p promotes a selected memory, never row paste")
  assert.equal(entryId("settings", "shift+j"), "settings.backup.down", "J reorders the selected backup down")
  assert.equal(entryId("settings", "shift+k"), "settings.backup.up", "K reorders the selected backup up")
})

test("settings promote and reorder teach their keys from the catalog", () => {
  const promote = normalEntries("settings").find((entry) => entry.id === "settings.promote")
  assert.equal(promote?.hint, "p promote")
  assert.equal(promote?.title, "Promote memory")
  const down = normalEntries("settings").find((entry) => entry.id === "settings.backup.down")
  const up = normalEntries("settings").find((entry) => entry.id === "settings.backup.up")
  assert.equal(down?.hint, "J/K reorder")
  assert.equal(down?.title, "Move backup down")
  assert.equal(up?.title, "Move backup up")
  const hints = statuslineHints("settings")
  assert.ok(hints.includes("p promote"), hints)
  assert.ok(hints.includes("J/K reorder"), hints)
})

test("settings lists expose no Visual, yank, or paste and no per-tab filter chords", () => {
  for (const entry of normalEntries("settings")) {
    assert.ok(!/visual|yank|paste/i.test(`${entry.id} ${entry.title}`), `settings:${entry.id} is a list-surface action`)
    assert.ok(!entry.keys.some((key) => key.startsWith("ctrl+")), `settings:${entry.id} must not use a Ctrl chord`)
  }
  assert.deepEqual(duplicateBindings(), [], "settings keys never collide in their context")
})

test("the work zone is reachable with Tab and keeps list navigation", () => {
  const keys = keysFor("work")
  for (const sequence of ["j", "k", "g g", "shift+g", "enter", "tab", "escape"]) {
    assert.ok(keys.includes(sequence), `work keeps ${sequence}`)
  }
})

test("the work list carries the shared task actions on their Normal keys", () => {
  const keys = keysFor("work")
  for (const sequence of ["x", "r", "shift+r", "d", "t", "o"]) {
    assert.ok(keys.includes(sequence), `work keeps ${sequence}`)
  }
  assert.equal(entryId("work", "enter"), "work.open")
  assert.equal(entryId("work", "x"), "work.cancel")
  assert.equal(entryId("work", "r"), "work.retry")
  assert.equal(entryId("work", "shift+r"), "work.restart")
  assert.equal(entryId("work", "d"), "work.delegate")
  assert.equal(entryId("work", "t"), "work.reassign")
  assert.equal(entryId("work", "o"), "work.native")
})

test("d delegates in the work list instead of invoking the text delete operator", () => {
  const delegate = normalEntries("work").find((entry) => entry.keys.join(" ") === "d")
  assert.equal(delegate?.id, "work.delegate")
  assert.match(delegate?.title ?? "", /delegate/i)
  assert.ok(!/delete/i.test(`${delegate?.id} ${delegate?.title}`), "work d never binds delete")
})

test("Esc and Tab return from the work list to the transcript", () => {
  const escape = normalEntries("work").find((entry) => entry.id === "escape")
  const tab = normalEntries("work").find((entry) => entry.id === "focus.tab")
  assert.match(escape?.title ?? "", /transcript/i)
  assert.match(tab?.title ?? "", /transcript/i)
  assert.equal(actionId(resolveNormalKey("work", ["g"], "g")), "work.top")
  assert.equal(actionId(resolveNormalKey("work", [], "shift+g")), "work.bottom")
  assert.equal(actionId(resolveNormalKey("work", [], "x")), "work.cancel")
})

test("the catalog retires the tilde leader and list surfaces expose no Visual, yank, or paste", () => {
  for (const entry of KEYMAP_CATALOG) {
    assert.ok(!entry.keys.includes("~"), `${entry.id} must not bind ~`)
    assert.ok(!entry.keys.some((key) => key.includes("~")), `${entry.id} must not carry a ~ chord`)
  }
  const listContexts: KeyContext[] = ["roster", "chat", "work"]
  for (const context of listContexts) {
    for (const entry of normalEntries(context)) {
      assert.ok(!/visual|yank|paste/i.test(`${entry.id} ${entry.title}`), `${context}:${entry.id} is a list-surface action`)
    }
  }
  assert.equal(entryId("roster", "space"), "leader")
  assert.equal(entryId("chat", "space"), "leader")
  assert.equal(entryId("work", "space"), "leader")
})

test("the chat new-workspace key yields to active transcript search", () => {
  const entry = normalEntries("chat").find((candidate) => candidate.id === "chat.new.workspace")
  assert.equal(entry?.availability, "no-transcript-search")
})

test("the leader catalog covers the documented Normal actions with unique keys", () => {
  const ids = leaderEntries().map((entry) => entry.id)
  for (const id of [
    "leader.help",
    "leader.leave",
    "leader.new.agent",
    "leader.new.workspace",
    "leader.edit.workspace",
    "leader.archive.workspace",
    "leader.delete.workspace",
    "leader.archive.agent",
    "leader.delete.agent",
    "leader.settings",
    "leader.approvals",
    "leader.pause",
    "leader.init",
    "leader.native",
    "leader.delegate",
    "leader.reassign",
    "leader.retry",
    "leader.restart",
    "leader.cancel.task",
    "leader.cancel",
  ]) {
    assert.ok(ids.includes(id), `leader lists ${id}`)
  }
  assert.deepEqual(duplicateBindings(), [], "no context has two bindings for one key sequence")
})

test("keys resolve through the chord machine, including gg, G, and Ctrl+d", () => {
  const pending = resolveNormalKey("chat", [], "g")
  assert.equal(pending.type, "pending")
  assert.equal(resolveNormalKey("chat", ["g"], "g").type, "action")
  assert.equal(actionId(resolveNormalKey("chat", ["g"], "g")), "chat.top")
  assert.equal(actionId(resolveNormalKey("chat", [], "shift+g")), "chat.bottom")
  assert.equal(actionId(resolveNormalKey("chat", [], "ctrl+d")), "chat.half.down")
  // A pending prefix never swallows the next unrelated key: the fresh single
  // binding resolves after the prefix clears.
  assert.equal(actionId(resolveNormalKey("roster", ["g"], "j")), "nav.down")
  assert.equal(resolveNormalKey("roster", [], "escape").type, "action")
})

test("wizard steps carry list navigation, multi-select, filter, and the Esc ladder", () => {
  const keys = keysFor("wizard")
  for (const sequence of ["j", "k", "g g", "shift+g", "enter", "space", "/", "escape"]) {
    assert.ok(keys.includes(sequence), `wizard keeps ${sequence}`)
  }
  assert.equal(entryId("wizard", "j"), "wizard.down")
  assert.equal(entryId("wizard", "enter"), "wizard.activate")
  assert.equal(entryId("wizard", "space"), "wizard.toggle")
  assert.equal(entryId("wizard", "/"), "wizard.filter")
  assert.equal(entryId("wizard", "escape"), "wizard.back")
  assert.equal(actionId(resolveNormalKey("wizard", ["g"], "g")), "wizard.top")
  // `:` and the leader never claim keys inside a wizard.
  assert.equal(resolveNormalKey("wizard", [], ":").type, "none")
  assert.equal(entryId("wizard", ":"), undefined)
  assert.ok(!keys.includes(":"), "wizard never opens the command line")
})

test("pickers, results, and approvals share the list grammar", () => {
  for (const context of ["picker", "result", "approvals"] as const) {
    const keys = keysFor(context)
    for (const sequence of ["j", "k", "g g", "shift+g", "enter", "escape"]) {
      assert.ok(keys.includes(sequence), `${context} keeps ${sequence}`)
    }
    assert.equal(actionId(resolveNormalKey(context, ["g"], "g")), `${context}.top`)
    assert.equal(actionId(resolveNormalKey(context, [], "shift+g")), `${context}.bottom`)
  }
  assert.equal(entryId("picker", "space"), "picker.toggle")
  assert.equal(entryId("picker", "/"), "picker.filter")
  assert.equal(actionId(resolveNormalKey("result", [], "ctrl+d")), "result.half.down")
  assert.equal(entryId("result", "enter"), "result.close.enter")
  assert.equal(entryId("result", "escape"), "result.close.escape")
  assert.equal(entryId("approvals", "enter"), "approvals.resolve")
  assert.equal(entryId("approvals", "escape"), "approvals.close")
})

test("confirm accepts with y/Enter and cancels with n/Esc", () => {
  assert.equal(actionId(resolveNormalKey("confirm", [], "enter")), "confirm.accept.enter")
  assert.equal(actionId(resolveNormalKey("confirm", [], "y")), "confirm.accept")
  assert.equal(actionId(resolveNormalKey("confirm", [], "escape")), "confirm.reject.escape")
  assert.equal(actionId(resolveNormalKey("confirm", [], "n")), "confirm.reject")
  assert.equal(resolveNormalKey("confirm", [], "j").type, "none", "confirm traps unrelated keys")
})

test("dialog hints come from the catalog and stay truthful about variants", () => {
  const wizard = statuslineHints("wizard", { multiple: true })
  assert.ok(wizard.includes("j/k move"), wizard)
  assert.ok(wizard.includes("enter next"), wizard)
  assert.ok(wizard.includes("space toggle"), wizard)
  assert.ok(wizard.includes("/ filter"), wizard)
  assert.ok(wizard.includes("esc back"), wizard)
  const single = statuslineHints("wizard", { multiple: false })
  assert.ok(!single.includes("space toggle"), "a single-choice step never promises Space")

  const picker = statuslineHints("picker", { multiple: true })
  for (const hint of ["j/k move", "enter select", "space toggle", "/ filter", "esc cancel"]) {
    assert.ok(picker.includes(hint), `${hint} in ${picker}`)
  }
  assert.ok(!statuslineHints("picker", { multiple: false }).includes("space toggle"))

  assert.ok(statuslineHints("confirm").includes("y/enter yes"))
  assert.ok(statuslineHints("confirm").includes("n/esc no"))
  assert.ok(statuslineHints("result").includes("enter/esc close"))
  assert.ok(statuslineHints("approvals").includes("enter resolve"))
  assert.ok(statuslineHints("approvals").includes("esc close"))
})

test("text-field hints share the dialog ladder vocabulary", () => {
  assert.ok(statuslineHints("wizardField").includes("esc normal"))
  assert.ok(statuslineHints("wizardText").includes("esc back"))
  assert.ok(statuslineHints("promptField").includes("shift+enter newline"))
  assert.ok(statuslineHints("promptText").includes("esc cancel"))
  const filter = statuslineHints("filter")
  assert.ok(filter.includes("enter done"), filter)
  assert.ok(filter.includes("esc clear"), filter)
})

test("leader keys resolve and Esc cancels the leader", () => {
  assert.equal(actionId(resolveLeaderKey("?")), "leader.help")
  assert.equal(actionId(resolveLeaderKey("escape")), "leader.cancel")
  assert.equal(resolveLeaderKey("~").type, "none")
})

test("statusline hints come from the same catalog and adapt to the work zone", () => {
  const roster = statuslineHints("roster")
  assert.ok(roster.includes("enter open"), roster)
  assert.ok(roster.includes("space leader"), roster)
  assert.ok(roster.includes("/ filter"), roster)
  assert.ok(!roster.includes("~"), "the retired prefix never appears in a hint")

  const chatWithWork = statuslineHints("chat", { hasWork: true })
  assert.ok(chatWithWork.includes("j/k scroll"), chatWithWork)
  assert.ok(chatWithWork.includes("tab work"), chatWithWork)
  const chatIdle = statuslineHints("chat", { hasWork: false })
  assert.ok(chatIdle.includes("tab rail"), chatIdle)
  assert.ok(!chatIdle.includes("tab work"), "an empty work zone is never promised")

  const work = statuslineHints("work")
  assert.ok(work.includes("enter result"), work)
  for (const hint of ["x cancel", "r retry", "R restart", "d delegate", "t reassign", "o native"]) {
    assert.ok(work.includes(hint), `work hints name ${hint} (${work})`)
  }
})

test("settings hints keep teaching keys only where that tab has the action", () => {
  const enabled = (tab: "general" | "models" | "memories" | "skillbox") => (entry: { id: string }) => {
    if (entry.id === "settings.add") return tab === "models" || tab === "memories"
    if (entry.id === "settings.delete") return tab === "models" || tab === "memories"
    if (entry.id === "settings.toggle") return tab === "skillbox"
    if (entry.id === "settings.filter") return tab === "memories" || tab === "skillbox"
    if (entry.id === "settings.promote") return tab === "memories"
    if (entry.id === "settings.backup.down" || entry.id === "settings.backup.up") return tab === "models"
    return true
  }
  const general = statuslineHints("settings", { filter: enabled("general") })
  for (const hint of ["h/l tabs", "j/k rows", "enter edit", "s save", "esc close"]) {
    assert.ok(general.includes(hint), `general teaches ${hint}: ${general}`)
  }
  assert.ok(!general.includes("a add"), "general has no add row")
  assert.ok(!general.includes("/ filter"), "general has no filter tab")
  assert.ok(!general.includes("p promote"), "general has no memory to promote")
  assert.ok(!general.includes("J/K reorder"), "general has no backup to reorder")

  const memories = statuslineHints("settings", { filter: enabled("memories") })
  assert.ok(memories.includes("a add"), memories)
  assert.ok(memories.includes("x delete"), memories)
  assert.ok(memories.includes("/ filter"), memories)
  assert.ok(memories.includes("p promote"), memories)

  const models = statuslineHints("settings", { filter: enabled("models") })
  assert.ok(models.includes("a add"), models)
  assert.ok(models.includes("J/K reorder"), models)
  assert.ok(!models.includes("p promote"), "models has no memory to promote")

  const skillbox = statuslineHints("settings", { filter: enabled("skillbox") })
  assert.ok(skillbox.includes("space toggle"), skillbox)
  assert.ok(!skillbox.includes("a add"), "skillbox has no add row")
  assert.ok(!skillbox.includes("p promote"), "skillbox has no memory to promote")
})

test("layer entries are single-key bindings the host can generate directly", () => {
  for (const context of ["roster", "chat", "work"] as const) {
    const entries = layerEntries(context)
    assert.ok(entries.length > 0)
    for (const entry of entries) assert.equal(entry.keys.length, 1, `${entry.id} is a single-key layer binding`)
    const keys = entries.map((entry) => entry.keys[0])
    assert.equal(new Set(keys).size, keys.length, `${context} layer binds each key once`)
  }
  assert.ok(leaderLayerEntries().every((entry) => entry.keys.length === 1))
})

test("which-key renders two columns and every leader entry remains discoverable", () => {
  const lines = whichKeyLines(leaderEntries())
  assert.ok(lines.length > 0)
  const text = lines.join("\n")
  for (const title of ["Help", "Leave Ensemble", "New agent", "New workspace", "Approvals", "Pause / resume"]) {
    assert.ok(text.includes(title), `which-key lists ${title}`)
  }
  assert.ok(lines.every((line) => line.length > 0))
})

test("key labels read like Vim/terminal keys", () => {
  assert.equal(keyLabel(["g", "g"]), "gg")
  assert.equal(keyLabel(["shift+g"]), "G")
  assert.equal(keyLabel(["ctrl+d"]), "Ctrl+D")
  assert.equal(keyLabel(["ctrl+shift+w"]), "Ctrl+Shift+W")
  assert.equal(keyLabel(["ctrl+shift+delete"]), "Ctrl+Shift+Delete")
  assert.equal(keyLabel(["enter"]), "Enter")
  assert.equal(keyLabel(["space"]), "Space")
  assert.equal(keyLabel(["escape"]), "Esc")
  assert.equal(keyLabel(["p"]), "p", "plain Vim keys keep their case")
  assert.equal(keyChordLabel(["d", "shift+g"]), "dG")
  assert.equal(keyChordLabel(["g", "g"]), "gg")
})

test("raw keypresses normalize to catalog tokens", () => {
  assert.equal(normalizeKeyToken({ name: "space", sequence: " " }), "space")
  assert.equal(normalizeKeyToken({ name: "return" }), "enter")
  assert.equal(normalizeKeyToken({ name: "return", shift: true }), "shift+enter")
  assert.equal(normalizeKeyToken({ name: "escape" }), "escape")
  assert.equal(normalizeKeyToken({ name: "tab" }), "tab")
  assert.equal(normalizeKeyToken({ name: "g", shift: true }), "shift+g")
  assert.equal(normalizeKeyToken({ name: "G", sequence: "G" }), "shift+g")
  assert.equal(normalizeKeyToken({ name: "d", ctrl: true }), "ctrl+d")
  assert.equal(normalizeKeyToken({ name: "ctrl+d" }), "ctrl+d")
  assert.equal(normalizeKeyToken({ name: "?", sequence: "?" }), "?")
  assert.equal(normalizeKeyToken({ name: "/", sequence: "/" }), "/")
})
