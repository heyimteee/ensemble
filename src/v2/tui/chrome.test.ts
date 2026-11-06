import test from "node:test"
import assert from "node:assert/strict"
import {
  approvalResolvingSuffix,
  approvalsEmptyLine,
  chromeOwnsFocus,
  dmEmptyDetail,
  footerLine1,
  footerLine2,
  helpEmptyLine,
  pickerEmptyLine,
  railBusyMark,
  railEmptyLine,
  resolveChromeFocus,
  skillsEmptyLine,
  type ChromeFocus,
} from "./chrome.ts"

const areas: ChromeFocus[] = ["rail", "chat", "composer", "overlay"]

test("slice E focus resolves to exactly one border owner in every state", () => {
  for (const focusArea of ["rail", "chat"] as const) {
    for (const composerActive of [false, true]) {
      for (const overlayOpen of [false, true]) {
        const focus = resolveChromeFocus({ focusArea, composerActive, overlayOpen })
        const owners = areas.filter((area) => chromeOwnsFocus(focus, area))
        assert.equal(owners.length, 1, `${focusArea}/${composerActive}/${overlayOpen} owns ${owners.join(",")}`)
      }
    }
  }
})

test("slice E focus precedence is overlay over composer over column", () => {
  assert.equal(resolveChromeFocus({ focusArea: "rail", composerActive: false, overlayOpen: false }), "rail")
  assert.equal(resolveChromeFocus({ focusArea: "chat", composerActive: false, overlayOpen: false }), "chat")
  assert.equal(resolveChromeFocus({ focusArea: "chat", composerActive: true, overlayOpen: false }), "composer")
  assert.equal(resolveChromeFocus({ focusArea: "rail", composerActive: true, overlayOpen: false }), "composer")
  assert.equal(resolveChromeFocus({ focusArea: "chat", composerActive: true, overlayOpen: true }), "overlay")
  assert.equal(resolveChromeFocus({ focusArea: "rail", composerActive: false, overlayOpen: true }), "overlay")
})

test("slice E footer line 1 changes with focus and never names hidden work", () => {
  const rail = footerLine1({ focus: "rail", hasWork: false })
  const chatIdle = footerLine1({ focus: "chat", hasWork: false })
  const chatWork = footerLine1({ focus: "chat", hasWork: true })
  const composer = footerLine1({ focus: "composer", hasWork: true })
  assert.ok(rail.includes("enter open"), "rail names its open action")
  assert.ok(!chatIdle.includes("enter result") && !chatIdle.includes("j/k work"), "idle chat hides work hints")
  assert.ok(chatWork.includes("tab work") && chatWork.includes("enter focus"), "active chat names the work zone and composer")
  assert.ok(composer.includes("enter send") && composer.includes("esc normal"), "composer names send/back")
  assert.ok(!composer.includes("enter result"), "composer hides dead work keys")
  assert.notEqual(rail, chatIdle)
  assert.notEqual(chatIdle, composer)
  assert.notEqual(chatWork, chatIdle)
})

test("slice E footer line 2 gates work keys and keeps missing-skills precedence", () => {
  const missing = ["phi-4"]
  assert.ok(footerLine2({ focus: "chat", hasWork: true, missingSkills: missing }).startsWith("! missing skills:"), "missing warning wins")
  assert.ok(footerLine2({ focus: "rail", hasWork: false, missingSkills: missing }).includes("phi-4"), "warning names the skill")
  const work = footerLine2({ focus: "chat", hasWork: true, missingSkills: [] })
  assert.ok(work.includes("tab work"), "the work zone is named with the block")
  const idle = footerLine2({ focus: "chat", hasWork: false, missingSkills: [] })
  assert.ok(!idle.includes("tab work"), "idle hides work keys")
  const composing = footerLine2({ focus: "composer", hasWork: true, missingSkills: [] })
  assert.ok(!composing.includes("tab work"), "composer hides dead work keys")
  const overlay = footerLine2({ focus: "overlay", hasWork: true, missingSkills: [] })
  assert.ok(!overlay.includes("tab work"), "dialog hides dead work keys")
})

test("slice E empty states name the fix action and key", () => {
  assert.equal(railEmptyLine(), "No agents or workspaces yet. n new workspace │ a new agent")
  assert.ok(skillsEmptyLine().includes("No matching skills"), "skills names the miss")
  assert.ok(skillsEmptyLine().includes("refine filter"), "skills names the fix")
  assert.ok(helpEmptyLine().includes("No matching shortcuts"), "help names the miss")
  assert.ok(pickerEmptyLine().includes("No matches"), "picker names the miss")
  assert.equal(approvalsEmptyLine(), "Nothing waits for you.")
  assert.ok(dmEmptyDetail().includes("i to compose"), "direct empty names its key")
})

test("ticket93: chrome footers use the shared faint bar instead of a dot", () => {
  const lines = [
    footerLine1({ focus: "rail", hasWork: false }),
    footerLine1({ focus: "chat", hasWork: true }),
    footerLine2({ focus: "chat", hasWork: true, missingSkills: [] }),
    footerLine2({ focus: "chat", hasWork: false, missingSkills: [] }),
    railEmptyLine(),
    approvalResolvingSuffix(true),
  ]
  for (const line of lines) {
    assert.ok(!line.includes(" · "), `dot separator remains: ${line}`)
    assert.ok(line.includes(" │ ") || line.startsWith("No "), `missing bar separator: ${line}`)
  }
})

test("slice E approval rows show Resolving… only while acted on", () => {
  assert.equal(approvalResolvingSuffix(false), "")
  assert.equal(approvalResolvingSuffix(true), " │ ⠋ Resolving…")
  assert.equal(approvalResolvingSuffix(true, 1), " │ ⠙ Resolving…")
  assert.equal(approvalResolvingSuffix(true, 9), " │ ⠏ Resolving…")
  assert.equal(approvalResolvingSuffix(true, 10), " │ ⠋ Resolving…")
  assert.equal(approvalResolvingSuffix(true, 3, { ENSEMBLE_REDUCED_MOTION: "1" }), " │ ⠋ Resolving…")
})

test("ticket114: rail busy counts use the one-cell Braille working frame", () => {
  assert.equal(railBusyMark(0, 0), "")
  assert.equal(railBusyMark(2, 0), "⠋2")
  assert.equal(railBusyMark(2, 1), "⠙2")
  assert.equal(railBusyMark(2, 9), "⠏2")
  assert.equal(railBusyMark(2, 10), "⠋2")
  assert.equal(railBusyMark(12, 4), "⠼12")
  assert.equal(railBusyMark(2, 3, { ENSEMBLE_REDUCED_MOTION: "1" }), "⠋2")
  for (let tick = 0; tick < 10; tick++) {
    assert.equal([...railBusyMark(3, tick)].length, 2, "one marker cell plus the count")
  }
})

test("ticket68: approval inbox tags distinguish native blocks from product decisions", async () => {
  const { approvalSourceTag } = await import("./chrome.ts")
  const { approvalSource } = await import("../types.ts")
  assert.equal(approvalSourceTag("native"), "Native")
  assert.equal(approvalSourceTag("agent"), "Agent")
  assert.equal(approvalSourceTag("workspace"), "Workspace")
  assert.equal(approvalSourceTag("memory"), "Memory")
  assert.equal(approvalSourceTag("unknown-source"), "Workspace")
  // Every approval kind carries a source label: the native permission
  // mirror reads Native; the agent question reads Agent; roster and
  // cross-project sharing read Workspace; memory promotion reads Memory.
  assert.equal(approvalSource({ kind: "native" } as any), "native")
  assert.equal(approvalSource({ kind: "ask_person" } as any), "agent")
  assert.equal(approvalSource({ kind: "outside_roster" } as any), "workspace")
  assert.equal(approvalSource({ kind: "interrupted" } as any), "workspace")
  assert.equal(approvalSource({ kind: "promote_memory" } as any), "memory")
  assert.equal(approvalSource({ kind: "cross_project" } as any), "workspace")
  // Legacy rows that stored the wrong cross-project source still read as
  // workspace decisions, never as memory promotions.
  assert.equal(approvalSource({ kind: "cross_project", source: "memory" } as any), "workspace")
  assert.equal(approvalSource({ kind: "cross_project", source: "workspace" } as any), "workspace")
  assert.equal(approvalSource({ kind: "promote_memory", source: "memory" } as any), "memory")
  assert.equal(approvalSource({ kind: "ask_person", source: "agent" } as any), "agent")
})
