import type { ModelOption } from "../types.ts"
import { short } from "./format.ts"
import type { SettingsTabID } from "./skills.ts"
import { skillsEmptyLine } from "./chrome.ts"

/**
 * Slice G settings language (ticket #69). One designed grammar behind every
 * settings surface — agents/general, models, memories, skillbox, the agent
 * list, and the model picker: section headers, card-like blocks, aligned
 * label/value columns, descriptions and counts, one consistent selection
 * marker, and one action-footer grammar. Pure helpers only; components and
 * the model picker render these strings so empty, loading, dirty,
 * unavailable, and error states share the same visual grammar.
 */

/** Label column width behind every `label value` row. Labels here top out at
 * `Backup N` widths; the constant keeps values on one shared column. */
export const SETTINGS_LABEL_WIDTH = 10

/** Card rule width behind section dividers (components truncate to fit). */
export const SETTINGS_DIVIDER_WIDTH = 48

/** One selection marker everywhere: `› ` on the cursor row, blanks elsewhere. */
export function settingsCursorMark(selected: boolean): string {
  return selected ? "› " : "  "
}

/** Header grammar: `Name · settings` plus dirty and pending-deferral flags. */
export function settingsHeader(agentName: string, dirty: boolean, pending: boolean): string {
  return `${agentName} · settings${dirty ? " · UNSAVED" : ""}${pending ? " · pending next task" : ""}`
}

/** Per-tab section header naming the section plus its live counts. */
export function settingsSectionHeader(
  tab: SettingsTabID,
  counts: { memories: number; backups: number; assigned: number; catalog: number },
): string {
  switch (tab) {
    case "general":
      return "Identity — name · title · role · color · model"
    case "models":
      return `Main + backups — ${modelsSectionCount(counts.backups)}`
    case "memories":
      return `Saved knowledge — Memories (${counts.memories})`
    case "skillbox":
      return `Optional skills — Skillbox (${counts.assigned}/${counts.catalog})`
  }
}

/** One shared rule between the header, the section body, and the footer. */
export function settingsDivider(): string {
  return "─".repeat(SETTINGS_DIVIDER_WIDTH)
}

/** Aligned row: the label pads to the shared column, the value follows. */
export function settingsFieldRow(label: string, value: string): string {
  return `${label.padEnd(SETTINGS_LABEL_WIDTH)} ${value}`
}

export type GeneralFieldSource = {
  name: string
  title: string
  role: string
  color: string
}

/** General tab rows: identity, role, color, plus the main-model summary. */
export function generalFieldRows(
  agent: GeneralFieldSource,
  mainModel: { providerID: string; modelID: string; variant?: string },
): Array<[string, string]> {
  return [
    ["Name", agent.name],
    ["Title", agent.title || "(empty)"],
    ["Role", short(agent.role || "(empty)", 100)],
    ["Color", agent.color || "(empty)"],
    ["Model", modelSummary(mainModel)],
  ]
}

/** Compact model identity: `provider/model` plus `#variant` when set. */
export function modelSummary(model: { providerID: string; modelID: string; variant?: string }): string {
  return `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}`
}

/** Backup row label with its slot number and variant info. */
export function backupRowLabel(
  index: number,
  model: { providerID: string; modelID: string; variant?: string },
): string {
  return `Backup ${index + 1}: ${modelSummary(model)}`
}

/** Models section count grammar: the main slot plus the backup depth. */
export function modelsSectionCount(backupCount: number): string {
  return `main + ${backupCount} backups`
}

/** Models empty state: names the state and the add key. */
export function modelsEmptyLine(): string {
  return "No backups yet. b adds one."
}

/** Memories empty state (exact legacy copy, now pinned in one place). */
export function memoriesEmptyLine(): string {
  return "No memories yet. e adds one."
}

/** Memories filter zero state (exact legacy copy, now pinned in one place). */
export function memoriesNoMatchLine(): string {
  return "No matching memories — refine filter."
}

/** No-agent state: names the state and the open key. */
export function settingsNoAgentLine(): string {
  return "No agent selected. s opens settings."
}

/** Loading state grammar for settings surfaces awaiting a snapshot. */
export function settingsLoadingLine(): string {
  return "Loading settings…"
}

/** Unavailable state: the host offers no skill catalog, so the miss is the
 *  catalog — never the filter. */
export function skillsUnavailableLine(): string {
  return "No skills available from the host."
}

/** Re-export the skillbox zero state so every tab reads empty lines from
 *  this seam. */
export function skillboxEmptyLine(): string {
  return skillsEmptyLine()
}

/** Per-tab action footer: the keys that act on this tab. The shared save
 *  line renders beneath it via settingsSaveFooter. */
export function settingsTabFooter(tab: SettingsTabID): string {
  // Ticket #77 keybinds: Ctrl+S and Ctrl+arrows collide with macOS window
  // shortcuts, Cmd chords, and the Herdr leader. Save is a plain `s` inside
  // the settings layer (no global conflict there); reorder uses Shift+arrows.
  switch (tab) {
    case "general":
      return "e edits a field · s saves"
    case "models":
      return "e main · b add · Shift+↑/↓ move · Backspace remove"
    case "memories":
      return "e edit · n new · Ctrl+D delete · Ctrl+P promote · / filter"
    case "skillbox":
      return "Space toggles · PgUp/PgDn pages · empty means no optional skills"
  }
}

/** Shared save/cancel footer grammar under every tab. */
export function settingsSaveFooter(): string {
  return "s save · Esc cancel"
}

/** Agent-list group header with its live count. */
export function railGroupLine(kind: "agent" | "workspace", count: number): string {
  return `${kind === "agent" ? "AGENTS" : "WORKSPACES"} (${count})`
}

/** Agent-list row label: the name plus its title description when set. */
export function railAgentLabel(name: string, title: string): string {
  return title.trim() ? `${name} — ${title.trim()}` : name
}

/** Model picker row: display name, provider/model grouping, variant depth. */
export function modelPickerLabel(model: ModelOption): string {
  const identity = `${model.providerID}/${model.modelID}`
  const variants =
    model.variants.length === 0
      ? ""
      : model.variants.length === 1
        ? " · 1 variant"
        : ` · ${model.variants.length} variants`
  return `${model.name} — ${identity}${variants}`
}

/** Provider grouping for the flat picker window: providers cluster, then
 *  models sort within the provider. Returns a copy; never mutates. */
export function sortModelsByProvider(models: readonly ModelOption[]): ModelOption[] {
  return [...models].sort((a, b) =>
    a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID),
  )
}
