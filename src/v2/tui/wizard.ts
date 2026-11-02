export type WizardFilterKey = {
  sequence?: string
  ctrl?: boolean
  meta?: boolean
  super?: boolean
}

export function wizardFilterText(event: WizardFilterKey | undefined): string | undefined {
  const sequence = String(event?.sequence ?? "")
  if (sequence.length !== 1 || sequence < " ") return undefined
  if (event?.ctrl || event?.meta || event?.super) return undefined
  return sequence
}

/**
 * Wizard navigation is deliberately identical on every platform and bypasses
 * the macOS Ctrl→Cmd transform. Stock macOS terminals never deliver Cmd
 * chords to a TUI, so a "Cmd" wizard shortcut can never fire there. Plain
 * Ctrl+letter chords are the only family every common terminal delivers.
 */
export const WIZARD_NAV_BINDINGS = { back: "ctrl+p", next: "ctrl+n" } as const

/** Footer labels for the universal pair; true on every platform. */
export function wizardNavHint(final: boolean): string {
  return `Ctrl+P back · Ctrl+N next · enter ${final ? "submit" : "continue"} · esc cancel`
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
