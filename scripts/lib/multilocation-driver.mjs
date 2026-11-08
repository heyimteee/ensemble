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
 * A fifth channel/agent pair then proves the per-location tool registry
 * (spec #152): the fake provider emits an `ensemble_ask_person` tool call from
 * that non-first location, and the probe requires a durable pending approval,
 * resolves it, and asserts cleanup. A missing tool leaves no approval and
 * fails the probe.
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

// Ticket #157: a deliberately separate fifth location. It is created after the
// 100-request run so the request mix, counts, and timings stay unchanged.
const PROBE = { name: "mock-e", lead: "iota", peer: "kappa" }
const PROBE_PROMPT = "Probe 101: fake-ask-person"
const PROBE_QUESTION = "Which release channel should this task use?"

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

function probeTranscript(state, workspaceID) {
  const messages = Object.values(state.messages ?? {})
    .flat()
    .filter((message) => message.workspaceID === workspaceID)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .slice(-20)
    .map((message) => ({ seq: message.seq, author: message.author, kind: message.kind, text: String(message.text ?? "").slice(0, 300) }))
  const tasks = Object.values(state.subtasks ?? {})
    .filter((task) => task.workspaceID === workspaceID)
    .map((task) => ({ id: task.id, title: task.title, state: task.state, outcome: task.outcome, approvalID: task.approvalID ?? "", error: task.error ?? "" }))
  const approvals = Object.values(state.approvals ?? {})
    .filter((approval) => approval.workspaceID === workspaceID)
    .map((approval) => ({ id: approval.id, kind: approval.kind, status: approval.status, detail: approval.detail }))
  return { messages, tasks, approvals }
}

/**
 * Ticket #157 regression for the missing per-location tools. The fifth channel
 * is never the first plugin location, so its native session only has
 * `ensemble_ask_person` if the realm installs tools on every attached location.
 * The fake provider emits the tool call; a pass requires the durable pending
 * approval, an explicit decision, and no pending row left behind.
 */
async function runToolProbe(failures) {
  const started = Date.now()
  const failuresBefore = failures.length
  const probe = {
    status: "fail",
    channel: PROBE.name,
    prompt: PROBE_PROMPT,
    workspaceID: "",
    agentID: "",
    approvalID: "",
    detail: "",
    resolution: "",
    taskState: "",
    outcome: "",
    elapsedMs: 0,
    transcript: null,
  }
  try {
    const lead = await invoke("agent.create", {
      name: PROBE.lead,
      title: "Probe leader",
      role: "Non-first-location tool probe.",
      mainModel: { providerID: "ensemble-fake", modelID: "ensemble-fake-model" },
    })
    const peer = await invoke("agent.create", {
      name: PROBE.peer,
      title: "Probe peer",
      role: "Non-first-location tool probe.",
      mainModel: { providerID: "ensemble-fake", modelID: "ensemble-fake-model" },
    })
    const directory = join(project, "channels", PROBE.name)
    mkdirSync(directory, { recursive: true })
    const workspace = await invoke("workspace.create", {
      name: PROBE.name,
      directory,
      memberIDs: [lead.id, peer.id],
      leaderID: lead.id,
      synthesis: true,
    })
    probe.workspaceID = workspace.id
    probe.agentID = lead.id
    // Let onboarding prompts and this new location's plugin boot settle.
    await sleep(3_000)
    await invoke("message.send", { workspaceID: workspace.id, text: PROBE_PROMPT, recipientIDs: [lead.id] })

    const approvalDeadline = Date.now() + 90_000
    let approval
    while (Date.now() < approvalDeadline) {
      const state = await snapshot()
      approval = Object.values(state.approvals ?? {}).find((item) =>
        item.status === "pending" && item.kind === "ask_person" && item.workspaceID === workspace.id
      )
      if (approval) break
      await sleep(1_000)
    }
    if (!approval) {
      const state = await snapshot()
      probe.transcript = probeTranscript(state, workspace.id)
      probe.elapsedMs = Date.now() - started
      fail(`tool probe: no pending ask_person approval in ${PROBE.name}; the non-first location did not execute ensemble_ask_person`, failures)
      return probe
    }
    probe.approvalID = approval.id
    probe.detail = String(approval.detail ?? "")
    if (probe.detail !== PROBE_QUESTION) fail(`tool probe: unexpected question detail "${probe.detail}"`, failures)

    await invoke("approval.resolve", {
      id: approval.id,
      approve: true,
      resolution: "Approved by the multi-location tool probe.",
    })

    const cleanupDeadline = Date.now() + 120_000
    let cleanup
    while (Date.now() < cleanupDeadline) {
      const state = await snapshot()
      const pending = Object.values(state.approvals ?? {}).filter((item) =>
        item.status === "pending" && item.workspaceID === workspace.id
      )
      const task = approval.subtaskID ? state.subtasks?.[approval.subtaskID] : undefined
      cleanup = {
        pending: pending.length,
        approvalStatus: state.approvals?.[approval.id]?.status ?? "",
        taskState: task?.state ?? "",
        outcome: task?.outcome ?? "",
        error: task?.error ?? "",
      }
      if (cleanup.pending === 0 && cleanup.taskState === "replied" && cleanup.outcome === "succeeded") break
      await sleep(1_000)
    }
    probe.resolution = cleanup?.approvalStatus ?? ""
    probe.taskState = cleanup?.taskState ?? ""
    probe.outcome = cleanup?.outcome ?? ""
    probe.elapsedMs = Date.now() - started
    if (probe.resolution !== "approved") fail(`tool probe: approval resolved as "${probe.resolution}", expected approved`, failures)
    if ((cleanup?.pending ?? 1) !== 0) fail(`tool probe: ${cleanup?.pending ?? "unknown"} pending approval(s) remain after resolution`, failures)
    if (probe.taskState !== "replied" || probe.outcome !== "succeeded") {
      fail(`tool probe: task ended ${probe.taskState}/${probe.outcome}${cleanup?.error ? ` (${cleanup.error})` : ""}`, failures)
    }
    if (failures.length === failuresBefore) probe.status = "pass"
    return probe
  } catch (error) {
    probe.elapsedMs = Date.now() - started
    fail(`tool probe failed: ${error?.message ?? error}`, failures)
    return probe
  }
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

  // Ticket #157: the fifth location attaches after the measured 100-request
  // run, then a fake-provider ask_person tool call must produce a real
  // approval on that channel. Re-read the logs afterwards: a later location
  // must not start a second service, and the resolved probe must not add
  // failures.
  const toolProbe = await runToolProbe(failures)
  const serviceAfterProbe = readLogs("service-")
  const startsAfterProbe = serviceAfterProbe.rows.filter((row) => row.event === "service.start")
  const taskFailedAfterProbe = serviceAfterProbe.rows.filter((row) => row.event === "task.failed")
  const failureRecordsAfterProbe = serviceAfterProbe.rows.filter((row) => row.cat === "failure")
  if (startsAfterProbe.length !== 1) fail(`expected 1 service.start after the fifth location attached, saw ${startsAfterProbe.length}`, failures)
  if (taskFailedAfterProbe.length !== 0) fail(`expected 0 task.failed after the tool probe, saw ${taskFailedAfterProbe.length}`, failures)
  if (failureRecordsAfterProbe.length !== 0) fail(`expected 0 failure records after the tool probe, saw ${failureRecordsAfterProbe.length}`, failures)
  if (toolProbe.approvalID) {
    const requested = serviceAfterProbe.rows.filter((row) => row.event === "approval.requested" && row.approvalID === toolProbe.approvalID)
    const resolved = serviceAfterProbe.rows.filter((row) => row.event === "approval.resolved" && row.approvalID === toolProbe.approvalID)
    if (requested.length !== 1) fail(`tool probe: expected 1 approval.requested row, saw ${requested.length}`, failures)
    if (resolved.length !== 1) fail(`tool probe: expected 1 approval.resolved row, saw ${resolved.length}`, failures)
  }
  const tuiAfterProbe = readLogs("tui-")
  const gapWarningsAfterProbe = tuiAfterProbe.rows.filter((row) =>
    row.event === "feed.gap" && row.level === "warn" && row.ts >= runStarted)
  if (gapWarningsAfterProbe.length >= 5) fail(`expected <5 warn-level feed.gap lines after the tool probe, saw ${gapWarningsAfterProbe.length}`, failures)

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
    serviceStarts: startsAfterProbe.length,
    taskFailed: taskFailedAfterProbe.length,
    failureRecords: failureRecordsAfterProbe.length,
    tuiGapWarnings: gapWarningsAfterProbe.length,
    maxObservedRuns: maxRuns,
    settleMs: elapsedMs,
    resultMessages: [...tasks.values()].filter((task) => task.resultMessageID).length,
    resultChars: [...tasks.values()]
      .map((task) => messageById.get(task.resultMessageID)?.text?.length ?? 0)
      .filter((chars) => chars > 0)
      .reduce((sum, chars) => sum + chars, 0),
    toolProbe,
    files: { service: serviceAfterProbe.rows.length, tui: tuiAfterProbe.rows.length, malformed: serviceAfterProbe.malformed + tuiAfterProbe.malformed },
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
