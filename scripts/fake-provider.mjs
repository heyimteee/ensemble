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
import { appendFileSync, renameSync, writeFileSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"

const FAKE_RICH_PROMPT = "fake-rich-fixture"
const FAKE_BUBBLE_PROMPT = "fake-bubble-fixture"
const MODEL_ID = "ensemble-fake-model"

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
const chunkDelay = Math.max(0, Number(argValue("--chunk-delay-ms", "35")))
const initialDelay = Math.max(0, Number(argValue("--initial-delay-ms", "250")))

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

async function streamCompletion(response, text, requestID) {
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
    if (chunkDelay > 0) await delay(chunkDelay)
  }
  response.write(chunkFrame("", "stop"))
  response.write("data: [DONE]\n\n")
  response.end()
  log("response_end", { request: requestID, chunks: chunks.length, rich: text === RICH_MARKDOWN, bubble: text === BUBBLE_MARKDOWN })
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
    // Bubble fixture wins: prior context can still contain fake-rich-fixture,
    // and the bubble request must always return the long bubble document.
    const text = bubble ? BUBBLE_MARKDOWN : rich ? RICH_MARKDOWN : SHORT_REPLY
    log("request", {
      request: requestID,
      model: body?.model,
      stream: body?.stream !== false,
      messages: messages.length,
      rich,
      bubble,
      promptTail: prompt.slice(-120),
    })
    try {
      if (body?.stream === false) await nonStreamingCompletion(response, text, requestID)
      else await streamCompletion(response, text, requestID)
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
