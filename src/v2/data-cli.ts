import { writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { pathToFileURL } from "node:url"
import { assertSupportedNode } from "./node-version.ts"
import { canonicalDirectory } from "./paths.ts"
import { defaultServiceDescriptorPath, readServiceDescriptor, validateServerUrl, type ServiceDescriptor } from "./doctor-cli.ts"

/**
 * Ticket #272: user-facing data control.
 *
 * The CLI is a thin client over the existing `ensemble.v2` `invoke` RPC, just
 * like `doctor` is a thin client over `diagnostic`. It adds no runtime seam:
 * export and delete stay server-owned so the durable store, bindings, and
 * native-session lifecycle are handled in one place. The documented export
 * format is `ensemble.data-export` (see docs/privacy/data-and-retention.md).
 */
export type DataCommand = "export" | "delete"

export type DataOptions = {
  command?: DataCommand
  directory?: string
  workspaceID?: string
  out?: string
  confirm?: string
  deleteNativeSessions: boolean
  logs: boolean
  json: boolean
  server?: string
  serviceFile?: string
  help: boolean
}

export class DataControlError extends Error {
  readonly code: string
  readonly exitCode: number

  constructor(code: string, message: string, exitCode = 2) {
    super(message)
    this.name = "DataControlError"
    this.code = code
    this.exitCode = exitCode
  }
}

export function parseDataArgs(argv: string[]): DataOptions {
  const args: DataOptions = { deleteNativeSessions: false, logs: false, json: false, help: false }
  const positional: string[] = []
  const value = (flag: string, index: number): string => {
    const next = argv[index]
    if (!next || next.startsWith("--")) throw new DataControlError("usage", `${flag} needs a value.`)
    return next
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!
    if (argument === "--help" || argument === "-h") {
      args.help = true
      continue
    }
    if (argument === "--json") {
      args.json = true
      continue
    }
    if (argument === "--delete-native-sessions") {
      args.deleteNativeSessions = true
      continue
    }
    if (argument === "--logs") {
      args.logs = true
      continue
    }
    if (argument === "--workspace") {
      args.workspaceID = value("--workspace", ++index)
      continue
    }
    if (argument.startsWith("--workspace=")) {
      args.workspaceID = argument.slice("--workspace=".length)
      if (!args.workspaceID) throw new DataControlError("usage", "--workspace needs a value.")
      continue
    }
    if (argument === "--out") {
      args.out = value("--out", ++index)
      continue
    }
    if (argument.startsWith("--out=")) {
      args.out = argument.slice("--out=".length)
      if (!args.out) throw new DataControlError("usage", "--out needs a value.")
      continue
    }
    if (argument === "--confirm") {
      args.confirm = value("--confirm", ++index)
      continue
    }
    if (argument.startsWith("--confirm=")) {
      args.confirm = argument.slice("--confirm=".length)
      if (!args.confirm) throw new DataControlError("usage", "--confirm needs a value.")
      continue
    }
    if (argument === "--server") {
      args.server = value("--server", ++index)
      continue
    }
    if (argument.startsWith("--server=")) {
      args.server = argument.slice("--server=".length)
      if (!args.server) throw new DataControlError("usage", "--server needs a URL.")
      continue
    }
    if (argument === "--service-file") {
      args.serviceFile = value("--service-file", ++index)
      continue
    }
    if (argument.startsWith("--service-file=")) {
      args.serviceFile = argument.slice("--service-file=".length)
      if (!args.serviceFile) throw new DataControlError("usage", "--service-file needs a path.")
      continue
    }
    if (argument.startsWith("-")) throw new DataControlError("usage", "Unknown option. Use --help for usage.")
    positional.push(argument)
  }
  if (args.help) return args
  const command = positional[0]
  if (command !== "export" && command !== "delete") {
    throw new DataControlError("usage", "First argument must be export or delete.")
  }
  args.command = command
  const directory = positional[1]
  if (!directory) throw new DataControlError("usage", "A workspace directory is required.")
  if (positional.length > 2) throw new DataControlError("usage", "Only one workspace directory is accepted.")
  args.directory = directory
  if (command === "delete" && args.confirm !== "DELETE") {
    throw new DataControlError("confirmation_required", 'Deleting data needs --confirm DELETE.')
  }
  if (command === "export" && args.confirm !== undefined) {
    throw new DataControlError("usage", "--confirm only applies to delete.")
  }
  if (command === "export" && (args.logs || args.deleteNativeSessions)) {
    throw new DataControlError("usage", "--logs and --delete-native-sessions only apply to delete.")
  }
  if (command === "delete" && args.out !== undefined) {
    throw new DataControlError("usage", "--out only applies to export.")
  }
  return args
}

export type DataRunOptions = {
  env?: NodeJS.ProcessEnv
  home?: string
  fetchImpl?: typeof fetch
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

type InvokeOutput = {
  ok?: boolean
  result?: any
  error?: { code?: string; message?: string }
}

function invokeUrl(url: string, directory: string): string {
  return `${url}/api/rpc/ensemble.v2/invoke?location%5Bdirectory%5D=${encodeURIComponent(directory)}`
}

async function invoke(
  url: string,
  password: string | undefined,
  directory: string,
  action: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (password) headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  let response: Response
  try {
    response = await fetchImpl(invokeUrl(url, directory), {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify({ input: { directory, action, payload } }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new DataControlError("request_failed", "Could not reach the OpenCode service.")
  }
  if (!response.ok) {
    throw new DataControlError("request_failed", `The OpenCode service answered HTTP ${response.status}.`)
  }
  let body: any
  try {
    body = await response.json()
  } catch {
    throw new DataControlError("invalid_response", "The OpenCode service response was not JSON.")
  }
  const output: InvokeOutput | undefined = body?.output
  if (!output || typeof output !== "object") {
    throw new DataControlError("invalid_response", "The OpenCode service response had no invoke output.")
  }
  if (output.ok !== true) {
    throw new DataControlError(
      output.error?.code ?? "invoke_failed",
      output.error?.message ?? "The Ensemble data request failed.",
      1,
    )
  }
  return output.result
}

export async function runData(argv: string[], options: DataRunOptions = {}): Promise<number> {
  const env = options.env ?? process.env
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text))
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text))
  const fetchImpl = options.fetchImpl ?? fetch
  const args = parseDataArgs(argv)
  if (args.help) {
    stdout(helpText())
    return 0
  }
  let directory: string
  try {
    directory = canonicalDirectory(args.directory!)
  } catch {
    throw new DataControlError("invalid_directory", `Not a directory: ${args.directory}`)
  }
  const descriptorPath = args.serviceFile ?? defaultServiceDescriptorPath(env, options.home ?? homedir())
  let descriptor: ServiceDescriptor | undefined
  if (args.serviceFile || !args.server) descriptor = readServiceDescriptor(descriptorPath)
  const url = validateServerUrl(args.server ?? descriptor?.url ?? "")
  const password = env.OPENCODE_PASSWORD ?? (args.server && !args.serviceFile ? undefined : descriptor?.password)
  if (args.command === "export") {
    const payload: Record<string, unknown> = {}
    if (args.workspaceID) payload.workspaceID = args.workspaceID
    const result = await invoke(url, password, directory, "data.export", payload, fetchImpl)
    const text = `${JSON.stringify(result, null, 2)}\n`
    if (args.out) {
      try {
        writeFileSync(args.out, text, { encoding: "utf8", mode: 0o600 })
      } catch {
        throw new DataControlError("write_failed", `Could not write the export file: ${args.out}`)
      }
      const counts = result?.counts ?? {}
      stderr(
        `Wrote ${counts.messages ?? 0} message(s), ${counts.work ?? 0} Work row(s), `
          + `${counts.memories ?? 0} memor(ies) to ${args.out}.\n`,
      )
    } else {
      stdout(text)
    }
    return 0
  }
  const payload: Record<string, unknown> = { confirmation: args.confirm }
  if (args.workspaceID) payload.workspaceID = args.workspaceID
  if (args.deleteNativeSessions) payload.deleteNativeSessions = true
  if (args.logs) payload.logs = true
  const result = await invoke(url, password, directory, "data.delete", payload, fetchImpl)
  if (args.json) {
    stdout(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }
  const deleted = result?.deleted ?? {}
  const lines = [
    `Deleted Ensemble data for workspace "${result?.workspace?.name ?? "unknown"}".`,
    `  conversations: ${deleted.conversations ?? 0}`,
    `  messages: ${deleted.messages ?? 0}`,
    `  Work rows: ${deleted.subtasks ?? 0}`,
    `  dispatch groups: ${deleted.dispatchGroups ?? 0}`,
    `  memories: ${deleted.memories ?? 0}`,
    `  approvals: ${deleted.approvals ?? 0}`,
    `  queued direct sends: ${deleted.dmQueue ?? 0}`,
    `  bindings: ${deleted.bindings ?? 0}`,
    `  native host sessions: ${result?.nativeSessionsDeleted ?? 0}`,
  ]
  if (args.logs) lines.push(`  local log files: ${result?.logsDeleted ?? 0}`)
  lines.push(`Retained: ${Array.isArray(result?.retained) ? result.retained.join(", ") : "workspace"}.`)
  stdout(`${lines.join("\n")}\n`)
  return 0
}

function helpText(): string {
  return `Ensemble data: export or delete one workspace's Ensemble data

Usage:
  npm run data -- export <directory> [--out <file>] [--workspace <id>] [--server <url>] [--service-file <path>]
  npm run data -- delete <directory> --confirm DELETE [--workspace <id>] [--logs] [--delete-native-sessions] [--json]

Commands:
  export   Write the documented ensemble.data-export JSON to stdout or --out.
  delete   Delete this workspace's conversations, Work, memories, approvals, and
           queued direct sends. The workspace, roster, and config stay usable.

Delete options:
  --confirm DELETE          Required. Confirms the delete.
  --logs                    Also delete the local Ensemble log files (all workspaces).
  --delete-native-sessions  Also ask the OpenCode host to remove the bound native
                            sessions. Without it, deleted transcripts can no longer
                            be re-ingested because their bindings are removed, but
                            the host may still hold the original session history.

Service resolution:
  The default descriptor is $XDG_STATE_HOME/opencode/service.json, or
  ~/.local/state/opencode/service.json when XDG_STATE_HOME is unset.
  OPENCODE_PASSWORD takes precedence over the descriptor password.
  Credentials are never printed.

Export format:
  JSON, format "ensemble.data-export", formatVersion 1. It carries the workspace
  roster, conversations and messages, Work text, and workspace-attributed
  memories. It never carries binding session ids, workspace or home directory
  paths, model configuration, settings, credentials, or operational logs.

Exit codes:
  0  The command completed.
  1  The service refused the request (for example a bad confirmation token).
  2  Usage, connection, descriptor, or response failure.
`
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  try {
    assertSupportedNode()
    process.exitCode = await runData(argv)
  } catch (error: any) {
    process.stderr.write(`data: ${error?.message ?? error}\n`)
    process.exitCode = typeof error?.exitCode === "number" ? error.exitCode : 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
