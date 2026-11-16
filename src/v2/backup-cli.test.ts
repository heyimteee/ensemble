import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("../../scripts/backup.mjs", import.meta.url))
const PASSWORD = "ticket273-password"
const PRIVATE_TEXT = "PRIVATE-CONVERSATION-TEXT"

const document = {
  format: "ensemble.backup",
  formatVersion: 1,
  createdAt: 1_700_000_000_000,
  protocol: 4,
  contractVersion: 7,
  counts: { agents: 1, workspaces: 0, messages: 1, subtasks: 0, dispatchGroups: 0, initJobs: 0, nativeSubagents: 0, bindings: 0, memories: 0, approvals: 0, dmQueue: 0, legacyDirect: 0 },
  digest: "0123456789abcdef0123456789abcdef",
  payload: {
    meta: null,
    entries: [
      { key: "v2/agent/a", value: { id: "a", name: "Nova", archived: false } },
      { key: "v2/message/00000001", value: { id: "m", workspaceID: "w", seq: 1, createdAt: 1, text: PRIVATE_TEXT } },
    ],
    workspaceConfigs: [],
  },
}

function run(
  args: string[],
  options: { state?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH, XDG_STATE_HOME: options.state ?? join(tmpdir(), "ensemble-backup-none"), ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })
}

test("ticket273: backup CLI documents usage and requires confirmation", async () => {
  const help = await run(["--help"])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Ensemble backup/)
  assert.match(help.stdout, /--confirm RESTORE/)

  const usage = await run([])
  assert.equal(usage.status, 2)
  assert.match(usage.stderr, /command is required/i)

  const root = mkdtempSync(join(tmpdir(), "ensemble-273-cli-"))
  try {
    const noConfirm = await run(["restore", "--in", join(root, "missing.json"), root])
    assert.equal(noConfirm.status, 2)
    assert.match(noConfirm.stderr, /RESTORE/)

    const wrongFile = join(root, "not-a-backup.json")
    writeFileSync(wrongFile, JSON.stringify({ hello: "world" }))
    const wrong = await run(["restore", "--in", wrongFile, "--confirm", "RESTORE", root])
    assert.equal(wrong.status, 2)
    assert.match(wrong.stderr, /not an ensemble\.backup/)

    const missing = await run(["restore", "--in", join(root, "missing.json"), "--confirm", "RESTORE", root])
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /does not exist/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("ticket273: backup CLI exports atomically, restores, rolls back, and reports status", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-273-cli-live-"))
  const requests: Array<{ action: string; payload: any; directory: string; auth: string | undefined; path: string; location: string | null }> = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => { body += chunk })
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      const input = JSON.parse(body).input
      requests.push({ action: input.action, payload: input.payload, directory: input.directory, auth: request.headers.authorization, path: url.pathname, location: url.searchParams.get("location[directory]") })
      const result = input.action === "backup.export"
        ? { backup: document }
        : input.action === "backup.status"
          ? { rollback: { present: true, valid: true, formatVersion: 1, createdAt: document.createdAt, version: 9, counts: document.counts } }
          : { formatVersion: 1, createdAt: document.createdAt, version: 10, counts: document.counts, workspaces: { restored: 0, skipped: 0, removed: 0 }, rollbackSlot: { written: input.action === "backup.restore" } }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ output: { ok: true, result } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  const url = `http://127.0.0.1:${port}`
  try {
    const out = join(root, "backup.json")
    const exported = await run(["export", "--out", out, "--server", url, root], { env: { OPENCODE_PASSWORD: PASSWORD } })
    assert.equal(exported.status, 0, exported.stderr)
    assert.equal(statSync(out).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), document)
    assert.equal(exported.stdout.includes(PRIVATE_TEXT), false)
    assert.equal(exported.stdout.includes(PASSWORD), false)
    assert.match(exported.stdout, /agents=1/)
    assert.equal(requests[0].action, "backup.export")
    assert.equal(requests[0].path, "/api/rpc/ensemble.v2/invoke")
    assert.equal(requests[0].location, root)
    assert.equal(requests[0].auth, `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`)

    const restored = await run(["restore", "--in", out, "--confirm", "RESTORE", "--server", url, root])
    assert.equal(restored.status, 0, restored.stderr)
    assert.equal(requests[1].action, "backup.restore")
    assert.equal(requests[1].payload.confirmation, "RESTORE")
    assert.deepEqual(requests[1].payload.backup, document)
    assert.match(restored.stdout, /rollback slot written: yes/)

    const status = await run(["status", "--json", "--server", url, root])
    assert.equal(status.status, 0, status.stderr)
    const report = JSON.parse(status.stdout)
    assert.equal(report.rollback.valid, true)
    assert.equal(report.rollback.version, 9)
    assert.equal(status.stdout.includes(PRIVATE_TEXT), false)

    const rolled = await run(["rollback", "--confirm", "ROLLBACK", "--server", url, root])
    assert.equal(rolled.status, 0, rolled.stderr)
    assert.equal(requests[3].action, "backup.rollback")
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})

test("ticket273: backup CLI surfaces a service refusal as exit 1 without content", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-273-cli-refuse-"))
  const server = createServer((request, response) => {
    request.resume()
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ output: { ok: false, error: { code: "busy", message: "Stop active work before restoring a backup." } } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  try {
    const file = join(root, "backup.json")
    writeFileSync(file, JSON.stringify(document))
    const restored = await run(["restore", "--in", file, "--confirm", "RESTORE", "--json", "--server", `http://127.0.0.1:${port}`, root])
    assert.equal(restored.status, 1)
    const report = JSON.parse(restored.stdout)
    assert.equal(report.ok, false)
    assert.equal(report.error.code, "busy")
    assert.equal(restored.stdout.includes(PRIVATE_TEXT), false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})
