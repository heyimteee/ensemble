#!/usr/bin/env node
/**
 * Ticket #276: one content-free soak sample.
 *
 * Reads a diagnostic response, reduces it to counts, and appends one JSON row.
 * The diagnostic payload itself is never copied into the record.
 */
import { readFileSync, readdirSync } from "node:fs"
import { basename } from "node:path"

import { diagnosticCounts } from "../src/v2/soak-metrics.ts"

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`)
  return value
}

function number(name, fallback = 0) {
  const value = Number(arg(name, String(fallback)))
  return Number.isFinite(value) ? value : fallback
}

function processTable() {
  const table = new Map()
  let entries = []
  try {
    entries = readdirSync("/proc").filter((name) => /^\d+$/.test(name))
  } catch {
    return table
  }
  for (const name of entries) {
    const pid = Number(name)
    let stat
    let status
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8")
      status = readFileSync(`/proc/${name}/status`, "utf8")
    } catch {
      continue
    }
    const close = stat.lastIndexOf(")")
    if (close < 0) continue
    const fields = stat.slice(close + 2).split(" ")
    const ppid = Number(fields[1])
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(status)
    table.set(pid, { ppid, rssBytes: match ? Number(match[1]) * 1024 : 0 })
  }
  return table
}

function treeRssBytes(table, rootPid) {
  if (!rootPid || !table.has(rootPid)) return 0
  const children = new Map()
  for (const [pid, entry] of table) {
    const list = children.get(entry.ppid) ?? []
    list.push(pid)
    children.set(entry.ppid, list)
  }
  const seen = new Set()
  let total = 0
  const stack = [rootPid]
  while (stack.length > 0) {
    const pid = stack.pop()
    if (!pid || seen.has(pid)) continue
    seen.add(pid)
    const entry = table.get(pid)
    if (entry) total += entry.rssBytes
    for (const child of children.get(pid) ?? []) stack.push(child)
  }
  return total
}

function main() {
  const diagnosticPath = arg("--diagnostic")
  if (!diagnosticPath) throw new Error("--diagnostic is required")
  const output = JSON.parse(readFileSync(diagnosticPath, "utf8"))
  const counts = diagnosticCounts(output?.output ?? output)
  const table = processTable()
  const serviceBytes = treeRssBytes(table, number("--server-pid"))
  const tuiBytes = treeRssBytes(table, number("--tui-pid"))
  const sample = {
    ...counts,
    at: number("--at", Date.now()),
    elapsedSeconds: number("--elapsed"),
    rss: { serviceBytes, tuiBytes, totalBytes: serviceBytes + tuiBytes },
    storageBytes: number("--storage-bytes"),
    diagnosticBytes: number("--diagnostic-bytes"),
    diagnosticMs: number("--diagnostic-ms"),
  }
  process.stdout.write(`${JSON.stringify(sample)}\n`)
}

try {
  main()
} catch (error) {
  console.error(`soak-sample: ${basename(import.meta.url)}: ${error?.message ?? error}`)
  process.exit(2)
}
