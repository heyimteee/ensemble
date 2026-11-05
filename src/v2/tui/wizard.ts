/**
 * Wizard Enter behavior. Text steps own Enter inside the field; every
 * non-text step owns Enter — selecting the focused option, continuing a list
 * step, or submitting the final step — and never reaches the composer
 * completion popup. Wizard navigation keys live in the shared dialog catalog.
 */
import type { InteractionEvent } from "./interaction.ts"

export type WizardEnterAction = "select" | "continue" | "submit" | "text"

export function wizardEnterAction(kind: string, final: boolean): WizardEnterAction {
  if (kind === "text") return "text"
  if (kind === "multi") return final ? "submit" : "continue"
  if (final) return "submit"
  return "select"
}

/**
 * New-agent and workspace-edit wizard draft. Text fields live here once a step
 * commits; memories are an ordered list, never a newline blob.
 */
export type WizardDraft = {
  directory: string
  name: string
  title: string
  role: string
  memberIDs: string[]
  leaderID: string
  synthesis: boolean
  /** Optional agent memories, one list entry per memory. */
  memories: string[]
  modelKey: string
  variant: string
}

export type WizardModelSource = {
  providerID: string
  modelID: string
  name: string
}

export type WizardNavOption = {
  id: string
  label: string
}

export function wizardModelOptions(models: readonly WizardModelSource[]): WizardNavOption[] {
  return models.map((item) => ({ id: `${item.providerID}/${item.modelID}`, label: `${item.name} · ${item.providerID}/${item.modelID}` }))
}

export function sameWizardOptions(a: readonly WizardNavOption[], b: readonly WizardNavOption[]): boolean {
  return a.length === b.length && a.every((option, index) => option.id === b[index].id && option.label === b[index].label)
}

/** Keeps a still-valid model choice, otherwise falls back to the first option. */
export function wizardModelKeyFor(currentKey: string, options: readonly WizardNavOption[]): string {
  if (currentKey && options.some((option) => option.id === currentKey)) return currentKey
  return options[0]?.id ?? ""
}

/** Explains an empty model step instead of showing a bare "0 options". */
export function wizardModelEmptyHint(modelsError: string | undefined): string {
  const reason = String(modelsError ?? "").trim()
  return reason
    ? `No models available · ${reason}`
    : "No models reported by OpenCode yet · options refresh automatically"
}

export type OverlayGeometry = { width: number; left: number; top: number }

/** Shared centered-overlay geometry for the picker, prompt, and wizards. */
export function overlayGeometry(viewWidth: number, viewHeight: number, height: number): OverlayGeometry {
  const width = Math.max(48, Math.min(96, Math.floor(viewWidth * 0.7)))
  const left = Math.max(1, Math.floor((viewWidth - width) / 2))
  const top = Math.max(1, Math.floor((viewHeight - height) / 2))
  return { width, left, top }
}

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

/** True once the draft differs from the draft opened with (the discard guard). */
export function wizardDraftDirty(initial: WizardDraft, current: WizardDraft): boolean {
  return (
    initial.directory !== current.directory ||
    initial.name !== current.name ||
    initial.title !== current.title ||
    initial.role !== current.role ||
    !sameStrings(initial.memberIDs, current.memberIDs) ||
    initial.leaderID !== current.leaderID ||
    initial.synthesis !== current.synthesis ||
    !sameStrings(initial.memories, current.memories) ||
    initial.modelKey !== current.modelKey ||
    initial.variant !== current.variant
  )
}

/**
 * Step arrival is a focus move, never a mode move. A text step focuses its
 * field so Normal keeps a caret and Insert can type; a list step reports no
 * text target so Insert stays honest.
 */
export function wizardStepArrival(kind: string | undefined): InteractionEvent {
  return kind === "text" ? { type: "field.enter", target: "wizard" } : { type: "field.leave" }
}

/** Append one trimmed memory; blank input is a no-op. */
export function addWizardMemory(memories: readonly string[], text: string): string[] {
  const value = text.trim()
  return value ? [...memories, value] : [...memories]
}

/** Replace one memory with trimmed text; invalid or blank edits are no-ops. */
export function updateWizardMemory(memories: readonly string[], index: number, text: string): string[] {
  const value = text.trim()
  if (!value || !Number.isInteger(index) || index < 0 || index >= memories.length) return [...memories]
  const next = [...memories]
  next[index] = value
  return next
}

/** Remove one memory; an invalid index is a no-op. */
export function deleteWizardMemory(memories: readonly string[], index: number): string[] {
  if (!Number.isInteger(index) || index < 0 || index >= memories.length) return [...memories]
  return memories.filter((_, position) => position !== index)
}

export function clampWizardMemoryCursor(cursor: number, count: number): number {
  if (count <= 0) return 0
  return Math.max(0, Math.min(count - 1, Math.trunc(cursor)))
}

/** The exact texts to persist when the agent is created; an empty list skips. */
export function wizardMemorySaveList(memories: readonly string[]): string[] {
  return memories.map((text) => text.trim()).filter((text) => text.length > 0)
}
