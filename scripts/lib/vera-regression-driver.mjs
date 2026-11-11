#!/usr/bin/env node
/**
 * Ticket #241 Vera regression driver.
 *
 * Runs against the isolated OpenCode host loaded with this worktree's Ensemble
 * plugin and the deterministic fake provider. It proves the native-first
 * cutover end to end without a real model:
 *
 *   seed     create the Vera roster in a real temp workspace, warm the group
 *            binding, and seed a pre-v6 AGENTS.md contract.
 *   run      assert the host migrated an absent persisted nativeFirst to `on`,
 *            assert the generated v6 roster table, drive one leader native turn
 *            that explicitly delegates one member and then `$Name`-mentions
 *            several, and prove the legacy rollback/restore path with the real
 *            `nativeFirstCommand` / `toolsCommand` patches. The TUI key handler
 *            is a thin wrapper over those pure functions and is covered by
 *            `src/v2/tui/commands.test.ts`.
 *   restart  assert durable native turns, the contact ledger, the roster table,
 *            and the no-completion-bounce result survive a host restart.
 *
 * The driver records identities, counts, booleans, lengths, and token/schema
 * metrics only. It never writes prompt text, answer text, file bytes,
 * credentials, or absolute paths to its output.
 *
 * Test infrastructure only; the product plugin never imports this file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { teamRosterTable } from "../../src/v2/init-block.ts"
import { nativeFirstCommand, toolsCommand } from "../../src/v2/tui/commands.ts"

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const url = arg("--url")
const password = arg("--password")
const project = arg("--project")
const phase = arg("--phase", "seed")
const stateFile = arg("--state-file")
const out = arg("--out")
const fakeLog = arg("--fake-log")
const prestartStore = arg("--prestart-store")
const persistedStore = arg("--persisted-store")
if (!url || !password || !project) {
  process.stderr.write("vera-regression-driver: --url, --password, and --project are required\n")
  process.exit(2)
}
if (!stateFile || !out) {
  process.stderr.write("vera-regression-driver: --state-file and --out are required\n")
  process.exit(2)
}

const client = OpenCode.make({
  baseUrl: url,
  headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") },
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")

const SHORT_REPLY = "Onboarding complete. I am ready."
const WARMUP = "vera-warmup-fixture"
const ROLLBACK = "vera-rollback-fixture"
const WORKSPACE_NAME = "VeraProbe"
const FLOWS_WORKSPACE_NAME = "VeraFlows"
const FLOWS_WARMUP = "vera-flows-warmup-fixture"
const FLOW_TICKET_ONE = "fake-vera-flows:ticket=one;mode=relay;dispatch=start;workers=Phoenix,Kakiko,Clark,Juno,Mira,Wren;mentions=Kakiko,Clark"
const FLOW_TICKET_THREE = "fake-vera-flows:ticket=three;mode=refuse;dispatch=start;workers=Phoenix,Kakiko;mentions=Kakiko,Clark"
const FLOW_TICKET_FOUR = "fake-vera-flows:ticket=four;mode=route;dispatch=start;workers=Phoenix;mentions=Clark"
const PROJECT_LINE = "Keep this project-owned line."
const STALE_BLOCK = `<!-- ensemble:start v5 -->\nSTALE V5 CONTRACT\n<!-- ensemble:end -->\n\n# Project-owned\n\n${PROJECT_LINE}\n`
const V6_START = "<!-- ensemble:start v6 -->"
const V6_END = "<!-- ensemble:end -->"

/**
 * Fixture identities are fixed strings, never model-authored. The creation
 * order differs from memberIDs order so the generated table proves both
 * leader-first and memberIDs ordering.
 */
const FIXTURE = [
  { key: "phoenix", name: "Phoenix", title: "Roster Keeper", role: "Keeps the generated team roster exact." },
  { key: "vera", name: "Vera", title: "Vera Lead", role: "Owns the Vera regression and release sign-off." },
  { key: "kakiko", name: "Kakiko", title: "Completion Guard", role: "Checks that no second completion turn reaches the leader." },
  { key: "clark", name: "Clark", title: "Route Checker", role: "Confirms each mentioned member receives exactly one turn." },
  { key: "juno", name: "Juno", title: "Relay Runner", role: "Carries one relay hop without waking the leader." },
  { key: "mira", name: "Mira", title: "Branch Minder", role: "Keeps every fan-out branch terminal before synthesis." },
  { key: "wren", name: "Wren", title: "Terminal Checker", role: "Confirms a terminal turn creates no new work." },
]
// The VeraProbe workspace keeps the original four-member roster so the #241
// assertions stay stable; VeraFlows adds the three relay/fan-out workers.
const MEMBER_ORDER = ["clark", "vera", "kakiko", "phoenix"]
const FLOW_ORDER = ["vera", "phoenix", "kakiko", "clark", "juno", "mira", "wren"]
const LEADER_KEY = "vera"
const DELEGATE_KEY = "phoenix"
const MENTION_KEYS = ["phoenix", "clark", "kakiko"]

const checks = []
const failures = []
const metrics = {}
let stateFileData = { phase }

function check(name, condition, detail) {
  const ok = Boolean(condition)
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  if (!ok) failures.push(name)
  return ok
}

function assert(name, condition, detail) {
  if (!check(name, condition, detail)) throw new Error(`${name}${detail === undefined ? "" : `: ${detail}`}`)
}

async function rpc(method, input, timeoutMs = 120_000) {
  const target = `${url}/api/rpc/ensemble.v2/${method}?location%5Bdirectory%5D=${encodeURIComponent(project)}`
  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(timeoutMs),
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

async function diagnostic() {
  const value = await rpc("diagnostic", { directory: project })
  const result = value?.output ?? value
  if (!result?.state) throw new Error("diagnostic returned no state")
  return result
}

async function state() {
  return (await diagnostic()).state
}

async function logEntries(event, limit = 200) {
  const value = await rpc("logs.recent", { directory: project, event, limit })
  const result = value?.output ?? value
  return Array.isArray(result?.entries) ? result.entries : []
}

async function waitFor(description, predicate, timeoutMs = 60_000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await diagnostic()
    if (await predicate(last.state, last)) return last
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${description} after ${timeoutMs}ms`)
}

async function waitForLog(event, predicate, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const entries = await logEntries(event)
    if (predicate(entries)) return entries
    await sleep(100)
  }
  return logEntries(event)
}

function nativeTask(snapshot, sessionID, inboxID) {
  return Object.values(snapshot.subtasks ?? {}).find(
    (task) => task.origin === "native" && task.native?.sessionID === sessionID && task.native?.inboxID === inboxID,
  )
}

function channelMessages(snapshot, channel) {
  return snapshot.messages?.[channel] ?? []
}

function messageByID(snapshot, channel, id) {
  return channelMessages(snapshot, channel).find((message) => message.id === id)
}

function bindingFor(snapshot, agentID, workspaceID, kind) {
  return Object.values(snapshot.bindings ?? {}).find(
    (binding) => binding.agentID === agentID && binding.kind === kind && (binding.workspaceID ?? "home") === workspaceID,
  )
}

function providerRows() {
  if (!fakeLog) return []
  try {
    return readFileSync(fakeLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function requestMetrics(marker) {
  const row = providerRows().find((entry) => entry.event === "request" && String(entry.promptTail ?? "").includes(marker))
  if (!row) return undefined
  return {
    promptChars: row.promptChars,
    messagesChars: row.messagesChars,
    estimatedPromptTokens: row.estimatedPromptTokens,
    toolCount: row.toolCount,
    ensembleToolCount: row.ensembleToolCount,
    ensembleToolSchemaChars: row.ensembleToolSchemaChars,
    ensembleToolSchemaTokens: Math.ceil(Number(row.ensembleToolSchemaChars ?? 0) / 4),
    turnContextInjected: row.hasTurnContext,
    budgetContextInjected: row.hasBudgetContext,
  }
}

function streamingRequestsBetween(started, ended) {
  return providerRows().filter((entry) => {
    if (entry.event !== "request" || entry.stream === false) return false
    const at = Date.parse(entry.time)
    return Number.isFinite(at) && at >= started && at <= ended
  })
}

/** Ticket #251: one structured fake-provider row per flow turn, counts only. */
function flowMetrics(ticket, role) {
  const row = providerRows().find(
    (entry) => entry.event === "vera_flow" && entry.ticket === ticket && entry.role === role && entry.hasToolResult !== true,
  )
  if (!row) return undefined
  return {
    latestUserChars: row.latestUserChars,
    synthesisContextChars: row.synthesisContextChars,
    promptChars: row.promptChars,
    messagesChars: row.messagesChars,
    estimatedPromptTokens: row.estimatedPromptTokens,
    toolCount: row.toolCount,
    ensembleToolCount: row.ensembleToolCount,
    ensembleToolSchemaChars: row.ensembleToolSchemaChars,
    ensembleToolSchemaTokens: Math.ceil(Number(row.ensembleToolSchemaChars ?? 0) / 4),
    hasRootRequest: row.hasRootRequest,
    hasBranchResults: row.hasBranchResults,
  }
}

function toolSurfaceMetrics(count) {
  const row = providerRows().find(
    (entry) => entry.event === "request" && Number(entry.ensembleToolCount) === count && Number(entry.ensembleToolSchemaChars) > 0,
  )
  if (!row) return { count }
  return {
    count,
    chars: row.ensembleToolSchemaChars,
    tokens: Math.ceil(Number(row.ensembleToolSchemaChars) / 4),
  }
}

function tasksInGroup(snapshot, groupID) {
  return Object.values(snapshot.subtasks ?? {}).filter((task) => task.dispatchGroupID === groupID)
}

function leaderMessagesFor(snapshot, channel, leaderID, taskID) {
  return channelMessages(snapshot, channel).filter(
    (message) => message.author === "agent" && message.agentID === leaderID && message.taskID === taskID,
  )
}

function terminalNoticeFor(snapshot, channel, taskID) {
  return channelMessages(snapshot, channel).some(
    (message) =>
      message.author === "system" &&
      message.taskID === taskID &&
      String(message.text ?? "").includes("No work was created from mentions in a terminal turn"),
  )
}

function ticketMetrics(snapshot, root, leaderID, channel) {
  const tasks = tasksInGroup(snapshot, root.dispatchGroupID)
  const result = root.resultMessageID ? messageByID(snapshot, channel, root.resultMessageID) : undefined
  const leaderMessages = leaderMessagesFor(snapshot, channel, leaderID, root.id)
  return {
    rootTaskID: root.id,
    dispatchGroupID: root.dispatchGroupID,
    tasks: tasks.length,
    leaderTasks: tasks.filter((task) => task.assigneeID === leaderID).length,
    workerTurns: tasks.filter((task) => task.assigneeID !== leaderID && task.handoff?.completion !== true).length,
    completionTasks: tasks.filter((task) => task.handoff?.completion === true).length,
    leaderMessages: leaderMessages.length,
    leaderOutputChars: String(result?.text ?? "").length,
    leaderOutputTokens: Math.ceil(String(result?.text ?? "").length / 4),
  }
}

function relayChain(snapshot, root) {
  const chain = [root]
  let current = root
  for (;;) {
    const child = Object.values(snapshot.subtasks ?? {}).find(
      (task) => task.parentID === current.id && String(task.instruction ?? "").includes("fake-vera-relay:chain="),
    )
    if (!child) break
    chain.push(child)
    current = child
  }
  return chain.slice(1)
}

async function waitForCommandRoot(workspaceID, title, timeoutMs = 120_000) {
  const settled = await waitFor(`the ${title} command root synthesis`, async (next) => {
    const root = Object.values(next.subtasks ?? {}).find(
      (task) => task.workspaceID === workspaceID && task.title === title && !task.parentID,
    )
    return root?.stage === "synthesis" && root.state === "replied"
  }, timeoutMs)
  return settled.state
}

async function sendFlowKickoff(sessionID, marker) {
  const inbox = await promptNative(sessionID, marker)
  const settled = await waitFor("the flow kickoff native turn", async (next) => {
    const task = nativeTask(next, sessionID, inbox.id)
    return task?.native?.phase === "replied"
  }, 120_000)
  return settled.state
}

function commandRoot(snapshot, workspaceID, title) {
  return Object.values(snapshot.subtasks ?? {}).find(
    (task) => task.workspaceID === workspaceID && task.title === title && !task.parentID,
  )
}

async function promptNative(sessionID, text, extra = {}) {
  const inbox = await client.session.prompt({ sessionID, text, ...extra })
  if (!inbox?.id) throw new Error("native prompt did not return an inbox id")
  return inbox
}

function readAgents(workspaceDir) {
  const path = join(workspaceDir, "AGENTS.md")
  return existsSync(path) ? readFileSync(path, "utf8") : ""
}

function ensembleBlockText(content) {
  const start = content.indexOf("<!-- ensemble:start")
  const end = content.indexOf(V6_END)
  if (start < 0 || end < 0 || end < start) return undefined
  return content.slice(start, end + V6_END.length)
}

function rosterTableFrom(content) {
  const lines = content.split("\n")
  const start = lines.findIndex((line) => line.trim() === "## Team roster")
  if (start < 0) return undefined
  const table = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.startsWith("## ")) break
    if (line.startsWith("|")) table.push(line)
  }
  return table
}

function expectedRosterTable(saved) {
  // Ticket #238/#241: the expected table is the product renderer's exact
  // output, so escaping cannot drift between the harness and the contract.
  // The separate ordering assertion below still catches a product ordering
  // bug that this comparison would otherwise mirror.
  const agents = Object.fromEntries(saved.memberIDs.map((id) => [id, {
    name: saved.agentNames[id],
    title: saved.agentTitles[id],
    role: saved.agentRoles[id],
  }]))
  return teamRosterTable({
    leaderID: saved.leaderID,
    memberIDs: saved.memberIDs,
    agents,
  }).split("\n")
}

/** Member names in rendered row order, parsed independently of the renderer. */
function rosterMemberNames(table) {
  return (table ?? []).slice(2).map((line) => {
    const cell = line.replace(/^\| /, "").split(" | ")[0]
    return cell.replace(/^\*\*/, "").replace(/\*\* \(leader\)$/, "")
  })
}

function expectedRosterNames(saved) {
  return [saved.leaderID, ...saved.memberIDs.filter((id) => id !== saved.leaderID)].map((id) => saved.agentNames[id])
}

function withoutRosterSection(block) {
  const lines = block.split("\n")
  const start = lines.findIndex((line) => line.trim() === "## Team roster")
  if (start < 0) return block
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "))
  if (end < 0) return block
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n")
}

function size(text) {
  return { chars: text.length, estimatedTokens: Math.ceil(text.length / 4) }
}

function saveState() {
  writeFileSync(stateFile, `${JSON.stringify(stateFileData, null, 2)}\n`)
}

/** Seed one real temp workspace and the pre-v6 contract. */
async function seed() {
  const workspaceDir = join(project, "vera-workspace")
  mkdirSync(workspaceDir, { recursive: true })

  const created = {}
  for (const member of FIXTURE) {
    created[member.key] = await invoke("agent.create", {
      name: member.name,
      title: member.title,
      role: member.role,
      mainModel: { providerID: "ensemble-fake", modelID: "ensemble-fake-model" },
    })
  }
  const memberIDs = MEMBER_ORDER.map((key) => created[key].id)
  const leaderID = created[LEADER_KEY].id
  const workspace = await invoke("workspace.create", {
    name: WORKSPACE_NAME,
    directory: workspaceDir,
    memberIDs,
    leaderID,
  })

  let snapshot = await state()
  let groupBinding = bindingFor(snapshot, leaderID, workspace.id, "workspace")
  if (!groupBinding?.sessionID) {
    await invoke("message.send", {
      workspaceID: workspace.id,
      text: WARMUP,
      recipientIDs: [leaderID],
    })
    const warmed = await waitFor("the Vera group binding after warm-up", async (next) => {
      const task = Object.values(next.subtasks ?? {}).find(
        (item) => item.instruction === WARMUP && item.state === "replied",
      )
      return Boolean(task && bindingFor(next, leaderID, workspace.id, "workspace")?.sessionID)
    }, 60_000)
    snapshot = warmed.state
    groupBinding = bindingFor(snapshot, leaderID, workspace.id, "workspace")
  }
  assert("seed creates the group binding", Boolean(groupBinding?.sessionID))

  // Ticket #251: a second workspace runs the relay, fan-out, terminal-turn,
  // multi-ticket, refused-dispatch, and worker-route flows. It shares the
  // roster but keeps its own channel and group session so the #241 assertions
  // stay scoped to VeraProbe.
  const flowsWorkspaceDir = join(project, "vera-flows")
  mkdirSync(flowsWorkspaceDir, { recursive: true })
  const flowMemberIDs = FLOW_ORDER.map((key) => created[key].id)
  const flowsWorkspace = await invoke("workspace.create", {
    name: FLOWS_WORKSPACE_NAME,
    directory: flowsWorkspaceDir,
    memberIDs: flowMemberIDs,
    leaderID,
  })
  let flowsGroupBinding = bindingFor(snapshot, leaderID, flowsWorkspace.id, "workspace")
  if (!flowsGroupBinding?.sessionID) {
    await invoke("message.send", {
      workspaceID: flowsWorkspace.id,
      text: FLOWS_WARMUP,
      recipientIDs: [leaderID],
    })
    const warmed = await waitFor("the VeraFlows group binding after warm-up", async (next) => {
      const task = Object.values(next.subtasks ?? {}).find(
        (item) => item.instruction === FLOWS_WARMUP && item.state === "replied",
      )
      return Boolean(task && bindingFor(next, leaderID, flowsWorkspace.id, "workspace")?.sessionID)
    }, 60_000)
    snapshot = warmed.state
    flowsGroupBinding = bindingFor(snapshot, leaderID, flowsWorkspace.id, "workspace")
  }
  assert("seed creates the flows group binding", Boolean(flowsGroupBinding?.sessionID))

  // A pre-v6 initialized workspace: the next service reconciliation must
  // rewrite exactly this stale block to v6 with the generated roster.
  mkdirSync(join(workspaceDir, ".ensemble"), { recursive: true })
  writeFileSync(join(workspaceDir, ".ensemble", "init.json"), `${JSON.stringify({ version: 5 }, null, 2)}\n`)
  writeFileSync(join(workspaceDir, "AGENTS.md"), STALE_BLOCK)

  const agentNames = Object.fromEntries(FIXTURE.map((member) => [created[member.key].id, member.name]))
  const agentTitles = Object.fromEntries(FIXTURE.map((member) => [created[member.key].id, member.title]))
  const agentRoles = Object.fromEntries(FIXTURE.map((member) => [created[member.key].id, member.role]))
  stateFileData = {
    phase: "seed",
    leadID: leaderID,
    agentIDs: Object.fromEntries(FIXTURE.map((member) => [member.key, created[member.key].id])),
    agentNames,
    agentTitles,
    agentRoles,
    workspaceID: workspace.id,
    workspaceDir,
    workspaceChannel: workspace.id,
    groupSessionID: groupBinding.sessionID,
    memberIDs,
    flowsWorkspaceID: flowsWorkspace.id,
    flowsWorkspaceDir,
    flowsChannel: flowsWorkspace.id,
    flowsGroupSessionID: flowsGroupBinding.sessionID,
    flowsMemberIDs: flowMemberIDs,
    leaderID,
  }
  metrics.seed = {
    agents: FIXTURE.length,
    memberIDs: memberIDs.length,
    groupBinding: true,
    warmupSettled: true,
    flowsGroupBinding: true,
    flowsWarmupSettled: true,
  }
  saveState()
}

/** Assert the generated contract and run the one leader native turn. */
async function run() {
  const saved = JSON.parse(readFileSync(stateFile, "utf8"))
  stateFileData = saved
  assert("run has the seed scenario state", Boolean(saved.leaderID && saved.workspaceID && saved.groupSessionID))

  if (prestartStore) {
    const prestart = JSON.parse(readFileSync(prestartStore, "utf8"))
    assert("the upgrade store carried a persisted nativeFirst before the fixture", prestart.hadNativeFirst === true)
    assert("the upgrade store fixture removed nativeFirst", Number(prestart.removed) > 0)
    assert("the pre-restart store has no persisted nativeFirst", prestart.absent === true)
  }
  if (persistedStore) {
    const persisted = JSON.parse(readFileSync(persistedStore, "utf8"))
    assert("the restarted store persisted nativeFirst on", persisted.nativeFirst === "on")
  }

  const diag = await diagnostic()
  assert("the effective mode is on after the host restart", diag.state.settings.nativeFirst === "on")
  const binding = await invoke("agent.sessionBinding", {
    agentID: saved.leaderID,
    workspaceID: saved.workspaceID,
    conversation: "workspace",
  })
  assert("the runtime binding reports native-first on", binding.mode === "on")
  const modeLogs = await logEntries("native.mode")
  assert(
    "the service logged the persisted default migration",
    modeLogs.some((entry) => entry.mode === "on" && entry.migrated === true),
  )

  // Wait for the restart reconciliation to rewrite the stale v5 block.
  await waitFor("the v6 AGENTS.md contract", async () => readAgents(saved.workspaceDir).includes(V6_START), 30_000)
  const content = readAgents(saved.workspaceDir)
  const block = ensembleBlockText(content)
  const table = rosterTableFrom(content)
  const expected = expectedRosterTable(saved)
  assert("the workspace AGENTS.md carries one v6 block", Boolean(block) && (content.match(/<!-- ensemble:start/g) ?? []).length === 1)
  assert("the generated roster table is exact", JSON.stringify(table) === JSON.stringify(expected))
  assert(
    "the roster table lists active members leader-first in memberIDs order",
    JSON.stringify(rosterMemberNames(table)) === JSON.stringify(expectedRosterNames(saved)),
  )
  assert("the project-owned content outside the block is preserved", content.includes(PROJECT_LINE) && !content.includes("STALE V5 CONTRACT"))
  const genericBlock = block ? withoutRosterSection(block) : undefined
  const tableText = (table ?? []).join("\n")
  metrics.agentsBlock = {
    version: 6,
    block: size(block ?? ""),
    generic: size(genericBlock ?? ""),
    rosterTable: size(tableText),
    fixedV6Filled12: { chars: 5667, estimatedTokens: 1417 },
    deltaCharsVsFixedV6Filled12: (block?.length ?? 0) - 5667,
    deltaTokensVsFixedV6Filled12: Math.ceil((block?.length ?? 0) / 4) - 1417,
  }

  // The native surface deliberately omits the explicit migration tools. Use
  // the documented `:tools legacy` override while keeping native-first on so
  // one real native turn can call `ensemble_delegate`; the service still owns
  // ingestion, routing, the contact ledger, and completion.
  const explicitOverride = toolsCommand(["legacy"])
  assert("the :tools legacy command validates", explicitOverride.ok)
  await invoke("settings.update", explicitOverride.patch)
  let snapshot = await state()
  assert("the explicit-tool override keeps the mode on", snapshot.settings.nativeFirst === "on" && snapshot.settings.toolSurface === "legacy")

  const before = new Set(Object.keys(snapshot.subtasks ?? {}))
  const delegateName = saved.agentNames[saved.agentIDs[DELEGATE_KEY]]
  const mentionNames = MENTION_KEYS.map((key) => saved.agentNames[saved.agentIDs[key]])
  const marker = `fake-vera-regression:delegate=${delegateName};mentions=${mentionNames.join(",")}`
  const inbox = await promptNative(saved.groupSessionID, marker)
  const started = Date.now()

  const settled = await waitFor("the Vera turn and every routed member", async (next) => {
    const own = nativeTask(next, saved.groupSessionID, inbox.id)
    if (own?.native?.phase !== "replied" || !own.resultMessageID) return false
    const created = Object.values(next.subtasks ?? {}).filter((task) => !before.has(task.id) && task.id !== own.id)
    const expectedKeys = ["phoenix", "clark", "kakiko"]
    return expectedKeys.every((key) => {
      const id = saved.agentIDs[key]
      return created.some((task) => task.assigneeID === id && task.state === "replied")
    })
  }, 90_000)
  await sleep(250)
  snapshot = (await diagnostic()).state
  const elapsed = Date.now() - started

  const own = nativeTask(snapshot, saved.groupSessionID, inbox.id)
  assert("the leader turn is one native turn", Boolean(own) && own.origin === "native" && own.workKind === "turn")
  assert("the leader turn settles replied exactly once", own.native?.phase === "replied" && own.state === "replied" && Boolean(own.native?.settledAt))
  assert(
    "the leader turn records one successful execution event",
    (own.native?.events ?? []).filter((event) => event.type === "session.execution.succeeded").length === 1,
  )
  assert("the leader turn uses the workspace channel", own.conversationID === saved.workspaceChannel)

  const created = Object.values(snapshot.subtasks ?? {}).filter((task) => !before.has(task.id) && task.id !== own.id)
  const byKey = Object.fromEntries(
    ["phoenix", "clark", "kakiko"].map((key) => {
      const id = saved.agentIDs[key]
      return [key, created.filter((task) => task.assigneeID === id)]
    }),
  )
  assert("the delegated recipient has exactly one work item", byKey.phoenix.length === 1)
  assert("the delegated recipient work item is the explicit delegation", byKey.phoenix[0]?.workKind === "delegation")
  assert("the delegated recipient has no duplicate peer turn", created.filter((task) => task.assigneeID === saved.agentIDs.phoenix && task.workKind === "turn").length === 0)
  assert("the first mentioned member has exactly one turn", byKey.clark.length === 1 && byKey.clark[0]?.workKind === "turn")
  assert("the second mentioned member has exactly one turn", byKey.kakiko.length === 1 && byKey.kakiko[0]?.workKind === "turn")
  assert(
    "every routed member shares the leader turn dispatch group",
    created.every((task) => task.dispatchGroupID === own.dispatchGroupID),
  )
  assert(
    "every routed member is parented to the leader turn",
    created.every((task) => task.parentID === own.id),
  )
  assert("the final text created no other work", created.length === 3)

  const contacted = own.native?.contacted ?? []
  assert("the contact ledger records all three recipients once", contacted.length === 3)
  assert(
    "the contact ledger records the explicit recipient and the final-text routes",
    ["phoenix", "clark", "kakiko"].every((key) => contacted.includes(saved.agentIDs[key])),
  )
  const suppressed = await waitForLog("native.route.suppressed", (entries) =>
    entries.some((entry) => entry.turnID === own.id && entry.agentID === saved.agentIDs.phoenix && entry.reason === "already-routed"))
  assert(
    "the explicit recipient is suppressed as already contacted",
    suppressed.some((entry) => entry.turnID === own.id && entry.agentID === saved.agentIDs.phoenix && entry.reason === "already-routed"),
  )
  const contacts = await waitForLog("native.contact.recorded", (entries) =>
    entries.some((entry) => entry.turnID === own.id && entry.recipientID === saved.agentIDs.phoenix && entry.source === "delegation"))
  assert(
    "the delegation recorded the explicit recipient on the turn",
    contacts.some((entry) => entry.turnID === own.id && entry.recipientID === saved.agentIDs.phoenix && entry.source === "delegation"),
  )

  const messages = channelMessages(snapshot, saved.workspaceChannel)
  const userRows = messages.filter((message) => message.author === "user" && message.taskID === own.id)
  const agentRows = messages.filter((message) => message.author === "agent" && message.taskID === own.id)
  assert("the leader turn has one user row", userRows.length === 1)
  assert("the leader turn has one final agent row", agentRows.length === 1 && agentRows[0].id === own.resultMessageID)
  assert("the final agent row is not streaming", agentRows[0].streaming !== true && String(agentRows[0].text ?? "").length > 0)
  assert(
    "the leader receives no second completion turn",
    Object.values(snapshot.subtasks ?? {}).filter((task) => task.assigneeID === saved.leaderID && task.id !== own.id && task.handoff?.completion === true).length === 0,
  )
  assert(
    "no completion work was assigned to the leader after the turn",
    created.filter((task) => task.assigneeID === saved.leaderID).length === 0,
  )
  const completionSkips = await waitForLog("completion.skipped", (entries) =>
    entries.some((entry) => entry.reason === "parent-is-leader") && entries.filter((entry) => entry.reason === "asker-is-leader").length >= 2)
  assert(
    "the delegation completion skip is logged for the leader parent",
    completionSkips.some((entry) => entry.taskID === byKey.phoenix[0]?.id && entry.reason === "parent-is-leader" && entry.leaderID === saved.leaderID),
  )
  assert(
    "the peer-turn completion skips are logged for the leader asker",
    completionSkips.filter((entry) => entry.reason === "asker-is-leader" && entry.leaderID === saved.leaderID).length >= 2,
  )
  assert(
    "the completion guard created no completion task anywhere",
    Object.values(snapshot.subtasks ?? {}).filter((task) => task.handoff?.completion === true).length === 0,
  )

  const leaderAgentRows = messages.filter(
    (message) => message.author === "agent" && message.agentID === saved.leaderID && message.createdAt >= own.createdAt,
  )
  assert("the leader authored one turn row only", leaderAgentRows.length === 1 && leaderAgentRows[0].id === own.resultMessageID)
  metrics.veraTurn = {
    latencyMs: elapsed,
    parentTaskID: own.id,
    contacted: contacted.length,
    newTasks: created.length,
    routes: { phoenix: byKey.phoenix.length, clark: byKey.clark.length, kakiko: byKey.kakiko.length },
    suppressedAlreadyRouted: suppressed.filter((entry) => entry.reason === "already-routed").length,
    completionSkips: completionSkips.length,
    finalChars: String(agentRows[0]?.text ?? "").length,
    successEvents: (own.native?.events ?? []).filter((event) => event.type === "session.execution.succeeded").length,
    ...(requestMetrics(marker) ?? {}),
  }

  // --- rollback: :native-first off plus :tools legacy -----------------------
  // The driver applies the exact validated patches the TUI commands produce.
  // The TUI key handler is a thin wrapper over these pure functions and is
  // covered by src/v2/tui/commands.test.ts.
  const nativeBefore = Object.values(snapshot.subtasks ?? {}).filter((task) => task.origin === "native").length
  const ledgerBefore = [...(own.native?.contacted ?? [])]
  const phoenixBefore = Object.values(snapshot.subtasks ?? {}).filter((task) => task.assigneeID === saved.agentIDs.phoenix).length
  const offPatch = nativeFirstCommand(["off"])
  const legacyPatch = toolsCommand(["legacy"])
  assert("the :native-first off command validates", offPatch.ok)
  assert("the :tools legacy command validates", legacyPatch.ok)
  await invoke("settings.update", offPatch.patch)
  await invoke("settings.update", legacyPatch.patch)
  snapshot = await state()
  assert("rollback stores nativeFirst off and the legacy tool surface", snapshot.settings.nativeFirst === "off" && snapshot.settings.toolSurface === "legacy")
  const offBinding = await invoke("agent.sessionBinding", {
    agentID: saved.leaderID,
    workspaceID: saved.workspaceID,
    conversation: "workspace",
  })
  assert("rollback reports the off mode", offBinding.mode === "off")
  const rollbackStarted = Date.now()
  const sent = await invoke("message.send", { workspaceID: saved.workspaceID, text: ROLLBACK, recipientIDs: [saved.leaderID] })
  assert("the legacy send is accepted", Array.isArray(sent?.recipients) && sent.recipients.includes(saved.leaderID))
  const legacySettled = await waitFor("the legacy rollback task", async (next) =>
    Object.values(next.subtasks ?? {}).some((task) => task.instruction === ROLLBACK && task.state === "replied"), 60_000)
  const legacyTask = Object.values(legacySettled.state.subtasks ?? {}).find((task) => task.instruction === ROLLBACK)
  assert("the legacy task replied on the old path", legacyTask.state === "replied" && legacyTask.origin !== "native")
  const legacyRequests = streamingRequestsBetween(rollbackStarted, Date.now() + 500)
  assert("the legacy path registered the full 11-tool surface", legacyRequests.some((entry) => Number(entry.ensembleToolCount ?? 0) === 11))

  const onPatch = nativeFirstCommand(["on"])
  const nativePatch = toolsCommand(["native"])
  assert("the :native-first on command validates", onPatch.ok)
  assert("the :tools native command validates", nativePatch.ok)
  await invoke("settings.update", onPatch.patch)
  await invoke("settings.update", nativePatch.patch)
  snapshot = await state()
  assert("restoring on/native keeps the mode on", snapshot.settings.nativeFirst === "on" && snapshot.settings.toolSurface === "native")
  const restoredBinding = await invoke("agent.sessionBinding", {
    agentID: saved.leaderID,
    workspaceID: saved.workspaceID,
    conversation: "workspace",
  })
  assert("restoring on/native reports the on mode", restoredBinding.mode === "on")
  const restoredParent = snapshot.subtasks[own.id]
  assert("the parent native turn survives the rollback", restoredParent?.native?.phase === "replied" && restoredParent.resultMessageID === own.resultMessageID)
  assert("the contact ledger survives the rollback", JSON.stringify(restoredParent.native?.contacted ?? []) === JSON.stringify(ledgerBefore))
  const nativeAfter = Object.values(snapshot.subtasks ?? {}).filter((task) => task.origin === "native").length
  assert("rollback and restore preserve every durable native turn", nativeAfter === nativeBefore)
  assert(
    "restoring keeps one work item for the explicit recipient",
    Object.values(snapshot.subtasks ?? {}).filter((task) => task.assigneeID === saved.agentIDs.phoenix).length === phoenixBefore,
  )
  metrics.rollback = {
    legacyTaskReplied: legacyTask.state === "replied",
    legacyEnsembleToolCount: Number(legacyRequests.find((entry) => Number(entry.ensembleToolCount ?? 0) === 11)?.ensembleToolCount ?? 0),
    nativeTurnsPreserved: nativeAfter === nativeBefore,
    ledgerPreserved: JSON.stringify(restoredParent.native?.contacted ?? []) === JSON.stringify(ledgerBefore),
    commands: {
      off: offPatch.ok,
      legacy: legacyPatch.ok,
      on: onPatch.ok,
      native: nativePatch.ok,
    },
  }

  stateFileData.phase = "run"
  stateFileData.parentTaskID = own.id
  stateFileData.parentResultMessageID = own.resultMessageID
  stateFileData.contacted = [...(restoredParent.native?.contacted ?? [])]
  // Scope the #241 durability counts to VeraProbe: the VeraFlows warm-up and
  // ticket #251 scenarios live in a second workspace.
  stateFileData.nativeCount = Object.values(snapshot.subtasks ?? {}).filter(
    (task) => task.workspaceID === saved.workspaceID && task.origin === "native",
  ).length
  stateFileData.ledgerBefore = ledgerBefore
  stateFileData.phoenixTaskCount = phoenixBefore
  stateFileData.legacyTaskID = legacyTask.id
  stateFileData.taskCount = Object.values(snapshot.subtasks ?? {}).filter(
    (task) => task.workspaceID === saved.workspaceID,
  ).length
  stateFileData.agentsBlock = metrics.agentsBlock
  saveState()
}

/**
 * Ticket #251: the live relay, fan-out, terminal-turn, multi-ticket,
 * refused-dispatch, and worker-route flows. Every command root is leader-owned
 * through `ensemble_dispatch`, so the completion guard skips every worker
 * completion and the root is the only synthesis turn.
 */
async function flows() {
  const saved = JSON.parse(readFileSync(stateFile, "utf8"))
  stateFileData = saved
  assert(
    "flows has the seed scenario state",
    Boolean(saved.flowsWorkspaceID && saved.flowsGroupSessionID && saved.flowsChannel && saved.leaderID),
  )
  const diag = await diagnostic()
  assert(
    "flows starts on the native surface",
    diag.state.settings.nativeFirst === "on" && diag.state.settings.toolSurface === "native",
  )
  const workspaceID = saved.flowsWorkspaceID
  const channel = saved.flowsChannel
  const leaderID = saved.leaderID
  const agentIDs = saved.agentIDs

  // --- ticket one: five-hop relay + terminal continuation dispatch ---------
  await sendFlowKickoff(saved.flowsGroupSessionID, FLOW_TICKET_ONE)
  let snapshot = await waitForCommandRoot(workspaceID, "Ticket one")
  let root = commandRoot(snapshot, workspaceID, "Ticket one")
  assert("ticket one is a parentless leader command root", Boolean(root) && root.parentID === undefined && root.assigneeID === leaderID)
  const relay = relayChain(snapshot, root)
  assert("ticket one relay has six worker turns", relay.length === 6, String(relay.length))
  assert(
    "ticket one relay runs the five named hops",
    JSON.stringify(relay.map((task) => saved.agentNames[task.assigneeID])) ===
      JSON.stringify(["Phoenix", "Kakiko", "Clark", "Juno", "Mira", "Wren"]),
    JSON.stringify(relay.map((task) => saved.agentNames[task.assigneeID])),
  )
  assert(
    "ticket one has no completion work",
    tasksInGroup(snapshot, root.dispatchGroupID).every((task) => task.handoff?.completion !== true),
  )
  assert(
    "ticket one has exactly one synthesis task",
    tasksInGroup(snapshot, root.dispatchGroupID).filter((task) => task.stage === "synthesis").length === 1,
  )
  const one = ticketMetrics(snapshot, root, leaderID, channel)
  assert("ticket one has one leader synthesis turn", one.leaderTasks === 1 && one.leaderMessages === 1, JSON.stringify(one))
  const oneSynthesis = flowMetrics("one", "synthesis")
  assert(
    "ticket one synthesis carries the root request and branch digest",
    oneSynthesis?.hasRootRequest === true && oneSynthesis?.hasBranchResults === true,
  )
  const oneSuppressed = (await logEntries("native.route.suppressed", 500)).filter(
    (entry) => entry.turnID === root.id && entry.reason === "terminal-turn",
  )
  assert("ticket one terminal mentions create no peer turns", oneSuppressed.length === 2, String(oneSuppressed.length))
  assert("ticket one dispatched, so it posts no terminal notice", !terminalNoticeFor(snapshot, channel, root.id))
  const dispatchLogs = await logEntries("dispatch.command.created", 100)
  const ticketTwoDispatch = dispatchLogs.find((entry) => entry.originTaskID === root.id)
  assert("ticket one's terminal turn dispatches ticket two", Boolean(ticketTwoDispatch) && ticketTwoDispatch.assignmentCount === 5)

  // --- ticket two: five-way fan-out, fresh command root, one synthesis ------
  snapshot = await waitForCommandRoot(workspaceID, "Ticket two")
  root = commandRoot(snapshot, workspaceID, "Ticket two")
  assert("ticket two is a parentless leader command root", Boolean(root) && root.parentID === undefined && root.assigneeID === leaderID)
  assert("ticket two is a new command, not a child of ticket one", root.dispatchGroupID !== one.dispatchGroupID)
  assert("ticket two is the dispatched root", root.id === ticketTwoDispatch?.rootTaskID)
  const twoGroup = snapshot.dispatchGroups[root.dispatchGroupID]
  assert("ticket two has a fresh command budget", Boolean(twoGroup) && twoGroup.rootID === root.dispatchGroupID && twoGroup.usedHops === 5 && twoGroup.commandUsedHops === 5 && twoGroup.maxHops === 8 && twoGroup.commandMaxHops === 24, JSON.stringify(twoGroup))
  const two = ticketMetrics(snapshot, root, leaderID, channel)
  assert("ticket two has five fan-out worker turns", two.workerTurns === 5, String(two.workerTurns))
  assert("ticket two has one leader synthesis turn", two.leaderTasks === 1 && two.leaderMessages === 1, JSON.stringify(two))
  assert("ticket two has no per-child completion review", two.completionTasks === 0)
  assert(
    "ticket two creates no peer turns from the synthesis",
    tasksInGroup(snapshot, root.dispatchGroupID).every((task) => task.workKind !== "turn"),
  )
  assert("ticket two posts the visible terminal notice", terminalNoticeFor(snapshot, channel, root.id))
  const twoSuppressed = (await logEntries("native.route.suppressed", 500)).filter(
    (entry) => entry.turnID === root.id && entry.reason === "terminal-turn",
  )
  assert("ticket two terminal mentions are references", twoSuppressed.length === 5, String(twoSuppressed.length))
  const twoTerminal = (await logEntries("native.route.terminal", 100)).find((entry) => entry.turnID === root.id)
  assert("ticket two terminal turn reports no dispatch", Boolean(twoTerminal) && twoTerminal.count === 5 && twoTerminal.dispatched !== true)
  const twoSynthesis = flowMetrics("two", "synthesis")
  assert(
    "ticket two synthesis carries the root request and branch digest",
    twoSynthesis?.hasRootRequest === true && twoSynthesis?.hasBranchResults === true,
  )

  // --- ticket three: refused dispatch at the command cap --------------------
  await invoke("settings.update", {
    dispatchGroupMaxHops: 8,
    dispatchCommandMaxHops: 8,
    dispatchDepth: 8,
    dispatchContinuations: 0,
  })
  await sendFlowKickoff(saved.flowsGroupSessionID, FLOW_TICKET_THREE)
  snapshot = await waitForCommandRoot(workspaceID, "Ticket three")
  root = commandRoot(snapshot, workspaceID, "Ticket three")
  assert("ticket three is a parentless leader command root", Boolean(root) && root.parentID === undefined && root.assigneeID === leaderID)
  const three = ticketMetrics(snapshot, root, leaderID, channel)
  assert("ticket three has one leader synthesis turn", three.leaderTasks === 1 && three.leaderMessages === 1, JSON.stringify(three))
  assert("ticket three has no completion work", three.completionTasks === 0)
  const refusedBatch = Object.values(snapshot.subtasks ?? {}).filter((task) =>
    String(task.instruction ?? "").includes("fake-vera-fanout:ticket=three;worker="),
  )
  assert("the refused dispatch creates no work", refusedBatch.length === 0, String(refusedBatch.length))
  const refusalCopy = channelMessages(snapshot, channel).find(
    (message) =>
      message.author === "system" &&
      String(message.text ?? "").startsWith("Dispatch refused:") &&
      String(message.text ?? "").includes("the command budget is exhausted (9/8 hops)") &&
      String(message.text ?? "").includes("Ask the user to start a new command"),
  )
  assert("the command-cap refusal is visible in the group chat", Boolean(refusalCopy))
  const refusalLog = (await logEntries("dispatch.command.refused", 100)).find((entry) => entry.originTaskID === root.id)
  assert(
    "the command-cap refusal names the command layer",
    Boolean(refusalLog) && refusalLog.layer === "command" && refusalLog.used === 9 && refusalLog.max === 8,
    JSON.stringify(refusalLog ?? {}),
  )
  assert("ticket three posts the visible terminal notice", terminalNoticeFor(snapshot, channel, root.id))
  const threeSynthesis = flowMetrics("three", "synthesis")
  assert(
    "ticket three synthesis carries the root request and branch digest",
    threeSynthesis?.hasRootRequest === true && threeSynthesis?.hasBranchResults === true,
  )
  const threeSuppressed = (await logEntries("native.route.suppressed", 500)).filter(
    (entry) => entry.turnID === root.id && entry.reason === "terminal-turn",
  )
  assert("ticket three terminal mentions are references", threeSuppressed.length === 2, String(threeSuppressed.length))
  await invoke("settings.update", {
    dispatchGroupMaxHops: 8,
    dispatchCommandMaxHops: 24,
    dispatchDepth: 8,
    dispatchContinuations: 2,
  })

  // --- ticket four: worker handoff with $Name to a sibling -------------------
  await sendFlowKickoff(saved.flowsGroupSessionID, FLOW_TICKET_FOUR)
  snapshot = await waitForCommandRoot(workspaceID, "Ticket four")
  root = commandRoot(snapshot, workspaceID, "Ticket four")
  assert("ticket four is a parentless leader command root", Boolean(root) && root.parentID === undefined && root.assigneeID === leaderID)
  const four = ticketMetrics(snapshot, root, leaderID, channel)
  assert("ticket four has one leader synthesis turn", four.leaderTasks === 1 && four.leaderMessages === 1, JSON.stringify(four))
  assert("ticket four has no completion work", four.completionTasks === 0)
  const phoenixTask = tasksInGroup(snapshot, root.dispatchGroupID).find((task) => task.assigneeID === agentIDs.phoenix)
  assert("ticket four assigns the worker", Boolean(phoenixTask))
  const peerRoute = Object.values(snapshot.subtasks ?? {}).find(
    (task) => task.parentID === phoenixTask?.id && task.assigneeID === agentIDs.clark,
  )
  assert("a worker turn still routes a sibling with $Name", Boolean(peerRoute) && peerRoute.workKind === "turn" && peerRoute.state === "replied")
  const routeLog = (await logEntries("native.route.created", 100)).find(
    (entry) => entry.turnID === phoenixTask?.id && entry.recipientID === agentIDs.clark,
  )
  assert("the worker route is logged as a real peer turn", Boolean(routeLog))
  assert("ticket four posts the visible terminal notice", terminalNoticeFor(snapshot, channel, root.id))
  const fourSynthesis = flowMetrics("four", "synthesis")
  assert(
    "ticket four synthesis carries the root request and branch digest",
    fourSynthesis?.hasRootRequest === true && fourSynthesis?.hasBranchResults === true,
  )
  const fourSuppressed = (await logEntries("native.route.suppressed", 500)).filter(
    (entry) => entry.turnID === root.id && entry.reason === "terminal-turn",
  )
  assert("ticket four terminal mentions are references", fourSuppressed.length === 1, String(fourSuppressed.length))

  const kickoffs = Object.values(snapshot.subtasks ?? {}).filter(
    (task) =>
      task.workspaceID === workspaceID &&
      task.origin === "native" &&
      String(task.instruction ?? "").startsWith("fake-vera-flows:"),
  )
  assert("three native kickoff turns start the flow tickets", kickoffs.length === 3, String(kickoffs.length))
  assert("every kickoff turn settled", kickoffs.every((task) => task.native?.phase === "replied"))

  const tickets = { one, two, three, four }
  for (const [ticket, values] of Object.entries(tickets)) {
    const synthesis = flowMetrics(ticket, "synthesis")
    values.synthesisPromptChars = synthesis?.latestUserChars
    values.synthesisPromptTokens = Math.ceil(Number(synthesis?.latestUserChars ?? 0) / 4)
    values.synthesisContextChars = synthesis?.synthesisContextChars
    values.synthesisContextTokens = Math.ceil(Number(synthesis?.synthesisContextChars ?? 0) / 4)
  }
  const synthesisPromptChars = ["one", "two", "three", "four"].reduce(
    (total, ticket) => total + Number(flowMetrics(ticket, "synthesis")?.latestUserChars ?? 0),
    0,
  )
  const synthesisContextChars = ["one", "two", "three", "four"].reduce(
    (total, ticket) => total + Number(flowMetrics(ticket, "synthesis")?.synthesisContextChars ?? 0),
    0,
  )
  const leaderOutputChars = Object.values(tickets).reduce((total, ticket) => total + ticket.leaderOutputChars, 0)
  const beforeRelayChars = 8333
  const beforeFanoutChars = 5761
  metrics.flows = {
    tickets,
    kickoffTurns: kickoffs.length,
    terminalSuppressed: { one: oneSuppressed.length, two: twoSuppressed.length, three: threeSuppressed.length, four: fourSuppressed.length },
    terminalNotices: {
      one: terminalNoticeFor(snapshot, channel, one.rootTaskID),
      two: terminalNoticeFor(snapshot, channel, two.rootTaskID),
      three: terminalNoticeFor(snapshot, channel, three.rootTaskID),
      four: terminalNoticeFor(snapshot, channel, four.rootTaskID),
    },
    refusal: { visible: Boolean(refusalCopy), layer: refusalLog?.layer, used: refusalLog?.used, max: refusalLog?.max, createdWork: refusedBatch.length },
    workerRoute: { peerTurns: peerRoute ? 1 : 0, routed: Boolean(routeLog) },
    toolSurface: { native: toolSurfaceMetrics(6), legacy: toolSurfaceMetrics(11) },
    synthesis: {
      promptChars: synthesisPromptChars,
      promptTokens: Math.ceil(synthesisPromptChars / 4),
      contextChars: synthesisContextChars,
      contextTokens: Math.ceil(synthesisContextChars / 4),
    },
    totals: {
      leaderTurns: Object.values(tickets).reduce((total, ticket) => total + ticket.leaderTasks, 0),
      leaderOutputChars,
      leaderOutputTokens: Math.ceil(leaderOutputChars / 4),
    },
    beforeAfter: {
      relay: {
        beforeChars: beforeRelayChars,
        beforeTokens: Math.ceil(beforeRelayChars / 4),
        afterChars: one.leaderOutputChars,
        afterTokens: one.leaderOutputTokens,
        deltaChars: beforeRelayChars - one.leaderOutputChars,
        deltaTokens: Math.ceil(beforeRelayChars / 4) - one.leaderOutputTokens,
      },
      fanout: {
        beforeChars: beforeFanoutChars,
        beforeTokens: Math.ceil(beforeFanoutChars / 4),
        beforeBranches: 3,
        afterChars: two.leaderOutputChars,
        afterTokens: two.leaderOutputTokens,
        afterBranches: two.workerTurns,
        deltaChars: beforeFanoutChars - two.leaderOutputChars,
        deltaTokens: Math.ceil(beforeFanoutChars / 4) - two.leaderOutputTokens,
      },
      leaderTurns: {
        beforeRelay: 5,
        beforeFanout: 4,
        afterPerTicket: 1,
        relayDelta: 4,
        fanoutDelta: 3,
      },
    },
  }

  const workspaceTasks = Object.values(snapshot.subtasks ?? {}).filter((task) => task.workspaceID === workspaceID)
  stateFileData.flows = {
    workspaceID,
    channel,
    groupSessionID: saved.flowsGroupSessionID,
    taskCount: workspaceTasks.length,
    nativeCount: workspaceTasks.filter((task) => task.origin === "native").length,
    roots: { one: one.rootTaskID, two: two.rootTaskID, three: three.rootTaskID, four: four.rootTaskID },
    groups: { one: one.dispatchGroupID, two: two.dispatchGroupID, three: three.dispatchGroupID, four: four.dispatchGroupID },
    kickoffTurns: kickoffs.length,
    peerRouteTaskID: peerRoute?.id,
    ticketMetrics: tickets,
    terminalNotices: metrics.flows.terminalNotices,
    toolSurface: metrics.flows.toolSurface,
    beforeAfter: metrics.flows.beforeAfter,
    totals: metrics.flows.totals,
  }
  stateFileData.phase = "flows"
  saveState()
}

/** Restart pass: durable native turns, ledger, roster, and no bounce. */
async function restart() {
  const saved = JSON.parse(readFileSync(stateFile, "utf8"))
  stateFileData = saved
  assert("restart has the run scenario state", Boolean(saved.parentTaskID && saved.workspaceID && saved.leaderID))
  const diag = await diagnostic()
  const snapshot = diag.state
  assert("restart keeps native-first on", snapshot.settings.nativeFirst === "on")
  assert("restart reports native sync live", diag.native?.sync?.state === "live", diag.native?.sync?.state)
  const binding = await invoke("agent.sessionBinding", {
    agentID: saved.leaderID,
    workspaceID: saved.workspaceID,
    conversation: "workspace",
  })
  assert("restart keeps the workspace binding on", binding.mode === "on" && binding.state === "bound")

  const parent = snapshot.subtasks[saved.parentTaskID]
  assert("restart preserves the parent native turn", parent?.origin === "native" && parent.native?.phase === "replied")
  assert("restart preserves the parent result row", parent.resultMessageID === saved.parentResultMessageID)
  assert("restart preserves the contact ledger", JSON.stringify(parent.native?.contacted ?? []) === JSON.stringify(saved.ledgerBefore))
  assert(
    "restart keeps one successful execution event for the parent",
    (parent.native?.events ?? []).filter((event) => event.type === "session.execution.succeeded").length === 1,
  )
  assert(
    "restart preserves every durable native turn",
    Object.values(snapshot.subtasks ?? {}).filter(
      (task) => task.workspaceID === saved.workspaceID && task.origin === "native",
    ).length === saved.nativeCount,
  )
  assert(
    "restart keeps exactly one work item for the explicit recipient",
    Object.values(snapshot.subtasks ?? {}).filter(
      (task) => task.workspaceID === saved.workspaceID && task.assigneeID === saved.agentIDs.phoenix,
    ).length === saved.phoenixTaskCount,
  )
  assert(
    "restart creates no completion turn for the leader",
    Object.values(snapshot.subtasks ?? {}).filter((task) => task.handoff?.completion === true).length === 0,
  )
  const stuck = Object.values(snapshot.subtasks ?? {}).filter(
    (task) => task.origin === "native" && ["queued", "working", "retrying"].includes(task.native?.phase),
  )
  assert("restart leaves no stuck native turn", stuck.length === 0)

  const content = readAgents(saved.workspaceDir)
  const table = rosterTableFrom(content)
  assert("restart keeps the exact generated roster table", JSON.stringify(table) === JSON.stringify(expectedRosterTable(saved)))
  assert(
    "restart keeps the roster order and names",
    JSON.stringify(rosterMemberNames(table)) === JSON.stringify(expectedRosterNames(saved)),
  )
  assert("restart keeps exactly one v6 block", (content.match(/<!-- ensemble:start/g) ?? []).length === 1 && content.includes(V6_START))
  const messages = channelMessages(snapshot, saved.workspaceChannel)
  const parentRows = messages.filter((message) => message.taskID === saved.parentTaskID && message.author === "agent")
  assert("restart keeps one final parent row", parentRows.length === 1 && parentRows[0].id === saved.parentResultMessageID)
  const leaderRows = messages.filter(
    (message) => message.author === "agent"
      && message.agentID === saved.leaderID
      && message.createdAt >= parent.createdAt
      && message.taskID !== saved.legacyTaskID,
  )
  assert("restart keeps the leader's single turn row", leaderRows.length === 1 && leaderRows[0].id === saved.parentResultMessageID)
  assert(
    "restart keeps the same total work rows",
    Object.values(snapshot.subtasks ?? {}).filter((task) => task.workspaceID === saved.workspaceID).length === saved.taskCount,
  )

  // Ticket #251: the multi-ticket flow survives the host restart with its
  // roots, one synthesis per ticket, and the visible terminal notices.
  const flows = saved.flows
  assert("restart has the ticket #251 flow state", Boolean(flows?.workspaceID && flows?.roots?.two))
  const flowTasks = Object.values(snapshot.subtasks ?? {}).filter((task) => task.workspaceID === flows.workspaceID)
  assert("restart preserves every flow task", flowTasks.length === flows.taskCount)
  assert(
    "restart preserves every flow native turn",
    flowTasks.filter((task) => task.origin === "native").length === flows.nativeCount,
  )
  assert("restart creates no flow completion turn", flowTasks.every((task) => task.handoff?.completion !== true))
  for (const [ticket, rootID] of Object.entries(flows.roots)) {
    const flowRoot = snapshot.subtasks[rootID]
    assert(`restart keeps the ${ticket} command root`, Boolean(flowRoot) && flowRoot.parentID === undefined && flowRoot.assigneeID === saved.leaderID)
    assert(`restart keeps the ${ticket} synthesis`, flowRoot?.stage === "synthesis" && flowRoot.state === "replied")
    assert(
      `restart keeps one ${ticket} leader message`,
      leaderMessagesFor(snapshot, flows.channel, saved.leaderID, rootID).length === 1,
    )
    if (ticket === "two" || ticket === "three" || ticket === "four") {
      assert(`restart keeps the ${ticket} terminal notice`, terminalNoticeFor(snapshot, flows.channel, rootID))
    }
  }
  const flowTwoGroup = snapshot.dispatchGroups[flows.groups.two]
  assert(
    "restart keeps ticket two's fresh command budget",
    Boolean(flowTwoGroup) && flowTwoGroup.usedHops === 5 && flowTwoGroup.commandUsedHops === 5 && flowTwoGroup.commandMaxHops === 24,
  )
  assert("restart keeps the worker route peer turn", Boolean(snapshot.subtasks[flows.peerRouteTaskID]))

  metrics.restart = {
    mode: snapshot.settings.nativeFirst,
    sync: diag.native?.sync?.state,
    nativeTurns: saved.nativeCount,
    contacted: (parent.native?.contacted ?? []).length,
    parentRows: parentRows.length,
    leaderRows: leaderRows.length,
    stuckTurns: stuck.length,
    rosterExact: JSON.stringify(table) === JSON.stringify(expectedRosterTable(saved)),
    flows: {
      tasks: flowTasks.length,
      nativeTurns: flowTasks.filter((task) => task.origin === "native").length,
      roots: Object.keys(flows.roots).length,
      ticketTwoCommandMaxHops: flowTwoGroup?.commandMaxHops,
      peerRoute: Boolean(snapshot.subtasks[flows.peerRouteTaskID]),
    },
  }
  stateFileData.phase = "restart"
  saveState()
}

try {
  if (phase === "seed") await seed()
  else if (phase === "run") await run()
  else if (phase === "flows") await flows()
  else if (phase === "restart") await restart()
  else throw new Error(`unknown phase: ${phase}`)
} catch (error) {
  failures.push(String(error?.message ?? error))
  process.stderr.write(`vera-regression-driver: ${error?.stack ?? error}\n`)
}

const output = {
  schema: "ensemble.vera-regression",
  version: 1,
  phase,
  project: "<project>",
  checks,
  failures,
  metrics,
  counts: {
    checks: checks.length,
    passed: checks.filter((entry) => entry.ok).length,
    failed: checks.filter((entry) => !entry.ok).length,
  },
  privacy: {
    promptText: false,
    answerText: false,
    fileBytes: false,
    absolutePaths: false,
    credentials: false,
  },
}
writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ phase, checks: output.counts, failures }, null, 2)}\n`)
if (failures.length > 0) process.exit(1)
