/**
 * v5.6 settings interaction grammar (ticket #83).
 *
 * One pure row/tab model behind the settings surface: tabs, rows, and the
 * per-tab add/delete/filter/toggle actions. The keymap catalog owns the keys;
 * this module owns what a row is and where a cursor can move. The app adapter
 * only turns these decisions into draft mutations and RPC calls.
 */

import type { SettingsTabID } from "./skills.ts"

export const SETTINGS_TABS: readonly SettingsTabID[] = ["general", "models", "memories", "skillbox"]

/** General-tab text fields in row order; model and mirror rows follow. */
export const SETTINGS_FIELDS = ["name", "title", "role", "color"] as const

export type SettingsFieldID = (typeof SETTINGS_FIELDS)[number]

export type SettingsRowKind = "field" | "model" | "toggle" | "backup" | "memory" | "skill" | "none"

export type SettingsCounts = {
  backups: number
  memories: number
  skills: number
}

/** Rows in a tab: identity + model + mirror, main + backups, memories, skills. */
export function settingsRowCount(tab: SettingsTabID, counts: SettingsCounts): number {
  switch (tab) {
    case "general":
      return SETTINGS_FIELDS.length + 2
    case "models":
      return 1 + counts.backups
    case "memories":
      return counts.memories
    case "skillbox":
      return counts.skills
  }
}

/** Tab key semantics: h/l or Tab/Shift+Tab, with wraparound. */
export function settingsTabStep(tab: SettingsTabID, delta: number): SettingsTabID {
  const index = Math.max(0, SETTINGS_TABS.indexOf(tab))
  const next = (index + delta + SETTINGS_TABS.length) % SETTINGS_TABS.length
  return SETTINGS_TABS[next]
}

export function settingsTabAfterKey(tab: SettingsTabID, key: string): SettingsTabID | null {
  if (key === "tab") return settingsTabStep(tab, 1)
  if (key === "shift+tab") return settingsTabStep(tab, -1)
  if (key === "l") return settingsTabStep(tab, 1)
  if (key === "h") return settingsTabStep(tab, -1)
  return null
}

export function clampSettingsRow(cursor: number, count: number): number {
  if (count <= 0) return 0
  return Math.max(0, Math.min(count - 1, Math.trunc(cursor)))
}

export function moveSettingsRow(cursor: number, delta: number, count: number): number {
  return clampSettingsRow(clampSettingsRow(cursor, count) + delta, count)
}

/** What the row at `cursor` is, independent of which tab renders it. */
export function settingsRowKind(tab: SettingsTabID, cursor: number, counts: SettingsCounts): SettingsRowKind {
  if (cursor < 0 || cursor >= settingsRowCount(tab, counts)) return "none"
  switch (tab) {
    case "general":
      if (cursor < SETTINGS_FIELDS.length) return "field"
      return cursor === SETTINGS_FIELDS.length ? "model" : "toggle"
    case "models":
      return cursor === 0 ? "model" : "backup"
    case "memories":
      return "memory"
    case "skillbox":
      return "skill"
  }
}

/** General-tab row -> editable text field; the model row has no text field. */
export function settingsFieldAtRow(cursor: number): SettingsFieldID | null {
  return SETTINGS_FIELDS[cursor] ?? null
}

export type SettingsAddAction = "none" | "backup" | "memory"
export type SettingsDeleteAction = "none" | "backup" | "memory"

export function settingsAddAction(tab: SettingsTabID): SettingsAddAction {
  if (tab === "models") return "backup"
  if (tab === "memories") return "memory"
  return "none"
}

export function settingsDeleteAction(tab: SettingsTabID): SettingsDeleteAction {
  if (tab === "models") return "backup"
  if (tab === "memories") return "memory"
  return "none"
}

export function settingsFilterable(tab: SettingsTabID): boolean {
  return tab === "memories" || tab === "skillbox"
}

export function settingsToggleAction(tab: SettingsTabID): "skill" | "none" {
  return tab === "skillbox" ? "skill" : "none"
}

export function settingsPromoteAction(tab: SettingsTabID): "memory" | "none" {
  return tab === "memories" ? "memory" : "none"
}

export function settingsReorderAction(tab: SettingsTabID): "backup" | "none" {
  return tab === "models" ? "backup" : "none"
}

/**
 * Move one backup by one slot. Returns the new list and cursor index, or null
 * when the move is out of range so callers never invent a no-op mutation.
 */
export function reorderBackupList<T>(
  backups: readonly T[],
  index: number,
  direction: "up" | "down",
): { backups: T[]; index: number } | null {
  if (!Number.isInteger(index) || index < 0 || index >= backups.length) return null
  const target = direction === "up" ? index - 1 : index + 1
  if (target < 0 || target >= backups.length) return null
  const next = [...backups]
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item)
  return { backups: next, index: target }
}

const FIELD_LABELS: Record<SettingsFieldID, string> = {
  name: "Name",
  title: "Title",
  role: "Role",
  color: "Color",
}

export function settingsFieldLabel(field: SettingsFieldID): string {
  return FIELD_LABELS[field]
}

/** Collapse identity fields to one line; roles keep their intentional breaks. */
export function normalizeSettingsField(field: SettingsFieldID, value: string): string {
  if (field === "role") return value.replace(/[ \t]+\n/g, "\n").trim()
  return value.replace(/\s+/g, " ").trim()
}
