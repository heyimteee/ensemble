import test from "node:test"
import assert from "node:assert/strict"
import type { InitJob } from "../types.ts"
import { activeInitJobs, initMessageIDs, initRowForJob, initRowText, initStageIndicator } from "./initrow.ts"

function job(overrides: Partial<InitJob> = {}): InitJob {
  return {
    id: "init_1",
    workspaceID: "w",
    messageID: "m",
    state: "running",
    phase: "starting",
    phases: ["starting"],
    previousAgentsMD: null,
    startedAt: 10,
    ...overrides,
  }
}

test("ticket118: the init row has four honest stages and no fabricated percentage", () => {
  assert.equal(initStageIndicator("starting"), "● ○ ○ ○")
  assert.equal(initStageIndicator("running"), "● ● ○ ○")
  assert.equal(initStageIndicator("writing"), "● ● ● ○")
  assert.equal(initStageIndicator("reporting"), "● ● ● ●")
})

test("ticket118: the running phase is labeled indeterminate and explains the opaque native call", () => {
  const row = initRowForJob(job({ phase: "running", phases: ["starting", "running"] }), 0, {})
  assert.equal(row.phase, "running")
  assert.equal(row.label, "running · indeterminate")
  assert.equal(row.stage, "● ● ○ ○")
  assert.equal(row.detail, "native /init is opaque; progress is indeterminate")
  assert.equal(row.glyph, "⠋")
  const text = initRowText(row)
  assert.match(text, /System Agent/)
  assert.match(text, /running · indeterminate/)
  assert.match(text, /● ● ○ ○/)
  assert.match(text, /opaque/)
  assert.equal(text.includes("%"), false, "the row never claims a percentage")
})

test("ticket118: every stage reads as its own label and detail without a percentage", () => {
  const rows = ["starting", "running", "writing", "reporting"].map((phase) =>
    initRowForJob(job({ phase: phase as InitJob["phase"], phases: [phase as NonNullable<InitJob["phase"]>] }), 0, {}),
  )
  assert.deepEqual(rows.map((row) => row.label), [
    "starting",
    "running · indeterminate",
    "writing",
    "reporting",
  ])
  for (const row of rows) assert.equal(initRowText(row).includes("%"), false, row.phase)
})

test("ticket118: the init glyph animates on the shared clock and pins under reduced motion", () => {
  const running = job({ phase: "running", phases: ["starting", "running"] })
  assert.equal(initRowForJob(running, 0, {}).glyph, "⠋")
  assert.equal(initRowForJob(running, 1, {}).glyph, "⠙")
  assert.equal(initRowForJob(running, 3, { ENSEMBLE_REDUCED_MOTION: "1" }).glyph, "⠋")
})

test("ticket118: only running jobs in the active workspace render as live init rows", () => {
  const jobs = {
    a: job({ id: "a", workspaceID: "w", messageID: "message-a", startedAt: 20, phase: "running", phases: ["starting", "running"] }),
    b: job({ id: "b", workspaceID: "w", messageID: "message-b", startedAt: 10, phase: "starting", phases: ["starting"] }),
    c: job({ id: "c", workspaceID: "other", messageID: "message-c", startedAt: 5 }),
    d: job({ id: "d", workspaceID: "w", messageID: "message-d", startedAt: 1, state: "succeeded", phase: "reporting", phases: ["starting", "running", "writing", "reporting"] }),
  }
  assert.deepEqual(activeInitJobs(jobs, "w").map((item) => item.id), ["b", "a"])
  assert.deepEqual([...initMessageIDs(jobs, "w")].sort(), ["message-a", "message-b", "message-d"])
})

test("ticket118: a legacy running job without a stored phase reads as running", () => {
  const legacy = job({ phase: undefined, phases: undefined })
  const row = initRowForJob(legacy, 0, {})
  assert.equal(row.phase, "running")
  assert.equal(row.label, "running · indeterminate")
  assert.equal(row.stage, "● ● ○ ○")
})
