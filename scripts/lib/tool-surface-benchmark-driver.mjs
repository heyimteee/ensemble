#!/usr/bin/env node
/**
 * Ticket #225 tool-surface benchmark driver.
 *
 * Runs the same peer-coordination operation through the legacy explicit tool
 * surface and the native final-text surface on an isolated fake host. For each
 * surface it records:
 *   - wall-clock from the native prompt to the routed peer reply,
 *   - model round-trips (streaming provider requests in that window),
 *   - tool calls (the fake provider's tool-call fixtures),
 *   - prompt and tool-schema sizes from the provider request body.
 *
 * The fake provider records shapes, sizes, and counts only. This driver never
 * writes conversation content, file bytes, credentials, or absolute paths.
 */
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const url = arg("--url")
const password = arg("--password")
const project = arg("--project")
const out = arg("--out")
const fakeLog = arg("--fake-log")
const client = OpenCode.make({
  baseUrl: url,
  headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") },
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function rpc(method, input) {
  const target = `${url}/api/rpc/ensemble.v2/${method}?location%5Bdirectory%5D=${encodeURIComponent(project)}`
  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`)
  return response.json()
}

async function invoke(action, payload) {
  const value = await rpc("invoke", { directory: project, action, payload })
  const result = value?.output ?? value
  if (!result?.ok) throw new Error(`${action} failed: ${JSON.stringify(result?.error ?? result)}`)
  return result.result
}

async function state() {
  const value = await rpc("diagnostic", { directory: project })
  const result = value?.output ?? value
  if (!result?.state) throw new Error("diagnostic returned no state")
  return result.state
}

async function waitFor(description, predicate, timeoutMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await state()
    if (await predicate(value)) return value
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${description}`)
}

function logRows(since, until) {
  const rows = []
  for (const line of readFileSync(fakeLog, "utf8").split("\n")) {
    if (!line.trim()) continue
    const row = JSON.parse(line)
    const at = Date.parse(row.time)
    if (Number.isFinite(at) && at >= since && at <= until) rows.push(row)
  }
  return rows
}

async function scenario(surface, label) {
  const workspaceDir = join(project, `bench-${surface}`)
  mkdirSync(workspaceDir, { recursive: true })
  const agent = await invoke("agent.create", {
    name: `${label}Agent`,
    role: "Benchmark fixture agent.",
    mainModel: { providerID: "ensemble-fake", modelID: "ensemble-fake-model" },
  })
  const peer = await invoke("agent.create", {
    name: `${label}Peer`,
    role: "Benchmark fixture peer.",
    mainModel: { providerID: "ensemble-fake", modelID: "ensemble-fake-model" },
  })
  const workspace = await invoke("workspace.create", {
    name: `bench-${surface}`,
    directory: workspaceDir,
    memberIDs: [agent.id, peer.id],
    leaderID: agent.id,
  })
  await invoke("settings.update", { nativeFirst: "on", nativeMentionRouting: true, toolSurface: surface })
  // Warm the group binding with an ordinary user turn. It creates the native
  // session; the benchmark window starts after this run settles.
  await invoke("message.send", { workspaceID: workspace.id, text: "Warm up the benchmark binding." })
  await waitFor("the warm-up turn to settle", (snapshot) =>
    Object.values(snapshot.subtasks ?? {}).some((task) => task.assigneeID === agent.id && task.state === "replied"))
  const bound = Object.values((await state()).bindings ?? {}).find(
    (binding) => binding.agentID === agent.id && binding.workspaceID === workspace.id && binding.kind === "workspace",
  )
  if (!bound) throw new Error("the warm-up did not create a workspace binding")

  const marker = `fake-benchmark-${surface}:${peer.name}`
  const startedAt = Date.now()
  await client.session.prompt({ sessionID: bound.sessionID, text: `Coordinate the release. ${marker}` })
  const settled = await waitFor("the routed peer turn to settle", (snapshot) => {
    const tasks = Object.values(snapshot.subtasks ?? {})
    const routed = tasks.find((task) => task.assigneeID === peer.id && task.state === "replied")
    const own = tasks.find((task) => task.origin === "native" && task.assigneeID === agent.id && task.state === "replied")
    return Boolean(routed && own)
  })
  const endedAt = Date.now()
  const rows = logRows(startedAt, endedAt + 100)
  const requests = rows.filter((row) => row.event === "request" && row.stream !== false)
  const senderRequests = requests.filter((row) => String(row.promptTail ?? "").includes(marker))
  const first = senderRequests[0]
  if (!first) throw new Error(`no sender provider request captured for ${surface}`)
  const toolCalls = rows.filter((row) => row.event === "benchmark_tool_call").length
  const routed = Object.values(settled.subtasks ?? {}).find((task) => task.assigneeID === peer.id && task.state === "replied")
  return {
    surface,
    wallClockMs: endedAt - startedAt,
    modelRoundTrips: requests.length,
    senderModelRoundTrips: senderRequests.length,
    toolCalls,
    toolCount: first.toolCount,
    toolSchemaChars: first.toolSchemaChars,
    ensembleToolCount: first.ensembleToolCount,
    ensembleToolSchemaChars: first.ensembleToolSchemaChars,
    ensembleToolSchemaTokens: Math.ceil(first.ensembleToolSchemaChars / 4),
    promptChars: first.promptChars,
    estimatedPromptTokens: first.estimatedPromptTokens,
    turnContextInjected: first.hasTurnContext,
    budgetContextInjected: first.hasBudgetContext,
    routedWorkKind: routed?.workKind,
    routedInstructionPresent: Boolean(routed?.instruction),
    responded: Boolean(routed?.resultMessageID),
  }
}

const result = {
  project: project.replace(/.*\//, "<project>/"),
  scenarios: [
    await scenario("native", "Native"),
    await scenario("legacy", "Legacy"),
  ],
}
if (out) {
  const { writeFileSync } = await import("node:fs")
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`)
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
