import test from "node:test"
import assert from "node:assert/strict"
import {
  ASCII_SEPARATOR,
  CHROME_SEPARATOR,
  chromeJoin,
  chromeSeparator,
  chromeSeparatorParts,
  chromeSplit,
} from "./separators.ts"

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
