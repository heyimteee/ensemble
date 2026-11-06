/**
 * App-owned feedback toasts (ticket #119).
 *
 * The queue and timers are pure functions over an explicit clock so the
 * lifecycle is deterministic in tests. The Solid adapter only schedules the
 * next deadline with a single timeout; rendering never owns toast state.
 *
 * One toast is visible at a time and up to three wait in arrival order. A
 * toast's display window starts when it becomes visible, so a burst of
 * feedback never shortens an already-visible message. The oldest waiting
 * toast is dropped when the queue overflows, keeping the newest feedback.
 */

import type { InitJobState } from "../types.ts"

export type ToastTone = "info" | "success" | "warning" | "error"

export type ToastInput = {
  title: string
  message: string
  tone?: ToastTone
}

export type ToastNotice = {
  id: number
  title: string
  message: string
  tone: ToastTone
}

export type VisibleToast = ToastNotice & { expiresAt: number }

export type ToastState = {
  /** Monotonic id source; preserved across clears. */
  sequence: number
  visible: VisibleToast | null
  /** Waiting toasts, oldest first. */
  queue: ToastNotice[]
}

export const TOAST_QUEUE_LIMIT = 3
export const TOAST_DURATION_MS = 4_000
export const TOAST_ERROR_DURATION_MS = 6_000
export const TOAST_MIN_WIDTH = 36
export const TOAST_MAX_WIDTH = 56

export function createToastState(): ToastState {
  return { sequence: 0, visible: null, queue: [] }
}

/** Errors stay a little longer; every other tone shares one window. */
export function toastDuration(tone: ToastTone = "info"): number {
  return tone === "error" ? TOAST_ERROR_DURATION_MS : TOAST_DURATION_MS
}

/**
 * Accept one toast. With nothing visible it shows immediately; otherwise it
 * joins the bounded queue. The visible toast's deadline never moves.
 */
export function pushToast(state: ToastState, input: ToastInput, now: number): ToastState {
  const sequence = state.sequence + 1
  const next: ToastNotice = {
    id: sequence,
    title: input.title,
    message: input.message,
    tone: input.tone ?? "info",
  }
  if (!state.visible) {
    return {
      sequence,
      visible: { ...next, expiresAt: now + toastDuration(next.tone) },
      queue: state.queue,
    }
  }
  const queue = [...state.queue, next]
  return { sequence, visible: state.visible, queue: queue.slice(Math.max(0, queue.length - TOAST_QUEUE_LIMIT)) }
}

function promote(state: ToastState, now: number): ToastState {
  const [next, ...rest] = state.queue
  if (!next) return { ...state, visible: null }
  return {
    ...state,
    visible: { ...next, expiresAt: now + toastDuration(next.tone) },
    queue: rest,
  }
}

/** Close the visible toast and start the next waiting toast's window. */
export function dismissToast(state: ToastState, now: number): ToastState {
  if (!state.visible) return state
  return promote(state, now)
}

/** Advance expired toasts. Queued entries have no deadline until promoted. */
export function expireToasts(state: ToastState, now: number): ToastState {
  if (!state.visible || state.visible.expiresAt > now) return state
  return promote(state, now)
}

/** The next timer deadline, or undefined when no toast is visible. */
export function nextToastDeadline(state: ToastState): number | undefined {
  return state.visible?.expiresAt
}

export function clearToasts(state: ToastState): ToastState {
  if (!state.visible && state.queue.length === 0) return state
  return { sequence: state.sequence, visible: null, queue: [] }
}

export type ToastPlacement = { top: number; left: number; width: number }

/**
 * Bounded top-right geometry. The width grows with the terminal but never
 * below 36 or above 56 cells, and always keeps a one-cell margin on the right.
 * `viewWidth` is the content width inside the app's one-cell padding.
 */
export function toastPlacement(viewWidth: number): ToastPlacement {
  const width = Math.max(1, Math.floor(viewWidth))
  const available = Math.max(12, width - 2)
  const desired = Math.max(TOAST_MIN_WIDTH, Math.min(TOAST_MAX_WIDTH, Math.floor(width * 0.35)))
  const bounded = Math.min(desired, available)
  return { top: 2, left: Math.max(1, width - bounded - 2), width: bounded }
}

/**
 * A modal owns the statusline while it is open, so app feedback goes there
 * instead of painting a toast over the dialog.
 */
export function feedbackChannel(modalOpen: boolean): "toast" | "statusline" {
  return modalOpen ? "statusline" : "toast"
}

/** Concise terminal-job feedback; running jobs have no toast of their own. */
export function initToast(state: InitJobState, error?: string): ToastInput | undefined {
  switch (state) {
    case "succeeded":
      return { title: "Ensemble init", message: "Workspace init complete.", tone: "success" }
    case "failed":
      return { title: "Ensemble init", message: error ? `Init failed: ${error}` : "Init failed.", tone: "error" }
    case "cancelled":
      return { title: "Ensemble init", message: "Init cancelled.", tone: "warning" }
    case "interrupted":
      return { title: "Ensemble init", message: "Init interrupted; rerun /init.", tone: "warning" }
    case "running":
      return undefined
  }
}
