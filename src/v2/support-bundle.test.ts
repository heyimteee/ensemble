import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

import {
  SUPPORT_BUNDLE_FORMAT,
  buildSupportManifest,
  redactSupportText,
  redactSupportValue,
  sanitizeLogRows,
} from "./support-bundle.ts"

const script = fileURLToPath(new URL("../../scripts/support-bundle.mjs", import.meta.url))

const context = {
  home: "/home/private-user",
  stateDirectory: "/home/private-user/.local/state",
  logDirectory: "/home/private-user/.local/state/ensemble/logs",
  roots: ["/tmp/private-live-base"],
}

test("ticket276: support redaction replaces paths and credentials", () => {
  const text = redactSupportText(
    "dir=/tmp/private-live-base/project home=/home/private-user/work token=sk-abcdefgh12345678 password=hunter2 Authorization: Bearer abc.def",
    context,
  )
  assert.equal(text.includes("/tmp/private-live-base"), false)
  assert.equal(text.includes("/home/private-user"), false)
  assert.equal(text.includes("sk-abcdefgh"), false)
  assert.equal(text.includes("hunter2"), false)
  assert.equal(text.includes("abc.def"), false)
  assert.match(text, /~\/work/)
})

test("ticket276: support values drop content keys and keep structured evidence", () => {
  const value = redactSupportValue({
    event: "task.failed",
    taskID: "task_1",
    text: "SECRET_MESSAGE",
    title: "SECRET_TITLE",
    instruction: "SECRET_INSTRUCTION",
    prompt: "SECRET_PROMPT",
    content: "SECRET_CONTENT",
    body: "SECRET_BODY",
    result: "SECRET_RESULT",
    patch: "SECRET_PATCH",
    diff: "SECRET_DIFF",
    files: [{ path: "/home/private-user/secret.ts", bytes: 10 }],
    error: "failed in /home/private-user/work",
    count: 2,
  }, context)
  assert.ok(value && typeof value === "object" && !Array.isArray(value))
  const record = value as Record<string, unknown>
  assert.equal(record.event, "task.failed")
  assert.equal(record.taskID, "task_1")
  assert.equal(record.count, 2)
  assert.equal(record.text, undefined)
  assert.equal(record.title, undefined)
  assert.equal(record.instruction, undefined)
  assert.equal(record.prompt, undefined)
  assert.equal(record.content, undefined)
  assert.equal(record.body, undefined)
  assert.equal(record.result, undefined)
  assert.equal(record.patch, undefined)
  assert.equal(record.diff, undefined)
  assert.equal(record.files, undefined)
  assert.equal(record.error, "failed in ~/work")
  const serialized = JSON.stringify(value)
  for (const secret of ["SECRET_", "/home/private-user"]) assert.equal(serialized.includes(secret), false)
})

test("ticket276: support log slices are bounded and content-free", () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    ts: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    level: "info",
    event: "task.completed",
    taskID: `task_${index}`,
    text: "SECRET_MESSAGE",
    title: "SECRET_TITLE",
  }))
  const kept = sanitizeLogRows(rows, context, 5)
  assert.equal(kept.length, 5)
  assert.equal(kept[0]!.taskID, "task_15")
  assert.equal(JSON.stringify(kept).includes("SECRET_"), false)
})

test("ticket276: the manifest is versioned and path-redacted", () => {
  const manifest = buildSupportManifest({
    createdAt: "2026-01-01T00:00:00.000Z",
    platform: "linux",
    release: "6.1.0",
    arch: "x64",
    node: "26.12.1",
    ensembleVersion: "0.1.0",
    directories: ["/home/private-user/work"],
    files: [{ name: "doctor.json", bytes: 10 }],
    context,
  })
  assert.equal(manifest.format, SUPPORT_BUNDLE_FORMAT)
  assert.equal(manifest.version, 1)
  assert.deepEqual(manifest.directories, ["~/work"])
  assert.equal(JSON.stringify(manifest).includes("/home/private-user"), false)
})

test("ticket276: the support-bundle command writes redacted evidence without a live server", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-support-bundle-"))
  try {
    const home = join(root, "home")
    const project = join(home, "project")
    const logs = join(home, ".local", "state", "ensemble", "logs")
    const out = join(root, "bundle")
    mkdirSync(project, { recursive: true })
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, "service-20260101-1.jsonl"), [
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", level: "warn", role: "service", event: "task.failed", taskID: "t1", text: "SECRET_MESSAGE", title: "SECRET_TITLE", error: `failed in ${project}` }),
      JSON.stringify({ ts: "2026-01-01T00:00:01.000Z", level: "info", role: "service", event: "task.completed", taskID: "t2", text: "SECRET_MESSAGE" }),
    ].join("\n") + "\n")
    writeFileSync(join(logs, "service-failures-20260101-1.jsonl"), `${JSON.stringify({ ts: "2026-01-01T00:00:02.000Z", level: "error", cat: "failure", event: "failure.terminal", taskID: "t3", text: "SECRET_MESSAGE", error: `boom ${home}` })}\n`)
    mkdirSync(join(home, ".local", "state", "opencode"), { recursive: true })
    writeFileSync(join(home, ".local", "state", "opencode", "service.json"), JSON.stringify({ id: "svc", version: "2.2.7", url: "http://127.0.0.1:1", pid: 42, password: "SUPER_SECRET_PASSWORD" }))

    const result = spawnSync(process.execPath, [
      "--experimental-strip-types",
      script,
      "--out", out,
      "--directory", project,
      "--server", "http://127.0.0.1:1",
      "--log-dir", logs,
    ], { encoding: "utf8", env: { ...process.env, HOME: home } })

    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(join(out, "manifest.json")))
    assert.ok(existsSync(join(out, "logs-summary.json")))
    assert.ok(existsSync(join(out, "logs", "recent.jsonl")))
    const manifest = readFileSync(join(out, "manifest.json"), "utf8")
    const recent = readFileSync(join(out, "logs", "recent.jsonl"), "utf8")
    const summary = readFileSync(join(out, "logs-summary.json"), "utf8")
    const service = readFileSync(join(out, "service.json"), "utf8")
    for (const text of [manifest, recent, summary, service]) {
      assert.equal(text.includes("SECRET_MESSAGE"), false)
      assert.equal(text.includes("SECRET_TITLE"), false)
      assert.equal(text.includes("SUPER_SECRET_PASSWORD"), false)
      assert.equal(text.includes(home), false)
    }
    assert.match(service, /\[redacted\]/)
    assert.match(recent, /failure\.terminal|task\.failed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
