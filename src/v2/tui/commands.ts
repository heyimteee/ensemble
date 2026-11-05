/**
 * Command-line catalog and parsing (ticket #80).
 *
 * Commands cover navigation and state only. Destructive and selection actions
 * stay on keys and the leader menu with their confirmations, so a mistyped
 * command can never delete or reassign work.
 */

export type CommandName =
  | "settings"
  | "approvals"
  | "workspace"
  | "agent"
  | "new-agent"
  | "new-workspace"
  | "edit-workspace"
  | "pause"
  | "resume"
  | "init"
  | "native"
  | "help"
  | "q"

export type CommandSpec = {
  name: CommandName
  description: string
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: "settings", description: "open agent settings" },
  { name: "approvals", description: "open the approval inbox" },
  { name: "workspace", description: "switch workspace" },
  { name: "agent", description: "open a direct conversation" },
  { name: "new-agent", description: "create an agent" },
  { name: "new-workspace", description: "create a workspace" },
  { name: "edit-workspace", description: "edit members and leader" },
  { name: "pause", description: "pause the active workspace" },
  { name: "resume", description: "resume the active workspace" },
  { name: "init", description: "initialize workspace files" },
  { name: "native", description: "open the native session" },
  { name: "help", description: "show keyboard help" },
  { name: "q", description: "leave Ensemble" },
]

const COMMAND_NAMES = new Set<string>(COMMANDS.map((command) => command.name))

export type ParsedCommand = { name: CommandName }

/**
 * Parse a command line. The leading `:` is optional because the caller also
 * receives the raw text after it; unknown names return null so the caller can
 * report the miss without running anything.
 */
export function parseCommandLine(input: string): ParsedCommand | null {
  const trimmed = input.trim()
  const withoutColon = trimmed.startsWith(":") ? trimmed.slice(1).trim() : trimmed
  if (!withoutColon) return null
  const name = withoutColon.split(/\s+/)[0]
  if (!COMMAND_NAMES.has(name)) return null
  return { name: name as CommandName }
}

function commandQuery(input: string): string | undefined {
  const trimmed = input.trim()
  const withoutColon = trimmed.startsWith(":") ? trimmed.slice(1) : trimmed
  if (/\s/.test(withoutColon)) return undefined
  return withoutColon.toLowerCase()
}

/** Completion candidates for the typed prefix, in catalog order. */
export function commandCompletions(input: string): CommandSpec[] {
  const query = commandQuery(input)
  if (query === undefined) return []
  if (!query) return [...COMMANDS]
  return COMMANDS.filter((command) => command.name.startsWith(query))
}

/** Tab completes to the first matching command name, or leaves text alone. */
export function completeCommand(input: string): string | undefined {
  return commandCompletions(input)[0]?.name
}
