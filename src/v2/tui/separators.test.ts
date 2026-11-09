import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  ASCII_SEPARATOR,
  CHROME_SEPARATOR,
  chromeJoin,
  chromeSeparator,
  chromeSeparatorParts,
  chromeSplit,
} from "./separators.ts"
import { settingsHeader, modelPickerLabel } from "./settings.ts"
import { memoryProvenanceLine } from "./memories.ts"
import { capLineText, settingsTabLine } from "./skills.ts"
import { wizardModelEmptyHint, wizardModelOptions } from "./wizard.ts"

test("chrome separators are a faint bar with one space on each side", () => {
  assert.equal(CHROME_SEPARATOR, "│")
  assert.equal(ASCII_SEPARATOR, "|")
  assert.equal(chromeJoin(["NORMAL", "Roster", "j/k move"]), "NORMAL │ Roster │ j/k move")
})

test("ASCII is only the fallback for a dumb or explicitly-ASCII terminal", () => {
  assert.equal(chromeSeparator({}), "│")
  assert.equal(chromeSeparator({ TERM: "xterm-256color" }), "│")
  assert.equal(chromeSeparator({ ENSEMBLE_ASCII: "1" }), "|")
  assert.equal(chromeSeparator({ ENSEMBLE_ASCII: "true" }), "|")
  assert.equal(chromeSeparator({ TERM: "dumb" }), "|")
})

test("splitting a chrome line keeps separator spans addressable", () => {
  assert.deepEqual(chromeSeparatorParts("NORMAL │ Roster"), [
    { text: "NORMAL", separator: false },
    { text: " │ ", separator: true },
    { text: "Roster", separator: false },
  ])
  assert.deepEqual(chromeSeparatorParts("one │ two │ three"), [
    { text: "one", separator: false },
    { text: " │ ", separator: true },
    { text: "two", separator: false },
    { text: " │ ", separator: true },
    { text: "three", separator: false },
  ])
  assert.deepEqual(chromeSeparatorParts("plain"), [{ text: "plain", separator: false }])
})

test("chrome lists round-trip through the shared separator", () => {
  assert.deepEqual(chromeSplit("NORMAL │ Roster │ j/k move"), ["NORMAL", "Roster", "j/k move"])
  assert.deepEqual(chromeSplit("one · two"), ["one", "two"], "legacy dot lists still split")
  assert.deepEqual(chromeSplit("one | two", "|"), ["one", "two"])
})

test("settings, memory, picker, and wizard chrome use bars instead of dots", () => {
  const lines = [
    settingsHeader("FakeAgent", true, true),
    settingsTabLine("skillbox", 2, 1, 9),
    memoryProvenanceLine({ origin: "manual", scope: "project", history: [], text: "fact" } as any),
    modelPickerLabel({ providerID: "fake", modelID: "m1", name: "Model", variants: ["low", "high"] } as any),
    capLineText(3),
    wizardModelEmptyHint("no catalog"),
    wizardModelOptions([{ providerID: "fake", modelID: "m1", name: "Model" }])[0].label,
  ]
  for (const line of lines) {
    assert.ok(!line.includes(" · "), `dot separator remains: ${line}`)
    assert.ok(line.includes(" │ "), `missing bar separator: ${line}`)
  }
})

test("app chrome no longer hardcodes the work footer or per-agent activity rows", () => {
  const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  // Ticket #172: the Work pane's action hints come from the keymap catalog in
  // the statusline, so the app carries no second hand-written footer.
  assert.ok(!source.includes('chromeJoin(["d delegate"'), "the Work pane has no hand-written action footer")
  assert.ok(!source.includes("d delegate │ t reassign"), "the Work pane no longer hardcodes a bar")
  // Ticket #181: chat carries one aggregate summary line instead of per-agent
  // activity rows and their overflow line.
  assert.ok(!source.includes("+{liveActivity().overflow} more"), "the activity overflow row is gone")
  assert.ok(!source.includes("liveActivity().shown"), "no per-agent activity rows remain")
  assert.ok(source.includes("text={liveActivity().text}"), "the activity summary renders through ChromeText")
  assert.ok(source.includes("text={surfaceTitle()}"), "the surface title renders through ChromeText for faint separators")
})
