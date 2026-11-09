import test from "node:test"
import assert from "node:assert/strict"
import {
  KEYMAP_CATALOG,
  duplicateBindings,
  commandStatusHints,
  globalEntries,
  keyChordLabel,
  layerEntries,
  leaderHints,
  leaderMenuEntries,
  singleKeyEntry,
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
  for (const sequence of ["j", "k", "g g", "shift+g", "enter", "tab", "/", "a", "e", "s", "x", "shift+x", "space", "z"]) {
    assert.ok(keys.includes(sequence), `roster keeps ${sequence}`)
  }
  assert.equal(entryId("roster", "enter"), "open")
  assert.equal(entryId("roster", "z"), "rail.collapse", "z toggles the selected workspace group")
})

test("ticket180: select mode owns pane movement, Enter, and the chat composer key", () => {
  const keys = keysFor("pane")
  for (const sequence of ["h", "l", "j", "k", "enter", "i", "v", "tab", "shift+tab", "space"]) {
    assert.ok(keys.includes(sequence), `pane select keeps ${sequence}`)
  }
  assert.equal(entryId("pane", "h"), "pane.left")
  assert.equal(entryId("pane", "l"), "pane.right")
  assert.equal(entryId("pane", "j"), "pane.down")
  assert.equal(entryId("pane", "k"), "pane.up")
  assert.equal(entryId("pane", "enter"), "pane.enter")
  assert.equal(entryId("pane", "i"), "pane.compose")
  assert.equal(entryId("pane", "v"), "pane.approvals")
  assert.equal(entryId("pane", "tab"), "focus.tab")
  assert.equal(entryId("pane", "escape"), "pane.escape", "select-mode Esc is a claimed no-op")
  const hints = statuslineHints("pane")
  for (const hint of ["h/l column", "j/k pane", "enter enter", "i compose", "tab next"]) {
    assert.ok(hints.includes(hint), `pane hints include ${hint}: ${hints}`)
  }
})

test("ticket180: pane movement lives only in select mode, not in pane content grammars", () => {
  assert.equal(entryId("chat", "l"), undefined, "chat l selects Work only from select mode")
  assert.equal(entryId("roster", "l"), undefined, "roster l selects the chat only from select mode")
  assert.equal(entryId("roster", "h"), undefined, "roster h selects a pane only from select mode")
})

test("group chat and direct conversation scroll the transcript and never expose a message cursor", () => {
  const keys = keysFor("chat")
  for (const sequence of ["j", "k", "g g", "shift+g", "ctrl+d", "ctrl+u", "i", "tab", "/", "space"]) {
    assert.ok(keys.includes(sequence), `chat keeps ${sequence}`)
  }
  assert.equal(entryId("chat", "j"), "chat.scroll.down")
  assert.equal(entryId("chat", "k"), "chat.scroll.up")
  assert.equal(entryId("chat", "enter"), "chat.enter", "chat Enter keeps transcript navigation, never the composer")
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
    const paging = entry.id === "settings.half.down" || entry.id === "settings.half.up"
    assert.ok(paging || !entry.keys.some((key) => key.startsWith("ctrl+")), `settings:${entry.id} must not use an app Ctrl chord`)
  }
  assert.deepEqual(duplicateBindings(), [], "settings keys never collide in their context")
})

test("the work zone is reachable with Tab and keeps spatial list navigation", () => {
  const keys = keysFor("work")
  for (const sequence of ["j", "k", "h", "l", "g g", "shift+g", "ctrl+d", "ctrl+u", "enter", "tab", "escape", "v"]) {
    assert.ok(keys.includes(sequence), `work keeps ${sequence}`)
  }
  assert.equal(entryId("work", "f"), "work.filter", "ticket172: f toggles ACTIVE/HISTORY")
  assert.equal(entryId("work", "pageup"), "work.page.up")
  assert.equal(entryId("work", "pagedown"), "work.page.down")
  assert.equal(entryId("work", "v"), "work.approvals", "ticket185: v opens full approvals")
  assert.equal(resolveNormalKey("work", [], "shift+v").type, "none", "ticket185: V is retired")
})

test("ticket185: full approvals own j/k, Enter, Esc, and Tab", () => {
  const keys = keysFor("approvals")
  for (const sequence of ["j", "k", "g g", "shift+g", "enter", "tab", "shift+tab", "escape"]) {
    assert.ok(keys.includes(sequence), `full approvals keep ${sequence}`)
  }
  assert.equal(entryId("approvals", "j"), "approvals.down")
  assert.equal(entryId("approvals", "k"), "approvals.up")
  assert.equal(entryId("approvals", "enter"), "approvals.resolve")
  assert.equal(entryId("approvals", "escape"), "approvals.close")
  assert.equal(resolveNormalKey("approvals", [], "shift+v").type, "none", "V is retired")
})

test("the work list carries the shared task actions on their Normal keys", () => {
  const keys = keysFor("work")
  for (const sequence of ["x", "r", "shift+r", "d", "t", "o", "shift+d"]) {
    assert.ok(keys.includes(sequence), `work keeps ${sequence}`)
  }
  assert.equal(entryId("work", "enter"), "work.open")
  assert.equal(entryId("work", "x"), "work.cancel")
  assert.equal(entryId("work", "r"), "work.retry")
  assert.equal(entryId("work", "shift+r"), "work.restart")
  assert.equal(entryId("work", "d"), "work.delegate")
  assert.equal(entryId("work", "t"), "work.reassign")
  assert.equal(entryId("work", "o"), "work.native")
  assert.equal(entryId("work", "shift+d"), "work.history.clear", "ticket184: D clears the history view")
})

test("d delegates in the work list instead of invoking the text delete operator", () => {
  const delegate = normalEntries("work").find((entry) => entry.keys.join(" ") === "d")
  assert.equal(delegate?.id, "work.delegate")
  assert.match(delegate?.title ?? "", /delegate/i)
  assert.ok(!/delete/i.test(`${delegate?.id} ${delegate?.title}`), "work d never binds delete")
})

test("ticket185: Work hints teach focus, history, approvals, and page keys without V", () => {
  const hints = statuslineHints("work")
  for (const hint of ["j/k cards", "h/l row", "ctrl+d/u page", "v approvals", "f history", "tab next"]) {
    assert.ok(hints.includes(hint), `work hints include ${hint}: ${hints}`)
  }
  assert.ok(!hints.includes("V inbox"), "V is retired")
  const approvals = statuslineHints("approvals")
  for (const hint of ["j/k move", "enter resolve", "esc split", "tab next"]) {
    assert.ok(approvals.includes(hint), `full approval hints include ${hint}: ${approvals}`)
  }
})

test("Esc and Tab move through the work zones without inventing a cursor", () => {
  const escape = normalEntries("work").find((entry) => entry.id === "escape")
  const tab = normalEntries("work").find((entry) => entry.id === "focus.tab")
  assert.match(escape?.title ?? "", /pane selection/i)
  assert.match(tab?.title ?? "", /pane/i, "ticket180: Tab cycles visible panes")
  assert.equal(actionId(resolveNormalKey("work", ["g"], "g")), "work.top")
  assert.equal(actionId(resolveNormalKey("work", [], "shift+g")), "work.bottom")
  assert.equal(actionId(resolveNormalKey("work", [], "x")), "work.cancel")
})

test("the catalog retires the tilde leader and legacy Ctrl app actions", () => {
  for (const entry of KEYMAP_CATALOG) {
    assert.ok(!entry.keys.includes("~"), `${entry.id} must not bind ~`)
    assert.ok(!entry.keys.some((key) => key.includes("~")), `${entry.id} must not carry a ~ chord`)
    for (const key of entry.keys) {
      assert.ok(!["ctrl+s", "ctrl+up", "ctrl+down", "ctrl+n", "ctrl+p", "ctrl+w", "ctrl+a", "ctrl+shift+w", "ctrl+shift+a", "ctrl+shift+delete"].includes(key), `${entry.id} must not bind retired ${key}`)
      assert.ok(!key.startsWith("ctrl+shift"), `${entry.id} must not bind a Ctrl+Shift app shortcut`)
    }
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

test("wizard steps carry list navigation, multi-select, filter, memory actions, and the cancel ladder", () => {
  const keys = keysFor("wizard")
  for (const sequence of ["j", "k", "g g", "shift+g", "enter", "space", "/", "escape", "n", "shift+n", "a", "e", "x"]) {
    assert.ok(keys.includes(sequence), `wizard keeps ${sequence}`)
  }
  assert.equal(entryId("wizard", "j"), "wizard.down")
  assert.equal(entryId("wizard", "enter"), "wizard.activate")
  assert.equal(entryId("wizard", "space"), "wizard.toggle")
  assert.equal(entryId("wizard", "/"), "wizard.filter")
  assert.equal(entryId("wizard", "escape"), "wizard.cancel")
  assert.equal(entryId("wizard", "n"), "wizard.next")
  assert.equal(entryId("wizard", "shift+n"), "wizard.prev")
  assert.equal(entryId("wizard", "a"), "wizard.memory.add")
  assert.equal(entryId("wizard", "e"), "wizard.memory.edit")
  assert.equal(entryId("wizard", "x"), "wizard.memory.delete")
  assert.equal(actionId(resolveNormalKey("wizard", ["g"], "g")), "wizard.top")
  // `:` and the leader never claim keys inside a wizard.
  assert.equal(resolveNormalKey("wizard", [], ":").type, "none")
  assert.equal(entryId("wizard", ":"), undefined)
  assert.ok(!keys.includes(":"), "wizard never opens the command line")
})

test("wizard text Normal reuses n/N for step navigation and Esc for cancel", () => {
  assert.equal(entryId("wizardText", "n"), "wizardText.next")
  assert.equal(entryId("wizardText", "shift+n"), "wizardText.prev")
  assert.equal(entryId("wizardText", "escape"), "wizardText.escape")
  assert.match(normalEntries("wizardText").find((entry) => entry.id === "wizardText.escape")?.hint ?? "", /esc cancel/)
  assert.match(statuslineHints("wizardText"), /esc cancel/)
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
  const wizard = statuslineHints("wizard", { multiple: true, memory: true })
  assert.ok(wizard.includes("j/k select"), wizard)
  assert.ok(wizard.includes("enter next"), wizard)
  assert.ok(wizard.includes("n next"), wizard)
  assert.ok(wizard.includes("N previous"), wizard)
  assert.ok(wizard.includes("space toggle"), wizard)
  assert.ok(wizard.includes("a add"), wizard)
  assert.ok(wizard.includes("e edit"), wizard)
  assert.ok(wizard.includes("x delete"), wizard)
  assert.ok(wizard.includes("/ filter"), wizard)
  assert.ok(wizard.includes("esc cancel"), wizard)
  const single = statuslineHints("wizard", { multiple: false })
  assert.ok(!single.includes("space toggle"), "a single-choice step never promises Space")
  assert.ok(!single.includes("a add"), "a non-memory step never promises add")
  assert.ok(!single.includes("x delete"), "a non-memory step never promises delete")

  const picker = statuslineHints("picker", { multiple: true })
  for (const hint of ["j/k move", "enter select", "space toggle", "/ filter", "esc cancel"]) {
    assert.ok(picker.includes(hint), `${hint} in ${picker}`)
  }
  assert.ok(!statuslineHints("picker", { multiple: false }).includes("space toggle"))

  assert.ok(statuslineHints("confirm").includes("y/enter yes"))
  assert.ok(statuslineHints("confirm").includes("n/esc no"))
  assert.ok(statuslineHints("result").includes("enter/esc close"))
  assert.ok(statuslineHints("approvals").includes("enter resolve"))
  assert.ok(statuslineHints("approvals").includes("esc split"))
})

test("text-field hints share the dialog ladder vocabulary", () => {
  assert.ok(statuslineHints("wizardField").includes("esc normal"))
  assert.ok(statuslineHints("wizardText").includes("esc cancel"))
  assert.ok(statuslineHints("wizardMemory").includes("enter save"), statuslineHints("wizardMemory"))
  assert.ok(statuslineHints("wizardMemory").includes("esc list"))
  assert.ok(statuslineHints("settingsMemoryField").includes("enter save"))
  assert.ok(statuslineHints("settingsMemoryText").includes("esc settings"))
  assert.ok(statuslineHints("promptField").includes("shift+enter newline"))
  assert.ok(statuslineHints("promptText").includes("esc cancel"))
  const filter = statuslineHints("filter")
  assert.ok(filter.includes("enter done"), filter)
  assert.ok(filter.includes("esc clear"), filter)
})

test("leader keys resolve and Esc cancels the leader", () => {
  assert.equal(actionId(resolveLeaderKey([], "?")), "leader.help")
  assert.equal(actionId(resolveLeaderKey([], "escape")), "leader.cancel")
  assert.equal(resolveLeaderKey([], "~").type, "none")
})

test("ticket183: Space b is a prefix and Space l/r stay direct", () => {
  const pending = resolveLeaderKey([], "b")
  assert.equal(pending.type, "pending")
  assert.deepEqual(pending.type === "pending" ? pending.prefix : [], ["b"], "b waits for the pane key")
  assert.deepEqual(
    pending.type === "pending" ? pending.entries.map((entry) => entry.id).sort() : [],
    ["leader.pane.left", "leader.pane.right"],
    "the submenu offers the two pane toggles",
  )
  assert.equal(actionId(resolveLeaderKey(["b"], "l")), "leader.pane.left")
  assert.equal(actionId(resolveLeaderKey(["b"], "r")), "leader.pane.right")
  assert.equal(actionId(resolveLeaderKey([], "l")), "leader.limits", "Space l still opens limits")
  assert.equal(actionId(resolveLeaderKey([], "r")), "leader.retry", "Space r still retries")
  assert.equal(actionId(resolveLeaderKey(["b"], "escape")), "leader.cancel", "Esc cancels the pending prefix")
  assert.equal(resolveLeaderKey(["b"], "x").type, "none", "an unrelated key never resolves the submenu")
  assert.equal(resolveLeaderKey([], "x").type, "action", "a direct leader key still resolves at the top level")
})

test("ticket183: which-key shows the pane submenu at each depth", () => {
  const top = leaderMenuEntries([])
  assert.ok(top.some((entry) => entry.id === "leader.pane"), "the top level names the pane submenu")
  assert.ok(!top.some((entry) => entry.id === "leader.pane.left"), "nested keys wait for the prefix")
  const topLines = whichKeyLines(top)
  assert.ok(topLines.join("\n").includes("b Pane visibility"), topLines.join("\n"))

  const submenu = leaderMenuEntries(["b"])
  assert.deepEqual(submenu.map((entry) => entry.id), ["leader.pane.left", "leader.pane.right"])
  const submenuLines = whichKeyLines(submenu, 2, 1)
  const text = submenuLines.join("\n")
  assert.ok(text.includes("l Toggle the left pane"), text)
  assert.ok(text.includes("r Toggle the right pane"), text)
})

test("ticket183: the leader layer binds only immediate, non-prefix actions", () => {
  const ids = leaderLayerEntries().map((entry) => entry.id)
  assert.ok(ids.includes("leader.limits"))
  assert.ok(ids.includes("leader.retry"))
  assert.ok(!ids.includes("leader.pane"), "the b prefix is resolved by the raw key machine, not a host binding")
  assert.ok(!ids.includes("leader.pane.left"))
  assert.ok(!ids.includes("leader.pane.right"))
})

test("ticket183: leader hints teach the pane prefix and its submenu", () => {
  const top = leaderHints()
  assert.ok(top.includes("b panes"), top)
  const submenu = leaderHints(["b"])
  assert.ok(submenu.includes("l left"), submenu)
  assert.ok(submenu.includes("r right"), submenu)
  assert.ok(submenu.includes("esc cancel"), submenu)
})

test("statusline hints come from the same catalog and adapt to the work zone", () => {
  const roster = statuslineHints("roster")
  assert.ok(roster.includes("enter open"), roster)
  assert.ok(roster.includes("space leader"), roster)
  assert.ok(roster.includes("/ filter"), roster)
  assert.ok(!roster.includes("~"), "the retired prefix never appears in a hint")

  const chatWithWork = statuslineHints("chat", { hasWork: true })
  assert.ok(chatWithWork.includes("j/k scroll"), chatWithWork)
  assert.ok(chatWithWork.includes("tab next"), chatWithWork)
  assert.ok(chatWithWork.includes("i compose"), chatWithWork)
  const chatIdle = statuslineHints("chat", { hasWork: false })
  assert.ok(chatIdle.includes("tab next"), chatIdle)

  const work = statuslineHints("work")
  assert.ok(work.includes("enter result"), work)
  for (const hint of ["x cancel", "r retry", "R restart", "d delegate", "t reassign", "o native", "f history"]) {
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
  assert.equal(keyChordLabel(["g", "g"]), "gg")
  assert.equal(keyChordLabel(["shift+g"]), "G")
  assert.equal(keyChordLabel(["ctrl+d"]), "Ctrl+D")
  assert.equal(keyChordLabel(["enter"]), "Enter")
  assert.equal(keyChordLabel(["space"]), "Space")
  assert.equal(keyChordLabel(["escape"]), "Esc")
  assert.equal(keyChordLabel(["p"]), "p", "plain Vim keys keep their case")
  assert.equal(keyChordLabel(["d", "$"]), "d$", "chord labels join single characters without a space")
  assert.equal(keyChordLabel(["d", "shift+g"]), "dG")
  assert.equal(keyChordLabel(["g", "g"]), "gg")
})

test("raw keypresses normalize to catalog tokens", () => {
  assert.equal(normalizeKeyToken({ name: "space", sequence: " " }), "space")
  assert.equal(normalizeKeyToken({ name: "return" }), "enter")
  assert.equal(normalizeKeyToken({ name: "return", shift: true }), "shift+enter")
  assert.equal(normalizeKeyToken({ name: "escape" }), "escape")
  assert.equal(normalizeKeyToken({ name: "tab" }), "tab")
  assert.equal(normalizeKeyToken({ name: "F3", sequence: "\u001bOR" }), "f3", "function keys still normalize")
  assert.equal(normalizeKeyToken({ name: "g", shift: true }), "shift+g")
  assert.equal(normalizeKeyToken({ name: "G", sequence: "G" }), "shift+g")
  assert.equal(normalizeKeyToken({ name: "d", ctrl: true }), "ctrl+d")
  assert.equal(normalizeKeyToken({ name: "ctrl+d" }), "ctrl+d")
  assert.equal(normalizeKeyToken({ name: "?", sequence: "?" }), "?")
  assert.equal(normalizeKeyToken({ name: "/", sequence: "/" }), "/")
})

test("colon normalizes from every terminal shape after a keyboard-protocol reset", () => {
  assert.equal(normalizeKeyToken({ name: ":", sequence: ":" }), ":")
  assert.equal(normalizeKeyToken({ name: ";", shift: true, sequence: ":" }), ":")
  assert.equal(normalizeKeyToken({ name: ";", shift: true, sequence: ";" }), ":")
  assert.equal(normalizeKeyToken({ name: "colon", sequence: ":" }), ":")
  assert.equal(normalizeKeyToken({ name: ";", sequence: ";" }), ";", "a literal semicolon is not a command")
  assert.equal(normalizeKeyToken({ name: "/", sequence: "/" }), "/", "slash search still opens")
})

test("the catalog covers every app-level key the handlers consume", () => {
  const required: Array<[KeyContext, string, string]> = [
    ["roster", "shift+tab", "focus.shift.tab"],
    ["roster", "ctrl+d", "nav.half.down"],
    ["roster", "ctrl+u", "nav.half.up"],
    ["chat", "shift+tab", "focus.shift.tab"],
    ["chat", "ctrl+d", "chat.half.down"],
    ["work", "shift+tab", "focus.shift.tab"],
    ["work", "ctrl+d", "work.half.down"],
    ["work", "ctrl+u", "work.half.up"],
    ["work", "f", "work.filter"],
    ["work", "v", "work.approvals"],
    ["work", "pageup", "work.page.up"],
    ["work", "pagedown", "work.page.down"],
    ["settings", "shift+tab", "settings.tab.cycle.prev"],
    ["settings", "ctrl+d", "settings.half.down"],
    ["settings", "ctrl+u", "settings.half.up"],
    ["composerInsert", "enter", "composerInsert.enter"],
    ["composerInsert", "escape", "composerInsert.escape"],
    ["composerInsert", "ctrl+g", "composerInsert.leave"],
    ["composerNormal", "enter", "composerNormal.enter"],
    ["composerNormal", "escape", "composerNormal.escape"],
    ["composerNormal", "ctrl+g", "composerNormal.leave"],
    ["composerNormal", ":", "composerNormal.command"],
    ["composerNormal", "/", "composerNormal.search"],
    ["composerVisual", "escape", "composerVisual.escape"],
    ["composerVisual", "ctrl+g", "composerVisual.leave"],
    ["wizardField", "enter", "wizardField.submit"],
    ["wizardField", "escape", "wizardField.escape"],
    ["wizardField", "ctrl+g", "wizardField.leave"],
    ["wizardText", "enter", "wizardText.submit"],
    ["wizardText", "escape", "wizardText.escape"],
    ["wizardText", "ctrl+g", "wizardText.leave"],
    ["wizardText", "n", "wizardText.next"],
    ["wizardText", "shift+n", "wizardText.prev"],
    ["wizardText", "h", "wizardText.motion.h"],
    ["wizardText", "d", "wizardText.delete"],
    ["wizardText", "y", "wizardText.yank"],
    ["promptField", "enter", "promptField.submit"],
    ["promptField", "escape", "promptField.escape"],
    ["promptField", "ctrl+g", "promptField.leave"],
    ["promptText", "enter", "promptText.submit"],
    ["promptText", "escape", "promptText.escape"],
    ["promptText", "ctrl+g", "promptText.leave"],
    ["promptText", "p", "promptText.paste"],
    ["settingsField", "enter", "settingsField.submit"],
    ["settingsField", "escape", "settingsField.escape"],
    ["settingsField", "ctrl+g", "settingsField.leave"],
    ["settingsMemoryField", "enter", "settingsMemoryField.submit"],
    ["settingsMemoryField", "escape", "settingsMemoryField.escape"],
    ["settingsMemoryField", "ctrl+g", "settingsMemoryField.leave"],
    ["settingsMemoryText", "enter", "settingsMemoryText.submit"],
    ["settingsMemoryText", "escape", "settingsMemoryText.escape"],
    ["wizardMemory", "enter", "wizardMemory.save"],
    ["wizardMemory", "escape", "wizardMemory.list"],
    ["wizardMemory", "ctrl+g", "wizardMemory.leave"],
    ["settingsText", "enter", "settingsText.submit"],
    ["settingsText", "escape", "settingsText.escape"],
    ["settingsText", "ctrl+g", "settingsText.leave"],
    ["settingsText", "x", "settingsText.x"],
    ["help", "j", "help.down"],
    ["help", "ctrl+d", "help.half.down"],
    ["help", "pagedown", "help.page.down"],
    ["help", "escape", "help.close"],
    ["command", "enter", "command.run"],
    ["command", "escape", "command.cancel"],
    ["command", "up", "command.history.up"],
    ["command", "tab", "command.complete"],
    ["command", "backspace", "command.backspace"],
  ]
  for (const [context, token, id] of required) {
    assert.equal(singleKeyEntry(context, token)?.id, id, `${context} resolves ${token} to ${id}`)
  }
  assert.equal(KEYMAP_CATALOG.find((entry) => entry.id === "global.work"), undefined, "ticket183: F3 is retired")
  assert.ok(!globalEntries().some((entry) => entry.keys.includes("f3")), "no global binding claims F3")
  // Multi-key chords resolve through the same pending machine.
  assert.equal(actionId(resolveNormalKey("wizardText", ["g"], "g")), "wizardText.motion.gg")
  assert.equal(actionId(resolveNormalKey("wizardText", ["y"], "y")), "wizardText.yy")
  const dg = resolveNormalKey("promptText", ["d"], "g")
  assert.equal(dg.type, "pending")
  assert.deepEqual(dg.type === "pending" ? dg.prefix : [], ["d", "g"])
  assert.equal(actionId(resolveNormalKey("promptText", ["d", "g"], "g")), "promptText.dgg")
})

test("statusline hints for special text buffers are catalog-generated", () => {
  const composer = statuslineHints("composerNormal")
  assert.ok(composer.includes("i insert │ h/j/k/l"), composer)
  assert.ok(composer.includes("enter send │ esc chat"), composer)
  const insert = statuslineHints("composerInsert")
  assert.ok(insert.includes("enter send │ esc normal │ ctrl+g leave"), insert)
  const wizard = statuslineHints("wizardText")
  assert.ok(wizard.includes("i/a insert │ h/j/k/l"), wizard)
  assert.ok(wizard.includes("esc cancel"), wizard)
  assert.ok(wizard.includes("n next │ N previous"), wizard)
  const prompt = statuslineHints("promptText")
  assert.ok(prompt.includes("esc cancel"), prompt)
  const settings = statuslineHints("settingsText")
  assert.ok(settings.includes("esc settings"), settings)
  const field = statuslineHints("settingsField")
  assert.ok(field.includes("enter done │ esc field normal"), field)
})

test("leader and command hints are generated from their catalogs", () => {
  const leader = leaderHints()
  for (const hint of ["? help", "q leave", "esc cancel"]) assert.ok(leader.includes(hint), leader)
  const command = commandStatusHints(":")
  assert.ok(command.includes("enter run"), command)
  assert.ok(command.includes("tab complete"), command)
  const search = commandStatusHints("/")
  assert.ok(search.includes("enter search"), search)
  assert.ok(!search.includes("tab complete"), "search has no command-name completion")
})
