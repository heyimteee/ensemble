import test from "node:test"
import assert from "node:assert/strict"
import {
  SETTINGS_FLASH_MS,
  createMissingSkillsTracker,
  missingSkillsKey,
  settingsAcknowledgement,
  settingsFeedbackSignal,
  settingsFlashActive,
  settingsRowFlash,
  trackMissingSkills,
} from "./settings-feedback.ts"

const reduced = { ENSEMBLE_REDUCED_MOTION: "1" }

test("a save flashes once, then settles to its final state", () => {
  const saved = settingsFeedbackSignal("saved", null, 1000)
  assert.equal(saved.kind, "saved")
  assert.equal(settingsFlashActive(saved, 1000), true, "the signal starts lit")
  assert.equal(settingsFlashActive(saved, 1000 + SETTINGS_FLASH_MS - 1), true, "the flash lasts one window")
  assert.equal(settingsFlashActive(saved, 1000 + SETTINGS_FLASH_MS), false, "the flash ends and never restarts")
  assert.equal(settingsFlashActive(saved, 999), false, "a signal never flashes before it fired")

  const lit = settingsAcknowledgement(saved, 1000)
  assert.equal(lit.saved, true)
  assert.equal(lit.savedFlash, true)
  const settled = settingsAcknowledgement(saved, 1000 + SETTINGS_FLASH_MS)
  assert.equal(settled.saved, true, "the saved state word remains after the flash")
  assert.equal(settled.savedFlash, false)
})

test("reduced motion keeps the final state without a flash", () => {
  const saved = settingsFeedbackSignal("saved", null, 1000)
  const ack = settingsAcknowledgement(saved, 1000, reduced)
  assert.equal(ack.saved, true, "the saved state still reads")
  assert.equal(ack.savedFlash, false, "no decorative flash under reduced motion")

  const memory = settingsAcknowledgement(settingsFeedbackSignal("memory-added", "mem-1", 1000), 1000, reduced)
  assert.equal(memory.memoryID, "mem-1", "the row identity survives")
  assert.equal(memory.memoryFlash, false, "the row mounts at its final color")
})

test("a row acknowledgement names exactly one memory or skill and expires once", () => {
  const memory = settingsFeedbackSignal("memory-added", "mem-1", 2000)
  const ack = settingsAcknowledgement(memory, 2000)
  assert.equal(ack.memoryID, "mem-1")
  assert.equal(ack.memoryFlash, true)
  assert.equal(ack.skillID, null, "memory feedback never highlights a skill row")
  assert.equal(ack.saved, false)

  const settled = settingsAcknowledgement(memory, 2000 + SETTINGS_FLASH_MS)
  assert.equal(settled.memoryID, "mem-1", "the acknowledged row identity remains after the flash")
  assert.equal(settled.memoryFlash, false)

  const skill = settingsAcknowledgement(settingsFeedbackSignal("skill-changed", "skill-1", 3000), 3000)
  assert.equal(skill.skillID, "skill-1")
  assert.equal(skill.skillFlash, true)
  assert.equal(skill.memoryID, null, "skill feedback never highlights a memory row")

  const none = settingsAcknowledgement(null, 3000)
  assert.deepEqual(none, {
    saved: false,
    savedFlash: false,
    memoryID: null,
    memoryFlash: false,
    skillID: null,
    skillFlash: false,
    missingFlash: false,
  })
})

test("one row predicate serves both memory and skill acknowledgements", () => {
  const memory = settingsAcknowledgement(settingsFeedbackSignal("memory-added", "mem-1", 1000), 1000)
  assert.equal(settingsRowFlash(memory, "memory", "mem-1"), true)
  assert.equal(settingsRowFlash(memory, "memory", "mem-2"), false, "only the named memory row flashes")
  assert.equal(settingsRowFlash(memory, "skill", "mem-1"), false, "a memory signal never lights a skill row")
  const skill = settingsAcknowledgement(settingsFeedbackSignal("skill-changed", "skill-1", 1000), 1000)
  assert.equal(settingsRowFlash(skill, "skill", "skill-1"), true)
  assert.equal(settingsRowFlash(skill, "memory", "skill-1"), false)
  const settled = settingsAcknowledgement(settingsFeedbackSignal("skill-changed", "skill-1", 1000), 1000 + SETTINGS_FLASH_MS)
  assert.equal(settingsRowFlash(settled, "skill", "skill-1"), false, "the settled row keeps its final color without a flash")
  assert.equal(settingsRowFlash(undefined, "memory", "mem-1"), false)
})

test("missing-skill emphasis fires once per set and does not loop on refreshes", () => {
  const tracker = createMissingSkillsTracker()
  const first = trackMissingSkills(tracker, ["beta", "alpha"], 10)
  assert.equal(first?.kind, "missing-skills")
  assert.equal(first?.key, missingSkillsKey(["alpha", "beta"]), "the key is order-independent")
  assert.equal(trackMissingSkills(tracker, ["alpha", "beta"], 20), null, "a snapshot refresh does not re-signal")
  assert.equal(trackMissingSkills(tracker, ["beta", "alpha"], 30), null, "reordering the same set does not re-signal")
  assert.equal(trackMissingSkills(tracker, [], 40), null, "a cleared warning has nothing to emphasize")
  assert.equal(trackMissingSkills(tracker, ["gamma"], 50)?.key, "gamma", "a changed set emphasizes once more")
})
