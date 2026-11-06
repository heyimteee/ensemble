/**
 * Wizard Enter behavior. Text steps own Enter inside the field; every
 * non-text step owns Enter — selecting the focused option, continuing a list
 * step, or submitting the final step — and never reaches the composer
 * completion popup. Wizard navigation keys live in the shared dialog catalog.
 */
import type { InteractionEvent } from "./interaction.ts"
import { isReducedMotion } from "./motion.ts"
import { chromeJoin } from "./separators.ts"
import type { ToastInput } from "./toast.ts"

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
  return models.map((item) => ({ id: `${item.providerID}/${item.modelID}`, label: chromeJoin([item.name, `${item.providerID}/${item.modelID}`]) }))
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
    ? chromeJoin(["No models available", reason])
    : chromeJoin(["No models reported by OpenCode yet", "options refresh automatically"])
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

export type WizardValidationModel = { key: string; variants: readonly string[] }

export type WizardValidationInput = {
  flow: "workspace" | "agent"
  draft: WizardDraft
  agentNames: readonly string[]
  models: readonly WizardValidationModel[]
}

/** The first validation failure plus the step key it belongs to. Pure. */
export type WizardValidation = { error: string | undefined; stepKey: string }

/**
 * Validate the complete draft at submit time. The draft is read-only here:
 * a failure jumps the wizard to `stepKey` and keeps every entered value.
 */
export function wizardValidation(input: WizardValidationInput): WizardValidation {
  const { flow, draft } = input
  const invalid = (error: string, stepKey: string): WizardValidation => ({ error, stepKey })
  if (flow === "workspace") {
    if (!draft.directory.trim()) return invalid("Choose a workspace directory.", "directory")
    if (!draft.name.trim()) return invalid("Workspace name is required.", "name")
    if (draft.memberIDs.length === 0) return invalid("Choose at least one member.", "members")
    if (!draft.leaderID || !draft.memberIDs.includes(draft.leaderID)) return invalid("Choose a leader from the selected members.", "leader")
    return { error: undefined, stepKey: "" }
  }
  if (!draft.name.trim()) return invalid("Agent name is required.", "name")
  if (!draft.role.trim()) return invalid("Agent role is required.", "role")
  if (!draft.modelKey) return invalid("Choose a main model.", "model")
  const normalizedName = draft.name.trim().toLowerCase()
  if (input.agentNames.some((name) => name.toLowerCase() === normalizedName)) return invalid("An agent with that name already exists.", "name")
  const model = input.models.find((item) => item.key === draft.modelKey)
  if (model && model.variants.length > 0 && !model.variants.includes(draft.variant)) return invalid("Choose a reasoning effort.", "variant")
  return { error: undefined, stepKey: "" }
}

/**
 * Step arrival is a focus move, never a mode move. A text step focuses its
 * field so Normal keeps a caret and Insert can type; a list step reports no
 * text target so Insert stays honest.
 */
export function wizardStepArrival(kind: string | undefined): InteractionEvent {
  return kind === "text" ? { type: "field.enter", target: "wizard" } : { type: "field.leave" }
}

/**
 * One-line step rail: one terminal cell per step. Completed steps stay filled,
 * the current step is the larger mark, and upcoming steps stay hollow. The
 * rail carries position only; the step title directly below announces the
 * current step, so a narrow overlay never has to truncate labels.
 */
export const WIZARD_STEP_MARKS = { done: "▪", current: "▣", upcoming: "▫" } as const

export function wizardStepRail(count: number, index: number): string {
  const total = Math.max(0, Math.trunc(count))
  if (total === 0) return ""
  const current = Math.max(0, Math.min(total - 1, Math.trunc(index)))
  const cells: string[] = []
  for (let cell = 0; cell < total; cell++) {
    cells.push(cell < current ? WIZARD_STEP_MARKS.done : cell === current ? WIZARD_STEP_MARKS.current : WIZARD_STEP_MARKS.upcoming)
  }
  return cells.join(" ")
}

/**
 * The step transition is a short one-shot opacity settle, never geometry.
 * Reduced motion (or No Color) pins the content at its final state, so the
 * new step swaps instantly with no dim interval.
 */
export const WIZARD_STEP_SETTLE_MS = 140
export const WIZARD_STEP_SETTLE_OPACITY = 0.55

export function wizardStepSettleMs(env: NodeJS.ProcessEnv = process.env): number {
  return isReducedMotion(env) ? 0 : WIZARD_STEP_SETTLE_MS
}

export function wizardStepSettleOpacity(settling: boolean): number {
  return settling ? WIZARD_STEP_SETTLE_OPACITY : 1
}

/** Memory add/edit/delete only exist on the one-by-one memories step. */
export function isWizardMemoryStep(stepKey: string | undefined): boolean {
  return stepKey === "memories"
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

export type WizardSuccessOutcome = "workspace-created" | "workspace-updated" | "agent-created"

/**
 * One success toast per submitted wizard outcome. The caller shows it only
 * after the workspace or agent operation actually succeeds, so a failed
 * create never claims success. The payload is the app's shared ToastInput, so
 * the transport needs no field renaming or wrapper.
 */
export function wizardSuccessToast(outcome: WizardSuccessOutcome, name: string, memories = 0): ToastInput {
  const message = outcome === "workspace-created"
    ? `#${name} created.`
    : outcome === "workspace-updated"
      ? `#${name} updated.`
      : `${name} created. Opening a direct chat.${memories > 0 ? ` Saved ${memories} ${memories === 1 ? "memory" : "memories"}.` : ""}`
  return { title: "Ensemble", message, tone: "success" }
}
