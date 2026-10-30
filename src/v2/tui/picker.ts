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
