#!/usr/bin/env node
// Ticket #210: native host event-contract probe.
//
// Drives a bounded sequence of real native turns through the public client API
// on an isolated OpenCode host, while a probe plugin records the host's own
// plugin-context event stream (the surface the Ensemble service ingests). The
// two sources are deduplicated by host event id and written as a JSONL fixture.
//
// The fixture records identities and shapes, not conversation content: every
// text value becomes a length plus a short digest, file bytes are never read,
// and absolute paths become stable placeholders.
//
// This is verification infrastructure. The product plugin never imports it.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { OpenCode } from "@opencode/client"

const args = process.argv.slice(2)
function argValue(name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = args[index + 1]
  return value === undefined ? fallback : value
}
function requiredArg(name) {
  const value = argValue(name, "")
  if (!value) {
    process.stderr.write(`host-probe: missing ${name}\n`)
    process.exit(2)
  }
  return value
}

const baseUrl = requiredArg("--url")
const password = requiredArg("--password")
const projectDir = requiredArg("--project")
const workspaceDir = requiredArg("--workspace")
const outFile = requiredArg("--out")
const eventsFile = requiredArg("--events")
const versions = {
  node: argValue("--node-version", process.version),
  opencode: argValue("--opencode-version", "unknown"),
  tmux: argValue("--tmux-version", "unknown"),
  provider: "ensemble-fake (local OpenAI-compatible fixture)",
}
const caseTimeoutMs = Number(argValue("--case-timeout-ms", "45000"))

const client = OpenCode.make({
  baseUrl,
  headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") },
})

// --- record state ---------------------------------------------------------

const caseOrder = []
const caseRecords = new Map()
let currentCase = "setup"
let caseStartedAt = Date.now()
function ensureCase(name) {
  if (!caseRecords.has(name)) caseRecords.set(name, [])
  return caseRecords.get(name)
}
function record(value) {
  ensureCase(currentCase).push({ at: Date.now(), ...value })
}
function flushPartial(error) {
  try {
    const partial = {}
    for (const [name, entries] of caseRecords) partial[name] = entries
    writeFileSync(`${outFile}.partial.json`, JSON.stringify({ error: String(error), caseOrder, partial }, null, 2))
  } catch {
    // The original failure remains the important one.
  }
}
process.on("uncaughtException", (error) => {
  flushPartial(error)
  process.stderr.write(`host-probe: ${error?.stack ?? error}\n`)
  process.exit(1)
})
process.on("unhandledRejection", (error) => {
  flushPartial(error)
  process.stderr.write(`host-probe: ${error?.stack ?? error}\n`)
  process.exit(1)
})

// --- identity and shape normalization ------------------------------------

const sessionLabels = new Map()
const messageLabels = new Map()
const eventLabels = new Map()
const pathRoots = [
  [workspaceDir, "<workspace>"],
  [projectDir, "<project>"],
]
function labelFor(map, prefix, value) {
  if (typeof value !== "string" || value.length === 0) return value
  if (!map.has(value)) map.set(value, `${prefix}${map.size + 1}`)
  return map.get(value)
}
const sid = (value) => labelFor(sessionLabels, "s", value)
const mid = (value) => labelFor(messageLabels, "m", value)
const eid = (value) => labelFor(eventLabels, "e", value)
function normalizePath(value) {
  if (typeof value !== "string") return value
  let out = value
  for (const [root, label] of pathRoots) out = out.split(root).join(label)
  out = out.replace(/(^|[\s"'(=,:])(\/[^\s"')]+)/g, "$1<path>")
  return out
}
function redact(value) {
  let out = normalizePath(String(value))
  for (const [raw, label] of sessionLabels) out = out.split(raw).join(label)
  for (const [raw, label] of messageLabels) out = out.split(raw).join(label)
  out = out.replace(/\b(?:ses|msg|evt|inbox)_[A-Za-z0-9]+\b/g, "<id>")
  return out
}
function digest(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 16)
}
function textShape(text) {
  if (typeof text !== "string") return undefined
  return { length: text.length, digest: digest(text) }
}
function errorShape(error) {
  if (!error) return undefined
  const status = error.status ?? error.response?.status ?? error.cause?.status
  return {
    name: typeof error.name === "string" ? error.name : "Error",
    status: typeof status === "number" ? status : undefined,
    message: typeof error.message === "string" ? redact(error.message).slice(0, 240) : undefined,
  }
}
function locationShape(location) {
  if (!location || typeof location !== "object") return undefined
  return {
    directory: normalizePath(location.directory),
    hasWorkspaceID: typeof location.workspaceID === "string" && location.workspaceID.length > 0,
  }
}
function fileShape(file) {
  if (!file || typeof file !== "object") return file
  const shape = {}
  if (typeof file.uri === "string") shape.uri = normalizePath(file.uri)
  if (typeof file.name === "string") shape.name = file.name
  if (typeof file.description === "string") shape.description = file.description
  if (file.mention) shape.mention = file.mention
  if (typeof file.mime === "string") shape.mime = file.mime
  if (typeof file.data === "string") shape.dataLength = file.data.length
  if (file.source && typeof file.source === "object") shape.sourceType = file.source.type
  if (typeof file.bytes === "number") shape.bytes = file.bytes
  return shape
}
function metadataShape(metadata) {
  if (!metadata || typeof metadata !== "object") return metadata
  const shape = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "childID" || key === "sessionID" || key === "parentID") shape[key] = sid(value)
    else if (key === "inboxID" || key === "messageID") shape[key] = mid(value)
    else if (typeof value === "string" && /^(?:ses|msg|evt)_/.test(value)) shape[key] = "<id>"
    else shape[key] = value
  }
  return shape
}
function payloadShape(payload) {
  if (!payload || typeof payload !== "object") return payload
  const shape = {}
  if ("text" in payload) shape.text = textShape(payload.text)
  if ("description" in payload) shape.description = payload.description
  if (Array.isArray(payload.files)) shape.files = payload.files.map(fileShape)
  if (Array.isArray(payload.agents)) shape.agents = payload.agents.map((agent) => ({ name: agent.name, mention: agent.mention }))
  if (Array.isArray(payload.skills)) shape.skills = payload.skills.map((skill) => ({ id: skill.id, mention: skill.mention }))
  if (payload.metadata !== undefined) shape.metadata = metadataShape(payload.metadata)
  return shape
}
function statusShape(status) {
  if (!status || typeof status !== "object") return status
  if (status.type === "retry") {
    return {
      type: "retry",
      attempt: status.attempt,
      nextInMs: typeof status.next === "number" ? status.next : undefined,
      hasMessage: typeof status.message === "string" && status.message.length > 0,
    }
  }
  return { type: status.type }
}
function durableShape(durable) {
  if (!durable || typeof durable !== "object") return undefined
  return { aggregate: sid(durable.aggregateID), seq: durable.seq, version: durable.version }
}

function normalizeEventData(type, data, created) {
  if (!data || typeof data !== "object") return data
  switch (type) {
    case "session.inbox.enqueued":
      return {
        sessionID: sid(data.sessionID),
        inboxID: mid(data.inboxID),
        item: data.item
          ? { type: data.item.type, delivery: data.item.delivery, payload: payloadShape(data.item.payload) }
          : undefined,
      }
    case "session.inbox.delivered":
    case "session.inbox.cancelled":
      return { sessionID: sid(data.sessionID), inboxID: mid(data.inboxID) }
    case "session.inbox.delivery.changed":
      return { sessionID: sid(data.sessionID), inboxID: mid(data.inboxID), delivery: data.delivery }
    case "session.text.started":
    case "session.text.ended":
      return {
        sessionID: sid(data.sessionID),
        assistantMessageID: mid(data.assistantMessageID),
        ordinal: data.ordinal,
        text: data.text === undefined ? undefined : textShape(data.text),
        hasNative: data.native !== undefined,
      }
    case "session.text.delta":
      return {
        sessionID: sid(data.sessionID),
        assistantMessageID: mid(data.assistantMessageID),
        ordinal: data.ordinal,
        deltaLength: typeof data.delta === "string" ? data.delta.length : undefined,
      }
    case "session.execution.started":
    case "session.execution.succeeded":
    case "session.idle":
      return { sessionID: sid(data.sessionID) }
    case "session.execution.failed":
      return { sessionID: sid(data.sessionID), error: errorShape(data.error) }
    case "session.execution.interrupted":
      return { sessionID: sid(data.sessionID), reason: data.reason }
    case "session.retry.scheduled":
      return {
        sessionID: sid(data.sessionID),
        assistantMessageID: mid(data.assistantMessageID),
        attempt: data.attempt,
        delayMs: typeof data.at === "number" && typeof created === "number" ? data.at - created : undefined,
        error: data.error
          ? {
              type: data.error.type,
              status: data.error.status,
              retryAfterMs: data.error.retryAfterMs,
              hasMessage: typeof data.error.message === "string" && data.error.message.length > 0,
            }
          : undefined,
      }
    case "session.status":
      return { sessionID: sid(data.sessionID), status: statusShape(data.status) }
    case "session.synthetic":
      return {
        sessionID: sid(data.sessionID),
        text: textShape(data.text),
        description: data.description,
        metadataKeys: data.metadata && typeof data.metadata === "object" ? Object.keys(data.metadata) : [],
      }
    case "session.created":
      return {
        sessionID: sid(data.sessionID),
        parentID: data.parentID === undefined ? undefined : sid(data.parentID),
        location: locationShape(data.location),
        titleLength: typeof data.title === "string" ? data.title.length : undefined,
        hostVersion: data.version,
      }
    case "session.deleted":
      return { sessionID: sid(data.sessionID) }
    case "session.moved":
      return { sessionID: sid(data.sessionID), location: locationShape(data.location), subpath: data.subpath }
    case "session.archived":
    case "session.unarchived":
      return { sessionID: sid(data.sessionID) }
    default:
      return genericShape(data)
  }
}
function genericShape(value) {
  if (Array.isArray(value)) return value.map(genericShape)
  if (!value || typeof value !== "object") return typeof value === "string" ? redact(value) : value
  const shape = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === "sessionID" || key === "parentID" || key === "childSessionID") shape[key] = sid(item)
    else if (key === "inboxID" || key === "assistantMessageID" || key === "messageID") shape[key] = mid(item)
    else if (key === "text" || key === "delta") shape[key] = textShape(item)
    else if (key === "location") shape[key] = locationShape(item)
    else if (key === "metadata") shape[key] = item
    else if (typeof item === "string" && item.length > 120) shape[key] = { length: item.length }
    else shape[key] = genericShape(item)
  }
  return shape
}

// --- raw event sources ----------------------------------------------------

const httpEvents = []
const httpAbort = new AbortController()
const HTTP_TYPES = [
  "session.created",
  "session.deleted",
  "session.moved",
  "session.archived",
  "session.unarchived",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.retry.scheduled",
  "session.status",
  "session.idle",
  "session.synthetic",
]
function eventKey(event) {
  if (typeof event.id === "string" && event.id.length > 0) return `id:${event.id}`
  return `${event.type}:${event.created}:${JSON.stringify(event.data ?? {})}`
}
async function consumeHttpEvents() {
  try {
    for await (const event of client.event.subscribe({ types: HTTP_TYPES, signal: httpAbort.signal })) {
      if (event.type === "server.connected") continue
      if (!String(event.type).startsWith("session.")) continue
      httpEvents.push({ source: "http", event })
    }
  } catch {
    // Abort closes the iterator.
  }
}
function readPluginEvents() {
  let text = ""
  try {
    text = readFileSync(eventsFile, "utf8")
  } catch {
    return []
  }
  const events = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // The plugin appends complete lines; ignore a partial tail on a race.
    }
  }
  return events
}
function mergedEvents() {
  const merged = new Map()
  for (const event of httpEvents) {
    if (typeof event.event?.id === "string") merged.set(eventKey(event.event), { source: "http", event: event.event })
  }
  for (const entry of readPluginEvents()) {
    if (entry.kind === "ready") continue
    if (entry.kind === "event" && entry.event) {
      merged.set(eventKey(entry.event), { source: "plugin", observer: entry.observer, event: entry.event })
    } else if (typeof entry.type === "string") {
      // Backward-compatible raw event line from an earlier probe build.
      merged.set(eventKey(entry), { source: "plugin", event: entry })
    }
  }
  return [...merged.values()].sort((left, right) => {
    const delta = (left.event.created ?? 0) - (right.event.created ?? 0)
    if (delta !== 0) return delta
    if (left.source === right.source) return 0
    return left.source === "plugin" ? -1 : 1
  })
}
function waitForEvent(from, predicate, description, timeoutMs = caseTimeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const events = mergedEvents()
      for (let index = from; index < events.length; index += 1) {
        if (predicate(events[index])) {
          clearInterval(timer)
          resolve(events[index])
          return
        }
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`timed out waiting for ${description}`))
      }
    }, 25)
  })
}
function eventMark() {
  return mergedEvents().length
}
function sessionHasEvent(events, type, sessionID) {
  return events.some((entry) => entry.event.type === type && entry.event.data?.sessionID === sessionID)
}

function waitForPluginReady(directory, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const ready = readPluginEvents().find((entry) => entry.kind === "ready" && entry.directory === directory)
      if (ready) {
        clearInterval(timer)
        resolve(ready)
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`plugin did not become ready for ${normalizePath(directory)}`))
      }
    }, 25)
  })
}

// --- client helpers -------------------------------------------------------

function recordApi(action, input, result) {
  record({ kind: "api", action, input, result })
}
async function api(action, input, call, normalize) {
  try {
    const result = await call()
    recordApi(action, input, { ok: true, ...(normalize ? normalize(result) : {}) })
    return result
  } catch (error) {
    recordApi(action, input, { ok: false, error: errorShape(error) })
    throw error
  }
}
async function tryApi(action, input, call, normalize) {
  try {
    const result = await call()
    recordApi(action, input, { ok: true, ...(normalize ? normalize(result) : {}) })
    return { ok: true, result }
  } catch (error) {
    recordApi(action, input, { ok: false, error: errorShape(error) })
    return { ok: false, error: errorShape(error) }
  }
}
function sessionInfoShape(info) {
  if (!info || typeof info !== "object") return info
  return {
    sessionID: sid(info.id),
    parentID: info.parentID === undefined ? undefined : sid(info.parentID),
    location: locationShape(info.location),
    hasTitle: typeof info.title === "string" && info.title.length > 0,
    archived: typeof info.time?.archived === "number",
    outcome: info.outcome,
    agent: typeof info.agent === "string" ? info.agent : undefined,
    model: info.model ? { providerID: info.model.providerID, id: info.model.id } : undefined,
  }
}
function inboxShape(inbox) {
  if (!inbox || typeof inbox !== "object") return inbox
  return {
    inboxID: mid(inbox.id),
    sessionID: sid(inbox.sessionID),
    type: inbox.type,
    delivery: inbox.delivery,
    payload: payloadShape(inbox.payload),
  }
}
function listShape(response) {
  const data = Array.isArray(response?.data) ? response.data : []
  return { count: data.length, sessions: data.map((info) => sid(info.id)), hasNext: Boolean(response?.cursor?.next) }
}

async function contextSnapshot(caseName, sessionID) {
  const messages = await client.session.context({ sessionID })
  const shape = messages.map((message) => {
    const entry = {
      id: mid(message.id),
      type: message.type,
      created: message.time?.created,
      completed: message.time?.completed,
      streamed: message.time?.streamed,
    }
    if (typeof message.text === "string") entry.text = textShape(message.text)
    if (typeof message.description === "string") entry.description = message.description
    if (message.files !== undefined) entry.files = message.files.map(fileShape)
    if (message.metadata !== undefined) entry.metadata = metadataShape(message.metadata)
    if (message.content !== undefined) {
      entry.content = message.content.map((part) => {
        if (part.type === "text") return { type: "text", text: textShape(part.text) }
        if (part.type === "tool") {
          return { type: "tool", toolID: part.id, name: part.name, status: part.state?.status, executed: part.executed }
        }
        return { type: part.type }
      })
    }
    if (message.finish !== undefined) entry.finish = message.finish
    if (message.error !== undefined) entry.error = { type: message.error.type, status: message.error.status }
    return entry
  })
  record({ kind: "context", case: caseName, session: sid(sessionID), messages: shape })
  return shape
}

function findUserMessage(context, textDigest) {
  const users = context.filter((message) => message.type === "user")
  if (textDigest === undefined) return users.at(-1)
  return users.find((message) => message.text?.digest === textDigest) ?? users.at(-1)
}
function findLastAssistant(context) {
  return context.filter((message) => message.type === "assistant").at(-1)
}

function recordTurnFinding(caseName, sessionID, context, expectedUserDigest) {
  const userMessage = findUserMessage(context, expectedUserDigest)
  const assistantMessage = findLastAssistant(context)
  const events = mergedEvents()
    .filter((entry) => entry.event.data?.sessionID === sessionID)
    .map((entry) => entry.event)
  const enqueued = events.filter((event) => event.type === "session.inbox.enqueued").at(-1)
  const delivered = events.filter((event) => event.type === "session.inbox.delivered").at(-1)
  const started = events.filter((event) => event.type === "session.text.started")
  const ended = events.filter((event) => event.type === "session.text.ended")
  const firstDelta = events.findIndex((event) => event.type === "session.text.delta")
  const firstEnded = events.findIndex((event) => event.type === "session.text.ended")
  const startedIndex = events.findIndex((event) => event.type === "session.execution.started")
  const deliveredIndex = events.findIndex((event) => event.type === "session.inbox.delivered")
  record({
    kind: "finding",
    case: caseName,
    id: "execution-started-precedes-inbox-delivered",
    value: startedIndex >= 0 && deliveredIndex >= 0 && startedIndex < deliveredIndex,
    executionStartedIndex: startedIndex,
    inboxDeliveredIndex: deliveredIndex,
  })
  record({
    kind: "finding",
    case: caseName,
    id: "text-delta-precedes-text-ended",
    value: firstDelta >= 0 && firstEnded > firstDelta,
    firstDeltaIndex: firstDelta,
    firstEndedIndex: firstEnded,
  })
  record({
    kind: "finding",
    case: caseName,
    id: "inbox-id-equals-context-user-id",
    value: Boolean(enqueued && userMessage && mid(enqueued.data.inboxID) === userMessage.id),
    inboxID: enqueued ? mid(enqueued.data.inboxID) : undefined,
    contextUserMessageID: userMessage?.id,
  })
  record({
    kind: "finding",
    case: caseName,
    id: "inbox-delivered-inbox-id-equals-prompt",
    value: Boolean(enqueued && delivered && enqueued.data.inboxID === delivered.data.inboxID),
    promptInboxID: enqueued ? mid(enqueued.data.inboxID) : undefined,
    deliveredInboxID: delivered ? mid(delivered.data.inboxID) : undefined,
  })
  record({
    kind: "finding",
    case: caseName,
    id: "inbox-text-equals-context-user-text",
    value: Boolean(enqueued && userMessage && textShape(enqueued.data.item?.payload?.text)?.digest === userMessage.text?.digest),
  })
  record({
    kind: "finding",
    case: caseName,
    id: "text-started-id-equals-context-assistant-id",
    value: Boolean(started.length > 0 && assistantMessage && started.every((event) => mid(event.data.assistantMessageID) === assistantMessage.id)),
    startedIDs: [...new Set(started.map((event) => mid(event.data.assistantMessageID)))],
    contextAssistantMessageID: assistantMessage?.id,
  })
  record({
    kind: "finding",
    case: caseName,
    id: "text-ended-id-equals-context-assistant-id",
    value: Boolean(ended.length > 0 && assistantMessage && ended.every((event) => mid(event.data.assistantMessageID) === assistantMessage.id)),
    endedIDs: [...new Set(ended.map((event) => mid(event.data.assistantMessageID)))],
    contextAssistantMessageID: assistantMessage?.id,
  })
  record({
    kind: "finding",
    case: caseName,
    id: "context-includes-idle-marker",
    value: context.some((message) => message.type === "idle"),
  })
  if (ended.length > 0) {
    const assistantTextParts = Array.isArray(assistantMessage?.content)
      ? assistantMessage.content.filter((part) => part.type === "text")
      : []
    record({
      kind: "finding",
      case: caseName,
      id: "ended-text-parts-match-context-assistant-text",
      value:
        assistantTextParts.length === ended.length &&
        assistantTextParts.every((part, index) => part.text?.length === textShape(ended[index].data.text)?.length),
      endedParts: ended.length,
      contextTextParts: assistantTextParts.length,
    })
  }
}

// --- scenario helpers -----------------------------------------------------

const sessionCase = new Map()
async function createSession(caseName, directory, title) {
  const info = await api(
    "session.create",
    { directory: normalizePath(directory) },
    () => client.session.create({ location: { directory }, title }),
    sessionInfoShape,
  )
  sessionCase.set(info.id, caseName)
  return info
}
async function prompt(caseName, sessionID, text, extra = {}) {
  return api(
    "session.prompt",
    {
      session: sid(sessionID),
      text: textShape(text),
      metadata: extra.metadata,
      files: extra.files ? extra.files.map(fileShape) : undefined,
      delivery: extra.delivery,
    },
    () => client.session.prompt({ sessionID, text, ...extra }),
    inboxShape,
  )
}
async function waitSettled(sessionID, from, description) {
  const terminal = await waitForEvent(
    from,
    (entry) =>
      ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(entry.event.type) &&
      entry.event.data?.sessionID === sessionID,
    `${description} (execution terminal)`,
  )
  // 2.2.6 did not deliver session.idle on this headless host. Keep a short
  // grace window so the fixture records arrival when it does happen; the
  // dedicated idle case later proves the longer-window behavior.
  const idle = await new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const events = mergedEvents()
      if (sessionHasEvent(events, "session.idle", sessionID)) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - started > 300) {
        clearInterval(timer)
        resolve(false)
      }
    }, 25)
  })
  record({ kind: "finding", case: currentCase, id: "idle-emitted-after-terminal", value: idle, terminal: terminal.event.type })
  return { terminal: terminal.event.type, idle }
}
async function waitForChildSession(parentID, from, description) {
  try {
    const created = await waitForEvent(
      from,
      (entry) => entry.event.type === "session.created" && entry.event.data?.parentID === parentID,
      description,
      20_000,
    )
    const rawChildID = created.event.data.sessionID
    sessionCase.set(rawChildID, currentCase)
    return { id: rawChildID, label: sid(rawChildID) }
  } catch {
    // Fall back to the host's parent-scoped list when the created event was
    // emitted before the probe subscription attached.
    const listed = await client.session.list({ parentID })
    const child = listed.data?.[0]
    if (!child) throw new Error("child session was not created")
    sessionCase.set(child.id, currentCase)
    record({ kind: "finding", case: currentCase, id: "child-session-event-observed", value: false })
    return { id: child.id, label: sid(child.id) }
  }
}

async function runCase(name, fn) {
  currentCase = name
  caseOrder.push(name)
  caseStartedAt = Date.now()
  ensureCase(name).push({ at: caseStartedAt, kind: "case.start", case: name })
  await fn()
  ensureCase(name).push({ at: Date.now(), kind: "case.end", case: name })
}

// --- probe ----------------------------------------------------------------

const FIXTURE = {
  direct: "probe-direct-turn",
  workspace: "probe-workspace-turn",
  retry: "fake-retry-fixture",
  interrupt: "fake-interrupt-hold-fixture",
  attachment: "probe-attachment-turn",
  synthetic: "probe-synthetic-turn",
  queued: "probe-queued-turn",
  cancelled: "probe-cancelled-turn",
  moved: "probe-move-turn",
  subagent: "fake-subagent-parent-fixture",
}
const attachmentName = "probe-attachment.txt"
const attachmentBytes = "ticket 210 attachment fixture\n"

const watchdog = setTimeout(() => {
  process.stderr.write(`host-probe: global timeout; partial fixture at ${outFile}\n`)
  process.exit(1)
}, 300_000)
watchdog.unref()

ensureCase("setup").push({
  at: Date.now(),
  kind: "meta",
  schema: "ensemble.native-host-contract",
  version: 1,
  recordedAt: "2026-11-10",
  versions,
  declaredTypes: "@opencode/plugin 2.2.1, @opencode/client 2.2.1",
  note: "Fixed synthetic prompts only. Text is recorded as length plus digest; paths are placeholders.",
})

void consumeHttpEvents()
await new Promise((resolve) => setTimeout(resolve, 500))

const modelList = await api("model.list", {}, () => client.model.list(), (response) => {
  const models = Array.isArray(response?.data) ? response.data : []
  const match = models.find((model) => model.providerID === "ensemble-fake" && model.id === "ensemble-fake-model")
  return { count: models.length, hasFixtureModel: Boolean(match) }
})
if (!modelList || !Array.isArray(modelList.data) || !modelList.data.some((model) => model.providerID === "ensemble-fake" && model.id === "ensemble-fake-model")) {
  throw new Error("fake provider model is not available")
}

// Activate each location before the recorded cases so the per-location plugin
// subscription cannot miss the first session.created event.
const warmProject = await client.session.create({ location: { directory: projectDir }, title: "probe warmup project" })
sessionCase.set(warmProject.id, "warmup")
await waitForPluginReady(projectDir, 20_000)
const warmWorkspace = await client.session.create({ location: { directory: workspaceDir }, title: "probe warmup workspace" })
sessionCase.set(warmWorkspace.id, "warmup")

const fixtureAttachmentPath = `${projectDir}/${attachmentName}`
writeFileSync(fixtureAttachmentPath, attachmentBytes)

let subagentChild
let subagentParent
let directSession

await runCase("direct", async () => {
  const from = eventMark()
  const session = await createSession("direct", projectDir, "probe direct")
  directSession = session
  await prompt("direct", session.id, FIXTURE.direct, { metadata: { "ensemble.probe": "direct" } })
  await waitSettled(session.id, from, "direct turn")
  const context = await contextSnapshot("direct", session.id)
  recordTurnFinding("direct", session.id, context, textShape(FIXTURE.direct)?.digest)
})

await runCase("workspace", async () => {
  const from = eventMark()
  const session = await createSession("workspace", workspaceDir, "probe workspace")
  await prompt("workspace", session.id, FIXTURE.workspace)
  await waitSettled(session.id, from, "workspace turn")
  const context = await contextSnapshot("workspace", session.id)
  recordTurnFinding("workspace", session.id, context, textShape(FIXTURE.workspace)?.digest)
  const workspaceObservers = [
    ...new Set(
      readPluginEvents()
        .filter((entry) => entry.kind === "event" && entry.event?.data?.sessionID === session.id)
        .map((entry) => normalizePath(entry.observer)),
    ),
  ]
  record({
    kind: "finding",
    case: "workspace",
    id: "workspace-events-observed-through-plugin-context",
    value: workspaceObservers.length > 0,
    pluginObservers: workspaceObservers,
    pluginReadyForWorkspace: readPluginEvents().some((entry) => entry.kind === "ready" && entry.directory === workspaceDir),
  })
})

await runCase("retry", async () => {
  const from = eventMark()
  const session = await createSession("retry", projectDir, "probe retry")
  await prompt("retry", session.id, FIXTURE.retry)
  await waitForEvent(from, (entry) => entry.event.type === "session.retry.scheduled" && entry.event.data?.sessionID === session.id, "retry.scheduled")
  await waitSettled(session.id, from, "retry turn")
  const retryEvents = mergedEvents().map((entry) => entry.event).filter((event) => event.data?.sessionID === session.id)
  const scheduled = retryEvents.find((event) => event.type === "session.retry.scheduled")
  const statusRetry = retryEvents.find((event) => event.type === "session.status" && event.data?.status?.type === "retry")
  record({
    kind: "finding",
    case: "retry",
    id: "retry-scheduled-shape",
    value: Boolean(scheduled),
    attempt: scheduled?.data?.attempt,
    errorType: scheduled?.data?.error?.type,
    status: scheduled?.data?.error?.status,
    retryAfterMs: scheduled?.data?.error?.retryAfterMs,
    hasMessage: typeof scheduled?.data?.error?.message === "string",
  })
  record({ kind: "finding", case: "retry", id: "retry-status-event-observed", value: Boolean(statusRetry) })
  const context = await contextSnapshot("retry", session.id)
  recordTurnFinding("retry", session.id, context, textShape(FIXTURE.retry)?.digest)
})

await runCase("interrupt", async () => {
  const from = eventMark()
  const session = await createSession("interrupt", projectDir, "probe interrupt")
  await prompt("interrupt", session.id, FIXTURE.interrupt)
  await waitForEvent(from, (entry) => entry.event.type === "session.text.delta" && entry.event.data?.sessionID === session.id, "interrupt delta")
  const interruptResult = await client.session.interrupt({ sessionID: session.id })
  recordApi("session.interrupt", { session: sid(session.id), state: "streaming" }, { ok: true, ...interruptResult })
  await waitSettled(session.id, from, "interrupt turn")
  const interruptEvents = mergedEvents().map((entry) => entry.event)
  const endedPart = interruptEvents.filter((event) => event.type === "session.text.ended" && event.data?.sessionID === session.id).at(-1)
  record({
    kind: "finding",
    case: "interrupt",
    id: "interrupt-preserves-partial-text",
    value: Boolean(endedPart) && endedPart.data.text.length > 0 && endedPart.data.text.length < 500,
    endedLength: endedPart?.data.text?.length,
    deltasBeforeInterrupt: interruptEvents.filter((event) => event.type === "session.text.delta" && event.data?.sessionID === session.id).length,
  })
  const context = await contextSnapshot("interrupt", session.id)
  recordTurnFinding("interrupt", session.id, context, textShape(FIXTURE.interrupt)?.digest)
})

await runCase("attachment", async () => {
  const from = eventMark()
  const session = await createSession("attachment", projectDir, "probe attachment")
  await prompt("attachment", session.id, FIXTURE.attachment, {
    files: [{ uri: `file://${fixtureAttachmentPath}`, name: attachmentName, description: "ticket 210 attachment fixture" }],
    metadata: { "ensemble.probe": "attachment" },
  })
  await waitSettled(session.id, from, "attachment turn")
  const context = await contextSnapshot("attachment", session.id)
  recordTurnFinding("attachment", session.id, context, textShape(FIXTURE.attachment)?.digest)
  const enqueueEvent = mergedEvents().find((entry) => entry.event.type === "session.inbox.enqueued" && entry.event.data?.sessionID === session.id)
  const enqueuedFile = enqueueEvent ? fileShape(enqueueEvent.event.data.item.payload.files?.[0]) : undefined
  const contextFile = context.find((message) => message.type === "user")?.files?.[0]
  record({
    kind: "finding",
    case: "attachment",
    id: "attachment-enqueued-file-has-uri",
    value: Boolean(enqueuedFile?.uri),
    enqueuedFile: enqueuedFile ? { name: enqueuedFile.name, mime: enqueuedFile.mime, dataLength: enqueuedFile.dataLength, sourceType: enqueuedFile.sourceType } : undefined,
  })
  record({
    kind: "finding",
    case: "attachment",
    id: "attachment-context-file-matches-enqueued",
    value: Boolean(enqueuedFile && contextFile && enqueuedFile.mime === contextFile.mime && enqueuedFile.name === contextFile.name && enqueuedFile.dataLength === contextFile.dataLength),
    contextFile: contextFile ? { name: contextFile.name, mime: contextFile.mime, dataLength: contextFile.dataLength, sourceType: contextFile.sourceType } : undefined,
  })
})

await runCase("synthetic", async () => {
  const from = eventMark()
  const session = await createSession("synthetic", projectDir, "probe synthetic")
  const synthetic = await api(
    "session.synthetic",
    { session: sid(session.id), text: textShape(FIXTURE.synthetic) },
    () => client.session.synthetic({ sessionID: session.id, text: FIXTURE.synthetic, description: "probe synthetic" }),
    inboxShape,
  )
  let syntheticStarted = false
  try {
    await waitForEvent(from, (entry) => entry.event.type === "session.execution.started" && entry.event.data?.sessionID === session.id, "synthetic execution", 3_000)
    syntheticStarted = true
  } catch {
    syntheticStarted = false
  }
  record({ kind: "finding", case: "synthetic", id: "synthetic-starts-execution", value: syntheticStarted, inboxID: mid(synthetic.id) })
  if (syntheticStarted) await waitSettled(session.id, from, "synthetic turn")
  const afterSynthetic = eventMark()
  await prompt("synthetic", session.id, FIXTURE.direct)
  await waitSettled(session.id, afterSynthetic, "post-synthetic turn")
  const context = await contextSnapshot("synthetic", session.id)
  record({ kind: "finding", case: "synthetic", id: "context-has-synthetic-message", value: context.some((message) => message.type === "synthetic") })
  record({
    kind: "finding",
    case: "synthetic",
    id: "synthetic-event-observed",
    value: mergedEvents().some((entry) => entry.event.type === "session.synthetic"),
  })
})

await runCase("subagent", async () => {
  const from = eventMark()
  const parent = await createSession("subagent", projectDir, "probe subagent parent")
  subagentParent = parent
  await prompt("subagent", parent.id, FIXTURE.subagent)
  const child = await waitForChildSession(parent.id, from, "child session created")
  subagentChild = child.id
  await waitForEvent(from, (entry) => entry.event.type === "session.execution.succeeded" && entry.event.data?.sessionID === parent.id, "parent execution succeeded")
  await waitSettled(parent.id, from, "parent turn")
  const childFrom = eventMark()
  await waitForEvent(childFrom, (entry) => ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(entry.event.type) && entry.event.data?.sessionID === child.id, "child terminal", 60_000)
  // A finished background child injects a synthetic user message into the
  // parent, and the parent runs one more model turn for it.
  const synthetic = await waitForEvent(
    childFrom,
    (entry) => entry.event.type === "session.inbox.enqueued" && entry.event.data?.sessionID === parent.id && entry.event.data?.item?.type === "synthetic",
    "parent synthetic completion",
    20_000,
  )
  await waitForEvent(
    childFrom,
    (entry) => entry.event.type === "session.execution.succeeded" && entry.event.data?.sessionID === parent.id,
    "parent synthetic turn settled",
    30_000,
  )
  record({
    kind: "finding",
    case: "subagent",
    id: "subagent-completion-injects-synthetic-parent-turn",
    value: Boolean(synthetic) && synthetic.event.data.item.payload.text.length > 0,
    syntheticInboxID: mid(synthetic.event.data.inboxID),
    metadataKeys: Object.keys(synthetic.event.data.item.payload.metadata ?? {}),
  })
  await contextSnapshot("subagent-parent", parent.id)
  await contextSnapshot("subagent-child", child.id)
  const events = mergedEvents().map((entry) => entry.event)
  const parentSucceeded = events.findIndex((event) => event.type === "session.execution.succeeded" && event.data?.sessionID === parent.id)
  const childSucceeded = events.findIndex((event) => event.type === "session.execution.succeeded" && event.data?.sessionID === child.id)
  record({
    kind: "finding",
    case: "subagent",
    id: "parent-execution-settles-before-child",
    value: parentSucceeded >= 0 && childSucceeded > parentSucceeded,
    parentSucceeded: parentSucceeded >= 0,
    childSucceeded: childSucceeded >= 0,
  })
  record({ kind: "finding", case: "subagent", id: "child-session-observed", value: true })
})

await runCase("delivery", async () => {
  const from = eventMark()
  const session = await createSession("delivery", projectDir, "probe delivery")
  await prompt("delivery", session.id, FIXTURE.interrupt)
  await waitForEvent(from, (entry) => entry.event.type === "session.text.delta" && entry.event.data?.sessionID === session.id, "delivery hold delta")
  const queued = await prompt("delivery", session.id, FIXTURE.queued, { delivery: "queue" })
  const cancelled = await prompt("delivery", session.id, FIXTURE.cancelled, { delivery: "queue" })
  await api("session.inbox.list", { session: sid(session.id) }, () => client.session.inbox.list({ sessionID: session.id }), (items) => ({
    count: items.length,
    items: items.map((item) => ({ inboxID: mid(item.id), type: item.type, delivery: item.delivery, textLength: item.payload?.text?.length })),
  }))
  await api(
    "session.inbox.update",
    { session: sid(session.id), inbox: mid(queued.id), delivery: "steer" },
    () => client.session.inbox.update({ sessionID: session.id, inboxID: queued.id, delivery: "steer" }),
  )
  await waitForEvent(from, (entry) => entry.event.type === "session.inbox.delivery.changed" && mid(entry.event.data?.inboxID) === mid(queued.id), "delivery.changed")
  await api(
    "session.inbox.cancel",
    { session: sid(session.id), inbox: mid(cancelled.id) },
    () => client.session.inbox.cancel({ sessionID: session.id, inboxID: cancelled.id }),
  )
  await waitForEvent(from, (entry) => entry.event.type === "session.inbox.cancelled" && mid(entry.event.data?.inboxID) === mid(cancelled.id), "inbox.cancelled")
  await api("session.inbox.list:after", { session: sid(session.id) }, () => client.session.inbox.list({ sessionID: session.id }), (items) => ({
    count: items.length,
    items: items.map((item) => ({ inboxID: mid(item.id), type: item.type, delivery: item.delivery })),
  }))
  const busyMove = await tryApi(
    "session.move",
    { session: sid(session.id), directory: "<workspace>", state: "busy" },
    () => client.session.move({ sessionID: session.id, directory: workspaceDir }),
  )
  record({ kind: "finding", case: "delivery", id: "busy-session-move-refused", value: busyMove.ok === false, error: busyMove.ok ? undefined : busyMove.error })
  const moveItem = mergedEvents().find(
    (entry) => entry.event.type === "session.inbox.enqueued" && entry.event.data?.sessionID === session.id && entry.event.data?.item?.type === "move",
  )
  record({
    kind: "finding",
    case: "delivery",
    id: "busy-move-enqueues-move-item",
    value: Boolean(moveItem),
    inboxID: moveItem ? mid(moveItem.event.data.inboxID) : undefined,
    delivery: moveItem?.event.data.item.delivery,
  })
  const busyGet = await api("session.get", { session: sid(session.id) }, () => client.session.get({ sessionID: session.id }), sessionInfoShape)
  record({ kind: "finding", case: "delivery", id: "busy-move-keeps-location", value: locationShape(busyGet.location)?.directory === "<project>" })
  const interruptResult = await client.session.interrupt({ sessionID: session.id })
  recordApi("session.interrupt", { session: sid(session.id), state: "busy" }, { ok: true, ...interruptResult })
  await waitSettled(session.id, from, "delivery turn")
  const idleInterrupt = await tryApi(
    "session.interrupt",
    { session: sid(session.id), state: "idle" },
    () => client.session.interrupt({ sessionID: session.id }),
  )
  await api("session.inbox.list:pending-after-interrupt", { session: sid(session.id) }, () => client.session.inbox.list({ sessionID: session.id }), (items) => ({
    count: items.length,
    items: items.map((item) => ({ inboxID: mid(item.id), type: item.type, delivery: item.delivery })),
  }))
  record({
    kind: "finding",
    case: "delivery",
    id: "idle-interrupt-shape",
    value: idleInterrupt.ok ? idleInterrupt.result?.interrupted === false : false,
    result: idleInterrupt.ok ? { interrupted: idleInterrupt.result?.interrupted } : idleInterrupt.error,
  })
  await contextSnapshot("delivery", session.id)
})

let moveSession
await runCase("move", async () => {
  const from = eventMark()
  moveSession = await createSession("move", projectDir, "probe move")
  await prompt("move", moveSession.id, FIXTURE.moved)
  await waitSettled(moveSession.id, from, "move turn")
  await api("session.move", { session: sid(moveSession.id), directory: "<workspace>" }, () => client.session.move({ sessionID: moveSession.id, directory: workspaceDir }))
  const movedEvent = await waitForEvent(from, (entry) => entry.event.type === "session.moved" && entry.event.data?.sessionID === moveSession.id, "session.moved")
  const moveItem = mergedEvents().find((entry) => entry.event.type === "session.inbox.enqueued" && entry.event.data?.sessionID === moveSession.id && entry.event.data?.item?.type === "move")
  record({
    kind: "finding",
    case: "move",
    id: "move-enqueues-inbox-item",
    value: Boolean(moveItem) && movedEvent.event.data?.location?.directory === workspaceDir,
    inboxID: moveItem ? mid(moveItem.event.data.inboxID) : undefined,
    delivery: moveItem?.event.data.item.delivery,
  })
  const moved = await api("session.get", { session: sid(moveSession.id) }, () => client.session.get({ sessionID: moveSession.id }), sessionInfoShape)
  record({ kind: "finding", case: "move", id: "moved-session-location", value: locationShape(moved.location)?.directory === "<workspace>" })
  const missing = await tryApi(
    "session.move",
    { session: sid(moveSession.id), directory: "<missing>" },
    () => client.session.move({ sessionID: moveSession.id, directory: `${workspaceDir}/missing-probe-directory` }),
  )
  record({ kind: "finding", case: "move", id: "move-to-missing-directory", value: missing.ok === false, error: missing.error })
})

await runCase("session-list", async () => {
  const scopes = [
    ["project", { directory: projectDir }],
    ["workspace", { directory: workspaceDir }],
    ["default", {}],
    ["project-roots", { directory: projectDir, parentID: null }],
    ["project-unarchived", { directory: projectDir, archived: false }],
    ["project-archived", { directory: projectDir, archived: true }],
    ["project-search-probe", { directory: projectDir, search: "probe direct" }],
    ["subagent-children", { directory: projectDir, parentID: subagentParent.id }],
  ]
  for (const [name, input] of scopes) {
    await api(`session.list:${name}`, { scope: name }, () => client.session.list(input), listShape)
  }
  await api("session.update", { session: sid(directSession.id), archived: true }, () => client.session.update({ sessionID: directSession.id, archived: true }))
  await api("session.list:project-archived-after", { scope: "project-archived" }, () => client.session.list({ directory: projectDir, archived: true }), listShape)
  await api("session.list:project-unarchived-after", { scope: "project-unarchived" }, () => client.session.list({ directory: projectDir, archived: false }), listShape)
  await api("session.update", { session: sid(directSession.id), archived: false }, () => client.session.update({ sessionID: directSession.id, archived: false }))
})

// The parent spec treats session.idle as a reconciliation hint. This case
// measures whether a headless host/client observes it at all, with and without
// a session view, so later tickets know which signal is authoritative.
await runCase("idle", async () => {
  const from = eventMark()
  await api("session.active", {}, () => client.session.active(), (value) => ({ count: Object.keys(value ?? {}).length }))
  await api("session.view", { session: sid(directSession.id), idle: 0 }, () => client.session.view({ sessionID: directSession.id, idle: 0 }))
  const started = Date.now()
  let idleSessions = []
  while (Date.now() - started < 10_000) {
    idleSessions = mergedEvents()
      .slice(from)
      .filter((entry) => entry.event.type === "session.idle")
      .map((entry) => sid(entry.event.data?.sessionID))
    if (idleSessions.length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  record({
    kind: "finding",
    case: "idle",
    id: "session-idle-observed",
    value: idleSessions.length > 0,
    waitedMs: Date.now() - started,
    idleSessions,
  })
  record({
    kind: "finding",
    case: "idle",
    id: "session-status-events-observed",
    value: mergedEvents().some((entry) => entry.event.type === "session.status"),
    statusEvents: mergedEvents().filter((entry) => entry.event.type === "session.status").length,
  })
})

// --- finalize -------------------------------------------------------------

clearTimeout(watchdog)
httpAbort.abort()

// Attach recorded events to the case that was active when the host emitted
// them. A late event falls back to the case that owns its session; a child
// session created during a parent case belongs to that case.
const windows = caseOrder
  .map((name) => {
    const entries = caseRecords.get(name) ?? []
    const start = entries.find((entry) => entry.kind === "case.start")?.at
    const end = entries.find((entry) => entry.kind === "case.end")?.at
    return { name, start, end }
  })
  .filter((window) => typeof window.start === "number" && typeof window.end === "number")
const rawEvents = mergedEvents()
for (const entry of rawEvents) {
  const event = entry.event
  if (event.type === "session.created" && event.data?.parentID) {
    if (sessionCase.has(event.data.parentID) && sessionCase.get(event.data.parentID) !== "warmup") {
      sessionCase.set(event.data.sessionID, sessionCase.get(event.data.parentID))
    }
  }
  const activeCase = windows.find((window) => event.created >= window.start && event.created <= window.end)?.name
  const owner = activeCase && activeCase !== "warmup" ? activeCase : sessionCase.get(event.data?.sessionID)
  if (!owner || owner === "warmup") continue
  ensureCase(owner).push({
    at: event.created ?? Date.now(),
    kind: "event",
    case: owner,
    source: entry.source,
    observedBy: entry.observer === undefined ? undefined : normalizePath(entry.observer),
    id: eid(event.id),
    type: event.type,
    durable: durableShape(event.durable),
    location: locationShape(event.location),
    data: normalizeEventData(event.type, event.data, event.created),
  })
}

const setupRecords = caseRecords.get("setup") ?? []
const meta = setupRecords.find((entry) => entry.kind === "meta")
const setupFindings = setupRecords.filter((entry) => entry.kind === "finding")

const output = []
if (meta) output.push({ ...meta, at: undefined, t: 0 })
for (const finding of setupFindings) output.push({ ...finding, at: undefined, t: 0 })

for (const name of caseOrder) {
  const records = caseRecords.get(name) ?? []
  const startedAt = records.find((entry) => entry.kind === "case.start")?.at ?? Date.now()
  const merged = records.slice().sort((left, right) => {
    if (left.kind === "case.start") return -1
    if (right.kind === "case.start") return 1
    if (left.kind === "case.end") return 1
    if (right.kind === "case.end") return -1
    return (left.at ?? 0) - (right.at ?? 0)
  })
  let seq = 0
  for (const entry of merged) {
    const cleaned = { ...entry, case: name, t: Math.max(0, (entry.at ?? startedAt) - startedAt) }
    delete cleaned.at
    if (cleaned.kind === "event") cleaned.seq = seq++
    output.push(cleaned)
  }
}

output.push({ kind: "done", cases: caseOrder.length })

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, output.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
process.stdout.write(`${outFile}\n`)
process.exit(0)
