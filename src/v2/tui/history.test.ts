import test from "node:test"
import assert from "node:assert/strict"
import {
  createCommandHistory,
  recallHistory,
  rememberHistory,
  startHistory,
} from "./history.ts"

test("command and search histories are separate lists with separate recall", () => {
  let history = createCommandHistory()
  history = rememberHistory(history, ":", "help")
  history = rememberHistory(history, "/", "fixture")

  assert.deepEqual(rememberHistory(history, ":", "settings")[":"].entries, ["help", "settings"])
  assert.deepEqual(rememberHistory(history, "/", "text")["/"].entries, ["fixture", "text"])
  assert.deepEqual(history[":"].entries, ["help"], "the original store was not mutated")
  assert.deepEqual(history["/"].entries, ["fixture"])
})

test("Up recalls newest first and stops at the oldest entry", () => {
  let history = createCommandHistory()
  history = rememberHistory(history, ":", "settings")
  history = rememberHistory(history, ":", "help")
  history = startHistory(history, ":")

  let recalled = recallHistory(history, ":", "up", "")
  assert.equal(recalled.text, "help")
  history = recalled.history
  recalled = recallHistory(history, ":", "up", "help")
  assert.equal(recalled.text, "settings")
  history = recalled.history
  recalled = recallHistory(history, ":", "up", "settings")
  assert.equal(recalled.text, "settings", "the oldest entry is a stop, not a wrap")
})

test("Down walks back to the draft typed before recall", () => {
  let history = createCommandHistory()
  history = rememberHistory(history, ":", "settings")
  history = rememberHistory(history, ":", "help")
  history = startHistory(history, ":")

  let recalled = recallHistory(history, ":", "up", "set")
  assert.equal(recalled.text, "help")
  history = recalled.history
  recalled = recallHistory(history, ":", "up", "help")
  assert.equal(recalled.text, "settings")
  history = recalled.history
  recalled = recallHistory(history, ":", "down", "settings")
  assert.equal(recalled.text, "help")
  history = recalled.history
  recalled = recallHistory(history, ":", "down", "help")
  assert.equal(recalled.text, "set", "Down past the newest entry restores the prior draft")
  history = recalled.history
  assert.equal(recallHistory(history, ":", "down", "set").text, "set", "Down on the draft is a no-op")
})

test("empty and consecutive duplicate commands are not recorded", () => {
  let history = createCommandHistory()
  history = rememberHistory(history, ":", "")
  history = rememberHistory(history, ":", "   ")
  assert.deepEqual(history[":"].entries, [])
  history = rememberHistory(history, ":", "help")
  history = rememberHistory(history, ":", "help")
  assert.deepEqual(history[":"].entries, ["help"])
})

test("starting a fresh line resets recall without dropping the list", () => {
  let history = createCommandHistory()
  history = rememberHistory(history, ":", "help")
  history = recallHistory(history, ":", "up", "").history
  history = startHistory(history, ":")
  assert.deepEqual(history[":"], { entries: ["help"], index: null, draft: "" })
})
