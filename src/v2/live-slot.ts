import type { Message } from "./types.ts"

/**
 * Live-streaming slot for one bound native session. The slot is keyed by
 * sessionID, so a second concurrent stream for the same session would
 * overwrite the first buffer entry. Per-agent serialization plus the
 * edit-directory lock means this never happens in practice (one session runs
 * at most one run at a time); the register path below still makes the
 * outcome safe instead of silently dropping text.
 */
export type LiveSlot = {
  message: Message | undefined
  lastSave: number
  buffer: string
}

export type LiveSlotRegistration = {
  slot: LiveSlot
  orphaned: { message: Message; buffer: string } | undefined
}

/**
 * Install a fresh live slot for a session. When the previous slot still
 * holds an opening row, it is returned as orphaned so the caller can
 * finalize it (interrupted) instead of leaking a stuck streaming row.
 * Pure over the caller's map.
 */
export function registerLiveSlot(
  slots: Map<string, LiveSlot>,
  sessionID: string,
  now: number,
): LiveSlotRegistration {
  const existing = slots.get(sessionID)
  const orphaned =
    existing?.message !== undefined ? { message: existing.message, buffer: existing.buffer } : undefined
  const slot: LiveSlot = { message: undefined, lastSave: now, buffer: "" }
  slots.set(sessionID, slot)
  return { slot, orphaned }
}
