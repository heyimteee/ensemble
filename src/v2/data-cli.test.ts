import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseDataArgs, runData } from "./data-cli.ts"

const PASSWORD = "data-secret-456"

test("data arguments require a command, directory, and an explicit delete confirmation", () => {
  const exported = parseDataArgs(["export", "/a", "--out", "/tmp/export.json", "--workspace", "w1"])
  assert.equal(exported.command, "export")
  assert.equal(exported.directory, "/a")
  assert.equal(exported.out, "/tmp/export.json")
  assert.equal(exported.workspaceID, "w1")

  const deleted = parseDataArgs(["delete", "/a", "--confirm", "DELETE", "--logs", "--delete-native-sessions"])
  assert.equal(deleted.command, "delete")
  assert.equal(deleted.confirm, "DELETE")
  assert.equal(deleted.logs, true)
  assert.equal(deleted.deleteNativeSessions, true)

  assert.throws(() => parseDataArgs([]), (error: any) => error.code === "usage" && error.exitCode === 2)
  assert.throws(() => parseDataArgs(["purge", "/a"]), (error: any) => error.code === "usage")
  assert.throws(() => parseDataArgs(["export"]), (error: any) => error.code === "usage")
  assert.throws(() => parseDataArgs(["delete", "/a"]), (error: any) => error.code === "confirmation_required")
  assert.throws(() => parseDataArgs(["delete", "/a", "--confirm", "yes"]), (error: any) => error.code === "confirmation_required")
  assert.throws(() => parseDataArgs(["export", "/a", "--confirm", "DELETE"]), (error: any) => error.code === "usage")
  assert.throws(() => parseDataArgs(["delete", "/a", "--confirm", "DELETE", "--out", "x"]), (error: any) => error.code === "usage")
  assert.throws(() => parseDataArgs(["export", "/a", "--bogus"]), (error: any) => error.code === "usage")
  assert.equal(parseDataArgs(["--help"]).help, true)
})

test("export writes the documented JSON to --out and never prints the service password", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-data-cli-"))
  try {
    const state = join(root, "state", "opencode")
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, "service.json"), JSON.stringify({ url: "http://service.invalid", password: PASSWORD }))
    const directory = join(root, "workspace")
    mkdirSync(directory)
    const out = join(root, "export.json")
    const stderr: string[] = []
    let captured: any
    const code = await runData(["export", directory, "--out", out], {
      env: { XDG_STATE_HOME: join(root, "state") },
      home: root,
      stdout: () => assert.fail("stdout must stay empty when --out is used"),
      stderr: (text) => stderr.push(text),
      fetchImpl: async (url, init) => {
        captured = { url, init }
        return new Response(JSON.stringify({
          output: {
            ok: true,
            result: {
              format: "ensemble.data-export",
              formatVersion: 1,
              counts: { messages: 2, work: 1, memories: 0 },
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } })
      },
    })
    assert.equal(code, 0)
    assert.equal(captured.url, `http://service.invalid/api/rpc/ensemble.v2/invoke?location%5Bdirectory%5D=${encodeURIComponent(directory)}`)
    assert.equal(captured.init.method, "POST")
    assert.equal(captured.init.redirect, "error")
    assert.equal(captured.init.headers.authorization, `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`)
    assert.deepEqual(JSON.parse(captured.init.body), {
      input: { directory, action: "data.export", payload: {} },
    })
    const written = JSON.parse(readFileSync(out, "utf8"))
    assert.equal(written.format, "ensemble.data-export")
    assert.equal(existsSync(out), true)
    assert.equal(stderr.join("").includes(PASSWORD), false)
    assert.match(stderr.join(""), /Wrote 2 message\(s\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("delete sends the confirmation and explicit delete scopes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-data-cli-delete-"))
  try {
    const directory = join(root, "workspace")
    mkdirSync(directory)
    let captured: any
    const stdout: string[] = []
    const code = await runData(["delete", directory, "--confirm", "DELETE", "--logs", "--delete-native-sessions", "--workspace", "w1", "--server", "http://service.invalid"], {
      env: {},
      home: root,
      stdout: (text) => stdout.push(text),
      fetchImpl: async (url, init) => {
        captured = { url, init }
        return new Response(JSON.stringify({
          output: {
            ok: true,
            result: {
              ok: true,
              workspace: { id: "w1", name: "site" },
              deleted: { messages: 3, subtasks: 2, memories: 1 },
              nativeSessionsDeleted: 1,
              logsDeleted: 4,
              retained: ["workspace", "agents", "workspace-config"],
            },
          },
        }), { status: 200 })
      },
    })
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(captured.init.body), {
      input: {
        directory,
        action: "data.delete",
        payload: { confirmation: "DELETE", workspaceID: "w1", deleteNativeSessions: true, logs: true },
      },
    })
    assert.equal(captured.init.headers.authorization, undefined, "no descriptor or env credentials exist")
    assert.match(stdout.join(""), /Deleted Ensemble data for workspace "site"/)
    assert.match(stdout.join(""), /messages: 3/)
    assert.match(stdout.join(""), /local log files: 4/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a refused delete returns the service error code instead of claiming success", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-data-cli-refused-"))
  try {
    const directory = join(root, "workspace")
    mkdirSync(directory)
    await assert.rejects(
      runData(["delete", directory, "--confirm", "DELETE", "--server", "http://service.invalid"], {
        env: {},
        home: root,
        fetchImpl: async () => new Response(JSON.stringify({
          output: { ok: false, error: { code: "confirmation_required", message: "Type DELETE to confirm." } },
        }), { status: 200 }),
      }),
      (error: any) => error.code === "confirmation_required" && error.exitCode === 1,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
