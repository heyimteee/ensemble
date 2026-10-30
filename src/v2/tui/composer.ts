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
