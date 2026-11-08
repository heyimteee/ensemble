#!/usr/bin/env node
/**
 * Dispatch-budget live probe for spec #159 / ticket #164.
 *
 * Runs on the same isolated fake-provider host as the multi-location probe,
 * after the 100-request measured run, so the existing path stays unchanged.
 * A deterministic two-agent relay exercises the real service admission seam:
 *
 *   five  — five handoff hops inside one root group
 *   nine  — eight root hops plus a leader continuation hop (nine total)
 *   cap   — eight root hops against an 8-hop command; continuation refused
 *
 * The fake provider writes the typed handoff files and emits the tool calls.
 * Every hop is therefore a real `ensemble_handoff`/`ensemble_delegate`
 * admission that consumes the durable ledger exactly once. The driver asserts
 * group/command counters, continuation lineage, exhaustion and refusal logs,
 * no duplicate task consumption, and no task-content leakage in dispatch rows.
 *
 * Test infrastructure only; the plugin never imports this file.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const WORKSPACE = {
  name: "mock-f",
  lead: "LedgerLead",
  peer: "LedgerPeer",
}

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
const stateDir = readArg("--state")
const handoffDir = readArg("--handoff-dir", join(project, "channels", WORKSPACE.name, ".ensemble", "handoffs"))
const out = readArg("--out", "")
const settleTimeoutMs = Number(readArg("--timeout-ms", "180000"))
const logDir = join(stateDir, "ensemble", "logs")

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

function fail(message, failures) {
  failures.push(message)
  console.error(`dispatch-budgets: ${message}`)
}

function marker(chain, consumed, total, next, mode = "handoff") {
  return `fake-budget-relay:chain=${chain};consumed=${consumed};total=${total};next=${next};mode=${mode}`
}

function consuming(task) {
  return task.creatorType === "agent" &&
    (task.workKind === "delegation" || task.workKind === "handoff") &&
    task.handoff?.completion !== true &&
    task.handoff?.batch !== true
}

async function waitForSettings(expected, failures) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const current = (await snapshot()).settings ?? {}
    if (
      current.dispatchGroupMaxHops === expected.dispatchGroupMaxHops &&
      current.dispatchCommandMaxHops === expected.dispatchCommandMaxHops &&
      current.dispatchDepth === expected.dispatchDepth &&
      current.dispatchContinuations === expected.dispatchContinuations
    ) {
      return
    }
    await sleep(250)
  }
  fail(`settings did not reach ${JSON.stringify(expected)}`, failures)
}

async function waitForRoot(text, deadline) {
  while (Date.now() < deadline) {
    const state = await snapshot()
    const rootTask = Object.values(state.subtasks ?? {})
      .filter((task) => task.workspaceID === workspaceID && task.creatorType === "user" && task.instruction === text)
      .pop()
    if (rootTask?.dispatchGroupID) return rootTask.dispatchGroupID
    await sleep(250)
  }
  return undefined
}

function scenarioGroups(state, rootID) {
  return Object.values(state.dispatchGroups ?? {})
    .filter((group) => group.rootID === rootID)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

function scenarioTasks(state, rootID) {
  const groupIDs = new Set(scenarioGroups(state, rootID).map((group) => group.id))
  return Object.values(state.subtasks ?? {}).filter((task) => groupIDs.has(task.dispatchGroupID))
}

async function settleScenario(rootID, expectedGroups, failures) {
  const started = Date.now()
  let stableSignature = ""
  let stableSince = 0
  let last
  while (Date.now() - started < settleTimeoutMs) {
    const state = await snapshot()
    const groups = scenarioGroups(state, rootID)
    const tasks = scenarioTasks(state, rootID)
    const open = tasks.filter((task) => task.state !== "replied")
    const runs = Object.keys(state.runs ?? {}).length
    last = { state, groups, tasks, open, runs }
    const signature = `${groups.length}:${tasks.length}:${open.length}:${runs}`
    if (groups.length >= expectedGroups && tasks.length > 0 && open.length === 0 && runs === 0) {
      if (signature === stableSignature) {
        if (Date.now() - stableSince >= 2_000) return last
      } else {
        stableSignature = signature
        stableSince = Date.now()
      }
    } else {
      stableSignature = signature
      stableSince = 0
    }
    await sleep(500)
  }
  fail(`scenario ${rootID} did not settle (groups=${last?.groups.length}/${expectedGroups}, open=${last?.open.length}, runs=${last?.runs})`, failures)
  return last
}

let workspaceID = ""

async function runScenario(input) {
  const failures = []
  const settings = {
    maxActiveRuns: 8,
    maxDelegations: 10,
    dispatchGroupMaxHops: input.groupMaxHops,
    dispatchCommandMaxHops: input.commandMaxHops,
    dispatchDepth: 8,
    dispatchContinuations: input.continuations,
  }
  await invoke("settings.update", settings)
  await waitForSettings(settings, failures)
  const text = marker(input.chain, 0, input.total, WORKSPACE.peer)
  const startedAt = Date.now()
  await invoke("message.send", { workspaceID, text, recipientIDs: [leaderID] })
  const rootID = await waitForRoot(text, startedAt + 60_000)
  if (!rootID) {
    fail(`${input.chain}: no root work item was created`, failures)
    return { name: input.chain, status: "fail", failures, hops: 0 }
  }
  const settled = await settleScenario(rootID, input.expectedGroups, failures)
  if (!settled) return { name: input.chain, status: "fail", failures, rootID, hops: 0 }
  const groups = settled.groups
  const tasks = settled.tasks
  const hops = tasks.filter(consuming)
  const root = groups.find((group) => group.id === rootID)
  const continuation = groups.find((group) => group.id !== rootID)
  const groupIDs = new Set(groups.map((group) => group.id))
  const service = readLogs("service-")
  const dispatchRows = service.rows.filter((row) => row.cat === "dispatch" && (
    row.dispatchGroupID !== undefined && groupIDs.has(row.dispatchGroupID) ||
    row.rootID === rootID
  ))
  const consumed = dispatchRows.filter((row) => row.event === "dispatch.hop.consumed")
  const refused = dispatchRows.filter((row) =>
    row.event === "dispatch.hop.refused" || row.event === "dispatch.group.refused"
  )
  const exhausted = dispatchRows.filter((row) => row.event === "dispatch.group.exhausted")
  const continued = dispatchRows.filter((row) => row.event === "dispatch.group.continued")
  const closed = dispatchRows.filter((row) => row.event === "dispatch.group.closed")
  const expectedHops = input.expectedHops

  const check = (condition, message) => {
    if (!condition) fail(`${input.chain}: ${message}`, failures)
  }
  check(groups.length === input.expectedGroups, `expected ${input.expectedGroups} group(s), saw ${groups.length}`)
  check(hops.length === expectedHops, `expected ${expectedHops} consuming hop(s), saw ${hops.length}`)
  check(root?.usedHops === expectedHops - (continuation?.usedHops ?? 0), `root usedHops ${root?.usedHops} does not match hop split`)
  check(root?.commandUsedHops === expectedHops, `command usedHops ${root?.commandUsedHops} does not equal ${expectedHops}`)
  check(consumed.length === expectedHops, `expected ${expectedHops} dispatch.hop.consumed row(s), saw ${consumed.length}`)
  check(new Set(consumed.map((row) => row.taskID)).size === consumed.length, "a work item consumed more than one hop")
  check(consumed.every((row) => hops.some((task) => task.id === row.taskID)), "a consumed row does not match a hop task")
  check(hops.every((task) => consumed.some((row) => row.taskID === task.id)), "a hop task has no consumed row")
  check(tasks.every((task) => (task.attempts ?? 0) <= 1), "a scenario task was retried")
  check(tasks.every((task) => task.state === "replied" && task.outcome === "succeeded"), "a scenario task did not succeed")
  const leaked = dispatchRows.filter((row) => {
    const text = JSON.stringify(row)
    return text.includes("fake-budget-relay") || text.includes("Budget relay") || text.includes("Deterministic budget relay")
  })
  check(leaked.length === 0, "dispatch rows leaked task content")
  check(root?.continuationsUsed === (continuation ? 1 : 0), `continuationsUsed is ${root?.continuationsUsed}`)
  if (input.expectContinuation) {
    check(continuation !== undefined, "expected a continuation group")
    check(continuation?.parentID === rootID, "continuation does not reference the root")
    check(continuation?.continuationIndex === 1, "continuation index is not 1")
    check(continuation?.closedAt === undefined, "the continuation is unexpectedly closed")
    check(root?.closedAt !== undefined && root?.closeReason === "continued", "the root was not sealed as continued")
    check(continued.length === 1, `expected one dispatch.group.continued row, saw ${continued.length}`)
    check(exhausted.length === 1 && exhausted[0]?.reason === "group-exhausted", "root exhaustion was not logged as a group stop")
    check(closed.length === 1, `expected one dispatch.group.closed row, saw ${closed.length}`)
  } else {
    check(continuation === undefined, "unexpected continuation group")
    check(continued.length === 0, "unexpected continuation row")
  }
  if (input.expectCommandStop) {
    check(root?.commandMaxHops === input.commandMaxHops, `command max is ${root?.commandMaxHops}`)
    check(root?.commandUsedHops === root?.commandMaxHops, "command cap was not reached")
    check(refused.length === 1, `expected one hop refusal, saw ${refused.length}`)
    check(refused[0]?.reason === "command-exhausted", `refusal reason is ${refused[0]?.reason}`)
    check(exhausted.length === 1 && exhausted[0]?.reason === "command-exhausted", "command exhaustion was not logged")
    const messages = Object.values(settled.state.messages ?? {}).flat()
    const refusal = messages.filter((message) =>
      message.workspaceID === workspaceID &&
      typeof message.text === "string" &&
      /^Continuation refused: the command budget is exhausted \(8\/8 hops\)/.test(message.text)
    )
    check(refusal.length === 1, `expected one command-cap refusal line, saw ${refusal.length}`)
  } else {
    check(refused.length === 0, `unexpected hop refusal: ${refused[0]?.reason ?? "unknown"}`)
    if (!input.expectContinuation) check(exhausted.length === 0, "unexpected exhaustion row")
  }

  return {
    name: input.chain,
    status: failures.length === 0 ? "pass" : "fail",
    rootID,
    workspaceID,
    groups: groups.map((group) => ({
      id: group.id,
      rootID: group.rootID,
      parentID: group.parentID,
      continuationIndex: group.continuationIndex,
      usedHops: group.usedHops,
      maxHops: group.maxHops,
      commandUsedHops: group.commandUsedHops,
      commandMaxHops: group.commandMaxHops,
      continuationsUsed: group.continuationsUsed,
      closeReason: group.closeReason,
      exhausted: group.usedHops >= group.maxHops,
    })),
    tasks: tasks.length,
    hops: hops.length,
    consumedRows: consumed.length,
    distinctConsumedTasks: new Set(consumed.map((row) => row.taskID)).size,
    refusedRows: refused.map((row) => ({ reason: row.reason, usedHops: row.usedHops, maxHops: row.maxHops })),
    exhaustedRows: exhausted.map((row) => ({ reason: row.reason, usedHops: row.usedHops, maxHops: row.maxHops })),
    continuedRows: continued.length,
    closedRows: closed.length,
    dispatchRows: dispatchRows.length,
    elapsedMs: Date.now() - startedAt,
    failures,
  }
}

async function main() {
  const failures = []
  mkdirSync(handoffDir, { recursive: true })
  mkdirSync(join(project, "channels", WORKSPACE.name), { recursive: true })

  const lead = await invoke("agent.create", {
    name: WORKSPACE.lead,
    title: "Budget relay leader",
    role: "Deterministic dispatch-budget fixture leader.",
    mainModel: { providerID: "ensemble-fake", modelID: "ensemble-fake-model" },
  })
  const peer = await invoke("agent.create", {
    name: WORKSPACE.peer,
    title: "Budget relay peer",
    role: "Deterministic dispatch-budget fixture peer.",
    mainModel: { providerID: "ensemble-fake", modelID: "ensemble-fake-model" },
  })
  leaderID = lead.id
  const directory = join(project, "channels", WORKSPACE.name)
  const workspace = await invoke("workspace.create", {
    name: WORKSPACE.name,
    directory,
    memberIDs: [lead.id, peer.id],
    leaderID: lead.id,
    synthesis: false,
  })
  workspaceID = workspace.id
  await sleep(2_000)

  const scenarios = []
  scenarios.push(await runScenario({
    chain: "five",
    total: 5,
    expectedHops: 5,
    expectedGroups: 1,
    groupMaxHops: 8,
    commandMaxHops: 24,
    continuations: 2,
    expectContinuation: false,
    expectCommandStop: false,
  }))
  scenarios.push(await runScenario({
    chain: "nine",
    total: 9,
    expectedHops: 9,
    expectedGroups: 2,
    groupMaxHops: 8,
    commandMaxHops: 24,
    continuations: 2,
    expectContinuation: true,
    expectCommandStop: false,
  }))
  scenarios.push(await runScenario({
    chain: "cap",
    total: 9,
    expectedHops: 8,
    expectedGroups: 1,
    groupMaxHops: 8,
    commandMaxHops: 8,
    continuations: 0,
    expectContinuation: false,
    expectCommandStop: true,
  }))

  const finalState = await snapshot()
  const pendingApprovals = Object.values(finalState.approvals ?? {})
    .filter((approval) => approval.workspaceID === workspaceID && approval.status === "pending")
  const openTasks = Object.values(finalState.subtasks ?? {})
    .filter((task) => task.workspaceID === workspaceID && task.state !== "replied")
  if (pendingApprovals.length !== 0) fail(`budget workspace left ${pendingApprovals.length} pending approval(s)`, failures)
  if (openTasks.length !== 0) fail(`budget workspace left ${openTasks.length} open task(s)`, failures)

  const service = readLogs("service-")
  const starts = service.rows.filter((row) => row.event === "service.start")
  const taskFailed = service.rows.filter((row) => row.event === "task.failed")
  const failureRecords = service.rows.filter((row) => row.cat === "failure")
  if (starts.length !== 1) fail(`expected 1 service.start after the budget location, saw ${starts.length}`, failures)
  if (taskFailed.length !== 0) fail(`expected 0 task.failed after the budget scenarios, saw ${taskFailed.length}`, failures)
  if (failureRecords.length !== 0) fail(`expected 0 failure records after the budget scenarios, saw ${failureRecords.length}`, failures)

  const allScenarios = scenarios.map((scenario) => ({
    name: scenario.name,
    status: scenario.status,
    rootID: scenario.rootID,
    groups: scenario.groups,
    tasks: scenario.tasks,
    hops: scenario.hops,
    consumedRows: scenario.consumedRows,
    distinctConsumedTasks: scenario.distinctConsumedTasks,
    refusedRows: scenario.refusedRows,
    exhaustedRows: scenario.exhaustedRows,
    continuedRows: scenario.continuedRows,
    closedRows: scenario.closedRows,
    dispatchRows: scenario.dispatchRows,
    elapsedMs: scenario.elapsedMs,
    failures: scenario.failures,
  }))
  for (const scenario of scenarios) failures.push(...scenario.failures)

  const summary = {
    status: failures.length === 0 ? "pass" : "fail",
    workspace: {
      name: WORKSPACE.name,
      id: workspaceID,
      leader: { name: WORKSPACE.lead, id: leaderID },
      peer: { name: WORKSPACE.peer, id: peer.id },
      directory,
    },
    scenarios: allScenarios,
    totals: {
      hops: scenarios.reduce((sum, scenario) => sum + (scenario.hops ?? 0), 0),
      consumedRows: scenarios.reduce((sum, scenario) => sum + (scenario.consumedRows ?? 0), 0),
      distinctConsumedTasks: scenarios.reduce((sum, scenario) => sum + (scenario.distinctConsumedTasks ?? 0), 0),
      refusals: scenarios.reduce((sum, scenario) => sum + (scenario.refusedRows?.length ?? 0), 0),
    },
    workspaceState: {
      pendingApprovals: pendingApprovals.length,
      openTasks: openTasks.length,
    },
    service: {
      starts: starts.length,
      taskFailed: taskFailed.length,
      failureRecords: failureRecords.length,
      rows: service.rows.length,
      malformed: service.malformed,
    },
    failures,
  }
  if (out) writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary, null, 2))
  if (failures.length > 0) process.exitCode = 1
}

let leaderID = ""

main().catch((error) => {
  console.error(`dispatch-budgets: ${error?.stack ?? error}`)
  process.exitCode = 1
})
