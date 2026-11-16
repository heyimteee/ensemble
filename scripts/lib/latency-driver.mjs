#!/usr/bin/env node
// Deterministic patch-card latency fixture.
//
// This driver talks to the isolated Ensemble service over the same public RPC
// surface the TUI uses. For each sample it:
//   1. invokes `task.delegate` (the durable RPC),
//   2. reads the durable `changes.since` patch after that version,
//   3. applies the subtask changes to a client-side state map,
//   4. renders the real Work card with the pure `workCardForTask` mapping,
//   5. cancels the fixture task.
//
// It never waits for a model token, so the measurement is the RPC -> patch ->
// card path, not the fake provider's hold. First-token samples are supplied by
// the shell probe and remain report-only.
//
// Run with `node --experimental-strip-types` because it imports the TUI card
// mapping. Output is counts and timings only; no conversation content, file
// bytes, credentials, or private paths.

import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { workCardForTask } from "../../src/v2/tui/workrows.ts"

const SERVER_URL = process.env.ENSEMBLE_LATENCY_SERVER_URL ?? ""
const SERVER_PASSWORD = process.env.ENSEMBLE_LATENCY_SERVER_PASSWORD ?? ""
const DIRECTORY = process.env.ENSEMBLE_LATENCY_DIRECTORY ?? ""
const AGENT_ID = process.env.ENSEMBLE_LATENCY_AGENT_ID ?? ""
const WORKSPACE_ID = process.env.ENSEMBLE_LATENCY_WORKSPACE_ID ?? ""
const CARD_SAMPLES = positiveInteger(process.env.ENSEMBLE_LATENCY_CARD_SAMPLES, 5)
const REGRESSION_MS = nonNegativeNumber(process.env.ENSEMBLE_LATENCY_REGRESSION_MS, 0)
const PROFILE = process.env.ENSEMBLE_LATENCY_PROFILE ?? "smoke"
const OUTPUT = process.env.ENSEMBLE_LATENCY_OUT ?? ""
const RAIL_SAMPLES = parseSamples(process.env.ENSEMBLE_LATENCY_RAIL_SAMPLES)
const FIRST_TOKEN_SAMPLES = parseSamples(process.env.ENSEMBLE_LATENCY_FIRST_TOKEN_SAMPLES)

for (const [name, value] of [
  ["ENSEMBLE_LATENCY_SERVER_URL", SERVER_URL],
  ["ENSEMBLE_LATENCY_SERVER_PASSWORD", SERVER_PASSWORD],
  ["ENSEMBLE_LATENCY_DIRECTORY", DIRECTORY],
  ["ENSEMBLE_LATENCY_AGENT_ID", AGENT_ID],
  ["ENSEMBLE_LATENCY_WORKSPACE_ID", WORKSPACE_ID],
]) {
  if (!value) fail(`${name} is required`)
}

const AUTH = `Basic ${Buffer.from(`opencode:${SERVER_PASSWORD}`).toString("base64")}`

function fail(message) {
  console.error(`latency-driver: ${message}`)
  process.exit(1)
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === "") return fallback
  if (!/^[1-9][0-9]*$/.test(value)) fail(`expected a positive integer, got ${value}`)
  return Number(value)
}

function nonNegativeNumber(value, fallback) {
  if (value === undefined || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) fail(`expected a non-negative number, got ${value}`)
  return parsed
}

function parseSamples(value) {
  if (!value) return []
  return value.split(",").map((part) => {
    const parsed = Number(part)
    if (!Number.isFinite(parsed) || parsed < 0) fail(`invalid sample ${part}`)
    return parsed
  })
}

function rpcURL(method) {
  return `${SERVER_URL}/api/rpc/ensemble.v2/${method}?location%5Bdirectory%5D=${encodeURIComponent(DIRECTORY)}`
}

async function rpc(method, input) {
  const response = await fetch(rpcURL(method), {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) fail(`${method} returned HTTP ${response.status}`)
  const body = await response.json()
  if (!body || body.output === undefined) fail(`${method} returned no output`)
  return body.output
}

async function snapshot() {
  return rpc("snapshot", { directory: DIRECTORY })
}

async function invoke(action, payload) {
  const output = await rpc("invoke", { directory: DIRECTORY, action, payload })
  if (!output?.ok) fail(`${action} failed: ${output?.error?.code ?? "unknown"}`)
  return output.result
}

async function changesSince(epoch, version) {
  return rpc("changes.since", { directory: DIRECTORY, epoch, version })
}

function applySubtaskChanges(subtasks, changes) {
  for (const entry of changes.entries ?? []) {
    for (const change of entry.entities ?? entry.changes ?? []) {
      if (change.entity !== "subtask") continue
      if (change.op === "upsert" && change.task?.id) subtasks[change.task.id] = change.task
      else if (change.op === "remove" && change.id) delete subtasks[change.id]
    }
  }
}

async function waitForTerminal(taskID, seconds = 5) {
  const deadline = Date.now() + seconds * 1_000
  while (Date.now() < deadline) {
    const state = await snapshot()
    const task = state.state.subtasks[taskID]
    if (!task || task.state === "replied") return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  fail(`fixture task ${taskID} did not settle after cancellation`)
}

async function measureCard(sample, runID) {
  const title = `lc-${runID}-${sample}`
  const before = await snapshot()
  const workspace = before.state.workspaces[WORKSPACE_ID]
  const agent = before.state.agents[AGENT_ID]
  if (!workspace) fail(`workspace ${WORKSPACE_ID} is missing`)
  if (!agent) fail(`agent ${AGENT_ID} is missing`)

  const started = performance.now()
  const task = await invoke("task.delegate", {
    workspaceID: WORKSPACE_ID,
    assigneeID: AGENT_ID,
    title,
    instruction: "latency-patch-card-fixture",
    mode: "research",
  })
  const rpcMs = performance.now() - started
  const taskID = task?.id
  if (!taskID) fail("task.delegate returned no task id")

  let subtasks = { ...before.state.subtasks }
  const changes = await changesSince(before.epoch, before.state.version)
  if (changes.reset) {
    const recovered = await snapshot()
    subtasks = { ...recovered.state.subtasks }
  } else {
    applySubtaskChanges(subtasks, changes)
  }
  const patchedAt = performance.now()
  const patched = subtasks[taskID] ?? Object.values(subtasks).find((item) => item.title === title)
  if (!patched) fail("durable patch did not include the fixture task")
  const card = workCardForTask(patched, agent.name, { now: Date.now(), width: 49 })
  const renderedAt = performance.now()
  if (card.title !== title) fail("Work card did not render the fixture title")

  const measuredMs = renderedAt - started
  const evaluatedMs = Math.round(measuredMs + REGRESSION_MS)
  console.log(
    `latency-driver: patch-card sample=${sample} measuredMs=${measuredMs.toFixed(1)} ` +
      `evaluatedMs=${evaluatedMs} rpcMs=${rpcMs.toFixed(1)} ` +
      `patchMs=${(patchedAt - started).toFixed(1)} renderMs=${(renderedAt - patchedAt).toFixed(1)}`,
  )

  await invoke("task.cancel", { id: taskID })
  await waitForTerminal(taskID)

  return {
    title,
    measuredMs,
    evaluatedMs,
    rpcMs,
    patchMs: patchedAt - started,
    renderMs: renderedAt - patchedAt,
  }
}

async function main() {
  const runID = randomUUID().slice(0, 6)
  const samples = []
  for (let sample = 1; sample <= CARD_SAMPLES; sample += 1) samples.push(await measureCard(sample, runID))

  const result = {
    profile: PROFILE,
    samples: {
      rail: RAIL_SAMPLES,
      patchCard: samples.map((sample) => sample.evaluatedMs),
      firstToken: FIRST_TOKEN_SAMPLES,
    },
    meta: {
      cardSamples: CARD_SAMPLES,
      regressionMs: REGRESSION_MS,
      patchCard: samples,
      firstTokenSamples: FIRST_TOKEN_SAMPLES.length,
    },
  }
  const text = `${JSON.stringify(result, null, 2)}\n`
  if (OUTPUT) writeFileSync(OUTPUT, text)
  else process.stdout.write(text)
}

await main()
