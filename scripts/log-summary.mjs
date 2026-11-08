#!/usr/bin/env node
/**
 * Read-only summary of Ensemble JSONL logs.
 *
 * The :logs viewer is interactive; this CLI is the agent/doctor-friendly
 * counterpart for incident triage and verification records.
 *
 * Usage:
 *   node scripts/log-summary.mjs [--dir DIR] [--since ISO] [--level warn]
 *                                [--event PREFIX] [--task ID] [--group ID] [--json]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 }

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`)
  return value
}

function defaultDir() {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(state, "ensemble", "logs")
}

const help = process.argv.includes("--help") || process.argv.includes("-h")
if (help) {
  console.log(`Usage: node scripts/log-summary.mjs [options]

  --dir DIR        log directory (default: $XDG_STATE_HOME/ensemble/logs)
  --since ISO      only rows with ts >= ISO
  --level LEVEL    minimum level: error|warn|info|debug|trace
  --event PREFIX   only events equal to or starting with PREFIX
  --task ID        only rows carrying taskID
  --group ID       only rows for one dispatch group or its continuation lineage
  --json           print the full machine-readable summary
  --help           show this help`)
  process.exit(0)
}

const dir = arg("--dir", defaultDir())
const since = arg("--since", undefined)
const level = arg("--level", undefined)
const event = arg("--event", undefined)
const task = arg("--task", undefined)
const group = arg("--group", undefined)
const asJson = process.argv.includes("--json")
if (level && !(level in LEVELS)) throw new Error(`unknown level: ${level}`)
if (!existsSync(dir)) {
  console.error(`log-summary: directory not found: ${dir}`)
  process.exit(2)
}

const roles = {}
const instances = {}
const levels = {}
const events = {}
const warnings = []
const failures = []
const tasks = new Set()
const failedTasks = new Set()
let rows = 0
let malformed = 0
let dropped = 0
let first = ""
let last = ""
let feedResets = 0
let feedGaps = 0
const dispatchGroupIDs = new Set()
const dispatchExhaustions = []
const dispatchRefusals = []
const dispatchCounts = {
  created: 0,
  continued: 0,
  exhausted: 0,
  closed: 0,
  reconciled: 0,
  hops: 0,
  refused: 0,
  invalidSettings: 0,
}

function dispatchWarning(entry) {
  return {
    ts: entry.ts,
    level: entry.level,
    event: entry.event,
    dispatchGroupID: entry.dispatchGroupID,
    rootID: entry.rootID,
    reason: entry.reason,
    usedHops: entry.usedHops,
    maxHops: entry.maxHops,
    commandUsedHops: entry.commandUsedHops,
    commandMaxHops: entry.commandMaxHops,
    continuationIndex: entry.continuationIndex,
  }
}

for (const name of readdirSync(dir).filter((item) => item.endsWith(".jsonl")).sort()) {
  const path = join(dir, name)
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    let entry
    try { entry = JSON.parse(line) } catch { malformed++; continue }
    if (since && String(entry.ts ?? "") < since) continue
    if (level && LEVELS[entry.level] > LEVELS[level]) continue
    if (event && entry.event !== event && !String(entry.event ?? "").startsWith(`${event}.`)) continue
    if (task && entry.taskID !== task) continue
    if (group && entry.dispatchGroupID !== group && entry.rootID !== group) continue
    rows++
    if (!first || entry.ts < first) first = entry.ts
    if (!last || entry.ts > last) last = entry.ts
    const role = String(entry.role ?? "unknown")
    const instance = String(entry.instanceID ?? "unknown")
    roles[role] = (roles[role] ?? 0) + 1
    instances[instance] = (instances[instance] ?? 0) + 1
    levels[entry.level] = (levels[entry.level] ?? 0) + 1
    events[entry.event] = (events[entry.event] ?? 0) + 1
    if (entry.taskID) tasks.add(entry.taskID)
    if (entry.event === "feed.reset") feedResets++
    if (entry.event === "feed.gap" || entry.event === "feed.gap.recovered") feedGaps++
    if (String(entry.event ?? "").startsWith("dispatch.")) {
      if (entry.dispatchGroupID) dispatchGroupIDs.add(entry.dispatchGroupID)
      switch (entry.event) {
        case "dispatch.group.created": dispatchCounts.created++; break
        case "dispatch.group.continued": dispatchCounts.continued++; break
        case "dispatch.group.exhausted":
          dispatchCounts.exhausted++
          dispatchExhaustions.push(dispatchWarning(entry))
          break
        case "dispatch.group.closed": dispatchCounts.closed++; break
        case "dispatch.group.reconciled": dispatchCounts.reconciled++; break
        case "dispatch.hop.consumed": dispatchCounts.hops++; break
        case "dispatch.hop.refused":
        case "dispatch.group.refused":
          dispatchCounts.refused++
          dispatchRefusals.push(dispatchWarning(entry))
          break
        case "dispatch.settings.invalid": dispatchCounts.invalidSettings++; break
      }
    }
    if (entry.event === "task.failed") {
      failedTasks.add(entry.taskID)
      failures.push(entry)
      continue
    }
    if (entry.cat === "failure" || String(entry.event ?? "").startsWith("failure.")) {
      failures.push(entry)
      continue
    }
    if (entry.level === "warn" || entry.level === "error") warnings.push(entry)
  }
}

const dispatch = {
  groups: dispatchGroupIDs.size,
  ...dispatchCounts,
  groupIDs: [...dispatchGroupIDs].sort(),
  recentExhaustions: dispatchExhaustions.slice(-10),
  recentRefusals: dispatchRefusals.slice(-10),
}

const summary = {
  dir,
  filters: { since, level, event, task, group },
  rows,
  malformed,
  first,
  last,
  roles,
  instances,
  levels,
  events,
  tasks: tasks.size,
  failedTasks: [...failedTasks],
  failures: failures.slice(-20).map((entry) => ({
    ts: entry.ts, level: entry.level, role: entry.role, instanceID: entry.instanceID,
    event: entry.event, taskID: entry.taskID, reason: entry.reason, error: entry.error,
  })),
  warnings: warnings.slice(-20).map((entry) => ({
    ts: entry.ts, level: entry.level, role: entry.role, event: entry.event,
    reason: entry.reason, count: entry.count, suppressed: entry.suppressed,
  })),
  warningCount: warnings.length,
  failureCount: failures.length,
  feedResets,
  feedGaps,
  dispatch,
}

if (asJson) {
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}

const pad = (value, width) => String(value).padEnd(width)
console.log(`logs: ${dir}`)
console.log(`rows: ${rows}  malformed: ${malformed}  window: ${first || "-"} -> ${last || "-"}`)
console.log(`roles: ${Object.entries(roles).map(([key, value]) => `${key}=${value}`).join(" ") || "-"}`)
console.log(`instances: ${Object.entries(instances).map(([key, value]) => `${key}=${value}`).join(" ") || "-"}`)
console.log(`levels: ${Object.entries(levels).map(([key, value]) => `${key}=${value}`).join(" ") || "-"}`)
console.log(`tasks: ${tasks.size}  failed: ${failedTasks.size}  failures: ${failures.length}`)
console.log(`feed: resets=${feedResets} gaps=${feedGaps}`)
console.log(`dispatch: groups=${dispatch.groups} hops=${dispatch.hops} exhausted=${dispatch.exhausted} continued=${dispatch.continued} refused=${dispatch.refused} closed=${dispatch.closed}`)
console.log("")
console.log("top events:")
for (const [key, value] of Object.entries(events).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${pad(key, 32)} ${value}`)
}
if (failures.length > 0) {
  console.log("")
  console.log("recent failures:")
  for (const entry of failures.slice(-10)) {
    console.log(`  ${entry.ts} ${entry.event} task=${entry.taskID ?? "-"} ${entry.reason ?? entry.error?.message ?? entry.error ?? ""}`)
  }
}
if (warnings.length > 0) {
  console.log("")
  console.log(`warnings: ${warnings.length} (last ${Math.min(10, warnings.length)})`)
  for (const entry of warnings.slice(-10)) {
    console.log(`  ${entry.ts} ${entry.level} ${entry.event} ${entry.reason ?? ""}`)
  }
}
const dispatchWarnings = [...dispatchExhaustions, ...dispatchRefusals].slice(-10)
if (dispatchWarnings.length > 0) {
  const total = dispatchExhaustions.length + dispatchRefusals.length
  console.log("")
  console.log(`dispatch warnings: ${total} (last ${dispatchWarnings.length})`)
  for (const entry of dispatchWarnings) {
    console.log(`  ${entry.ts} ${entry.level} ${entry.event} group=${entry.dispatchGroupID ?? "-"} root=${entry.rootID ?? "-"} reason=${entry.reason ?? ""} ${entry.usedHops ?? "?"}/${entry.maxHops ?? "?"}`)
  }
}
