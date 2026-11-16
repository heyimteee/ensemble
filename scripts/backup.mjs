#!/usr/bin/env node
/**
 * Ticket #273: operator backup/restore client for Ensemble durable state.
 *
 * The plugin owns the state and exposes it through `ensemble.v2` RPC
 * `invoke`. This script is the tested reference client: it resolves the same
 * service descriptor as `doctor`, calls `backup.export` / `backup.restore` /
 * `backup.rollback` / `backup.status`, and writes backups atomically with
 * owner-only permissions.
 *
 * It never prints conversation content, entity fields, credentials, or the
 * service password. Reports carry counts, versions, and the requested file.
 *
 * Usage:
 *   node scripts/backup.mjs export --out <file> [options] <directory>
 *   node scripts/backup.mjs restore --in <file> --confirm RESTORE [options] <directory>
 *   node scripts/backup.mjs rollback --confirm ROLLBACK [options] <directory>
 *   node scripts/backup.mjs status [options] <directory>
 *
 * Options:
 *   --server <url>          Override the service URL.
 *   --service-file <path>   Override the OpenCode service descriptor.
 *   --json                  Print one machine-readable report.
 *   --help                  Show this help.
 *
 * The script is repository tooling, not part of the published runtime package.
 * Users can run it from the release tag or call the same RPC directly.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

const FORMAT = "ensemble.backup"
const MAX_BACKUP_BYTES = 512 * 1024 * 1024
const COMMANDS = new Set(["export", "restore", "rollback", "status"])

class CliError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message)
    this.name = "BackupCliError"
    this.code = code
    this.exitCode = exitCode
  }
}

function parseArgs(argv) {
  const args = {
    command: undefined,
    directory: undefined,
    server: undefined,
    serviceFile: undefined,
    file: undefined,
    fileFlag: undefined,
    confirmation: undefined,
    json: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--help" || argument === "-h") {
      args.help = true
      continue
    }
    if (argument === "--json") {
      args.json = true
      continue
    }
    const take = (flag) => {
      const value = argv[++index]
      if (!value || value.startsWith("--")) throw new CliError("usage", `${flag} needs a value.`)
      return value
    }
    if (argument === "--server") { args.server = take("--server"); continue }
    if (argument.startsWith("--server=")) { args.server = argument.slice("--server=".length); continue }
    if (argument === "--service-file") { args.serviceFile = take("--service-file"); continue }
    if (argument.startsWith("--service-file=")) { args.serviceFile = argument.slice("--service-file=".length); continue }
    if (argument === "--out" || argument === "--in") {
      if (args.file) throw new CliError("usage", "Use only one of --out and --in.")
      args.file = take(argument)
      args.fileFlag = argument.slice(2)
      continue
    }
    if (argument === "--confirm") { args.confirmation = take("--confirm"); continue }
    if (argument.startsWith("-")) throw new CliError("usage", "Unknown option. Use --help for usage.")
    if (!args.command) {
      if (!COMMANDS.has(argument)) throw new CliError("usage", `Unknown command: ${argument}`)
      args.command = argument
      continue
    }
    if (args.directory) throw new CliError("usage", "Exactly one directory is required.")
    args.directory = argument
  }
  if (args.help) return args
  if (!args.command) throw new CliError("usage", "A command is required. Use --help for usage.")
  if (!args.directory) throw new CliError("usage", "A directory is required.")
  const directory = resolve(args.directory)
  try {
    if (!statSync(directory).isDirectory()) throw new Error("not a directory")
  } catch {
    throw new CliError("invalid_directory", "That directory does not exist.")
  }
  args.directory = directory
  if (args.command === "export" && (!args.file || args.fileFlag !== "out")) throw new CliError("usage", "export needs --out <file>.")
  if (args.command === "restore" && (!args.file || args.fileFlag !== "in")) throw new CliError("usage", "restore needs --in <file>.")
  if ((args.command === "rollback" || args.command === "status") && args.file) {
    throw new CliError("usage", `${args.command} takes no --in or --out.`)
  }
  if (args.command === "restore" && args.confirmation !== "RESTORE") {
    throw new CliError("confirmation_required", "restore needs --confirm RESTORE.")
  }
  if (args.command === "rollback" && args.confirmation !== "ROLLBACK") {
    throw new CliError("confirmation_required", "rollback needs --confirm ROLLBACK.")
  }
  return args
}

function defaultServiceDescriptorPath(env = process.env, home = homedir()) {
  return join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "opencode", "service.json")
}

function validateServerUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new CliError("usage", "--server must be a valid http(s) URL.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new CliError("usage", "--server must be a valid http(s) URL.")
  if (url.username || url.password) throw new CliError("usage", "--server must not contain credentials; set OPENCODE_PASSWORD instead.")
  return value.replace(/\/+$/, "")
}

function readServiceDescriptor(path) {
  let value
  try {
    value = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") throw new CliError("service_descriptor_missing", "Service descriptor not found. Pass --server.")
    throw new CliError("service_descriptor_invalid", "Service descriptor is not valid JSON.")
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.url !== "string" || !value.url.trim()) {
    throw new CliError("service_descriptor_invalid", "Service descriptor is missing a URL.")
  }
  if (value.password !== undefined && typeof value.password !== "string") {
    throw new CliError("service_descriptor_invalid", "Service descriptor password must be a string.")
  }
  return { url: value.url.trim(), password: value.password }
}

async function invoke(url, password, directory, action, payload) {
  const headers = { "content-type": "application/json" }
  if (password) headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const target = `${url}/api/rpc/ensemble.v2/invoke?location%5Bdirectory%5D=${encodeURIComponent(directory)}`
  let response
  try {
    response = await fetch(target, {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify({ input: { directory, action, payload } }),
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    throw new CliError("service_unreachable", "Could not reach the OpenCode service.")
  }
  if (!response.ok) throw new CliError("service_unreachable", `The service refused the request with HTTP ${response.status}.`)
  let body
  try {
    body = await response.json()
  } catch {
    throw new CliError("service_invalid", "The service response was not JSON.")
  }
  const output = body?.output
  if (!output || typeof output !== "object") throw new CliError("service_invalid", "The service response had no output.")
  if (output.ok !== true) {
    const error = output.error && typeof output.error === "object" ? output.error : {}
    throw new CliError(String(error.code ?? "service_refused"), String(error.message ?? "The service refused the request."), 1)
  }
  return output.result
}

function readBackupFile(path) {
  let stats
  try {
    stats = statSync(path)
  } catch {
    throw new CliError("backup_read_failed", "The backup file does not exist.")
  }
  if (!stats.isFile()) throw new CliError("backup_read_failed", "The backup path is not a file.")
  if (stats.size > MAX_BACKUP_BYTES) throw new CliError("backup_too_large", "The backup file is larger than the supported bound.")
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch {
    throw new CliError("backup_read_failed", "The backup file could not be read.")
  }
  let document
  try {
    document = JSON.parse(text)
  } catch {
    throw new CliError("backup_invalid", "The backup file is not valid JSON.")
  }
  if (!document || typeof document !== "object" || document.format !== FORMAT) {
    throw new CliError("backup_invalid", `The file is not an ${FORMAT} document.`)
  }
  return document
}

function writeBackupFile(path, document) {
  const target = resolve(path)
  try {
    mkdirSync(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(document)}\n`, { mode: 0o600 })
    renameSync(temporary, target)
  } catch {
    throw new CliError("backup_write_failed", "The backup file could not be written.")
  }
}

function exportReport(document, path, bytes) {
  return {
    ok: true,
    command: "export",
    out: resolve(path),
    bytes,
    formatVersion: document.formatVersion,
    createdAt: document.createdAt,
    protocol: document.protocol,
    contractVersion: document.contractVersion,
    counts: document.counts,
  }
}

function applyReport(result, command) {
  return {
    ok: true,
    command,
    formatVersion: result?.formatVersion,
    createdAt: result?.createdAt,
    version: result?.version,
    counts: result?.counts,
    workspaces: result?.workspaces,
    rollbackSlot: result?.rollbackSlot,
  }
}

function render(report) {
  const lines = [`Ensemble backup: ${report.command}`]
  if (report.command === "export") {
    lines.push(`  file: ${report.out} (${report.bytes} bytes)`)
    lines.push(`  format: v${report.formatVersion}; contract: v${report.contractVersion}; protocol: ${report.protocol}`)
    lines.push(`  counts: ${formatCounts(report.counts)}`)
    return `${lines.join("\n")}\n`
  }
  if (report.command === "status") {
    const rollback = report.rollback
    lines.push(`  rollback slot: ${rollback?.present ? "present" : "absent"}`)
    if (rollback?.present && rollback.valid) {
      lines.push(`    format: v${rollback.formatVersion}; version: ${rollback.version}; created: ${new Date(rollback.createdAt).toISOString()}`)
      lines.push(`    counts: ${formatCounts(rollback.counts)}`)
    } else if (rollback?.present) {
      lines.push(`    invalid: ${rollback.reason}`)
    }
    return `${lines.join("\n")}\n`
  }
  lines.push(`  version: ${report.version}; format: v${report.formatVersion}`)
  lines.push(`  counts: ${formatCounts(report.counts)}`)
  lines.push(`  workspace configs: restored=${report.workspaces?.restored ?? 0} skipped=${report.workspaces?.skipped ?? 0} removed=${report.workspaces?.removed ?? 0}`)
  lines.push(`  rollback slot written: ${report.rollbackSlot?.written === true ? "yes" : "no"}`)
  if (report.command === "restore") lines.push("  restart OpenCode to reload bindings and native sessions.")
  return `${lines.join("\n")}\n`
}

function formatCounts(counts) {
  const entries = Object.entries(counts ?? {}).filter(([, value]) => typeof value === "number" && value > 0)
  return entries.length === 0 ? "none" : entries.map(([name, value]) => `${name}=${value}`).join(" ")
}

function helpText() {
  return `Ensemble backup: export, restore, rollback, and status

Usage:
  node scripts/backup.mjs export --out <file> [options] <directory>
  node scripts/backup.mjs restore --in <file> --confirm RESTORE [options] <directory>
  node scripts/backup.mjs rollback --confirm ROLLBACK [options] <directory>
  node scripts/backup.mjs status [options] <directory>

Options:
  --server <url>          Override the service URL.
  --service-file <path>   Override the OpenCode service descriptor.
  --json                  Print one machine-readable report.
  --help                  Show this help.

Service resolution:
  The default descriptor is $XDG_STATE_HOME/opencode/service.json, or
  ~/.local/state/opencode/service.json when XDG_STATE_HOME is unset.
  OPENCODE_PASSWORD takes precedence over the descriptor password.
  Credentials are never printed.

Safety:
  export writes an owner-only (0600) file atomically. The backup contains
  conversation content and workspace state: keep it private and never commit it.
  restore and rollback require the explicit --confirm word and refuse while
  work is running. A restore writes one pre-restore rollback slot.

Exit codes:
  0  The command succeeded.
  1  The service refused the command.
  2  Usage, file, descriptor, or connection failure.
`
}

function resolveService(args) {
  const descriptorPath = args.serviceFile ?? defaultServiceDescriptorPath()
  const descriptor = args.server && !args.serviceFile ? undefined : readServiceDescriptor(descriptorPath)
  return {
    url: validateServerUrl(args.server ?? descriptor?.url ?? ""),
    password: process.env.OPENCODE_PASSWORD ?? descriptor?.password,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(helpText())
    return 0
  }
  // Read the local backup before resolving the service so invalid input fails
  // without a running host.
  const restoreDocument = args.command === "restore" ? readBackupFile(args.file) : undefined
  const { url, password } = resolveService(args)

  if (args.command === "export") {
    const result = await invoke(url, password, args.directory, "backup.export", {})
    const document = result?.backup
    if (!document || document.format !== FORMAT) throw new CliError("service_invalid", "The service returned no backup document.")
    const text = `${JSON.stringify(document)}\n`
    writeBackupFile(args.file, document)
    const report = exportReport(document, args.file, Buffer.byteLength(text))
    process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : render(report))
    return 0
  }
  if (args.command === "restore") {
    const result = await invoke(url, password, args.directory, "backup.restore", { backup: restoreDocument, confirmation: "RESTORE" })
    const report = applyReport(result, "restore")
    process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : render(report))
    return 0
  }
  if (args.command === "rollback") {
    const result = await invoke(url, password, args.directory, "backup.rollback", { confirmation: "ROLLBACK" })
    const report = applyReport(result, "rollback")
    process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : render(report))
    return 0
  }
  const result = await invoke(url, password, args.directory, "backup.status", {})
  const report = { ok: true, command: "status", rollback: result?.rollback ?? { present: false } }
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : render(report))
  return 0
}

try {
  process.exitCode = await main()
} catch (error) {
  const code = error?.code ?? "backup_failed"
  const message = error?.message ?? "The backup command failed."
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } }, null, 2)}\n`)
  } else {
    process.stderr.write(`backup: ${message}\n`)
  }
  process.exitCode = error?.exitCode ?? 2
}
