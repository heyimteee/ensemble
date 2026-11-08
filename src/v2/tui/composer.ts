/**
 * Composer slash commands. One catalog serves recognition, completion, and
 * execution; the shared skill planner imports it so palette and server
 * validation cannot drift.
 */
export const COMPOSER_COMMANDS = [
  { name: "workspace", description: "switch workspace" },
  { name: "agent", description: "mention an agent" },
  { name: "settings", description: "agent settings" },
  { name: "limits", description: "dispatch hop limits" },
  { name: "approvals", description: "approval inbox" },
  { name: "pause", description: "pause workspace" },
  { name: "resume", description: "resume workspace" },
  { name: "init", description: "initialize workspace files" },
  { name: "help", description: "shortcut help" },
  { name: "native", description: "open native session" },
  { name: "delegate", description: "delegate selected subtask" },
  { name: "retry", description: "retry selected subtask" },
  { name: "restart", description: "restart selected subtask" },
  { name: "cancel", description: "cancel selected subtask" },
  { name: "reset-ensemble", description: "delete all Ensemble data" },
] as const

export type ComposerTrigger = "agent" | "file" | "command"

export function composerTrigger(value: string): ComposerTrigger | undefined {
  if (value === "/") return "command"
  if (value.endsWith("$") && (value.length === 1 || /\s/.test(value.slice(-2, -1)))) return "agent"
  if (value.endsWith("@") && (value.length === 1 || /\s/.test(value.slice(-2, -1)))) return "file"
  return undefined
}

export function insertAgentMention(value: string, name: string): string {
  return `${value.replace(/\$$/, "")}$${name} `
}

export function insertFileReference(value: string, path: string): string {
  return `${value.replace(/@$/, "")}@${path} `
}

export function parseSlashCommand(value: string): { command: string; args: string[] } | undefined {
  const trimmed = value.trim()
  if (!trimmed.startsWith("/")) return undefined
  const [command, ...args] = trimmed.slice(1).split(/\s+/).filter(Boolean)
  if (!command) return undefined
  return { command, args }
}

export function composerHeight(value: string, width: number, max = 8): number {
  const usable = Math.max(4, width)
  const lines = value.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(line.length / usable)), 0)
  return Math.max(1, Math.min(max, lines))
}

/**
 * One-shot validation feedback for the composer (ticket #123). An invalid
 * command or failed submission starts this signal; the app keeps the draft
 * and flashes the composer border. Typing or a successful send clears it.
 *
 * The signal is a pure reducer so the lifecycle is testable without a TUI.
 */
export type ComposerValidationState = {
  /** The validation message that accompanied the one-shot border. */
  message: string
  /** Wall-clock start; the signal expires after COMPOSER_VALIDATION_MS. */
  startedAt: number
}

export type ComposerValidationEvent =
  | { type: "invalid"; message: string; at: number }
  | { type: "input" }
  | { type: "send-success" }
  | { type: "tick"; at: number }

/** Short, bounded lifetime of the bad-border state (one shot, never a loop). */
export const COMPOSER_VALIDATION_MS = 1_000

export function composerValidationReducer(
  state: ComposerValidationState | null,
  event: ComposerValidationEvent,
): ComposerValidationState | null {
  switch (event.type) {
    case "invalid":
      return { message: event.message, startedAt: event.at }
    case "input":
    case "send-success":
      return null
    case "tick":
      if (!state) return null
      return event.at - state.startedAt >= COMPOSER_VALIDATION_MS ? null : state
  }
}

/**
 * Border role for the active signal. Normal motion shows one bounded
 * bad-to-default pulse (the first half of the window); reduced motion holds
 * the bad color for the whole window without repeated movement. `undefined`
 * means no signal is active.
 */
export function composerValidationBorder(
  state: ComposerValidationState | null,
  at: number,
  reducedMotion = false,
): "bad" | "default" | undefined {
  if (!state) return undefined
  const elapsed = at - state.startedAt
  if (elapsed >= COMPOSER_VALIDATION_MS) return undefined
  if (reducedMotion) return "bad"
  return elapsed < COMPOSER_VALIDATION_MS / 2 ? "bad" : "default"
}
