import test from "node:test"
import assert from "node:assert/strict"
import { formatLogEntry, formatLogStats, logEntryTone, logsRpcInput, logsTitle, parseLogsCommand, sortLogEntries } from "./logs.ts"
import type { LogEntry } from "../logging.ts"

const entry = (patch: Partial<LogEntry> = {}): LogEntry => ({
  ts: "2026-11-08T12:34:56.000Z",
  level: "warn",
  cat: "retry",
  event: "retry.scheduled",
  pid: 1,
  role: "service",
  instanceID: "boot-1",
  threadID: 0,
  ...patch,
})

test(":logs accepts only the documented filters", () => {
  assert.deepEqual(parseLogsCommand([]), { kind: "all" })
  assert.deepEqual(parseLogsCommand(["failures"]), { kind: "failures" })
  assert.deepEqual(parseLogsCommand(["task", "t_1"]), { kind: "task", taskID: "t_1" })
  assert.deepEqual(parseLogsCommand(["task"]), { error: "usage: :logs task <id>" })
  assert.deepEqual(parseLogsCommand(["nope"]), { error: "usage: :logs [failures | task <id>]" })
})

test(":logs maps filters onto the RPC input and title", () => {
  assert.deepEqual(logsRpcInput({ kind: "all" }, 10), { limit: 10 })
  assert.deepEqual(logsRpcInput({ kind: "failures" }, 10), { limit: 10, cat: "failure" })
  assert.deepEqual(logsRpcInput({ kind: "task", taskID: "t_1" }, 10), { limit: 10, taskID: "t_1" })
  assert.equal(logsTitle({ kind: "failures" }), "Logs · failures")
  assert.equal(logsTitle({ kind: "task", taskID: "t_1" }), "Logs · t_1")
})

test("log lines lead with time, level, and event, then identifying fields", () => {
  const line = formatLogEntry(entry({
    taskID: "t_1",
    attempt: 2,
    delayMs: 5_000,
    reason: "provider exploded",
  }))
  assert.match(line, /^12:34:56 WARN {2}retry\.scheduled/)
  assert.match(line, /task=t_1/)
  assert.match(line, /attempt=2/)
  assert.match(line, /delay=5000/)
  assert.match(line, /reason=provider exploded/)
  assert.equal(formatLogEntry(entry({ cat: "failure", event: "failure.terminal", failureClass: "provider" as any })).includes("failure=provider"), true)
})

test("failure lines surface the error message and decision without dumping content", () => {
  const line = formatLogEntry(entry({
    level: "error",
    cat: "failure",
    event: "failure.terminal",
    failureClass: "provider" as any,
    error: { message: "Missing API key", stack: "secret stack" },
    decision: { type: "terminal" },
    lastMessages: [{ text: "never printed" }],
  }))
  assert.match(line, /ERROR failure\.terminal/)
  assert.match(line, /error=Missing API key/)
  assert.match(line, /decision=terminal/)
  assert.equal(line.includes("secret stack"), false)
  assert.equal(line.includes("never printed"), false)
})

test("tones and stats stay viewer-friendly", () => {
  assert.equal(logEntryTone("error"), "bad")
  assert.equal(logEntryTone("warn"), "warn")
  assert.equal(logEntryTone("info"), "info")
  assert.equal(logEntryTone("debug"), "muted")
  const stats = formatLogStats({ level: "info", instanceID: "boot-1", threadID: 0, content: false, ringSize: 4, dropped: 1, written: 8, failedWrites: 0, dir: "/tmp/logs", mainFile: "/tmp/logs/main.jsonl" })
  assert.match(stats, /level=info/)
  assert.match(stats, /content=off/)
  assert.match(stats, /ring=4/)
  assert.match(stats, /instance=boot-1/)
  assert.match(stats, /thread=0/)
  assert.match(stats, /dir=\/tmp\/logs/)
})

test("sorting is stable by timestamp then severity", () => {
  const sorted = sortLogEntries([
    entry({ ts: "2026-11-08T12:00:02.000Z", level: "info", event: "b" }),
    entry({ ts: "2026-11-08T12:00:01.000Z", level: "info", event: "a2" }),
    entry({ ts: "2026-11-08T12:00:01.000Z", level: "error", event: "a1" }),
  ])
  assert.deepEqual(sorted.map((item) => item.event), ["a1", "a2", "b"])
})
