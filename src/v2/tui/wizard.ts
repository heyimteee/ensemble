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
