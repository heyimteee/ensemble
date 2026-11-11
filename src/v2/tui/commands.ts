/**
 * Command-line catalog and parsing (ticket #80).
 *
 * Commands cover navigation and state only. Destructive and selection actions
 * stay on keys and the leader menu with their confirmations, so a mistyped
 * command can never delete or reassign work.
 */

import { isNativeFirstMode } from "../native-first.ts"
import { isToolSurface, type ToolSurface } from "../tool-surface.ts"
import type { NativeFirstMode } from "../types.ts"

export type CommandName =
  | "settings"
  | "limits"
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
  | "native-first"
  | "tools"
  | "logs"
  | "help"
  | "q"

export type CommandSpec = {
  name: CommandName
  description: string
  /** The command takes whitespace-separated arguments after its name. */
  args?: boolean
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: "settings", description: "open agent settings" },
  { name: "limits", description: "edit dispatch hop limits" },
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
  { name: "native-first", description: "set native-first on, off, or shadow", args: true },
  { name: "tools", description: "set the tool surface native or legacy", args: true },
  { name: "logs", description: "show recent logs (failures | task <id>)", args: true },
  { name: "help", description: "show keyboard help" },
  { name: "q", description: "leave Ensemble" },
]

const COMMANDS_BY_NAME = new Map<string, CommandSpec>(COMMANDS.map((command) => [command.name, command]))

export type ParsedCommand = { name: CommandName; args?: string[] }

/**
 * Parse a command line. The leading `:` is optional because the caller also
 * receives the raw text after it; unknown names return null so the caller can
 * report the miss without running anything. The catalog's `args` flag is the
 * one source of arity: a command without it ignores extra words.
 */
export function parseCommandLine(input: string): ParsedCommand | null {
  const trimmed = input.trim()
  const withoutColon = trimmed.startsWith(":") ? trimmed.slice(1).trim() : trimmed
  if (!withoutColon) return null
  const words = withoutColon.split(/\s+/)
  const name = words[0]
  const spec = COMMANDS_BY_NAME.get(name)
  if (!spec) return null
  if (spec.args) return { name: spec.name, args: words.slice(1) }
  return { name: spec.name }
}

/**
 * Ticket #240: the rollback commands return the validated settings patch and a
 * success line, or an actionable error. Keeping the patch pure lets the app
 * send one `settings.update` through the normal refresh path.
 */
export type NativeFirstCommandResult =
  | { ok: true; patch: { nativeFirst: NativeFirstMode }; message: string }
  | { ok: false; error: string }

export function nativeFirstCommand(args: readonly string[]): NativeFirstCommandResult {
  const mode = args[0]?.toLowerCase()
  if (args.length !== 1 || !mode || !isNativeFirstMode(mode)) {
    return { ok: false, error: "Usage: :native-first on|off|shadow" }
  }
  // Ticket #240: the mode and the tool surface are independent rollback
  // choices. `:native-first on` never clears an explicit `toolSurface:
  // legacy`; `:tools native` is the separate restore.
  return {
    ok: true,
    patch: { nativeFirst: mode },
    message: `Native-first ${mode}. :tools native restores the native tool surface; restart the host to load the plugin and AGENTS contract.`,
  }
}

export type ToolsCommandResult =
  | { ok: true; patch: { toolSurface: ToolSurface }; message: string }
  | { ok: false; error: string }

export function toolsCommand(args: readonly string[]): ToolsCommandResult {
  const surface = args[0]?.toLowerCase()
  if (args.length !== 1 || !surface || !isToolSurface(surface)) {
    return { ok: false, error: "Usage: :tools native|legacy" }
  }
  return {
    ok: true,
    patch: { toolSurface: surface },
    message: `Tool surface ${surface}. Native-first off or shadow keeps the legacy surface regardless.`,
  }
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
