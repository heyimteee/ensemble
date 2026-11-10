#!/usr/bin/env node
// Dependency-free OpenAI-compatible fake provider for live TUI checks.
//
// It implements the model-list endpoint and streaming/non-streaming
// chat-completion endpoint. The response is deterministic:
//   - prompts containing FAKE_RICH_PROMPT stream the rich Markdown fixture
//   - every other prompt returns a short onboarding reply
//
// It is test infrastructure only. The product plugin never loads this file.

import { createServer } from "node:http"
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const FAKE_RICH_PROMPT = "fake-rich-fixture"
const FAKE_BUBBLE_PROMPT = "fake-bubble-fixture"
const FAKE_QUEUE_HOLD_PROMPT = "fake-queue-hold"
const FAKE_QUEUE_HOLD_LONG_PROMPT = "fake-queue-hold-long"
const FAKE_ASK_PROMPT = "fake-ask-person"
// Ticket #225: deterministic tool-surface benchmark. The marker names the
// peer so the same fake provider can drive a native final-text route or a
// send_message tool call without knowing the workspace roster.
const FAKE_BENCHMARK_RE = /fake-benchmark-(native|legacy):([A-Za-z][A-Za-z0-9_-]*)/
// One-shot reduced-motion fixture: a normal 5 s stream so the Work card is
// observable on frame 0 without making the trigger sticky in session history.
const FAKE_MOTION_PROMPT = "fake-motion-static"
const FAKE_NATIVE_ERROR_PROMPT = "fake-native-error"
// Ticket #188: a real native subagent fixture. The parent turn calls the host's
// built-in `subagent` tool in background mode; the child prompt carries the
// child marker so it streams a bounded hold instead of answering immediately.
// The host finalizes the parent's first turn while the child is still running,
// which is exactly the early-finalization condition the barrier must cover.
const FAKE_SUBAGENT_PROMPT = "fake-subagent-parent-fixture"
const FAKE_SUBAGENT_CHILD_PROMPT = "fake-subagent-child-hold-fixture"
// Ticket #210: real host retry fixture. The first streaming request returns a
// retryable 429 with a zero delay; the host schedules `session.retry.scheduled`
// and the next request answers normally. Non-streaming title/aux requests are
// not counted, so the probe's single turn retries exactly once.
const FAKE_RETRY_PROMPT = "fake-retry-fixture"
// Ticket #210: a bounded stream long enough to interrupt mid-text and short
// enough that a missed interrupt still settles in a few seconds.
const FAKE_INTERRUPT_PROMPT = "fake-interrupt-hold-fixture"
const INTERRUPT_HOLD_CHUNKS = 90
// Ticket #227: deterministic agent final-text mention routing. The trigger names
// the peer; the reply body is the final native text the service routes from.
const FAKE_MENTION_FINAL_RE = /fake-mention-final:([A-Za-z][A-Za-z0-9_-]*)/
const FAKE_MENTION_FINAL_MARKER = "AGENT_FINAL_MENTION_MARKER"
// Ticket #227 keeps the retry state visible long enough to assert `retrying`.
// #210's probe leaves the default zero-delay behavior unchanged.
const RETRY_AFTER_MS = Math.max(0, Number(process.env.ENSEMBLE_FAKE_RETRY_DELAY_MS ?? "0"))
const retryFixtureAttempts = new Map()
const SUBAGENT_CHILD_DELAY_MS = Math.max(0, Number(process.env.ENSEMBLE_FAKE_SUBAGENT_CHILD_DELAY_MS ?? "120"))
const SUBAGENT_CHILD_MARKDOWN = [
  "# Subagent child fixture",
  "",
  "SUBAGENT_CHILD_HOLD_MARKER",
  ...Array.from(
    { length: 15 },
    (_, index) => `subagent child line ${index + 1} keeps the real child session working.`,
  ),
  "",
  "",
].join("\n")
// Ticket #165/#177: a stream that deliberately outlives the old five-minute
// delivery deadline while the service heartbeat keeps its lease alive. The
// provider splits text into 24-character chunks, so 170 lines at 700 ms is a
// little over five and a half minutes of streaming.
const FAKE_LEASE_PROMPT = "fake-lease-hold"
const LEASE_HOLD_CHUNKS = 170
const LEASE_HOLD_DELAY_MS = 700
const motionReplies = new Set()
// The host's native /init instruction. A short pause keeps the live init row's
// indeterminate stage observable without slowing any other turn.
const INIT_PROMPT_MARKER = "Preserve verified useful guidance"
// A peer/skill turn carries this instruction. A short pre-stream pause keeps
// the transient `Asking $Name…` work-card window observable on a narrow chat.
const TURN_PROMPT_MARKER = "Answer in this conversation as yourself"
const ASK_QUESTION = "Which release channel should this task use?"
// Ticket #164 dispatch-budget fixture. A marker in the current task
// instruction makes the fake model emit exactly one handoff or continuation
// delegation. The marker is authored by the previous fake tool call (or by the
// driver's initial command), so the chain is deterministic and every hop is a
// real service admission, not a direct RPC write.
const BUDGET_MARKER_RE = /fake-budget-relay:chain=([a-z0-9-]+);consumed=(\d+);total=(\d+);next=([A-Za-z][A-Za-z0-9_-]*);mode=(handoff|continue)/g
const BUDGET_REVIEW_RE = /Before continuing|before continuing/
const MODEL_ID = "ensemble-fake-model"
const askedTasks = new Set()
const budgetToolCalls = new Set()
const reviewToolCalls = new Set()

const RICH_MARKDOWN = [
  "# Rich Markdown Fixture",
  "",
  "Ensemble renders **bold text**, _italic text_, and `inline code` while streaming.",
  "",
  "## Lists",
  "",
  "- alpha item",
  "- beta item with **emphasis**",
  "- gamma item with `code`",
  "",
  "1. ordered one",
  "2. ordered two",
  "",
  "> quoted line one",
  "> quoted line two",
  "",
  "## Fenced code",
  "",
  "```ts",
  'const richCodeMarker = "RICH_CODE_MARKER"',
  "console.log(richCodeMarker)",
  "```",
  "",
  "## Link",
  "",
  "[Ensemble repository](https://github.com/heyimteee/ensemble)",
  "",
  "## Table",
  "",
  "| Feature | Result |",
  "| --- | --- |",
  "| Streaming | stream ok |",
  "| Finalization | table cell marker |",
  "",
].join("\n")

const SHORT_REPLY = "Onboarding complete. I am ready.\n"

// The host validates compaction responses against its structured-summary
// template. A short non-template reply is rejected and retried, which blocks
// the long-lived fake session between live probes.
const COMPACTION_SUMMARY = [
  "## Objective",
  "- Run the deterministic live TUI fixtures.",
  "",
  "## Requirements",
  "- Keep the fixture replies deterministic and bounded.",
  "",
  "## Decisions",
  "- Use a compact summary between live probes.",
  "",
  "## Work State",
  "### Completed",
  "- Earlier live probes.",
  "### Active",
  "- (none)",
  "### Blocked",
  "- (none)",
  "",
  "## Next Move",
  "1. Continue with the next live probe.",
  "",
  "## Relevant Files",
  "- (none)",
  "",
  "## Important Context",
  "- This is a fake-provider compaction fixture.",
  "",
].join("\n")

// A deterministic long stream for the parked-message live probe. The queued
// line only exists while the preceding turn streams, so a fixed-duration rich
// reply made the assertion race the queue transition. At 36 lines and the
// default 35 ms chunk delay this streams for roughly five seconds, leaving a
// stable window for the probe to type, park, assert, and remove without
// weakening the queued/removal assertions. Like the rich and bubble triggers,
// it stays in session history, so later turns keep the long stream too.
const QUEUE_HOLD_MARKDOWN = [
  "# Queue Hold Fixture",
  "",
  "QUEUE_HOLD_MARKER",
  ...Array.from(
    { length: 36 },
    (_, index) => `hold line ${index + 1} keeps this direct reply streaming while the parked-message probe runs.`,
  ),
  "",
].join("\n")

// v7 group-lifecycle fixture: two overlapping groups must stay visible while
// the earlier one is cancelled. At the default 35 ms chunk delay this holds
// for roughly fourteen seconds, well beyond the tmux capture window.
const QUEUE_HOLD_LONG_MARKDOWN = [
  "# Long Queue Hold Fixture",
  "",
  "QUEUE_HOLD_LONG_MARKER",
  ...Array.from(
    { length: 400 },
    (_, index) => `long hold line ${index + 1} keeps this second dispatch group live while the first group is cancelled.`,
  ),
  "",
].join("\n")

// Ticket #210: a bounded stream long enough to interrupt mid-text and short
// enough that a missed interrupt still settles in a few seconds.
const INTERRUPT_HOLD_MARKDOWN = [
  "# Interrupt Hold Fixture",
  "",
  "INTERRUPT_HOLD_MARKER",
  ...Array.from({ length: INTERRUPT_HOLD_CHUNKS }, (_, index) => `interrupt line ${index + 1} keeps this native turn streaming until the probe interrupts it.`),
  "",
].join("\n")

// Ticket #165/#177: 170 lines at 700 ms per provider chunk keeps a run active
// for about 5m40s, past the old five-minute delivery deadline.
const LEASE_HOLD_MARKDOWN = [
  "# Lease Hold Fixture",
  "",
  "LEASE_HOLD_MARKER",
  ...Array.from({ length: LEASE_HOLD_CHUNKS }, (_, index) => `lease line ${index + 1} stays active while the heartbeat renews the lease.`),
  "",
].join("\n")

// Ticket #72 long/multi-element bubble fixture: a long wrapping heading,
// a wrapping paragraph, a list, fenced code, and a table inside one bubble.
// Markers are unique greppable literals; the reply never echoes the trigger
// prompt so the DM user line keeps its exactly-once count.
const BUBBLE_MARKDOWN = [
  "# Bubble Long Heading Marker With Many Words To Force Wrapping Inside The Bounded Bubble Width",
  "",
  "This bubble paragraph carries many words so the fallback pre-wrap and the native Markdown wrap must agree on one shared width, otherwise the bubble bottom lands a line off and collides with the next row.",
  "",
  "## Bubble lists",
  "",
  "- bubble list alpha with enough words to wrap inside the bubble",
  "- bubble list beta",
  "- bubble list gamma",
  "",
  "## Bubble code",
  "",
  "```ts",
  'const bubbleCodeMarker = "BUBBLE_CODE_MARKER"',
  "console.log(bubbleCodeMarker)",
  "```",
  "",
  "## Bubble table",
  "",
  "| Feature | Result |",
  "| --- | --- |",
  "| Wrapping | bubble wrap ok |",
  "| Finalization | bubble table marker |",
  "",
].join("\n")

const args = process.argv.slice(2)
function argValue(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const host = argValue("--host", "127.0.0.1")
const port = Number(argValue("--port", "0"))
const urlFile = argValue("--url-file", "")
const logFile = argValue("--log", "")
const chunkDelay = Math.max(0, Number(argValue("--chunk-delay-ms", process.env.ENSEMBLE_FAKE_CHUNK_DELAY_MS ?? "35")))
const initialDelay = Math.max(0, Number(argValue("--initial-delay-ms", process.env.ENSEMBLE_FAKE_INITIAL_DELAY_MS ?? "250")))
const initDelay = Math.max(0, Number(argValue("--init-delay-ms", process.env.ENSEMBLE_FAKE_INIT_DELAY_MS ?? "1200")))
const turnStartDelay = Math.max(0, Number(argValue("--turn-start-delay-ms", process.env.ENSEMBLE_FAKE_TURN_START_DELAY_MS ?? "800")))
// Required only for the budget fixture: the fake model cannot call
// ensemble_handoff without a real typed file inside the target workspace.
const budgetHandoffDir = argValue("--handoff-dir", process.env.ENSEMBLE_FAKE_HANDOFF_DIR ?? "")
if (budgetHandoffDir) mkdirSync(budgetHandoffDir, { recursive: true })

function log(event, fields = {}) {
  const line = `${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`
  if (logFile) appendFileSync(logFile, line)
  else process.stdout.write(line)
}

function textOf(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (typeof part?.text === "string") return part.text
      if (typeof part?.content === "string") return part.content
      return ""
    })
    .join("")
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => { body += chunk })
    request.on("error", reject)
    request.on("end", () => resolve(body))
  })
}

function completionId() {
  return "chatcmpl-ensemble-fake"
}

function chunkFrame(content, finishReason = null) {
  return `data: ${JSON.stringify({
    id: completionId(),
    object: "chat.completion.chunk",
    created: 1790000000,
    model: MODEL_ID,
    choices: [{
      index: 0,
      delta: finishReason ? {} : { content },
      finish_reason: finishReason,
    }],
  })}\n\n`
}

function roleFrame() {
  return `data: ${JSON.stringify({
    id: completionId(),
    object: "chat.completion.chunk",
    created: 1790000000,
    model: MODEL_ID,
    choices: [{
      index: 0,
      delta: { role: "assistant", content: "" },
      finish_reason: null,
    }],
  })}\n\n`
}

function splitContent(text, size = 24) {
  const chunks = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + size))
    start += size
  }
  return chunks
}

async function streamCompletion(response, text, requestID, stepDelay = chunkDelay) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "close",
    "X-Accel-Buffering": "no",
  })
  response.flushHeaders?.()
  response.write(roleFrame())
  if (initialDelay > 0) await delay(initialDelay)
  const chunks = splitContent(text)
  for (const chunk of chunks) {
    if (response.destroyed || response.writableEnded) {
      log("response_aborted", { request: requestID })
      return
    }
    response.write(chunkFrame(chunk))
    if (stepDelay > 0) await delay(stepDelay)
  }
  response.write(chunkFrame("", "stop"))
  response.write("data: [DONE]\n\n")
  response.end()
  log("response_end", { request: requestID, chunks: chunks.length, rich: text === RICH_MARKDOWN, bubble: text === BUBBLE_MARKDOWN })
}

// v7 needs-you fixture: emit one OpenAI-compatible tool call so the native
// agent invokes Ensemble's ask_person tool. A follow-up request includes the
// tool result; the caller then streams the long hold fixture so the task stays
// active until the live check resolves the approval.
async function streamAskToolCall(response, requestID) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "close",
    "X-Accel-Buffering": "no",
  })
  response.flushHeaders?.()
  response.write(roleFrame())
  if (initialDelay > 0) await delay(initialDelay)
  response.write(`data: ${JSON.stringify({
    id: completionId(),
    object: "chat.completion.chunk",
    created: 1790000000,
    model: MODEL_ID,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_ensemble_ask_person",
          type: "function",
          function: { name: "ensemble_ask_person", arguments: JSON.stringify({ question: ASK_QUESTION }) },
        }],
      },
      finish_reason: null,
    }],
  })}\n\n`)
  response.write(chunkFrame("", "tool_calls"))
  response.write("data: [DONE]\n\n")
  response.end()
  log("response_tool_call", { request: requestID, tool: "ensemble_ask_person" })
}

function parseBudgetMarker(text) {
  let last
  for (const match of text.matchAll(BUDGET_MARKER_RE)) last = match
  if (!last) return undefined
  return {
    chain: last[1],
    consumed: Number(last[2]),
    total: Number(last[3]),
    next: last[4],
    mode: last[5],
  }
}

function latestDispatchGroup(prompt) {
  let last
  for (const match of prompt.matchAll(/group="(dispatch_[^"]+)"/g)) last = match[1]
  return last
}

function latestTaskID(prompt) {
  let last
  for (const match of prompt.matchAll(/task_id="(task_[^"]+)"/g)) last = match[1]
  return last
}

function budgetNextMarker(marker, next) {
  const consumed = marker.consumed + 1
  // Nine-hop scenarios continue at hop eight: the root group is spent and the
  // recipient is the leader. The command-cap scenario uses the same chain so
  // the refusal, not the fixture, decides the stop.
  const mode = marker.total >= 9 && consumed === marker.total - 1 ? "continue" : "handoff"
  return `fake-budget-relay:chain=${marker.chain};consumed=${consumed};total=${marker.total};next=${next};mode=${mode}`
}

function writeBudgetHandoff(marker, nextMarker, hop) {
  const title = `Budget relay ${marker.chain} hop ${hop}`
  const file = join(
    budgetHandoffDir,
    `budget-${marker.chain}-${hop}-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  )
  const content = [
    "---",
    "ensemble: handoff",
    "version: 1",
    `task: ${title}`,
    `summary: Deterministic budget relay fixture hop ${hop}.`,
    `instruction: ${nextMarker}`,
    "from: budget-fixture",
    `to: ${marker.next}`,
    `created: ${new Date().toISOString()}`,
    "---",
    "",
    "# Handoff",
    "",
    `Budget relay fixture hop ${hop}.`,
    "",
  ].join("\n")
  writeFileSync(file, content)
  return { title, file }
}

async function streamToolCall(response, requestID, tool, args, event, fields = {}) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "close",
    "X-Accel-Buffering": "no",
  })
  response.flushHeaders?.()
  response.write(roleFrame())
  if (initialDelay > 0) await delay(initialDelay)
  response.write(`data: ${JSON.stringify({
    id: completionId(),
    object: "chat.completion.chunk",
    created: 1790000000,
    model: MODEL_ID,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: `call_${tool}`,
          type: "function",
          function: { name: tool, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: null,
    }],
  })}\n\n`)
  response.write(chunkFrame("", "tool_calls"))
  response.write("data: [DONE]\n\n")
  response.end()
  log(event, { request: requestID, tool, ...fields })
}

async function nonStreamingCompletion(response, text, requestID) {
  response.writeHead(200, { "Content-Type": "application/json" })
  response.end(JSON.stringify({
    id: completionId(),
    object: "chat.completion",
    created: 1790000000,
    model: MODEL_ID,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }))
  log("response_end", { request: requestID, rich: text === RICH_MARKDOWN, bubble: text === BUBBLE_MARKDOWN, streaming: false })
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`)
  if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({
      object: "list",
      data: [{ id: MODEL_ID, object: "model", created: 0, owned_by: "ensemble" }],
    }))
    return
  }
  if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
    const requestID = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    let body
    try {
      body = JSON.parse(await readBody(request))
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "invalid JSON body" } }))
      log("request_invalid", { request: requestID })
      return
    }
    const messages = Array.isArray(body?.messages) ? body.messages : []
    const prompt = messages.filter((message) => message?.role === "user").map((message) => textOf(message.content)).join("\n")
    const rich = prompt.includes(FAKE_RICH_PROMPT)
    const bubble = prompt.includes(FAKE_BUBBLE_PROMPT)
    // The queue-hold trigger is deliberately sticky in history, like the rich
    // and bubble triggers: the live probe must always get the long stream even
    // when the host adds another user-role context message after the prompt.
    // Only the parked-message probe sends it, and no later DM turn depends on a
    // short reply, so the longer stream cannot mask another assertion.
    const hold = prompt.includes(FAKE_QUEUE_HOLD_PROMPT)
    const holdLong = prompt.includes(FAKE_QUEUE_HOLD_LONG_PROMPT)
    // v7 needs-you fixture: the first request calls ask_person; the follow-up
    // request (which carries a tool result) streams the long hold fixture.
    // The native session accumulates history, so "a tool result exists" is not
    // enough: only a tool result after the latest user message belongs to the
    // current turn. An approved re-run carries "User answer:" and must not ask
    // again.
    const init = prompt.includes(INIT_PROMPT_MARKER)
    const turnStart = prompt.includes(TURN_PROMPT_MARKER)
    let lastUser = -1
    for (let index = 0; index < messages.length; index++) {
      if (messages[index]?.role === "user") lastUser = index
    }
    const latestUserText = lastUser >= 0 ? textOf(messages[lastUser]?.content) : ""
    const subagentChild = latestUserText.includes(FAKE_SUBAGENT_CHILD_PROMPT)
    const subagentParent = latestUserText.includes(FAKE_SUBAGENT_PROMPT)
    const retryFixture = latestUserText.includes(FAKE_RETRY_PROMPT)
    const interruptHold = latestUserText.includes(FAKE_INTERRUPT_PROMPT)
    const finalMention = latestUserText.match(FAKE_MENTION_FINAL_RE)
    const askedThisTurn = latestUserText.includes(FAKE_ASK_PROMPT)
    const benchmark = latestUserText.match(FAKE_BENCHMARK_RE)
    const benchmarkMode = benchmark?.[1]
    const benchmarkPeer = benchmark?.[2]
    const leaseHold = latestUserText.includes(FAKE_LEASE_PROMPT)
    const answered = /User answer:/i.test(latestUserText)
    const toolResult = lastUser >= 0 && messages.slice(lastUser + 1).some((message) => message?.role === "tool")
    // Ticket #225 benchmark metrics: shapes, sizes, and counts only. Never log
    // message content, file bytes, or paths.
    const toolSchemas = Array.isArray(body?.tools) ? body.tools : body?.tools ? Object.values(body.tools) : []
    const ensembleSchemas = toolSchemas.filter((tool) => String(tool?.function?.name ?? tool?.name ?? "").startsWith("ensemble_"))
    const messagesChars = JSON.stringify(messages).length
    const toolSchemaChars = JSON.stringify(toolSchemas).length
    const ensembleToolSchemaChars = JSON.stringify(ensembleSchemas).length
    const taskTitles = [...prompt.matchAll(/title="([^"]+)"/g)]
    const taskTitle = taskTitles.at(-1)?.[1] ?? ""
    // One ask per distinct user request. The native session accumulates
    // context, so a title parsed from older context can collide; an explicit
    // ask-key marker gives the live harness a unique request identity while
    // the task title still guards the follow-up tool-result request.
    const askKeyMark = latestUserText.match(/\bask-key-[a-z0-9-]+/)
    const askKey = askKeyMark ? askKeyMark[0] : (taskTitle || latestUserText || prompt.slice(-200))
    const askNew = askedThisTurn && !answered && !askedTasks.has(askKey)
    // Ticket #74 fix-up: the DM session accumulates every earlier trigger,
    // so precedence must follow the LATEST trigger, not a fixed order —
    // otherwise the earlier rich trigger lingering in history shadows the
    // bubble prompt forever and its markers never render.
    const richAt = prompt.lastIndexOf(FAKE_RICH_PROMPT)
    const bubbleAt = prompt.lastIndexOf(FAKE_BUBBLE_PROMPT)
    const holdAt = prompt.lastIndexOf(FAKE_QUEUE_HOLD_PROMPT)
    const holdLongAt = prompt.lastIndexOf(FAKE_QUEUE_HOLD_LONG_PROMPT)
    const motion = latestUserText.includes(FAKE_MOTION_PROMPT) && !motionReplies.has(latestUserText)
    if (motion) motionReplies.add(latestUserText)
    // A long-lived session compacts between probes; the compaction prompt is
    // a summary template, not another queue-hold fixture. Never let an older
    // trigger in the accumulated prompt stream the long hold for it.
    const summaryRequest =
      /structured summary|summary template|exact section headings/i.test(latestUserText) ||
      /Return only the structured summary|exact section headings from the template/i.test(prompt.slice(-2000))
    const latest = Math.max(richAt, bubbleAt, holdAt, holdLongAt)
    const text = summaryRequest
      ? COMPACTION_SUMMARY
      : subagentChild
      ? SUBAGENT_CHILD_MARKDOWN
      : interruptHold
      ? INTERRUPT_HOLD_MARKDOWN
      : finalMention
      ? `${FAKE_MENTION_FINAL_MARKER} — $${finalMention[1]} please pick up the follow-up.\n`
      : leaseHold
      ? LEASE_HOLD_MARKDOWN
      : motion
      ? QUEUE_HOLD_MARKDOWN
      : latest === holdLongAt && holdLongAt >= 0
        ? QUEUE_HOLD_LONG_MARKDOWN
        : latest === holdAt && holdAt >= 0
          ? QUEUE_HOLD_MARKDOWN
          : bubbleAt > richAt
            ? BUBBLE_MARKDOWN
            : richAt >= 0
              ? RICH_MARKDOWN
              : SHORT_REPLY
    const budget = parseBudgetMarker(latestUserText)
    const reviewItems = [...latestUserText.matchAll(/ref (task_[A-Za-z0-9]+)/g)].map((item) => item[1])
    // Only close batch reviews created by the budget fixture. The existing
    // fake TUI scenarios inspect the batch before deciding it and must keep
    // their normal text reply.
    const reviewBatch = reviewItems.length > 0 &&
      BUDGET_REVIEW_RE.test(latestUserText) &&
      latestUserText.includes("Budget relay")
      ? latestTaskID(prompt)
      : undefined
    log("request", {
      request: requestID,
      model: body?.model,
      stream: body?.stream !== false,
      messages: messages.length,
      rich,
      bubble,
      hold,
      holdLong,
      ask: askedThisTurn,
      askNew,
      init,
      turnStart,
      leaseHold,
      subagentParent,
      subagentChild,
      motion,
      answered,
      toolResult,
      budget: budget ? `${budget.chain}:${budget.consumed}/${budget.total}:${budget.mode}` : "",
      budgetGroup: budget ? latestDispatchGroup(prompt) ?? "" : "",
      reviewItems: reviewItems.length,
      toolCount: toolSchemas.length,
      toolSchemaChars,
      ensembleToolCount: ensembleSchemas.length,
      ensembleToolSchemaChars,
      messagesChars,
      promptChars: prompt.length,
      hasTurnContext: JSON.stringify(body).includes("<ensemble_turn"),
      hasBudgetContext: JSON.stringify(body).includes("<ensemble_dispatch_budget"),
      estimatedPromptTokens: Math.ceil((messagesChars + toolSchemaChars) / 4),
      promptTail: prompt.slice(-120),
    })
    // Ticket #210: one retryable 429 per fixture text, counted only for
    // streaming model requests. The host schedules a retry and then succeeds.
    if (body?.stream !== false && retryFixture) {
      const key = latestUserText
      const attempt = (retryFixtureAttempts.get(key) ?? 0) + 1
      retryFixtureAttempts.set(key, attempt)
      log("retry_fixture", { request: requestID, attempt })
      if (attempt === 1) {
        response.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(RETRY_AFTER_MS / 1000)),
        })
        response.end(JSON.stringify({ error: { message: "fake retry fixture", type: "rate_limit_exceeded" } }))
        return
      }
    }
    // A real native error fixture: the host turn fails before any text stream.
    if (body?.stream !== false && latestUserText.includes(FAKE_NATIVE_ERROR_PROMPT)) {
      log("native_error", { request: requestID })
      // A 4xx model error is a real native execution failure the host does not
      // retry internally, so the service reaches its terminal `failed` row
      // without a long provider backoff.
      response.writeHead(400, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "fake native execution failure", type: "invalid_request_error" } }))
      return
    }
    try {
      if (body?.stream !== false && subagentChild) {
        // The real child session streams long enough that the parent's first
        // turn has already reached idle before this reply completes.
        await streamCompletion(response, SUBAGENT_CHILD_MARKDOWN, requestID, SUBAGENT_CHILD_DELAY_MS)
        return
      }
      if (body?.stream !== false && subagentParent && !toolResult) {
        // Background mode is the host shape that finalizes the parent before
        // the child: the tool returns an ack immediately, then the child runs.
        await streamToolCall(
          response,
          requestID,
          "subagent",
          {
            agent: "explore",
            description: "Watch the CI pipeline",
            prompt: `Check the CI pipeline from start to finish. ${FAKE_SUBAGENT_CHILD_PROMPT}`,
            background: true,
          },
          "subagent_tool_call",
        )
        return
      }
      if (body?.stream !== false && budget && !toolResult) {
        const key = latestTaskID(prompt) ?? `${budget.chain}:${budget.consumed}`
        if (!budgetHandoffDir) {
          log("budget_skip", { request: requestID, reason: "no_handoff_dir", chain: budget.chain, consumed: budget.consumed })
          await streamCompletion(response, SHORT_REPLY, requestID)
          return
        }
        if (budgetToolCalls.has(key)) {
          log("budget_skip", { request: requestID, reason: "duplicate_task", chain: budget.chain, consumed: budget.consumed })
          await streamCompletion(response, SHORT_REPLY, requestID)
          return
        }
        budgetToolCalls.add(key)
        const hop = budget.consumed + 1
        if (hop > budget.total) {
          log("budget_skip", { request: requestID, reason: "chain_complete", chain: budget.chain, consumed: budget.consumed })
          await streamCompletion(response, SHORT_REPLY, requestID)
          return
        }
        const next = budget.next === "LedgerPeer" ? "LedgerLead" : "LedgerPeer"
        const nextMarker = budgetNextMarker(budget, next)
        const maxHops = hop < budget.total ? 1 : 0
        if (budget.mode === "continue") {
          const group = latestDispatchGroup(prompt)
          if (!group) {
            log("budget_skip", { request: requestID, reason: "missing_group", chain: budget.chain, consumed: budget.consumed })
            await streamCompletion(response, SHORT_REPLY, requestID)
            return
          }
          await streamToolCall(
            response,
            requestID,
            "ensemble_delegate",
            {
              assignee: budget.next,
              title: `Budget relay ${budget.chain} hop ${hop}`,
              instruction: nextMarker,
              maxHops,
              continuationOf: group,
              groupMaxHops: 8,
            },
            "budget_tool_call",
            { chain: budget.chain, consumed: budget.consumed, hop, mode: budget.mode, group },
          )
          return
        }
        const { title, file } = writeBudgetHandoff(budget, nextMarker, hop)
        await streamToolCall(
          response,
          requestID,
          "ensemble_handoff",
          { task: title, summary: `Deterministic budget relay fixture hop ${hop}.`, path: file, to: budget.next, maxHops },
          "budget_tool_call",
          { chain: budget.chain, consumed: budget.consumed, hop, mode: budget.mode },
        )
        return
      }
      if (body?.stream !== false && reviewItems.length > 0 && reviewBatch && !toolResult) {
        if (!reviewToolCalls.has(reviewBatch)) {
          reviewToolCalls.add(reviewBatch)
          await streamToolCall(
            response,
            requestID,
            "ensemble_review",
            { batch: reviewBatch, decisions: reviewItems.map((item) => ({ item, action: "end" })) },
            "review_tool_call",
            { batch: reviewBatch, items: reviewItems.length },
          )
          return
        }
        log("review_skip", { request: requestID, reason: "duplicate_batch", batch: reviewBatch })
        await streamCompletion(response, SHORT_REPLY, requestID)
        return
      }
      // Ticket #225: the same coordination operation through the two surfaces.
      // Native answers once with `$Peer`; legacy calls send_message and needs a
      // second model turn after the tool result.
      if (body?.stream !== false && benchmarkMode === "legacy" && !toolResult && benchmarkPeer) {
        await streamToolCall(
          response,
          requestID,
          "ensemble_send_message",
          { kind: "workspace", text: `$${benchmarkPeer} please verify the benchmark route.` },
          "benchmark_tool_call",
          { surface: "legacy" },
        )
        return
      }
      if (body?.stream !== false && benchmarkMode === "native" && benchmarkPeer) {
        await streamCompletion(response, `$${benchmarkPeer} please verify the benchmark route.`, requestID)
        return
      }
      if (body?.stream !== false && benchmarkMode === "legacy" && toolResult) {
        await streamCompletion(response, SHORT_REPLY, requestID)
        return
      }
      if (init && body?.stream !== false && initDelay > 0) await delay(initDelay)
      if (turnStart && body?.stream !== false && turnStartDelay > 0) await delay(turnStartDelay)
      if (askedThisTurn && body?.stream !== false) {
        if (askNew) {
          askedTasks.add(askKey)
          if (taskTitle) askedTasks.add(taskTitle)
          await streamAskToolCall(response, requestID)
        } else await streamCompletion(response, QUEUE_HOLD_MARKDOWN, requestID)
      } else if (body?.stream === false) await nonStreamingCompletion(response, text, requestID)
      else await streamCompletion(response, text, requestID, leaseHold ? LEASE_HOLD_DELAY_MS : chunkDelay)
    } catch (error) {
      log("response_error", { request: requestID, message: String(error) })
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "fake provider failure" } }))
    }
    return
  }
  response.writeHead(404, { "Content-Type": "application/json" })
  response.end(JSON.stringify({ error: { message: `no fake route for ${request.method} ${url.pathname}` } }))
})

server.on("error", (error) => {
  log("server_error", { message: String(error) })
  process.exitCode = 1
})

server.listen(port, host, () => {
  const address = server.address()
  const url = `http://${host}:${address.port}`
  if (urlFile) {
    const temporary = `${urlFile}.tmp`
    writeFileSync(temporary, `${url}\n`)
    renameSync(temporary, urlFile)
  }
  log("listening", { url })
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
