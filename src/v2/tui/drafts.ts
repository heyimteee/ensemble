/**
 * Composer draft ownership (ticket #79).
 *
 * A draft belongs to the Workspace or Direct conversation it was written in,
 * never to the composer widget. Switching surfaces restores that surface's
 * text; mode changes and focus moves never clear it. Only a successful send
 * clears the draft of the surface it came from.
 */

export type DraftSurface =
  | { kind: "workspace"; workspaceID: string }
  | { kind: "agent"; agentID: string }

export type DraftStore = Readonly<Record<string, string>>

export function draftKey(surface: DraftSurface | null): string | null {
  if (!surface) return null
  return surface.kind === "workspace" ? `workspace:${surface.workspaceID}` : `direct:${surface.agentID}`
}

export function draftFor(drafts: DraftStore, key: string | null): string {
  if (!key) return ""
  return drafts[key] ?? ""
}

/** Store non-empty text; clearing text removes the key instead of growing the map. */
export function updateDraft(drafts: DraftStore, key: string | null, text: string): DraftStore {
  if (!key) return drafts
  if (text === "") {
    if (!(key in drafts)) return drafts
    const next = { ...drafts }
    delete next[key]
    return next
  }
  if (drafts[key] === text) return drafts
  return { ...drafts, [key]: text }
}

export function clearDraft(drafts: DraftStore, key: string | null): DraftStore {
  if (!key || !(key in drafts)) return drafts
  const next = { ...drafts }
  delete next[key]
  return next
}

/**
 * Apply a send outcome. A failed or busy send keeps the draft untouched;
 * a successful send clears exactly the surface that sent it.
 */
export function applySendResult(drafts: DraftStore, key: string | null, sent: boolean): DraftStore {
  return sent ? clearDraft(drafts, key) : drafts
}
