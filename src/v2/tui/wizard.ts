/**
 * Wizard Enter behavior. Text steps own Enter inside the field; every
 * non-text step owns Enter — selecting the focused option, continuing a list
 * step, or submitting the final step — and never reaches the composer
 * completion popup. Wizard navigation keys live in the shared dialog catalog.
 */
export type WizardEnterAction = "select" | "continue" | "submit" | "text"

export function wizardEnterAction(kind: string, final: boolean): WizardEnterAction {
  if (kind === "text") return "text"
  if (final) return "submit"
  if (kind === "multi") return "continue"
  return "select"
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

/**
 * New-agent memories entered in the wizard textarea: one memory per line.
 * Blank lines and surrounding whitespace are dropped; order is preserved.
 * Pure.
 */
export function wizardMemoryLines(value: string): string[] {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}
