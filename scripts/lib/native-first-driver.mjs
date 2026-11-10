#!/usr/bin/env node
/**
 * Ticket #227 native-first cutover driver.
 *
 * Runs against an isolated OpenCode host loaded with the worktree Ensemble
 * plugin and the deterministic fake provider. It drives real native prompts
 * through the same public `@opencode/client` surface the #210 host probe uses,
 * and reads durable state only through the public Ensemble RPC.
 *
 * The driver records identities, counts, booleans, latency, and token/schema
 * metrics. It never writes prompt text, answer text, file bytes, credentials,
 * or absolute paths to its output.
 *
 * Phases:
 *   main    setup, direct/workspace native turns, user and agent-final mention
 *           routing, attachment, adoption, retry, interruption, Work history,
 *           rollback, and latency/token metrics.
 *   restart assert durable state and Work history after a host restart, prove
 *           post-restart ingestion, then check the shadow-mode contract.
 *
 * Test infrastructure only; the product plugin never imports this file.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const url = arg("--url")
const password = arg("--password")
const project = arg("--project")
const phase = arg("--phase", "main")
const stateFile = arg("--state-file")
const out = arg("--out")
const fakeLog = arg("--fake-log")
const logDir = arg("--service-log-dir")
if (!url || !password || !project) {
  process.stderr.write("native-first-driver: --url, --password, and --project are required\n")
  process.exit(2)
}
if (!stateFile || !out) {
  process.stderr.write("native-first-driver: --state-file and --out are required\n")
  process.exit(2)
}

const client = OpenCode.make({
  baseUrl: url,
  headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") },
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")

const SHORT_REPLY = "Onboarding complete. I am ready."
const FINAL_MENTION_MARKER = "AGENT_FINAL_MENTION_MARKER"
const ATTACHMENT_CONTENT = "native-first attachment fixture"
const ATTACHMENT_NAME = "cutover-attachment.txt"

const checks = []
const failures = []
const gaps = []
const metrics = {}

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

async function workHistory(input) {
  const value = await rpc("work.history", { directory: project, ...input })
  return value?.output ?? value
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

function terminalNativeCount(snapshot, sessionID) {
  return Object.values(snapshot.subtasks ?? {}).filter(
    (task) => task.origin === "native" && task.native?.sessionID === sessionID && task.native?.phase !== "queued" && task.native?.phase !== "working" && task.native?.phase !== "retrying",
  ).length
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

async function pageHistoryIDs(conversationID) {
  const pages = []
  let before
  for (let index = 0; index < 20; index++) {
    const page = await workHistory({ conversationID, limit: 2, ...(before ? { before } : {}) })
    pages.push(page)
    if (!page.hasMore || !page.next) break
    before = page.next
  }
  const tasks = pages.flatMap((page) => Object.values(page.tasks ?? {}))
  return { pages, tasks, ids: tasks.map((task) => task.id) }
}

async function promptNative(sessionID, text, extra = {}) {
  const inbox = await client.session.prompt({ sessionID, text, ...extra })
  if (!inbox?.id) throw new Error("native prompt did not return an inbox id")
  return inbox
}

async function main() {
  const workspaceDir = join(project, "cutover-workspace")
  mkdirSync(workspaceDir, { recursive: true })
  await invoke("settings.update", { nativeFirst: "on", nativeMentionRouting: true, toolSurface: "native" })

  const lead = await invoke("agent.create", {
    name: "CutoverLead",
    title: "Cutover lead",
    role: "Native-first cutover fixture lead.",
    mainModel: { providerID: "ensemble-fake", modelID: "ensemble-fake-model" },
  })
  const peer = await invoke("agent.create", {
    name: "CutoverPeer",
    title: "Cutover peer",
    role: "Native-first cutover fixture peer.",
    mainModel: { providerID: "ensemble-fake", modelID: "ensemble-fake-model" },
  })
  const workspace = await invoke("workspace.create", {
    name: "CutoverProbe",
    directory: workspaceDir,
    memberIDs: [lead.id, peer.id],
    leaderID: lead.id,
  })
  let snapshot = await state()
  let groupBinding = bindingFor(snapshot, lead.id, workspace.id, "workspace")
  if (!groupBinding?.sessionID) {
    await invoke("message.send", { workspaceID: workspace.id, text: "Warm the native-first group binding.", recipientIDs: [lead.id] })
    const warmed = await waitFor("the workspace binding after warm-up", async (next) => Boolean(bindingFor(next, lead.id, workspace.id, "workspace")?.sessionID), 30_000)
    snapshot = warmed.state
    groupBinding = bindingFor(snapshot, lead.id, workspace.id, "workspace")
  }
  assert("workspace binding exists", Boolean(groupBinding?.sessionID))
  const groupSessionID = groupBinding.sessionID
  const workspaceChannel = workspace.id

  await invoke("chat.context", { agentID: lead.id, workspaceID: workspace.id })
  snapshot = await state()
  const directBinding = bindingFor(snapshot, lead.id, workspace.id, "direct")
  assert("workspace-direct binding exists", Boolean(directBinding?.sessionID))
  const directSessionID = directBinding.sessionID
  const directChannel = `dm:${lead.id}:${workspace.id}`
  check("group and direct sessions are separate", groupSessionID !== directSessionID)

  // --- direct native turn -------------------------------------------------
  {
    const marker = "native-direct-fixture"
    const inbox = await promptNative(directSessionID, marker)
    const started = Date.now()
    const settled = await waitFor("the direct native turn", (next) => {
      const task = nativeTask(next, directSessionID, inbox.id)
      const result = task?.resultMessageID ? messageByID(next, directChannel, task.resultMessageID) : undefined
      return Boolean(task?.native?.phase === "replied" && result && result.streaming !== true)
    })
    const elapsed = Date.now() - started
    snapshot = settled.state
    const task = nativeTask(snapshot, directSessionID, inbox.id)
    const messages = channelMessages(snapshot, directChannel)
    const userRow = messages.find((message) => message.author === "user" && message.taskID === task.id)
    const agentRow = messageByID(snapshot, directChannel, task.resultMessageID)
    const userRows = messages.filter((message) => message.author === "user" && message.taskID === task.id)
    const agentRows = messages.filter((message) => message.author === "agent" && message.taskID === task.id)
    assert("direct turn is a native turn", task.origin === "native" && task.adopted === undefined && task.workKind === "turn")
    assert("direct turn uses the direct conversation channel", task.conversationID === directChannel)
    assert("direct user row is exact", userRow?.text === marker)
    assert("direct final row is exact", String(agentRow?.text ?? "").trim() === SHORT_REPLY.trim(), `finalChars=${String(agentRow?.text ?? "").length}`)
    assert("direct turn has one user and one agent row", userRows.length === 1 && agentRows.length === 1)
    metrics.direct = { latencyMs: elapsed, turnCount: 1, finalChars: String(agentRow?.text ?? "").length, ...(requestMetrics(marker) ?? {}) }
  }

  // --- workspace native turn ---------------------------------------------
  {
    const marker = "native-workspace-fixture"
    const inbox = await promptNative(groupSessionID, marker)
    const started = Date.now()
    const settled = await waitFor("the workspace native turn", (next) => {
      const task = nativeTask(next, groupSessionID, inbox.id)
      const result = task?.resultMessageID ? messageByID(next, workspaceChannel, task.resultMessageID) : undefined
      return Boolean(task?.native?.phase === "replied" && result && result.streaming !== true)
    })
    const elapsed = Date.now() - started
    snapshot = settled.state
    const task = nativeTask(snapshot, groupSessionID, inbox.id)
    const messages = channelMessages(snapshot, workspaceChannel)
    const userRow = messages.find((message) => message.author === "user" && message.taskID === task.id)
    const agentRow = messageByID(snapshot, workspaceChannel, task.resultMessageID)
    assert("workspace turn uses the workspace channel", task.conversationID === workspaceChannel)
    assert("workspace user row is exact", userRow?.text === marker)
    assert("workspace final row is exact", String(agentRow?.text ?? "").trim() === SHORT_REPLY.trim(), `finalChars=${String(agentRow?.text ?? "").length}`)
    metrics.workspace = { latencyMs: elapsed, turnCount: 1, finalChars: String(agentRow?.text ?? "").length, ...(requestMetrics(marker) ?? {}) }
  }

  // --- user mention routing ----------------------------------------------
  {
    const marker = `Coordinate the release. $${peer.name} native-user-mention-fixture`
    const before = new Set(Object.keys(snapshot.subtasks ?? {}))
    const inbox = await promptNative(groupSessionID, marker)
    const started = Date.now()
    const settled = await waitFor("the user-mentioned peer turn", (next) => {
      const own = nativeTask(next, groupSessionID, inbox.id)
      if (own?.native?.phase !== "replied") return false
      return Object.values(next.subtasks ?? {}).some(
        (task) => !before.has(task.id) && task.assigneeID === peer.id && task.parentID === own.id && task.state === "replied",
      )
    })
    const elapsed = Date.now() - started
    snapshot = settled.state
    const own = nativeTask(snapshot, groupSessionID, inbox.id)
    const routed = Object.values(snapshot.subtasks ?? {}).filter(
      (task) => !before.has(task.id) && task.assigneeID === peer.id && task.parentID === own.id,
    )
    const peerTask = routed[0]
    assert("user mention creates exactly one peer turn", routed.length === 1)
    assert("user mention peer turn is a turn", peerTask.workKind === "turn" && peerTask.turn?.askerKind === "user")
    assert("user mention shares the native dispatch group", peerTask.dispatchGroupID === own.dispatchGroupID)
    const ledger = snapshot.dispatchGroups?.[own.dispatchGroupID]
    assert("user mention has a server-owned group budget", Number(ledger?.maxHops) > 0)
    assert("user mention does not author a task budget", peerTask.taskMaxHops === undefined)
    assert("user mention peer turn replied", peerTask.state === "replied" && Boolean(peerTask.resultMessageID))
    metrics.userMention = { latencyMs: elapsed, routes: routed.length, groupMaxHops: ledger?.maxHops, taskMaxHops: peerTask.taskMaxHops ?? null }
  }

  // --- agent final-text mention routing ----------------------------------
  {
    const marker = `Status update fake-mention-final:${peer.name}`
    const before = new Set(Object.keys(snapshot.subtasks ?? {}))
    const inbox = await promptNative(groupSessionID, marker)
    const started = Date.now()
    const settled = await waitFor("the final-text routed peer turn", (next) => {
      const own = nativeTask(next, groupSessionID, inbox.id)
      if (own?.native?.phase !== "replied") return false
      return Object.values(next.subtasks ?? {}).some(
        (task) => !before.has(task.id) && task.assigneeID === peer.id && task.parentID === own.id && task.state === "replied",
      )
    })
    const elapsed = Date.now() - started
    snapshot = settled.state
    const own = nativeTask(snapshot, groupSessionID, inbox.id)
    const finalRow = messageByID(snapshot, workspaceChannel, own.resultMessageID)
    const routed = Object.values(snapshot.subtasks ?? {}).filter(
      (task) => !before.has(task.id) && task.assigneeID === peer.id && task.parentID === own.id,
    )
    const peerTask = routed[0]
    assert("agent final text is the exact native answer", finalRow?.text.startsWith(`${FINAL_MENTION_MARKER} — $${peer.name}`))
    assert("agent final mention creates exactly one peer turn", routed.length === 1)
    assert("agent final peer turn is an agent turn", peerTask.workKind === "turn" && peerTask.turn?.askerKind === "agent" && peerTask.turn?.askerID === lead.id)
    assert("agent final mention shares the native dispatch group", peerTask.dispatchGroupID === own.dispatchGroupID)
    const ledger = snapshot.dispatchGroups?.[own.dispatchGroupID]
    assert("agent final mention has a server-owned group budget", Number(ledger?.maxHops) > 0)
    assert("agent final mention does not author a task budget", peerTask.taskMaxHops === undefined)
    assert("agent final peer turn replied", peerTask.state === "replied")
    metrics.agentFinalMention = { latencyMs: elapsed, routes: routed.length, groupMaxHops: ledger?.maxHops, taskMaxHops: peerTask.taskMaxHops ?? null, ...(requestMetrics(marker) ?? {}) }
  }

  // --- attachment prompt --------------------------------------------------
  {
    const attachmentPath = join(workspaceDir, ATTACHMENT_NAME)
    writeFileSync(attachmentPath, ATTACHMENT_CONTENT)
    const marker = "native-attachment-fixture"
    const inbox = await promptNative(directSessionID, marker, {
      files: [{ uri: `file://${attachmentPath}`, name: ATTACHMENT_NAME, description: "native-first attachment fixture" }],
    })
    const settled = await waitFor("the attachment native turn", (next) => {
      const task = nativeTask(next, directSessionID, inbox.id)
      return Boolean(task?.native?.phase === "replied" && task.resultMessageID)
    })
    snapshot = settled.state
    const task = nativeTask(snapshot, directSessionID, inbox.id)
    const userRow = channelMessages(snapshot, directChannel).find((message) => message.author === "user" && message.taskID === task.id)
    const attachment = userRow?.attachments?.[0]
    assert("attachment prompt produces one chip", userRow?.attachments?.length === 1)
    assert("attachment chip carries name", attachment?.name === ATTACHMENT_NAME)
    assert("attachment chip carries text MIME", String(attachment?.mime).startsWith("text/plain"))
    check("attachment chip carries a size", Number(attachment?.size) > 0, `size=${Number(attachment?.size ?? 0)}`)
    assert("attachment chip is a file", attachment?.kind === "file")
    assert("attachment prompt turn is replied", task.native.phase === "replied")
    const attachmentSerialized = JSON.stringify(userRow?.attachments ?? [])
    assert("attachment row has no file bytes", !attachmentSerialized.includes(ATTACHMENT_CONTENT))
    assert("attachment row has no source or store path", !attachmentSerialized.includes(workspaceDir) && !attachmentSerialized.includes(".ensemble/attachments"))
    metrics.attachment = { chips: userRow?.attachments?.length ?? 0, size: attachment?.size }
  }

  // --- retry --------------------------------------------------------------
  {
    const marker = "fake-retry-fixture"
    const inbox = await promptNative(directSessionID, marker)
    let retryingObserved = false
    const started = Date.now()
    const settled = await waitFor("the retried native turn", (next) => {
      const task = nativeTask(next, directSessionID, inbox.id)
      if (task?.native?.phase === "retrying") retryingObserved = true
      return Boolean(task?.native?.phase === "replied" && task.resultMessageID)
    }, 90_000)
    const elapsed = Date.now() - started
    snapshot = settled.state
    const task = nativeTask(snapshot, directSessionID, inbox.id)
    const agentRows = channelMessages(snapshot, directChannel).filter((message) => message.author === "agent" && message.taskID === task.id)
    const retryEvent = (task.native.events ?? []).some((event) => event.type === "session.retry.scheduled")
    assert("retry keeps one native turn", task.origin === "native" && task.native.phase === "replied")
    assert("retry reuses one assistant row", agentRows.length === 1 && agentRows[0].id === task.resultMessageID)
    assert("retry is recorded as a native event", retryEvent)
    assert("retry does not create an interrupted row", agentRows[0].interrupted !== true)
    metrics.retry = { latencyMs: elapsed, retryingObserved, retryEvent, assistantRows: agentRows.length, assistantMessageIDs: task.native.assistantMessageIDs.length }
  }

  // --- interruption -------------------------------------------------------
  {
    const marker = "fake-interrupt-hold-fixture"
    const inbox = await promptNative(directSessionID, marker)
    const streaming = await waitFor("the interrupt fixture to stream", (next) => {
      const task = nativeTask(next, directSessionID, inbox.id)
      const row = task?.native?.phase === "working" ? channelMessages(next, directChannel).find((message) => message.taskID === task.id && message.author === "agent" && message.streaming) : undefined
      return Boolean(row && String(row.text ?? "").length > 100)
    }, 30_000)
    const interruptResult = await client.session.interrupt({ sessionID: directSessionID })
    const settled = await waitFor("the interrupted native turn", (next) => {
      const task = nativeTask(next, directSessionID, inbox.id)
      return Boolean(task?.native?.phase === "cancelled")
    }, 30_000)
    snapshot = settled.state
    const task = nativeTask(snapshot, directSessionID, inbox.id)
    const rows = channelMessages(snapshot, directChannel).filter((message) => message.author === "agent" && message.taskID === task.id)
    const partial = rows[0]
    assert("interrupt is acknowledged by the host", interruptResult?.interrupted === true)
    assert("user interrupt settles cancelled", task.native.phase === "cancelled")
    assert("user interrupt preserves partial text", rows.length === 1 && String(partial?.text ?? "").length > 0 && partial.streaming !== true)
    assert("user interrupt is not an interrupted row", partial.interrupted !== true)
    metrics.interruption = {
      partialChars: String(partial?.text ?? "").length,
      phase: task.native.phase,
      streamingBeforeInterrupt: Boolean(streaming.state),
    }
  }

  // --- session adoption ---------------------------------------------------
  let previousGroupSessionID
  {
    const previous = bindingFor(snapshot, lead.id, workspace.id, "workspace")
    previousGroupSessionID = previous.sessionID
    const created = await client.session.create({ location: { directory: workspaceDir }, title: "Adoption fixture" })
    assert("adoption fixture session exists", Boolean(created?.id))
    const preview = await invoke("session.adopt.preview", {
      agentID: lead.id,
      workspaceID: workspace.id,
      conversation: "workspace",
      sessionID: created.id,
    })
    assert("adoption preview resolves the workspace conversation", preview.target?.kind === "workspace")
    assert("adoption preview is adoptable", preview.plan?.canAdopt === true && preview.plan?.blockers?.length === 0)
    assert("adoption preview names the current session", preview.currentSessionID === previous.sessionID)
    const adopted = await invoke("session.adopt", {
      agentID: lead.id,
      workspaceID: workspace.id,
      conversation: "workspace",
      sessionID: created.id,
    })
    assert("adoption reports adopted", adopted.adopted === true && adopted.state === "adopted")
    assert("adoption binds the new session", adopted.binding?.sessionID === created.id)
    assert("adoption keeps the previous session in history", (adopted.replacedSessionID === previous.sessionID) && (adopted.history ?? []).includes(previous.sessionID))
    snapshot = await waitFor("the adopted binding", (next) => bindingFor(next, lead.id, workspace.id, "workspace")?.sessionID === created.id, 30_000).then((result) => result.state)
    assert("adoption wrote a visible native heads-up", adopted.headsUp === true)
    // Ticket #229: prompt immediately after adoption, while the synthetic
    // heads-up turn may still be active. The prompt turn must settle with its
    // own exact answer or stay visibly queued with an execution owner; it must
    // never remain `pending` with no attribution.
    const marker = "native-adopted-fixture"
    const inbox = await promptNative(created.id, marker)
    const settled = await waitFor("the adopted session turn", (next) => {
      const task = nativeTask(next, created.id, inbox.id)
      return Boolean(task?.native?.phase === "replied" && task.resultMessageID)
    })
    await waitFor("the adoption heads-up to settle", (next) => {
      const turns = Object.values(next.subtasks ?? {}).filter((task) => task.origin === "native" && task.native?.sessionID === created.id)
      return turns.length > 0 && turns.every((task) => !["queued", "working", "retrying"].includes(task.native?.phase))
    }, 30_000)
    snapshot = settled.state
    const task = nativeTask(snapshot, created.id, inbox.id)
    assert("adopted session ingests into the workspace channel", task.conversationID === workspaceChannel)
    metrics.adoption = {
      adopted: true,
      historyKept: (adopted.history ?? []).length,
      headsUp: adopted.headsUp === true,
    }
    groupBinding = bindingFor(snapshot, lead.id, workspace.id, "workspace")
  }

  const adoptedGroupSessionID = groupBinding.sessionID

  // --- Work history and fresh reload -------------------------------------
  {
    const workspaceTerminal = Object.values(snapshot.subtasks ?? {}).filter(
      (task) => (task.conversationID ?? task.workspaceID) === workspaceChannel && ["replied", "cancelled", "failed", "stalled"].includes(task.status ?? ""),
    )
    const directTerminal = Object.values(snapshot.subtasks ?? {}).filter(
      (task) => (task.conversationID ?? task.workspaceID) === directChannel && ["replied", "cancelled", "failed", "stalled"].includes(task.status ?? ""),
    )
    const workspacePages = await pageHistoryIDs(workspaceChannel)
    const directPages = await pageHistoryIDs(directChannel)
    assert("workspace history pages at least twice", workspacePages.pages.length >= 2)
    assert("workspace history has no duplicate rows", new Set(workspacePages.ids).size === workspacePages.ids.length)
    assert("workspace history contains terminal turns", workspacePages.ids.length >= workspaceTerminal.length)
    assert("workspace history rows are terminal", workspacePages.tasks.every((task) => ["replied", "cancelled", "failed", "stalled"].includes(task.status)))
    assert("direct history contains every direct turn", directPages.ids.length >= directTerminal.length)
    assert("direct history has no duplicate rows", new Set(directPages.ids).size === directPages.ids.length)
    const bootstrap = await rpc("bootstrap", { directory: project, workspaceID: workspaceChannel })
    assert("fresh bootstrap succeeds", Boolean((bootstrap?.output ?? bootstrap)?.state))
    const reloaded = await pageHistoryIDs(workspaceChannel)
    assert("fresh reload returns the same history ids", reloaded.ids.join(",") === workspacePages.ids.join(","))
    metrics.workHistory = {
      workspaceTasks: workspacePages.ids.length,
      workspacePages: workspacePages.pages.length,
      directTasks: directPages.ids.length,
      directPages: directPages.pages.length,
      reloadStable: reloaded.ids.join(",") === workspacePages.ids.join(","),
    }
    stateFileData.workHistory = { workspace: workspacePages.ids, direct: directPages.ids }
  }

  // --- rollback to the explicit-tool surface -----------------------------
  {
    const nativeBefore = Object.values(snapshot.subtasks ?? {}).filter((task) => task.origin === "native").length
    await invoke("settings.update", { nativeFirst: "off", toolSurface: "legacy" })
    snapshot = await state()
    assert("rollback stores nativeFirst off", snapshot.settings.nativeFirst === "off")
    assert("rollback stores the legacy tool surface", snapshot.settings.toolSurface === "legacy")
    const binding = await invoke("agent.sessionBinding", { agentID: lead.id, workspaceID: workspace.id, conversation: "workspace" })
    assert("rollback reports the off mode", binding.mode === "off")
    const started = Date.now()
    const sent = await invoke("message.send", { workspaceID: workspace.id, text: "rollback-legacy-fixture", recipientIDs: [lead.id] })
    assert("legacy send is accepted", Array.isArray(sent?.recipients) && sent.recipients.includes(lead.id))
    const settled = await waitFor("the legacy task", (next) => {
      const task = Object.values(next.subtasks ?? {}).find((item) => item.instruction === "rollback-legacy-fixture" && item.state === "replied")
      return Boolean(task)
    }, 60_000)
    const elapsed = Date.now() - started
    snapshot = settled.state
    const legacyTask = Object.values(snapshot.subtasks ?? {}).find((task) => task.instruction === "rollback-legacy-fixture")
    assert("legacy task replied on the old path", legacyTask.state === "replied" && legacyTask.origin !== "native")
    const nativeAfter = Object.values(snapshot.subtasks ?? {}).filter((task) => task.origin === "native").length
    assert("rollback preserves durable native turns", nativeAfter === nativeBefore)
    const legacyRequests = streamingRequestsBetween(started, Date.now() + 500)
    const legacyRequest = legacyRequests[0]
    assert("legacy prompt uses the legacy tool surface", Number(legacyRequest?.ensembleToolCount ?? 0) === 11)
    await invoke("settings.update", { nativeFirst: "on", toolSurface: "native" })
    snapshot = await state()
    assert("native-first is restored", snapshot.settings.nativeFirst === "on" && snapshot.settings.toolSurface === "native")
    metrics.rollback = {
      latencyMs: elapsed,
      legacyTaskReplied: legacyTask.state === "replied",
      nativeTurnsPreserved: nativeAfter === nativeBefore,
      legacyEnsembleToolCount: Number(legacyRequest?.ensembleToolCount ?? 0),
      legacyModelRoundTrips: legacyRequests.length,
    }
    stateFileData.legacyTaskID = legacyTask.id
  }

  // --- latency and token summary -----------------------------------------
  metrics.tokens = {
    native: {
      tools: metrics.workspace?.ensembleToolCount,
      schemaChars: metrics.workspace?.ensembleToolSchemaChars,
      schemaTokens: metrics.workspace?.ensembleToolSchemaTokens,
      promptTokens: metrics.workspace?.estimatedPromptTokens,
      roundTrips: 1,
    },
    legacy: {
      tools: metrics.rollback?.legacyEnsembleToolCount,
      roundTrips: metrics.rollback?.legacyModelRoundTrips,
    },
  }
  metrics.sessionIDs = {
    group: groupSessionID,
    adoptedGroup: adoptedGroupSessionID,
    direct: directSessionID,
  }
  metrics.channels = { workspace: workspaceChannel, direct: directChannel }

  // Re-read after the rollback task so the restart comparison includes every
  // terminal row the main phase created.
  const finalWorkspaceHistory = await pageHistoryIDs(workspaceChannel)
  const finalDirectHistory = await pageHistoryIDs(directChannel)
  stateFileData.workHistory = { workspace: finalWorkspaceHistory.ids, direct: finalDirectHistory.ids }
  metrics.workHistory.workspaceTasks = finalWorkspaceHistory.ids.length
  metrics.workHistory.directTasks = finalDirectHistory.ids.length

  stateFileData.phase = "main"
  stateFileData.leadID = lead.id
  stateFileData.peerID = peer.id
  stateFileData.workspaceID = workspace.id
  stateFileData.groupSessionID = adoptedGroupSessionID
  stateFileData.previousGroupSessionID = previousGroupSessionID
  stateFileData.directSessionID = directSessionID
  stateFileData.directChannel = directChannel
  stateFileData.workspaceChannel = workspaceChannel
  stateFileData.nativeCount = Object.values(snapshot.subtasks ?? {}).filter((task) => task.origin === "native").length
  stateFileData.nativeTerminal = terminalNativeCount(snapshot, adoptedGroupSessionID) + terminalNativeCount(snapshot, directSessionID)
}

let stateFileData = { phase }

async function restart() {
  const saved = JSON.parse(readFileSync(stateFile, "utf8"))
  stateFileData = saved
  assert("restart has the main-phase scenario state", Boolean(saved.leadID && saved.workspaceID && saved.groupSessionID && saved.directSessionID))
  assert("restart has the pre-restart history", Array.isArray(saved.workHistory?.workspace) && Array.isArray(saved.workHistory?.direct))
  const diag = await diagnostic()
  const snapshot = diag.state
  assert("restart keeps native-first on", snapshot.settings.nativeFirst === "on")
  assert("restart reports native sync live", diag.native?.sync?.state === "live", diag.native?.sync?.state)
  const workspaceBinding = bindingFor(snapshot, saved.leadID, saved.workspaceID, "workspace")
  const directBinding = bindingFor(snapshot, saved.leadID, saved.workspaceID, "direct")
  assert("restart preserves the group binding", workspaceBinding?.sessionID === saved.groupSessionID)
  assert("restart preserves the direct binding", directBinding?.sessionID === saved.directSessionID)
  assert("restart keeps the replaced session in binding history", (workspaceBinding?.history ?? []).includes(saved.previousGroupSessionID))

  const nativeTurns = Object.values(snapshot.subtasks ?? {}).filter((task) => task.origin === "native")
  assert("restart preserves every durable native turn", nativeTurns.length >= saved.nativeCount)
  const terminal = nativeTurns.filter((task) => ["replied", "cancelled", "failed", "interrupted"].includes(task.native?.phase))
  assert("restart preserves terminal native phases", terminal.length >= saved.nativeTerminal)
  const stuck = nativeTurns.filter((task) => ["queued", "working", "retrying"].includes(task.native?.phase))
  assert("restart leaves no stuck native turn", stuck.length === 0, stuck.length)

  const workspaceHistory = await pageHistoryIDs(saved.workspaceChannel)
  const directHistory = await pageHistoryIDs(saved.directChannel)
  assert("restart workspace Work history matches the pre-restart page", workspaceHistory.ids.join(",") === saved.workHistory.workspace.join(","))
  assert("restart direct Work history matches the pre-restart page", directHistory.ids.join(",") === saved.workHistory.direct.join(","))

  const inbox = await promptNative(saved.groupSessionID, "native-restart-fixture")
  const settled = await waitFor("the post-restart native turn", (next) => {
    const task = nativeTask(next, saved.groupSessionID, inbox.id)
    return Boolean(task?.native?.phase === "replied" && task.resultMessageID)
  }, 60_000)
  const after = settled.state
  const task = nativeTask(after, saved.groupSessionID, inbox.id)
  assert("post-restart prompt ingests into the same conversation", task.conversationID === saved.workspaceChannel)
  check("post-restart sync returned live", (await diagnostic()).native?.sync?.state === "live")

  // --- shadow-mode contract ----------------------------------------------
  await invoke("settings.update", { nativeFirst: "shadow" })
  const shadowBefore = await state()
  const shadowBinding = await invoke("agent.sessionBinding", { agentID: saved.leadID, workspaceID: saved.workspaceID, conversation: "workspace" })
  check(
    "shadow setting and binding report the shadow mode",
    shadowBefore.settings.nativeFirst === "shadow" && shadowBinding.mode === "shadow",
  )
  const shadowMarker = "shadow-mode-fixture"
  const shadowPeerName = String(shadowBefore.agents?.[saved.peerID]?.name ?? "").trim()
  assert("shadow mention prompt names a roster peer", Boolean(shadowPeerName))
  const shadowInbox = await promptNative(saved.groupSessionID, `${shadowMarker} ask $${shadowPeerName}`)
  if (typeof client.session.wait === "function") await client.session.wait({ sessionID: saved.groupSessionID }).catch(() => undefined)
  await sleep(1500)
  const shadowDiag = await diagnostic()
  const shadowAfter = shadowDiag.state
  const shadowRows = shadowDiag.native?.shadow?.last ?? []
  const shadowComparison = shadowRows.find((row) => row.inboxID === shadowInbox.id)
  const shadowUnexplainedMismatch = Boolean(
    shadowComparison
    && (!shadowComparison.phaseMatch || !shadowComparison.textMatch || !shadowComparison.routingMatch),
  )
  const shadowOutcome = {
    ingested: Boolean(shadowComparison) && (shadowDiag.native?.shadow?.comparisons ?? 0) > 0,
    visiblePathUnchanged: shadowOutcomeVisiblePath(shadowBefore, shadowAfter, saved, shadowInbox.id),
    comparisonRows: Boolean(
      shadowComparison
      && shadowComparison.textLength > 0
      && /^[a-f0-9]{32}$/.test(String(shadowComparison.textDigest ?? ""))
      && shadowComparison.phaseMatch
      && shadowComparison.textMatch
      && shadowComparison.routingMatch
      && !shadowUnexplainedMismatch
      && ["replied", "failed", "interrupted", "cancelled"].includes(shadowComparison.phase),
    ),
    unexplainedMismatch: shadowUnexplainedMismatch,
    mentionPrompt: Boolean(shadowComparison && shadowComparison.plannedUserRoutes > 0),
    phase: shadowComparison?.phase,
    phaseMatch: shadowComparison?.phaseMatch,
    textLength: shadowComparison?.textLength,
    textMatch: shadowComparison?.textMatch,
    plannedUserRoutes: shadowComparison?.plannedUserRoutes,
    plannedRoutes: shadowComparison?.plannedRoutes,
    visibleRoutes: shadowComparison?.visibleRoutes,
    routingDelta: shadowComparison?.routingDelta,
    routingMatch: shadowComparison?.routingMatch,
  }
  assert(
    "the shadow mention prompt plans a route delta",
    shadowOutcome.mentionPrompt && shadowOutcome.routingDelta === shadowOutcome.plannedRoutes,
    JSON.stringify({ plannedUserRoutes: shadowOutcome.plannedUserRoutes, plannedRoutes: shadowOutcome.plannedRoutes, routingDelta: shadowOutcome.routingDelta }),
  )
  const shadowOk = shadowOutcome.ingested
    && shadowOutcome.visiblePathUnchanged
    && shadowOutcome.comparisonRows
    && shadowOutcome.mentionPrompt
  check(
    "shadow ingests, compares, and leaves the visible path unchanged",
    shadowOk,
    JSON.stringify(shadowOutcome),
  )
  if (!shadowOk) {
    gaps.push({
      name: "shadow-mode-ingestion-and-comparison",
      observed: shadowOutcome,
      expected: "shadow ingests without changing the visible path and records a final-text/phase/routing comparison row",
      note: "#230 shadow ingestion or comparison did not produce the required observation",
    })
  }
  metrics.shadow = shadowOutcome
  await invoke("settings.update", { nativeFirst: "on" })
  metrics.restart = {
    nativeTurns: nativeTurns.length,
    terminalTurns: terminal.length,
    stuckTurns: stuck.length,
    workspaceHistoryTasks: workspaceHistory.ids.length,
    directHistoryTasks: directHistory.ids.length,
    postRestartTurn: Boolean(task),
    shadow: shadowOutcome,
  }
  stateFileData.phase = "restart"
}

function visibleMessageCount(snapshot) {
  return Object.values(snapshot.messages ?? {}).reduce((total, list) => total + (Array.isArray(list) ? list.length : 0), 0)
}

function shadowOutcomeVisiblePath(before, after, saved, inboxID) {
  // The pre-cutover visible path must be byte-for-byte unchanged: same mode,
  // no durable native turn for the prompt, and no message/subtask growth.
  return after.settings.nativeFirst === "shadow"
    && !nativeTask(after, saved.groupSessionID, inboxID)
    && Object.keys(after.subtasks ?? {}).length === Object.keys(before.subtasks ?? {}).length
    && visibleMessageCount(after) === visibleMessageCount(before)
}

try {
  if (phase === "main") await main()
  else if (phase === "restart") await restart()
  else throw new Error(`unknown phase: ${phase}`)
} catch (error) {
  failures.push(String(error?.message ?? error))
  process.stderr.write(`native-first-driver: ${error?.stack ?? error}\n`)
}

const output = {
  schema: "ensemble.native-first-cutover",
  version: 1,
  phase,
  project: "<project>",
  checks,
  failures,
  gaps,
  metrics,
  counts: {
    checks: checks.length,
    passed: checks.filter((entry) => entry.ok).length,
    failed: checks.filter((entry) => !entry.ok).length,
    gaps: gaps.length,
  },
  privacy: {
    promptText: false,
    answerText: false,
    fileBytes: false,
    absolutePaths: false,
    credentials: false,
  },
}

if (phase === "main") {
  stateFileData.metrics = metrics
  stateFileData.checks = checks
  stateFileData.failures = failures
  stateFileData.gaps = gaps
  writeFileSync(stateFile, `${JSON.stringify(stateFileData, null, 2)}\n`)
}
writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ phase, checks: output.counts, gaps: gaps.map((gap) => gap.name), failures }, null, 2)}\n`)
if (failures.length > 0) process.exit(1)
