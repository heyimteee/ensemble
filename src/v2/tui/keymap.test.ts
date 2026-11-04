import test from "node:test"
import assert from "node:assert/strict"
import {
  KEYMAP_CATALOG,
  duplicateBindings,
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
  for (const sequence of ["h", "l", "tab", "shift+tab", "j", "k", "g g", "shift+g", "enter", "a", "e", "x", "space", "s", "/", "escape"]) {
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
})

test("settings hints keep teaching keys only where that tab has the action", () => {
  const enabled = (tab: "general" | "models" | "memories" | "skillbox") => (entry: { id: string }) => {
    if (entry.id === "settings.add") return tab === "models" || tab === "memories"
    if (entry.id === "settings.delete") return tab === "models" || tab === "memories"
    if (entry.id === "settings.toggle") return tab === "skillbox"
    if (entry.id === "settings.filter") return tab === "memories" || tab === "skillbox"
    return true
  }
  const general = statuslineHints("settings", { filter: enabled("general") })
  for (const hint of ["h/l tabs", "j/k rows", "enter edit", "s save", "esc close"]) {
    assert.ok(general.includes(hint), `general teaches ${hint}: ${general}`)
  }
  assert.ok(!general.includes("a add"), "general has no add row")
  assert.ok(!general.includes("/ filter"), "general has no filter tab")

  const memories = statuslineHints("settings", { filter: enabled("memories") })
  assert.ok(memories.includes("a add"), memories)
  assert.ok(memories.includes("x delete"), memories)
  assert.ok(memories.includes("/ filter"), memories)

  const skillbox = statuslineHints("settings", { filter: enabled("skillbox") })
  assert.ok(skillbox.includes("space toggle"), skillbox)
  assert.ok(!skillbox.includes("a add"), "skillbox has no add row")
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
  assert.equal(keyLabel(["enter"]), "Enter")
  assert.equal(keyLabel(["space"]), "Space")
  assert.equal(keyLabel(["escape"]), "Esc")
})

test("raw keypresses normalize to catalog tokens", () => {
  assert.equal(normalizeKeyToken({ name: "space", sequence: " " }), "space")
  assert.equal(normalizeKeyToken({ name: "return" }), "enter")
  assert.equal(normalizeKeyToken({ name: "escape" }), "escape")
  assert.equal(normalizeKeyToken({ name: "tab" }), "tab")
  assert.equal(normalizeKeyToken({ name: "g", shift: true }), "shift+g")
  assert.equal(normalizeKeyToken({ name: "G", sequence: "G" }), "shift+g")
  assert.equal(normalizeKeyToken({ name: "d", ctrl: true }), "ctrl+d")
  assert.equal(normalizeKeyToken({ name: "ctrl+d" }), "ctrl+d")
  assert.equal(normalizeKeyToken({ name: "?", sequence: "?" }), "?")
  assert.equal(normalizeKeyToken({ name: "/", sequence: "/" }), "/")
})
