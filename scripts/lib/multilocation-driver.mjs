#!/usr/bin/env node
/**
 * Multi-location RPC load probe for the single-service registry and lease-safe
 * recovery (spec #146).
 *
 * Creates four channels and eight agents on an isolated fake-provider host,
 * sends 100 requests, waits for every dispatch group to settle, and asserts:
 *   - one service.start despite the host loading the plugin at every location
 *   - every task succeeded, with no task.failed or failure records
 *   - the TUI logged fewer than five warn-level feed.gap lines
 *
 * It is test infrastructure only; the plugin never imports this file.
 */
import { mkdirSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const CHANNELS = [
  { name: "mock-a", lead: "alpha", peer: "beta" },
  { name: "mock-b", lead: "gamma", peer: "delta" },
  { name: "mock-c", lead: "epsilon", peer: "zeta" },
  { name: "mock-d", lead: "eta", peer: "theta" },
]

function readArg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (!value) throw new Error(`${name} needs a value`)
  return value
}

const url = readArg("--url")
const password = readArg("--password")
const project = readArg("--project")
const state = readArg("--state")
const promptsFile = readArg("--prompts", new URL("./multilocation-prompts.json", import.meta.url).pathname)
const settleMs = Number(readArg("--settle-ms", "8000"))
const out = readArg("--out", "")
const logDir = join(state, "ensemble", "logs")
const prompts = JSON.parse(readFileSync(promptsFile, "utf8"))

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function authHeader() {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

async function rpc(method, input, timeoutMs = 180_000) {
  const target = `${url}/api/rpc/ensemble.v2/${method}?location%5Bdirectory%5D=${encodeURIComponent(project)}`
  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: authHeader() },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`)
  const value = await response.json()
  return value?.output ?? value
}

async function invoke(action, payload) {
  const result = await rpc("invoke", { directory: project, action, payload })
  if (!result?.ok) throw new Error(`${action} failed: ${JSON.stringify(result?.error ?? result)}`)
  return result.result
}

async function snapshot() {
  return (await rpc("diagnostic", { directory: project })).state
}

function adapt(text, lead, peer) {
  return text
    .replaceAll("$xedo", `$${lead}`)
    .replaceAll("$meow", `$${peer}`)
    .replaceAll("xedo", lead)
    .replaceAll("meow", peer)
}

function readLogs(prefix) {
  let names = []
  try { names = readdirSync(logDir) } catch { return { rows: [], malformed: 0 } }
  const rows = []
  let malformed = 0
  for (const name of names.filter((item) => item.startsWith(prefix) && item.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(logDir, name), "utf8").split("\n")) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch { malformed++ }
    }
  }
  return { rows, malformed }
}

function relatedTasks(tasks, expected) {
  const roots = [...tasks.values()].filter((task) => expected.has(task.instruction))
  const found = new Set(roots.map((task) => task.instruction))
  const ids = new Set(roots.map((task) => task.id))
  let changed = true
  while (changed) {
    changed = false
    for (const task of tasks.values()) {
      if (task.parentID && ids.has(task.parentID) && !ids.has(task.id)) {
        ids.add(task.id)
        changed = true
      }
    }
  }
  return { roots, found, related: [...ids].map((id) => tasks.get(id)).filter(Boolean) }
}

async function settle(expected, timeoutMs = 180_000) {
  const started = Date.now()
  let stableSince = 0
  let maxRuns = 0
  let lastSignature = ""
  while (Date.now() - started < timeoutMs) {
    const state = await snapshot()
    const tasks = new Map(Object.entries(state.subtasks ?? {}))
    const runs = Object.keys(state.runs ?? {}).length
    maxRuns = Math.max(maxRuns, runs)
    const { found, related } = relatedTasks(tasks, expected)
    const open = related.filter((task) => task.state !== "replied")
    const signature = `${found.size}:${related.length}:${open.length}:${runs}`
    if (found.size >= expected.size && open.length === 0 && runs === 0) {
      if (signature === lastSignature) {
        if (Date.now() - stableSince >= 3_000) {
          return { state, tasks, related, elapsedMs: Date.now() - started, maxRuns }
        }
      } else {
        lastSignature = signature
        stableSince = Date.now()
      }
    } else {
      lastSignature = signature
      stableSince = 0
    }
    await sleep(1_000)
  }
  throw new Error(`dispatch groups did not settle within ${timeoutMs}ms`)
}

function fail(message, failures) {
  failures.push(message)
  console.error(`live-multilocation: ${message}`)
}

async function main() {
  const failures = []
  const agents = {}
  for (const channel of CHANNELS) {
    for (const [name, title] of [[channel.lead, "Mock leader"], [channel.peer, "Mock peer"]]) {
      const agent = await invoke("agent.create", {
        name,
        title,
        role: "Mock teammate.",
        mainModel: { providerID: "ensemble-fake", modelID: "ensemble-fake-model" },
      })
      agents[name] = agent.id
    }
  }
  const workspaces = {}
  for (const channel of CHANNELS) {
    const directory = join(project, "channels", channel.name)
    mkdirSync(directory, { recursive: true })
    workspaces[channel.name] = await invoke("workspace.create", {
      name: channel.name,
      directory,
      memberIDs: [agents[channel.lead], agents[channel.peer]],
      leaderID: agents[channel.lead],
      synthesis: true,
    })
  }
  await invoke("settings.update", { maxActiveRuns: 8, maxDelegations: 10, maxDepth: 5 })
  // Give onboarding prompts and the first plugin-location boot time to settle.
  await sleep(settleMs)

  const jobs = prompts.map((prompt, index) => {
    const channel = CHANNELS[index % CHANNELS.length]
    return {
      index: index + 1,
      category: prompt.category,
      channel: channel.name,
      workspaceID: workspaces[channel.name].id,
      text: adapt(prompt.text, channel.lead, channel.peer),
      sendError: "",
    }
  })
  const runStarted = new Date().toISOString()
  for (const job of jobs) {
    try {
      await invoke("message.send", { workspaceID: job.workspaceID, text: job.text })
    } catch (error) {
      job.sendError = String(error?.message ?? error)
    }
  }

  const expected = new Set(jobs.filter((job) => !job.sendError).map((job) => job.text))
  if (expected.size === 0) throw new Error("no request was accepted")
  const { state, tasks, related, elapsedMs, maxRuns } = await settle(expected)
  const messages = Object.values(state.messages ?? {}).flat()
  const messageById = new Map(messages.map((message) => [message.id, message]))
  const jobsFailed = []
  for (const job of jobs) {
    if (job.sendError) {
      jobsFailed.push({ index: job.index, error: job.sendError })
      continue
    }
    const roots = [...tasks.values()].filter((task) => task.instruction === job.text)
    if (roots.length === 0) {
      jobsFailed.push({ index: job.index, error: "no task created" })
      continue
    }
    const failed = roots.filter((task) => task.outcome !== "succeeded" || task.state !== "replied")
    if (failed.length > 0) {
      jobsFailed.push({ index: job.index, error: "root task failed", tasks: failed.map((task) => task.id) })
    }
  }
  const failedTasks = related.filter((task) => task.outcome !== "succeeded")
  if (failedTasks.length > 0) fail(`${failedTasks.length} related task(s) failed`, failures)
  if (jobsFailed.length > 0) fail(`${jobsFailed.length} job(s) failed`, failures)
  if (related.length < jobs.length) fail(`only ${related.length} related tasks for ${jobs.length} jobs`, failures)

  const service = readLogs("service-")
  const starts = service.rows.filter((row) => row.event === "service.start")
  const taskFailed = service.rows.filter((row) => row.event === "task.failed")
  const failureRecords = service.rows.filter((row) => row.cat === "failure")
  if (starts.length !== 1) fail(`expected 1 service.start, saw ${starts.length}`, failures)
  if (taskFailed.length !== 0) fail(`expected 0 task.failed, saw ${taskFailed.length}`, failures)
  if (failureRecords.length !== 0) fail(`expected 0 failure records, saw ${failureRecords.length}`, failures)

  const tui = readLogs("tui-")
  const gapWarnings = tui.rows.filter((row) =>
    row.event === "feed.gap" && row.level === "warn" && row.ts >= runStarted)
  if (gapWarnings.length >= 5) fail(`expected <5 warn-level feed.gap lines, saw ${gapWarnings.length}`, failures)

  const summary = {
    jobs: jobs.length,
    jobsFailed,
    taskRows: related.length,
    taskOutcomes: related.reduce((counts, task) => {
      counts[task.outcome] = (counts[task.outcome] ?? 0) + 1
      return counts
    }, {}),
    attempts: related.reduce((counts, task) => {
      counts[String(task.attempts ?? 0)] = (counts[String(task.attempts ?? 0)] ?? 0) + 1
      return counts
    }, {}),
    serviceStarts: starts.length,
    taskFailed: taskFailed.length,
    failureRecords: failureRecords.length,
    tuiGapWarnings: gapWarnings.length,
    maxObservedRuns: maxRuns,
    settleMs: elapsedMs,
    resultMessages: [...tasks.values()].filter((task) => task.resultMessageID).length,
    resultChars: [...tasks.values()]
      .map((task) => messageById.get(task.resultMessageID)?.text?.length ?? 0)
      .filter((chars) => chars > 0)
      .reduce((sum, chars) => sum + chars, 0),
    files: { service: service.rows.length, tui: tui.rows.length, malformed: service.malformed + tui.malformed },
    failures,
  }
  if (out) {
    const { writeFileSync } = await import("node:fs")
    writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`)
  }
  console.log(JSON.stringify(summary, null, 2))
  if (failures.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(`live-multilocation: ${error?.stack ?? error}`)
  process.exitCode = 1
})
