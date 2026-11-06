/**
 * Pure decision helpers for the in-house overlays. v5.6 T6 moved confirm and
 * result keys onto the shared dialog catalog (`confirm`/`result` contexts);
 * this module keeps the picker value helper, the inline filter editor, and
 * the v6 shell-overlay presence settle.
 */

import { isReducedMotion } from "./motion.ts"

/** One-shot overlay presence settle: short, terminal-friendly, never loops. */
export const OVERLAY_PRESENCE_MS = 120

/** The settle starts visibly faded so arrivals read as presence, not a flash. */
export const OVERLAY_PRESENCE_START = 0.6

/** The app samples the settle at this cadence (four steps over 120 ms). */
export const OVERLAY_PRESENCE_STEP_MS = 30

/**
 * Opacity for an overlay that opened `elapsedMs` ago. Ease-out from the quiet
 * baseline to full opacity, then hold 1 forever: this is one-shot, so a late
 * or repeated read can never restart or leave a stale translucency. Reduced
 * motion mounts at the final state. Negative/non-finite elapsed values are the
 * mount frame; a non-finite positive value is treated as settled.
 */
export function overlayPresenceOpacity(elapsedMs: number, env: NodeJS.ProcessEnv = process.env): number {
  if (isReducedMotion(env)) return 1
  if (!Number.isFinite(elapsedMs)) return elapsedMs === Number.POSITIVE_INFINITY ? 1 : OVERLAY_PRESENCE_START
  if (elapsedMs <= 0) return OVERLAY_PRESENCE_START
  if (elapsedMs >= OVERLAY_PRESENCE_MS) return 1
  const progress = elapsedMs / OVERLAY_PRESENCE_MS
  const eased = 1 - (1 - progress) ** 2
  return Math.round((OVERLAY_PRESENCE_START + (1 - OVERLAY_PRESENCE_START) * eased) * 1000) / 1000
}

/** Single-choice picker: Enter resolves the focused item, if any. */
export function singleChoiceValue<Item>(items: readonly Item[], cursor: number): Item | undefined {
  if (cursor < 0 || cursor >= items.length) return undefined
  return items[cursor]
}

export type FilterKey = {
  name?: string
  sequence?: string
  ctrl?: boolean
  meta?: boolean
  super?: boolean
}

export type FilterEdit = { query: string; done: boolean; cancelled: boolean }

/**
 * Inline filter editing shared by the skill palette and the memories tab:
 * printable keys append, backspace deletes, Enter submits, Escape cancels.
 * Modifier chords and multi-character sequences are ignored so terminal
 * chords never corrupt the filter.
 */
export function filterEdit(query: string, key: FilterKey | undefined): FilterEdit {
  const name = String(key?.name ?? "")
  const sequence = String(key?.sequence ?? "")
  if (name === "escape") return { query, done: true, cancelled: true }
  if (name === "return" || name === "enter" || name === "kpenter" || sequence === "\r" || sequence === "\n") {
    return { query, done: true, cancelled: false }
  }
  if (name === "backspace") return { query: query.slice(0, -1), done: false, cancelled: false }
  if (sequence.length === 1 && sequence >= " " && !key?.ctrl && !key?.meta && !key?.super) {
    return { query: `${query}${sequence}`, done: false, cancelled: false }
  }
  return { query, done: false, cancelled: false }
}
