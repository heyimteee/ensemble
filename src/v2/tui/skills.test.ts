import test from "node:test"
import assert from "node:assert/strict"
import {
  SKILL_VISIBLE_LIMIT,
  capLineText,
  capSkills,
  filterSkills,
  settingsTabLine,
  skillAssigned,
  skillPageCount,
  skillPageForCursor,
  skillPageItems,
  skillPageSlice,
  skillPaginationText,
  skillRowLabel,
  skillToggleMark,
} from "./skills.ts"
import type { SkillOption } from "../types.ts"

const catalog: SkillOption[] = [
  { id: "review", name: "Review", description: "Thorough code review with actionable findings" },
  { id: "deploy", name: "Deploy", description: "Ship the release pipeline" },
  { id: "notes", name: "Notes" },
]

test("skill filtering matches id, name, and description substrings case-insensitively", () => {
  assert.deepEqual(filterSkills(catalog, "").map((skill) => skill.id), ["review", "deploy", "notes"])
  assert.deepEqual(filterSkills(catalog, "REV").map((skill) => skill.id), ["review"])
  assert.deepEqual(filterSkills(catalog, "ship").map((skill) => skill.id), ["deploy"])
  assert.deepEqual(filterSkills(catalog, "notes").map((skill) => skill.id), ["notes"])
  assert.deepEqual(filterSkills(catalog, "zzz-no-such-skill"), [])
})

test("skill rows read name — description with an id fallback when undescribed", () => {
  assert.equal(skillRowLabel(catalog[0]), "Review — Thorough code review with actionable findings")
  assert.equal(skillRowLabel(catalog[2]), "Notes (notes)")
  assert.equal(skillRowLabel({ id: "lint", name: "lint" }), "lint")
})

test("assignment state is a fill mark, never a tick", () => {
  assert.equal(skillAssigned(["review"], "review"), true)
  assert.equal(skillAssigned(["review"], "deploy"), false)
  assert.equal(skillToggleMark(true), "[x]")
  assert.equal(skillToggleMark(false), "[ ]")
})

test("the visible cap keeps 12 rows and names the overflow explicitly", () => {
  assert.equal(SKILL_VISIBLE_LIMIT, 12)
  const many: SkillOption[] = Array.from({ length: 15 }, (_, index) => ({ id: `s${index}`, name: `s${index}` }))
  const capped = capSkills(many)
  assert.equal(capped.visible.length, 12)
  assert.equal(capped.overflow, 3)
  assert.equal(capLineText(capped.overflow), "· +3 more — refine filter")
  const exact = capSkills(many.slice(0, 12))
  assert.equal(exact.overflow, 0)
  assert.equal(exact.visible.length, 12)
})

test("the settings tab line carries live counts and marks the active tab", () => {
  const line = settingsTabLine("skillbox", 2, 1, 9)
  assert.ok(line.includes("Memories (2)"), `memories count missing: ${line}`)
  assert.ok(line.includes("Skillbox (1/9"), `skillbox counts missing: ${line}`)
  assert.ok(line.includes("›"), `active tab not marked: ${line}`)
  const general = settingsTabLine("general", 0, 0, 0)
  assert.ok(general.startsWith("› General"), `active general not marked: ${general}`)
})

test("skill pagination keeps the cursor row visible with a page indicator", () => {
  const many: SkillOption[] = Array.from({ length: 30 }, (_, index) => ({ id: `s${index}`, name: `s${index}` }))
  assert.equal(skillPageCount(30), 3)
  assert.deepEqual(skillPageSlice(many, 2).slice(0, 1).map((skill) => skill.id), ["s12"])
  const third = skillPageItems(many, 3)
  assert.equal(third[0].index, 24)
  assert.equal(third.at(-1)?.index, 29)
  assert.equal(skillPageForCursor(0), 1)
  assert.equal(skillPageForCursor(12), 2)
  assert.equal(skillPageForCursor(25), 3)
  assert.equal(skillPaginationText(30, 2), "page 2/3 · PgUp/PgDn")
  assert.equal(skillPaginationText(5, 1), "")
  // The last page may be short; the cursor still addresses real rows only.
  assert.equal(skillPageItems(many.slice(0, 29), 3).length, 5)
})
