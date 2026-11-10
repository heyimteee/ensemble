import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EnsembleV2Service } from "./service.ts"
import { EnsembleV2Rpc } from "./rpc.ts"
import { startServiceForTest } from "./test-service.ts"
import { V2Store } from "./store.ts"
import type { Agent, Workspace } from "./types.ts"

type Emitted = { name: string; data: any }

function fakeContext(directory: string) {
  const values = new Map<string, unknown>()
  const nativeSessions = new Map<string, any>()
  const listCalls: any[] = []
  const moved: Array<{ sessionID: string; directory: string }> = []
  const synthetic: any[] = []
  const permissions: any[] = []
  const models: any[] = []
  const instructions: any[] = []
  const createdSessions: any[] = []
  const emitted: Emitted[] = []
  let sessionCounter = 0
  let moveMode: "apply" | "throw" | "queue" = "apply"
  const subscriptions = new Set<any>()
  const event = {
    subscribe: async function* (options: any = {}) {
      const subscription = { types: options?.types ?? [], queue: [] as any[], wake: undefined as (() => void) | undefined }
      subscriptions.add(subscription)
      try {
        while (true) {
          if (subscription.queue.length === 0) await new Promise<void>((resolve) => { subscription.wake = resolve })
          while (subscription.queue.length > 0) yield subscription.queue.shift()
        }
      } finally {
        subscriptions.delete(subscription)
      }
    },
  }
  const list = async (input: any = {}) => {
    listCalls.push({ ...input })
    const data = [...nativeSessions.values()].filter((session) => {
      if (input.parentID === null && session.parentID) return false
      if (typeof input.parentID === "string" && session.parentID !== input.parentID) return false
      if (input.archived === false && session.time?.archived) return false
      if (input.directory && session.location?.directory !== input.directory) return false
      if (input.search) {
        const needle = String(input.search).toLowerCase()
        const haystack = `${session.title ?? ""} ${session.id}`.toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      return true
    })
    return { data, cursor: {} }
  }
  const ctx = {
    onboarding: false,
    location: { directory },
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => { values.set(key, value) },
      remove: async (key: string) => { values.delete(key) },
      scan: async ({ prefix, after, limit }: any) => {
        const entries = [...values.entries()]
          .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit ?? 500)
          .map(([key, value]) => ({ key, value }))
        return { entries, next: entries.length === (limit ?? 500) ? entries.at(-1)?.key : undefined }
      },
    },
    session: {
      hook: async () => ({ dispose: async () => undefined }),
      list,
      get: async ({ sessionID }: any) => {
        const found = nativeSessions.get(sessionID)
        if (!found) throw Object.assign(new Error("Session not found."), { code: "session_not_found" })
        return { data: found }
      },
      create: async (input: any) => {
        const id = `session_created_${++sessionCounter}`
        const info = {
          id,
          title: input?.title,
          location: input?.location,
          agent: input?.agent,
          time: { created: 10, updated: 10 },
        }
        createdSessions.push(input)
        nativeSessions.set(id, info)
        return { data: info }
      },
      instructions: { entry: { put: async (input: any) => { instructions.push(input) } } },
      switchModel: async (input: any) => { models.push(input) },
      update: async (input: any) => { permissions.push(input) },
      move: async ({ sessionID, directory: target }: any) => {
        moved.push({ sessionID, directory: target })
        if (moveMode === "throw") throw new Error("move failed")
        if (moveMode === "queue") return { ok: true }
        const found = nativeSessions.get(sessionID)
        if (found) found.location = { directory: target }
        return { ok: true }
      },
      synthetic: async (input: any) => { synthetic.push(input); return { id: `inbox_${synthetic.length}` } },
      prompt: async () => ({}),
      context: async () => ({ data: [] }),
      wait: async () => undefined,
      interrupt: async () => ({ interrupted: false }),
      remove: async ({ sessionID }: any) => { nativeSessions.delete(sessionID) },
      command: async () => undefined,
    },
    rpc: {
      register: async (_schema: unknown, value: any) => ({
        events: {
          emit: async (name: string, data: any) => { emitted.push({ name, data }) },
        },
        dispose: async () => undefined,
        value,
      }),
    },
    tool: { transform: async (factory: any) => factory({ namespace() {}, add() {} }) },
    model: { list: async () => [{ providerID: "probe", id: "probe-model", name: "Probe", variants: [] }] },
    skill: { list: async () => [] },
    event,
  }
  return {
    ctx,
    nativeSessions,
    listCalls,
    moved,
    synthetic,
    permissions,
    models,
    instructions,
    createdSessions,
    emitted,
    setMoveMode: (mode: "apply" | "throw" | "queue") => { moveMode = mode },
  }
}

const novaAgent = (patch: Partial<Agent> = {}): Agent => ({
  id: "a", name: "Nova", title: "", role: "",
  mainModel: { providerID: "probe", modelID: "probe-model" },
  backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false,
  version: 1, createdAt: 1, updatedAt: 1, ...patch,
})

const siteWorkspace = (directory: string, patch: Partial<Workspace> = {}): Workspace => ({
  id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true,
  archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1, ...patch,
})

async function setup(options: { homeDirectory?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-224-"))
  const workspace = join(directory, "site")
  const home = options.homeDirectory ?? join(directory, "home")
  const fake = fakeContext(directory)
  const seed = new V2Store(fake.ctx)
  await seed.load()
  await seed.saveAgent(novaAgent({ homeDirectory: home }))
  await seed.saveWorkspace(siteWorkspace(workspace))
  const service = new EnsembleV2Service(fake.ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  return {
    directory,
    workspace,
    home,
    ...fake,
    service,
    handlers,
    invoke: (action: string, payload: any) => handlers.invoke({ directory, action, payload }),
    async close() {
      await stop()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

function sessionInfo(id: string, directory: string, patch: any = {}): any {
  return {
    id,
    title: `Session ${id}`,
    location: { directory },
    time: { created: 1, updated: 1 },
    ...patch,
  }
}

test("the picker refresh is a declared id-only RPC event", () => {
  const schema = (EnsembleV2Rpc as any).events?.["sessions.changed"]?.schema
  assert.ok(schema, "sessions.changed is declared")
  assert.deepEqual(schema.required, ["revision", "kind"])
  assert.equal(schema.properties.sessionID.type, "string")
  assert.equal(Object.keys(schema.properties).includes("text"), false, "the event carries no conversation content")
})

test("picker lists recent roots in the selected scope and never outside it", async () => {
  const harness = await setup()
  try {
    harness.nativeSessions.set("s_workspace", sessionInfo("s_workspace", harness.workspace, { title: "Release audit", time: { updated: 40 } }))
    harness.nativeSessions.set("s_project", sessionInfo("s_project", harness.directory, { title: "Release plan", time: { updated: 30 } }))
    harness.nativeSessions.set("s_other", sessionInfo("s_other", "/tmp/elsewhere", { title: "Release elsewhere", time: { updated: 20 } }))
    harness.nativeSessions.set("s_archived", sessionInfo("s_archived", harness.workspace, { title: "Release archived", time: { updated: 50, archived: 1 } }))
    harness.nativeSessions.set("s_child", sessionInfo("s_child", harness.workspace, { title: "Release child", parentID: "s_workspace", time: { updated: 60 } }))

    const direct = await harness.invoke("session.picker", { agentID: "a", conversation: "direct", workspaceID: "w", scope: "direct" })
    assert.equal(direct.ok, true)
    assert.equal(direct.result.scope, "direct")
    assert.deepEqual(direct.result.sessions.map((row: any) => row.id), ["s_workspace"], "workspace target scope excludes project, archived, and child rows")

    const searched = await harness.invoke("session.picker", { agentID: "a", conversation: "direct", workspaceID: "w", scope: "direct", query: "plan" })
    assert.deepEqual(searched.result.sessions, [], "search never leaves the selected scope")

    const project = await harness.invoke("session.picker", { agentID: "a", conversation: "direct", workspaceID: "w", scope: "project" })
    assert.deepEqual(project.result.sessions.map((row: any) => row.id), ["s_project"])

    const all = await harness.invoke("session.picker", { agentID: "a", conversation: "direct", workspaceID: "w", scope: "all" })
    assert.deepEqual(all.result.sessions.map((row: any) => row.id), ["s_workspace", "s_project", "s_other"])

    const workspaceTarget = await harness.invoke("session.picker", { agentID: "a", conversation: "workspace", workspaceID: "w" })
    assert.equal(workspaceTarget.result.target.kind, "workspace")
    assert.equal(workspaceTarget.result.scope, "workspace", "a workspace target defaults to the workspace scope")
    assert.equal(workspaceTarget.result.sessions.length, 1)
  } finally {
    await harness.close()
  }
})

test("picker marks the target's current session and the usage of other rows", async () => {
  const harness = await setup()
  try {
    const seed = new V2Store(harness.ctx)
    await seed.load()
    await seed.saveBinding({
      workspaceID: "w", agentID: "a", sessionID: "s_direct", kind: "direct",
      directory: harness.workspace, agentVersion: 1, updatedAt: 1,
    })
    harness.nativeSessions.set("s_direct", sessionInfo("s_direct", harness.workspace, { time: { updated: 20 } }))
    harness.nativeSessions.set("s_group", sessionInfo("s_group", harness.workspace, { time: { updated: 30 } }))
    const result = await harness.invoke("session.picker", { agentID: "a", conversation: "direct", workspaceID: "w", scope: "workspace" })
    const rows = new Map(result.result.sessions.map((row: any) => [row.id, row]))
    assert.match((rows.get("s_direct") as any).detail, /in use/)
    const group = rows.get("s_group") as any
    assert.match(group.detail, /available/)
  } finally {
    await harness.close()
  }
})

test("picker refreshes from claimed session events and ignores chat traffic", async () => {
  const harness = await setup()
  try {
    await harness.service.handleHostEvent({ id: "evt_move_1", created: 5, type: "session.moved", data: { sessionID: "s_one" } })
    const first = harness.emitted.filter((event) => event.name === "sessions.changed")
    assert.equal(first.length, 1)
    assert.equal(first[0].data.kind, "session.moved")
    assert.equal(first[0].data.sessionID, "s_one")
    await harness.service.handleHostEvent({ id: "evt_move_1", created: 5, type: "session.moved", data: { sessionID: "s_one" } })
    assert.equal(harness.emitted.filter((event) => event.name === "sessions.changed").length, 1, "a duplicate host event is harmless")
    await harness.service.handleHostEvent({ id: "evt_text_1", created: 6, type: "session.text.delta", data: { sessionID: "s_one", delta: "x" } })
    assert.equal(harness.emitted.filter((event) => event.name === "sessions.changed").length, 1, "chat text never refreshes the picker")
  } finally {
    await harness.close()
  }
})

test("adoption applies identity, model, Skillbox permissions, and a native heads-up", async () => {
  const harness = await setup()
  try {
    harness.nativeSessions.set("s_candidate", sessionInfo("s_candidate", harness.workspace, { title: "Existing context" }))
    const preview = await harness.invoke("session.adopt.preview", {
      agentID: "a", conversation: "direct", workspaceID: "w", sessionID: "s_candidate",
    })
    assert.equal(preview.ok, true)
    assert.equal(preview.result.plan.canAdopt, true)
    assert.equal(preview.result.plan.moveRequired, false)

    const adopted = await harness.invoke("session.adopt", {
      agentID: "a", conversation: "direct", workspaceID: "w", sessionID: "s_candidate",
    })
    assert.equal(adopted.ok, true)
    assert.equal(adopted.result.adopted, true)
    assert.equal(adopted.result.binding.sessionID, "s_candidate")
    assert.equal(adopted.result.binding.kind, "direct")
    assert.equal(adopted.result.headsUp, true)
    assert.equal(harness.moved.length, 0, "same-directory adoption does not move")
    assert.ok(harness.instructions.some((input) => input.sessionID === "s_candidate" && input.key === "ensemble.v2.identity"))
    assert.ok(harness.models.some((input) => input.sessionID === "s_candidate"))
    assert.ok(harness.permissions.some((input) => input.sessionID === "s_candidate"))
    assert.equal(harness.synthetic.length, 1)
    assert.match(harness.synthetic[0].text, /#site direct conversation with Nova/)
    assert.doesNotMatch(harness.synthetic[0].text, new RegExp(harness.directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    const snapshot = await harness.handlers.snapshot({ directory: harness.directory })
    assert.equal(snapshot.state.bindings["dm:a:w"].sessionID, "s_candidate")
  } finally {
    await harness.close()
  }
})

test("a directory move needs confirmation and a failed move aborts the binding", async () => {
  const harness = await setup()
  try {
    harness.nativeSessions.set("s_home", sessionInfo("s_home", harness.home))
    const refused = await harness.invoke("session.adopt", {
      agentID: "a", conversation: "direct", workspaceID: "w", sessionID: "s_home",
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error?.code, "move_confirmation_required")
    assert.equal(harness.moved.length, 0)
    let snapshot = await harness.handlers.snapshot({ directory: harness.directory })
    assert.equal(snapshot.state.bindings["dm:a:w"], undefined)

    harness.setMoveMode("throw")
    const failed = await harness.invoke("session.adopt", {
      agentID: "a", conversation: "direct", workspaceID: "w", sessionID: "s_home", confirmMove: true,
    })
    assert.equal(failed.ok, false)
    assert.equal(failed.error?.code, "session_move_failed")
    snapshot = await harness.handlers.snapshot({ directory: harness.directory })
    assert.equal(snapshot.state.bindings["dm:a:w"], undefined, "a failed move leaves the binding untouched")

    harness.setMoveMode("queue")
    const queued = await harness.invoke("session.adopt", {
      agentID: "a", conversation: "direct", workspaceID: "w", sessionID: "s_home", confirmMove: true,
    })
    assert.equal(queued.ok, false)
    assert.equal(queued.error?.code, "session_move_unconfirmed", "a queued move is not evidence the session moved")
    snapshot = await harness.handlers.snapshot({ directory: harness.directory })
    assert.equal(snapshot.state.bindings["dm:a:w"], undefined)

    harness.setMoveMode("apply")
    const adopted = await harness.invoke("session.adopt", {
      agentID: "a", conversation: "direct", workspaceID: "w", sessionID: "s_home", confirmMove: true,
    })
    assert.equal(adopted.ok, true)
    assert.equal(adopted.result.moved, true)
    assert.deepEqual(harness.moved.at(-1), { sessionID: "s_home", directory: harness.workspace })
    snapshot = await harness.handlers.snapshot({ directory: harness.directory })
    assert.equal(snapshot.state.bindings["dm:a:w"].sessionID, "s_home")
    assert.equal(snapshot.state.bindings["dm:a:w"].directory, harness.workspace)
  } finally {
    await harness.close()
  }
})

test("archived, child, busy, and missing sessions are rejected before any write", async () => {
  const harness = await setup()
  try {
    harness.nativeSessions.set("s_archived", sessionInfo("s_archived", harness.workspace, { time: { archived: 1 } }))
    harness.nativeSessions.set("s_child", sessionInfo("s_child", harness.workspace, { parentID: "s_parent" }))
    harness.nativeSessions.set("s_busy", sessionInfo("s_busy", harness.workspace, { active: { type: "running" } }))
    const cases: Array<[string, string]> = [
      ["s_archived", "session_archived"],
      ["s_child", "session_child"],
      ["s_busy", "session_busy"],
      ["s_missing", "session_not_found"],
    ]
    for (const [sessionID, code] of cases) {
      const result = await harness.invoke("session.adopt", {
        agentID: "a", conversation: "direct", workspaceID: "w", sessionID, confirmMove: true,
      })
      assert.equal(result.ok, false, code)
      assert.equal(result.error?.code, code)
    }
    const snapshot = await harness.handlers.snapshot({ directory: harness.directory })
    assert.deepEqual(Object.keys(snapshot.state.bindings), [])
    assert.equal(harness.synthetic.length, 0)
  } finally {
    await harness.close()
  }
})

test("a session bound to another conversation requires explicit reassignment and keeps history", async () => {
  const harness = await setup()
  try {
    const seed = new V2Store(harness.ctx)
    await seed.load()
    await seed.saveBinding({
      workspaceID: "w", agentID: "a", sessionID: "s_shared", history: ["s_old_group"], kind: "workspace",
      directory: harness.workspace, agentVersion: 1, updatedAt: 1,
    })
    harness.nativeSessions.set("s_shared", sessionInfo("s_shared", harness.workspace))
    harness.nativeSessions.set("s_old_group", sessionInfo("s_old_group", harness.workspace))

    const preview = await harness.invoke("session.adopt.preview", {
      agentID: "a", conversation: "direct", workspaceID: "w", sessionID: "s_shared",
    })
    assert.equal(preview.result.plan.needsReassign, true)
    assert.match(preview.result.reassignFrom.conversation, /#site group chat/)

    const refused = await harness.invoke("session.adopt", {
      agentID: "a", conversation: "direct", workspaceID: "w", sessionID: "s_shared",
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error?.code, "session_already_bound")
    const before = await harness.handlers.snapshot({ directory: harness.directory })
    assert.equal(before.state.bindings["w:a"].sessionID, "s_shared")

    const adopted = await harness.invoke("session.adopt", {
      agentID: "a", conversation: "direct", workspaceID: "w", sessionID: "s_shared", reassign: true,
    })
    assert.equal(adopted.ok, true)
    assert.equal(adopted.result.reassigned.agentID, "a")
    const after = await harness.handlers.snapshot({ directory: harness.directory })
    assert.equal(after.state.bindings["dm:a:w"].sessionID, "s_shared")
    const group = after.state.bindings["w:a"]
    assert.notEqual(group.sessionID, "s_shared", "the previous conversation gets a fresh session")
    assert.deepEqual(group.history, ["s_shared", "s_old_group"], "the old session remains in binding history")
    assert.equal(harness.createdSessions.length, 1)
    assert.equal(harness.createdSessions[0].title, "Nova · site")

    // The same session cannot serve two conversations: a third target refuses
    // until explicitly reassigned again.
    const second = await harness.invoke("session.adopt", {
      agentID: "a", conversation: "home", sessionID: "s_shared",
    })
    assert.equal(second.ok, false)
    assert.equal(second.error?.code, "session_already_bound")
    const twice = await harness.handlers.snapshot({ directory: harness.directory })
    assert.equal(twice.state.bindings["dm:a:w"].sessionID, "s_shared")
    assert.equal(twice.state.bindings["home:a"], undefined)
  } finally {
    await harness.close()
  }
})

test("adoption preserves the replaced session in the target conversation's history", async () => {
  const harness = await setup()
  try {
    const seed = new V2Store(harness.ctx)
    await seed.load()
    await seed.saveBinding({
      workspaceID: "w", agentID: "a", sessionID: "s_old", history: ["s_older"], kind: "direct",
      directory: harness.workspace, agentVersion: 1, updatedAt: 1,
    })
    harness.nativeSessions.set("s_old", sessionInfo("s_old", harness.workspace))
    harness.nativeSessions.set("s_older", sessionInfo("s_older", harness.workspace))
    harness.nativeSessions.set("s_new", sessionInfo("s_new", harness.workspace))

    const adopted = await harness.invoke("session.adopt", {
      agentID: "a", conversation: "direct", workspaceID: "w", sessionID: "s_new",
    })
    assert.equal(adopted.ok, true)
    assert.equal(adopted.result.replacedSessionID, "s_old")
    const snapshot = await harness.handlers.snapshot({ directory: harness.directory })
    const binding = snapshot.state.bindings["dm:a:w"]
    assert.equal(binding.sessionID, "s_new")
    assert.deepEqual(binding.history, ["s_old", "s_older"])
  } finally {
    await harness.close()
  }
})

test("adoption works for a workspace group target and rejects non-members", async () => {
  const harness = await setup()
  try {
    harness.nativeSessions.set("s_group_candidate", sessionInfo("s_group_candidate", harness.workspace))
    const adopted = await harness.invoke("session.adopt", {
      agentID: "a", conversation: "workspace", workspaceID: "w", sessionID: "s_group_candidate",
    })
    assert.equal(adopted.ok, true)
    assert.equal(adopted.result.binding.kind, "workspace")
    assert.match(harness.synthetic[0].text, /#site group chat/)

    const seed = new V2Store(harness.ctx)
    await seed.load()
    await seed.saveAgent(novaAgent({ id: "b", name: "Bob", homeDirectory: join(harness.directory, "bob") }))
    const refused = await harness.invoke("session.adopt", {
      agentID: "b", conversation: "workspace", workspaceID: "w", sessionID: "s_group_candidate",
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error?.code, "agent_not_member")
  } finally {
    await harness.close()
  }
})

test("a failed reassignment move restores the previous owner and drops the replacement", async () => {
  const harness = await setup()
  try {
    const seed = new V2Store(harness.ctx)
    await seed.load()
    await seed.saveBinding({
      workspaceID: "w", agentID: "a", sessionID: "s_shared", history: [], kind: "workspace",
      directory: harness.workspace, agentVersion: 1, updatedAt: 1,
    })
    harness.nativeSessions.set("s_shared", sessionInfo("s_shared", harness.home))
    harness.setMoveMode("throw")
    const failed = await harness.invoke("session.adopt", {
      agentID: "a", conversation: "direct", workspaceID: "w", sessionID: "s_shared", confirmMove: true, reassign: true,
    })
    assert.equal(failed.ok, false)
    assert.equal(failed.error?.code, "session_move_failed")
    assert.equal(harness.createdSessions.length, 1, "a replacement is prepared before the move")
    assert.equal([...harness.nativeSessions.keys()].some((id) => id.startsWith("session_created_")), false, "the replacement is removed on abort")
    const snapshot = await harness.handlers.snapshot({ directory: harness.directory })
    assert.equal(snapshot.state.bindings["w:a"].sessionID, "s_shared")
    assert.equal(snapshot.state.bindings["dm:a:w"], undefined)
  } finally {
    await harness.close()
  }
})

test("adoption is idempotent for the conversation's current session", async () => {
  const harness = await setup()
  try {
    const seed = new V2Store(harness.ctx)
    await seed.load()
    await seed.saveBinding({
      workspaceID: "w", agentID: "a", sessionID: "s_current", kind: "direct",
      directory: harness.workspace, agentVersion: 1, updatedAt: 1,
    })
    harness.nativeSessions.set("s_current", sessionInfo("s_current", harness.workspace))
    const adopted = await harness.invoke("session.adopt", {
      agentID: "a", conversation: "direct", workspaceID: "w", sessionID: "s_current",
    })
    assert.equal(adopted.ok, true)
    assert.equal(adopted.result.state, "unchanged")
    assert.equal(harness.synthetic.length, 0)
    assert.equal(harness.instructions.length, 0)
  } finally {
    await harness.close()
  }
})
