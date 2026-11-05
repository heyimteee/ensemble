import type { SkillOption } from "../types.ts"
import { chromeJoin } from "./separators.ts"

/** Settings tabs that share the settings frame header. */
export type SettingsTabID = "general" | "models" | "memories" | "skillbox"

/**
 * Skill palette seams (ticket #61). Pure helpers behind the Skillbox tab:
 * substring filtering over id/name/description, `name — description` row
 * labels, fill-not-tick assignment marks, and an explicit overflow line
 * once the viewport cap is exceeded.
 */

/** Rows rendered before the overflow line names the remainder. */
export const SKILL_VISIBLE_LIMIT = 12

/** Substring filter across id, name, and description (case-insensitive). */
export function filterSkills(catalog: readonly SkillOption[], query: string): SkillOption[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...catalog]
  return catalog.filter((skill) =>
    skill.id.toLowerCase().includes(needle) ||
    skill.name.toLowerCase().includes(needle) ||
    (skill.description ?? "").toLowerCase().includes(needle),
  )
}

/** Palette row: `name — description`, falling back to `name (id)` or `name`. */
export function skillRowLabel(skill: SkillOption): string {
  const description = (skill.description ?? "").trim()
  if (description) return `${skill.name} — ${description}`
  if (skill.name !== skill.id) return `${skill.name} (${skill.id})`
  return skill.name
}

/** Assignment state: granted exactly when the draft skillbox holds the id. */
export function skillAssigned(skillbox: readonly string[], id: string): boolean {
  return skillbox.includes(id)
}

/** Fill-not-tick mark: state is the fill, never a tick. */
export function skillToggleMark(assigned: boolean): string {
  return assigned ? "[x]" : "[ ]"
}

export function capSkills<T>(list: readonly T[], limit: number = SKILL_VISIBLE_LIMIT): { visible: T[]; overflow: number } {
  if (list.length <= limit) return { visible: [...list], overflow: 0 }
  return { visible: list.slice(0, limit), overflow: list.length - limit }
}

/** Overflow line shown when the catalog/filter exceeds the viewport. */
export function capLineText(overflow: number): string {
  return chromeJoin([`+${overflow} more`, "refine filter"])
}

/** Pagination helpers for the Skillbox tab (ticket #77): 12 rows per page. */
export function skillPageCount(total: number, perPage: number = SKILL_VISIBLE_LIMIT): number {
  return Math.max(1, Math.ceil(total / perPage))
}

/** `page 3/11` grammar; empty when everything fits on one page. */
export function skillPaginationText(total: number, page: number, perPage: number = SKILL_VISIBLE_LIMIT): string {
  const pages = skillPageCount(total, perPage)
  if (pages <= 1) return ""
  const current = Math.max(1, Math.min(page, pages))
  return `page ${current}/${pages}`
}

/** Window of row indices for a page, preserving absolute cursor indices. */
export function skillPageItems(skills: SkillOption[], page: number, perPage: number = SKILL_VISIBLE_LIMIT): Array<{ skill: SkillOption; index: number }> {
  const start = (Math.max(1, page) - 1) * perPage
  return skills.slice(start, start + perPage).map((skill, index) => ({ skill, index: start + index }))
}

/** Page window of plain skill rows (no index wrapper) for cursor math. */
export function skillPageSlice<T>(list: readonly T[], page: number, perPage: number = SKILL_VISIBLE_LIMIT): T[] {
  const start = (Math.max(1, page) - 1) * perPage
  return list.slice(start, start + perPage)
}

/** Page holding the cursor row; keeps the visible window in sync with j/k. */
export function skillPageForCursor(cursor: number, perPage: number = SKILL_VISIBLE_LIMIT): number {
  return Math.floor(Math.max(0, cursor) / perPage) + 1
}

/**
 * Settings tab line with live counts; the active tab keeps the `›` cursor.
 * Skillbox keeps its `Tab` cycle hint alongside the assigned/catalog counts.
 */
export function settingsTabLine(tab: SettingsTabID, memoryCount: number, assignedCount: number, catalogCount: number): string {
  const segments: Array<[SettingsTabID, string]> = [
    ["general", "General"],
    ["models", "Models"],
    ["memories", `Memories (${memoryCount})`],
    ["skillbox", `Skillbox (${assignedCount}/${catalogCount}) │ Tab`],
  ]
  return chromeJoin(segments.map(([id, label]) => (id === tab ? `› ${label}` : label)))
}
