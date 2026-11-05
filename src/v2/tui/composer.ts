/**
 * Composer slash commands. One catalog serves recognition, completion, and
 * execution; the shared skill planner imports it so palette and server
 * validation cannot drift.
 */
export const COMPOSER_COMMANDS = [
  { name: "workspace", description: "switch workspace" },
  { name: "agent", description: "mention an agent" },
  { name: "settings", description: "agent settings" },
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
