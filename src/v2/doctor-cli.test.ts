import test from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { defaultServiceDescriptorPath, parseDoctorArgs, readLocationConfig, runDoctor } from "./doctor-cli.ts"

test("doctor arguments parse flags and reject missing directories or unknown flags", () => {
  const parsed = parseDoctorArgs(["--json", "--server", "http://127.0.0.1:1234", "--service-file", "/tmp/service.json", "/a", "/b"])
  assert.equal(parsed.json, true)
  assert.equal(parsed.server, "http://127.0.0.1:1234")
  assert.equal(parsed.serviceFile, "/tmp/service.json")
  assert.deepEqual(parsed.directories, ["/a", "/b"])

  assert.throws(() => parseDoctorArgs([]), (error: any) => error.code === "usage" && error.exitCode === 2)
  assert.throws(() => parseDoctorArgs(["--bogus", "/a"]), (error: any) => error.code === "usage" && error.exitCode === 2)
  assert.throws(() => parseDoctorArgs(["--server"]), (error: any) => error.code === "usage" && error.exitCode === 2)
  assert.equal(parseDoctorArgs(["--help"]).help, true)
})

test("the default descriptor respects XDG isolation even when its file is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-doctor-state-"))
  try {
    const home = join(root, "home")
    const state = join(root, "state")
    assert.equal(defaultServiceDescriptorPath({ XDG_STATE_HOME: state }, home), join(state, "opencode", "service.json"))
    assert.equal(defaultServiceDescriptorPath({}, home), join(home, ".local", "state", "opencode", "service.json"))
    mkdirSync(join(state, "opencode"), { recursive: true })
    writeFileSync(join(state, "opencode", "service.json"), "{}")
    assert.equal(defaultServiceDescriptorPath({ XDG_STATE_HOME: state }, home), join(state, "opencode", "service.json"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("workspace config reads distinguish missing, valid and invalid files", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-doctor-config-"))
  try {
    const missing = join(root, "missing")
    mkdirSync(missing)
    assert.deepEqual(readLocationConfig(missing), { present: false })

    const valid = join(root, "valid")
    mkdirSync(join(valid, ".ensemble"), { recursive: true })
    writeFileSync(join(valid, ".ensemble", "config.json"), JSON.stringify({
      version: 1,
      name: "site",
      leader: "Clark",
      members: ["Clark", "Jessy"],
      synthesis: false,
      paused: true,
    }))
    const good = readLocationConfig(valid)
    assert.equal(good.present, true)
    assert.equal(good.present && good.valid, true)
    if (good.present && good.valid) {
      assert.equal(good.config.name, "site")
      assert.equal(good.config.synthesis, false)
      assert.equal(good.config.paused, true)
    }

    const invalid = join(root, "invalid")
    mkdirSync(join(invalid, ".ensemble"), { recursive: true })
    writeFileSync(join(invalid, ".ensemble", "config.json"), "{oops")
    const bad = readLocationConfig(invalid)
    assert.equal(bad.present, true)
    assert.equal(bad.present && bad.valid, false)
    if (bad.present && !bad.valid) assert.match(bad.reason, /JSON/i)

    writeFileSync(join(invalid, ".ensemble", "config.json"), JSON.stringify({ version: 2, name: "site", leader: "Clark", members: ["Clark"] }))
    const version = readLocationConfig(invalid)
    assert.equal(version.present && version.valid, false)
    if (version.present && !version.valid) assert.match(version.reason, /version/i)

    writeFileSync(join(invalid, ".ensemble", "config.json"), JSON.stringify({ version: 1, name: "site", leader: "Clark", members: ["Clark", "clark"] }))
    const duplicate = readLocationConfig(invalid)
    assert.equal(duplicate.present && duplicate.valid, false)
    if (duplicate.present && !duplicate.valid) assert.match(duplicate.reason, /duplicate/i)

    const unreadable = join(root, "unreadable")
    mkdirSync(join(unreadable, ".ensemble", "config.json"), { recursive: true })
    assert.throws(() => readLocationConfig(unreadable), (error: any) => error.code === "config_read_failed" && error.exitCode === 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("an explicit server never receives unrelated descriptor credentials and redirects are forbidden", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-doctor-auth-"))
  try {
    const state = join(root, ".local", "state", "opencode")
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, "service.json"), JSON.stringify({ url: "http://local.invalid", password: PASSWORD }))
    let calls = 0
    await assert.rejects(runDoctor(["--server", "http://explicit.invalid", root], {
      env: {}, home: root,
      fetchImpl: async (_url, init) => {
        calls++
        assert.equal((init?.headers as Record<string, string>).authorization, undefined)
        assert.equal(init?.redirect, "error")
        return new Response("redirect", { status: 302 })
      },
    }), /HTTP 302/)
    assert.equal(calls, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const PASSWORD = "doctor-secret-123"

function snapshotFor(directory: string, includeJessy: boolean) {
  const agents: Record<string, unknown> = {
    agent_clark: { id: "agent_clark", name: "Clark", archived: false },
  }
  if (includeJessy) agents.agent_jessy = { id: "agent_jessy", name: "Jessy", archived: false }
  return {
    output: {
      state: {
        agents,
        workspaces: {
          workspace_site: {
            id: "workspace_site",
            name: "site",
            directory,
            leaderID: "agent_clark",
            memberIDs: ["agent_clark"],
            archived: false,
            synthesis: true,
            paused: false,
            configVersion: 1,
          },
        },
        bindings: {
          "workspace_site:agent_clark": {
            workspaceID: "workspace_site",
            agentID: "agent_clark",
            sessionID: "ses_clark",
            kind: "workspace",
            directory,
            agentVersion: 1,
          },
        },
        dispatchGroups: {
          dispatch_root: {
            id: "dispatch_root",
            workspaceID: "workspace_site",
            rootID: "dispatch_root",
            continuationIndex: 0,
            maxHops: 8,
            usedHops: 1,
            depthMax: 8,
            commandMaxHops: 24,
            commandUsedHops: 1,
            maxContinuations: 2,
            continuationsUsed: 0,
            createdAt: 1,
          },
        },
        subtasks: {
          task_root: {
            id: "task_root",
            workspaceID: "workspace_site",
            dispatchGroupID: "dispatch_root",
            creatorType: "agent",
            workKind: "delegation",
            title: "PRIVATE-TASK-TITLE",
          },
        },
      },
      models: [],
      skills: [],
      directory,
    },
  }
}

function writeConfig(directory: string, members: string[]) {
  mkdirSync(join(directory, ".ensemble"), { recursive: true })
  writeFileSync(join(directory, ".ensemble", "config.json"), JSON.stringify({
    version: 1,
    name: "site",
    leader: "Clark",
    members,
    synthesis: true,
    paused: false,
  }))
}

test("runDoctor returns 0 for agreement and 1 for divergence without printing credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-doctor-run-"))
  const directoryA = join(root, "a")
  const directoryB = join(root, "b")
  mkdirSync(directoryA)
  mkdirSync(directoryB)
  writeConfig(directoryA, ["Clark"])
  let includeJessy = false
  let brokenLedger = false
  let brokenWork = false
  const server = createServer((request, response) => {
    request.resume()
    if (request.headers.authorization !== `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`) {
      response.writeHead(401)
      response.end("unauthorized")
      return
    }
    response.writeHead(200, { "content-type": "application/json" })
    const body = snapshotFor(directoryA, includeJessy) as any
    if (brokenLedger) body.output.state.dispatchGroups.dispatch_root.usedHops = 9
    if (brokenWork) {
      body.output.state.subtasks.task_root = {
        ...body.output.state.subtasks.task_root,
        state: "replied",
        outcome: "failed",
        status: "failed",
        attempts: 5,
        failure: { kind: "delivery", reason: "deadline-exceeded" },
        deliveryHoldUntil: 11,
        finishedAt: 10,
        repliedAt: 10,
      }
      body.output.recoveries = [{ taskID: "task_root", from: "stalled", to: "replied", reason: "late-success", at: 20 }]
    }
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  const descriptor = join(root, "service.json")
  writeFileSync(descriptor, JSON.stringify({
    id: "svc-test",
    version: "2.2.3",
    url: "http://127.0.0.1:1",
    pid: 4242,
    password: PASSWORD,
  }))
  const serverUrl = `http://127.0.0.1:${port}`
  try {
    let output = ""
    const code = await runDoctor(["--json", "--service-file", descriptor, "--server", serverUrl, directoryA, directoryB], {
      env: {},
      home: root,
      stdout: (text) => { output += text },
      stderr: () => undefined,
    })
    assert.equal(code, 0)
    const report = JSON.parse(output)
    assert.equal(report.ok, true)
    assert.equal(report.summary.locations, 2)
    assert.equal(report.summary.services, 1)
    assert.deepEqual(report.locations[0].service, { id: "svc-test", pid: 4242, version: "2.2.3" })
    assert.equal(report.locations[0].dispatch.groups, 1)
    assert.equal(report.locations[0].dispatch.usedHops, 1)
    assert.equal(report.locations[0].dispatch.commandUsedHops, 1)
    assert.equal(output.includes(PASSWORD), false)
    assert.equal(output.includes("PRIVATE-TASK-TITLE"), false)

    includeJessy = true
    writeConfig(directoryA, ["Clark", "Jessy"])
    output = ""
    const divergent = await runDoctor(["--service-file", descriptor, "--server", serverUrl, "--json", directoryA], {
      env: {},
      home: root,
      stdout: (text) => { output += text },
      stderr: () => undefined,
    })
    assert.equal(divergent, 1)
    const failed = JSON.parse(output)
    assert.equal(failed.ok, false)
    assert.ok(failed.mismatches.some((mismatch: any) => mismatch.code === "config_storage_members_differ"))
    assert.equal(output.includes(PASSWORD), false)

    output = ""
    const human = await runDoctor(["--service-file", descriptor, "--server", serverUrl, directoryA], {
      env: {},
      home: root,
      stdout: (text) => { output += text },
      stderr: () => undefined,
    })
    assert.equal(human, 1)
    assert.match(output, /Remediation:/)
    assert.match(output, /config_storage_members_differ:/)
    assert.equal(output.includes(PASSWORD), false)

    // Ticket #163: the doctor sees the ledger through the diagnostic RPC and
    // reports a seeded over-budget counter without exposing task content.
    includeJessy = false
    brokenLedger = true
    writeConfig(directoryA, ["Clark"])
    output = ""
    const broken = await runDoctor(["--json", "--service-file", descriptor, "--server", serverUrl, directoryA], {
      env: {},
      home: root,
      stdout: (text) => { output += text },
      stderr: () => undefined,
    })
    assert.equal(broken, 1)
    const brokenReport = JSON.parse(output)
    assert.ok(brokenReport.mismatches.some((mismatch: any) => mismatch.code === "dispatch_group_over_budget"))
    assert.equal(output.includes("PRIVATE-TASK-TITLE"), false)

    // Ticket #170: structured work fields and recovery audit rows travel
    // through the diagnostic RPC without titles, instructions, or answer text.
    brokenLedger = false
    brokenWork = true
    output = ""
    const workBroken = await runDoctor(["--json", "--service-file", descriptor, "--server", serverUrl, directoryA], {
      env: {},
      home: root,
      stdout: (text) => { output += text },
      stderr: () => undefined,
    })
    assert.equal(workBroken, 1)
    const workReport = JSON.parse(output)
    assert.ok(workReport.mismatches.some((mismatch: any) => mismatch.code === "work_failed_timeout"))
    assert.ok(workReport.mismatches.some((mismatch: any) => mismatch.code === "work_recovery_mismatch"))
    assert.ok(workReport.mismatches.some((mismatch: any) => mismatch.code === "work_terminal_contradiction"), "a terminal delivery hold crosses the diagnostic wire")
    assert.equal(output.includes("PRIVATE-TASK-TITLE"), false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})

test("CLI uses the default descriptor, password override, snapshot-only wire contract and safe output", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-doctor-cli-"))
  const directory = join(root, "project")
  const state = join(root, "state")
  mkdirSync(directory)
  mkdirSync(join(state, "opencode"), { recursive: true })
  writeConfig(directory, ["Clark"])
  const before = readFileSync(join(directory, ".ensemble", "config.json"), "utf8")
  const requests: Array<{ method?: string; url?: string; auth?: string; body: string }> = []
  let mode: "healthy" | "divergent" | "invalid" | "unauthorized" = "healthy"
  const content = "PRIVATE-CONVERSATION-AND-MEMORY"
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    requests.push({ method: request.method, url: request.url, auth: request.headers.authorization, body })
    response.setHeader("content-type", "application/json")
    if (mode === "unauthorized") {
      response.writeHead(401)
      response.end(PASSWORD + content)
      return
    }
    if (mode === "invalid") {
      response.end(JSON.stringify({ output: { state: { messages: content } } }))
      return
    }
    const snap = snapshotFor(directory, mode === "divergent")
    response.end(JSON.stringify({ ...snap, output: { ...snap.output, state: {
      ...snap.output.state, messages: { secret: content }, memories: { secret: content },
    } } }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  writeFileSync(join(state, "opencode", "service.json"), JSON.stringify({
    url: `http://127.0.0.1:${address.port}`, password: "wrong-descriptor-password", pid: 42, version: "2.2.3",
  }))
  const script = fileURLToPath(new URL("./doctor-cli.ts", import.meta.url))
  const run = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script, "--json", directory], {
      env: { ...process.env, XDG_STATE_HOME: state, OPENCODE_PASSWORD: PASSWORD },
    })
    let stdout = "", stderr = ""
    child.stdout.on("data", (data) => { stdout += data })
    child.stderr.on("data", (data) => { stderr += data })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
  try {
    const healthy = await run()
    assert.equal(healthy.code, 0)
    const report = JSON.parse(healthy.stdout)
    assert.equal(report.ok, true)
    assert.match(report.caveats.join(" "), /diagnostic|read-only|discovery|reconciliation/i)
    assert.equal(report.locations[0].agents[0].name, "Clark")
    assert.equal(report.locations[0].dispatch.groups, 1)
    assert.equal(report.locations[0].dispatch.usedHops, 1)
    assert.equal(readFileSync(join(directory, ".ensemble", "config.json"), "utf8"), before)
    writeConfig(directory, ["Clark", "Jessy"])
    const divergentConfig = readFileSync(join(directory, ".ensemble", "config.json"), "utf8")
    mode = "divergent"
    const divergent = await run()
    assert.equal(divergent.code, 1)
    assert.ok(JSON.parse(divergent.stdout).mismatches.some((item: any) => item.code === "config_storage_members_differ"))
    mode = "invalid"
    const invalid = await run()
    assert.equal(invalid.code, 2)
    assert.equal(JSON.parse(invalid.stdout).error.code, "snapshot_invalid")
    mode = "unauthorized"
    const unauthorized = await run()
    assert.equal(unauthorized.code, 2)
    assert.equal(JSON.parse(unauthorized.stdout).error.code, "snapshot_failed")
    for (const result of [healthy, divergent, invalid, unauthorized]) {
      assert.equal(`${result.stdout}${result.stderr}`.includes(PASSWORD), false)
      assert.equal(`${result.stdout}${result.stderr}`.includes(content), false)
    }
    assert.equal(requests.length, 4)
    for (const request of requests) {
      assert.equal(request.method, "POST")
      const url = new URL(request.url!, "http://fixture")
      assert.equal(url.pathname, "/api/rpc/ensemble.v2/diagnostic")
      assert.equal(url.searchParams.get("location[directory]"), directory)
      assert.deepEqual(JSON.parse(request.body), { input: { directory } })
      assert.equal(request.auth, `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`)
    }
    assert.equal(readFileSync(join(directory, ".ensemble", "config.json"), "utf8"), divergentConfig)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})

test("the CLI exits 2 for usage and connection failures", () => {
  const script = fileURLToPath(new URL("./doctor-cli.ts", import.meta.url))
  const usage = spawnSync(process.execPath, ["--experimental-strip-types", script, "--json"], { encoding: "utf8" })
  assert.equal(usage.status, 2)
  const usageReport = JSON.parse(usage.stdout)
  assert.equal(usageReport.ok, false)
  assert.equal(usageReport.error.code, "usage")

  const root = mkdtempSync(join(tmpdir(), "ensemble-doctor-fail-"))
  try {
    const descriptor = join(root, "service.json")
    writeFileSync(descriptor, JSON.stringify({ url: "http://127.0.0.1:1", password: PASSWORD }))
    const failed = spawnSync(process.execPath, ["--experimental-strip-types", script, "--json", "--service-file", descriptor, root], { encoding: "utf8" })
    assert.equal(failed.status, 2)
    const report = JSON.parse(failed.stdout)
    assert.equal(report.ok, false)
    assert.equal(report.error.code, "snapshot_failed")
    assert.equal(`${failed.stdout}${failed.stderr}`.includes(PASSWORD), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
