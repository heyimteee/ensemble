#!/usr/bin/env node
/**
 * Ticket #276: local support bundle.
 *
 * Collects redacted, content-free evidence for an issue report. Nothing is
 * uploaded: the command writes a directory the user can inspect and attach.
 *
 *   npm run support:bundle -- --out /tmp/ensemble-support
 *   node --experimental-strip-types scripts/support-bundle.mjs --out DIR \
 *     [--directory PATH]... [--server URL] [--service-file PATH] [--log-dir DIR]
 *
 * The bundle contains:
 *   manifest.json          format/version, runtime, redacted directories, file list
 *   doctor.json            the read-only doctor report, or its connection error
 *   logs-summary.json      counts/events/failures from the local JSONL logs
 *   logs/recent.jsonl      bounded warn/error/failure rows with content keys removed
 *   logs/files.json        log file inventory (names and byte counts only)
 *   service.json           service descriptor summary with the password redacted
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { homedir, release, arch, platform } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

import {
  SUPPORT_BUNDLE_FORMAT,
  SUPPORT_BUNDLE_VERSION,
  buildSupportManifest,
  redactSupportText,
  redactSupportValue,
  sanitizeLogRows,
} from "../src/v2/support-bundle.ts"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const DOCTOR_CLI = join(REPO_ROOT, "src", "v2", "doctor-cli.ts")
const LOG_SUMMARY = join(REPO_ROOT, "scripts", "log-summary.mjs")
const RECENT_LOG_LIMIT = 500

function usage() {
  console.log(`Ensemble support bundle (local, redacted, no upload)

Usage:
  npm run support:bundle -- --out <dir> [options]

Options:
  --out DIR            Required. Bundle directory (created when missing).
  --directory PATH     Workspace to diagnose. Repeatable; defaults to the cwd.
  --server URL         Override the OpenCode service URL.
  --service-file PATH  Override the OpenCode service descriptor.
  --log-dir DIR        Ensemble log directory.
  --json               Print the manifest to stdout.
  --help               Show this help.

The command never calls a mutating RPC and never writes storage. Conversation
content, titles, instructions, prompts, file bytes, credentials, and home/state
paths are omitted or redacted. There is no telemetry upload.`)
}

function fail(message) {
  console.error(`support-bundle: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const args = { out: "", directories: [], server: "", serviceFile: "", logDir: "", json: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--help" || argument === "-h") { args.help = true; continue }
    if (argument === "--json") { args.json = true; continue }
    if (argument === "--out") { args.out = argv[++index] ?? ""; continue }
    if (argument === "--directory") { args.directories.push(argv[++index] ?? ""); continue }
    if (argument === "--server") { args.server = argv[++index] ?? ""; continue }
    if (argument === "--service-file") { args.serviceFile = argv[++index] ?? ""; continue }
    if (argument === "--log-dir") { args.logDir = argv[++index] ?? ""; continue }
    throw new Error(`unknown argument: ${argument}`)
  }
  return args
}

function defaultLogDirectory() {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(state, "ensemble", "logs")
}

function defaultServiceFile() {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(state, "opencode", "service.json")
}

function runNode(args, env, timeout = 30_000) {
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout,
    env,
    cwd: REPO_ROOT,
  })
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function writeText(path, value) {
  writeFileSync(path, value, { mode: 0o600 })
}

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version ?? "unknown"
  } catch {
    return "unknown"
  }
}

function serviceSummary(path, redact) {
  if (!existsSync(path)) return { present: false }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"))
    return {
      present: true,
      id: typeof value.id === "string" ? value.id : undefined,
      version: typeof value.version === "string" ? value.version : undefined,
      pid: typeof value.pid === "number" ? value.pid : undefined,
      url: typeof value.url === "string" ? redact(value.url) : undefined,
      password: value.password ? "[redacted]" : undefined,
    }
  } catch {
    return { present: true, error: "service descriptor is not valid JSON" }
  }
}

function readRecentLogs(directory, redact, context) {
  if (!existsSync(directory)) return { rows: [], files: [], error: "log directory not found" }
  const files = []
  const rows = []
  for (const name of readdirSync(directory).filter((item) => item.endsWith(".jsonl")).sort()) {
    const path = join(directory, name)
    try {
      const stat = statSync(path)
      files.push({ name, bytes: stat.size })
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue
        let entry
        try { entry = JSON.parse(line) } catch { continue }
        if (entry?.level === "warn" || entry?.level === "error" || entry?.cat === "failure" || String(entry?.event ?? "").startsWith("failure.")) {
          rows.push(entry)
        }
      }
    } catch {
      files.push({ name, bytes: 0, error: "unreadable" })
    }
  }
  return { rows: sanitizeLogRows(rows, context, RECENT_LOG_LIMIT), files }
}

function main() {
  let args
  try { args = parseArgs(process.argv.slice(2)) } catch (error) {
    console.error(`support-bundle: ${error.message}`)
    process.exit(2)
  }
  if (args.help) { usage(); return }
  if (!args.out) fail("--out is required")
  if (args.directories.length === 0) args.directories.push(process.cwd())
  const out = resolve(args.out)
  const logDir = resolve(args.logDir || defaultLogDirectory())
  const serviceFile = resolve(args.serviceFile || defaultServiceFile())
  const directories = args.directories.map((directory) => resolve(directory))
  const home = homedir()
  const context = {
    home,
    stateDirectory: process.env.XDG_STATE_HOME || join(home, ".local", "state"),
    logDirectory: logDir,
    roots: [out, ...directories],
    secrets: [process.env.OPENCODE_PASSWORD, process.env.GITHUB_TOKEN, process.env.NPM_TOKEN].filter(Boolean),
  }
  const redact = (value) => redactSupportText(String(value), context)

  mkdirSync(join(out, "logs"), { recursive: true })
  const env = { ...process.env }

  const doctorArgs = ["--experimental-strip-types", DOCTOR_CLI, "--json"]
  if (args.server) doctorArgs.push("--server", args.server)
  if (args.serviceFile) doctorArgs.push("--service-file", serviceFile)
  doctorArgs.push(...directories)
  const doctor = runNode(doctorArgs, env)
  if (doctor.error || doctor.status === null) {
    writeJson(join(out, "doctor.json"), {
      ok: false,
      error: { code: "doctor_failed", message: redact(doctor.error?.message ?? "doctor did not run") },
    })
  } else {
    let parsed
    try { parsed = JSON.parse(doctor.stdout) } catch { parsed = { ok: false, error: { code: "doctor_invalid", message: redact(doctor.stderr || doctor.stdout || "doctor returned no JSON") } } }
    writeJson(join(out, "doctor.json"), redactSupportValue(parsed, context))
  }

  const summary = runNode([LOG_SUMMARY, "--dir", logDir, "--json"], env)
  if (summary.status === 0) {
    let parsed
    try { parsed = JSON.parse(summary.stdout) } catch { parsed = { error: "log summary returned no JSON" } }
    writeJson(join(out, "logs-summary.json"), redactSupportValue(parsed, context))
  } else {
    writeJson(join(out, "logs-summary.json"), { error: redact(summary.stderr || "log summary unavailable") })
  }

  const recent = readRecentLogs(logDir, redact, context)
  writeText(join(out, "logs", "recent.jsonl"), recent.rows.map((row) => JSON.stringify(row)).join("\n") + (recent.rows.length > 0 ? "\n" : ""))
  writeJson(join(out, "logs", "files.json"), { files: recent.files, ...(recent.error ? { error: redact(recent.error) } : {}) })
  writeJson(join(out, "service.json"), serviceSummary(serviceFile, redact))

  const files = ["doctor.json", "logs-summary.json", "logs/recent.jsonl", "logs/files.json", "service.json"]
    .map((name) => ({ name, bytes: existsSync(join(out, name)) ? statSync(join(out, name)).size : 0 }))
  const manifest = buildSupportManifest({
    createdAt: new Date().toISOString(),
    platform: platform(),
    release: release(),
    arch: arch(),
    node: process.versions.node,
    ensembleVersion: readPackageVersion(),
    directories,
    files,
    context,
  })
  writeJson(join(out, "manifest.json"), manifest)

  if (args.json) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
  } else {
    console.log(`support bundle: ${out}`)
    console.log(`format: ${SUPPORT_BUNDLE_FORMAT} v${SUPPORT_BUNDLE_VERSION}`)
    console.log(`  manifest.json (${statSync(join(out, "manifest.json")).size} bytes)`)
    for (const file of files) console.log(`  ${file.name} (${file.bytes} bytes)`)
    console.log("no telemetry was uploaded; review the files before attaching them to an issue")
  }
}

try {
  main()
} catch (error) {
  console.error(`support-bundle: ${error?.message ?? error}`)
  process.exit(2)
}
