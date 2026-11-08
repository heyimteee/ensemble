import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { threadId } from "node:worker_threads"
import { createLogRateLimiter, createLogger } from "./logging.ts"

const now = () => 1_700_000_000_000

test("logging levels filter noisy events and the ring stays bounded", () => {
  const log = createLogger({ role: "service", dir: null, level: "info", ringSize: 2, now })
  log.event("debug", "task", "task.debug", { taskID: "ignored" })
  log.event("info", "task", "task.created", { taskID: "t1" })
  log.event("warn", "retry", "task.retry.scheduled", { taskID: "t1", delayMs: 5_000 })
  log.event("error", "task", "task.failed", { taskID: "t1" })

  assert.equal(log.recent().length, 2)
  assert.deepEqual(log.recent().map((entry) => entry.event), ["task.retry.scheduled", "task.failed"])
  assert.equal(log.stats().dropped, 1)
  assert.equal(log.stats().ringSize, 2)
})

test("logging filters by task, category, event prefix, and level", () => {
  const log = createLogger({ role: "service", dir: null, level: "trace", ringSize: 20, now })
  log.event("info", "task", "task.created", { taskID: "t1" })
  log.event("warn", "retry", "retry.scheduled", { taskID: "t1" })
  log.event("error", "failure", "failure.terminal", { taskID: "t2" })

  assert.equal(log.recent({ taskID: "t1" }).length, 2)
  assert.equal(log.recent({ cat: "retry" }).length, 1)
  assert.equal(log.recent({ event: "failure" }).length, 1)
  assert.equal(log.recent({ level: "warn" }).length, 2)
})

test("every row identifies its role, instance, and thread", () => {
  const log = createLogger({ role: "tui", instanceID: "mount-1", dir: null, level: "trace", now })
  log.event("info", "tui", "tui.mount", {})
  log.event("warn", "feed", "feed.reset", { reason: "epoch" })
  log.failure({ cat: "failure", event: "failure.terminal", level: "error", taskID: "t1" })

  for (const entry of log.recent()) {
    assert.equal(entry.role, "tui")
    assert.equal(entry.instanceID, "mount-1")
    assert.equal(entry.threadID, threadId)
  }
  assert.deepEqual(log.recent({ instanceID: "mount-1" }).map((entry) => entry.event), [
    "tui.mount",
    "feed.reset",
    "failure.terminal",
  ])
  assert.deepEqual(log.recent({ instanceID: "another-mount" }), [])
  assert.equal(log.stats().instanceID, "mount-1")
  assert.equal(log.stats().threadID, threadId)
})

test("identical warnings stay rate-limited and carry the suppressed count", () => {
  let clock = 1_000
  const limiter = createLogRateLimiter({ windowMs: 10_000, now: () => clock })

  assert.deepEqual(limiter.admit("epoch"), { allowed: true, suppressed: 0 })
  clock = 2_000
  assert.deepEqual(limiter.admit("epoch"), { allowed: false, suppressed: 1 })
  clock = 5_000
  assert.deepEqual(limiter.admit("epoch"), { allowed: false, suppressed: 2 })
  assert.deepEqual(limiter.admit("ring-gap"), { allowed: true, suppressed: 0 }, "a different reason is independent")
  clock = 11_000
  assert.deepEqual(limiter.admit("epoch"), { allowed: true, suppressed: 2 }, "the next window reports what it suppressed")
  clock = 11_500
  assert.deepEqual(limiter.admit("epoch"), { allowed: false, suppressed: 1 })
})

test("logging redacts credentials and keeps errors structured", () => {
  const log = createLogger({ role: "service", dir: null, level: "trace", now })
  log.event("error", "failure", "failure.terminal", {
    token: "super-secret",
    authorization: "Bearer abcdefghijklmnop",
    url: "https://user:password@example.com/path",
    error: new Error("request failed with sk-abcdefgh12345"),
  })

  const entry = log.recent()[0]!
  assert.equal(entry.token, "[redacted]")
  assert.equal(entry.authorization, "[redacted]")
  assert.match(String(entry.url), /\[redacted\]/)
  const error = entry.error as any
  assert.equal(error.name, "Error")
  assert.ok(error.stack)
  assert.equal(String(error.message).includes("sk-abcdefgh12345"), false)
})

test("logging writes JSONL main and failure files with private permissions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-log-"))
  const log = createLogger({ role: "service", dir, level: "info", now, ringSize: 10 })
  try {
    log.event("info", "task", "task.created", { taskID: "t1", title: "Check" })
    log.failure({
      level: "error",
      cat: "failure",
      event: "failure.terminal",
      taskID: "t1",
      failureClass: "provider",
      error: { name: "Error", message: "boom", stack: "stack" },
      decision: { type: "terminal" },
    })
    await log.flush()

    const names = readdirSync(dir)
    const main = names.find((name) => name.startsWith("service-") && !name.includes("failures"))
    const failure = names.find((name) => name.includes("failures"))
    assert.ok(main)
    assert.ok(failure)
    const mainLines = readFileSync(join(dir, main!), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    const failureLines = readFileSync(join(dir, failure!), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(mainLines[0].event, "task.created")
    assert.equal(failureLines[0].event, "failure.terminal")
    assert.equal(failureLines[0].failureClass, "provider")
    assert.equal(statSync(join(dir, main!)).mode & 0o777, 0o600)
    assert.ok(log.stats().written >= 2)
  } finally {
    await log.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("logging rotates files without blocking", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-log-rotate-"))
  const log = createLogger({ role: "service", dir, level: "info", now, maxBytes: 1_024, maxFiles: 3 })
  try {
    for (let index = 0; index < 20; index++) {
      log.event("info", "message", "message.appended", { messageID: `m${index}`, chars: 200, text: "x".repeat(200) })
    }
    await log.flush()
    await log.flush()
    const names = readdirSync(dir)
    assert.ok(names.some((name) => name.endsWith(".1")), "the active file rotates after the size cap")
  } finally {
    await log.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("disabled logging writes nothing and keeps no ring", () => {
  const log = createLogger({ role: "service", enabled: false, dir: null, level: "trace", now })
  log.event("error", "task", "task.failed", { taskID: "t" })
  log.failure({ level: "error", event: "failure.terminal", taskID: "t", cat: "failure" } as any)
  assert.equal(log.recent().length, 0)
  assert.equal(log.stats().enabled, false)
})
