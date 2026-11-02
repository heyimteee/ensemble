export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function pickerWindow(cursor: number, length: number, max = 8): { start: number; end: number } {
  const start = Math.max(0, Math.min(cursor - Math.floor(max / 2), Math.max(0, length - max)))
  return { start, end: Math.min(length, start + max) }
}

/** Value shape of one picker/overlay row (mirrors PickerItem in components.tsx). */
export type PickRow = { id: string; label: string; selected: boolean }

/**
 * Anti-jank identity for picker/overlay rows (review finding 5): return the
 * previous array when every row value-compares equal, so Solid keeps row
 * identity across snapshot polls and picker rows do not re-render.
 * Attachment rows need no equivalent — attachments are refused visibly and
 * never queued, so no attachment list renders in the TUI.
 *
 * Documented limit: comparison is shallow over id/label/selected in order;
 * callers must pass rows in stable order (they do — filtered candidates keep
 * catalog order). Pure.
 */
export function stablePickerItems(previous: readonly PickRow[], next: readonly PickRow[]): readonly PickRow[] {
  if (previous.length !== next.length) return next
  for (let index = 0; index < next.length; index++) {
    const a = previous[index]
    const b = next[index]
    if (a.id !== b.id || a.label !== b.label || a.selected !== b.selected) return next
  }
  return previous
}
